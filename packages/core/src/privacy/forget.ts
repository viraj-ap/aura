import type { Indexer } from '../indexes/indexer';
import type { JobQueue } from '../jobs/queue';
import { ids } from '../store/schema';
import type { SqlDb } from '../types';

export interface ForgetReport {
  events: number;
  episodesRebuilt: number;
  compactionsDropped: number;
  factsDeleted: number;
  factsUpdated: number;
  rulesDeleted: number;
}

/**
 * User deletion — the only way anything leaves the event log. Every derived item
 * records its source event ids, so a delete can find and remove/re-derive everything
 * built from what was deleted: summaries are dropped and rebuilt from what remains,
 * facts lose the source and vanish when no source is left.
 */
export class Forget {
  constructor(
    private db: SqlDb,
    private indexer: Indexer,
    private jobs: JobQueue,
  ) {}

  async events(eventIds: number[]): Promise<ForgetReport> {
    const report: ForgetReport = { events: 0, episodesRebuilt: 0, compactionsDropped: 0, factsDeleted: 0, factsUpdated: 0, rulesDeleted: 0 };
    if (eventIds.length === 0) return report;
    const gone = new Set(eventIds);
    // Feedback about a deleted message goes too.
    const fb = await this.db.all<{ id: number; meta: string }>(`SELECT id, meta FROM events WHERE type = 'feedback'`);
    for (const f of fb) if (gone.has(Number(JSON.parse(f.meta ?? '{}').targetId))) gone.add(f.id);
    const all = [...gone];
    const qs = all.map(() => '?').join(',');
    const touches = (src: string) => ids.decode(src).some((id) => gone.has(id));

    const affectedSessions = (await this.db.all<{ session_id: number }>(
      `SELECT DISTINCT session_id FROM events WHERE id IN (${qs})`, all)).map((r) => r.session_id);

    await this.indexer.remove('event', all);
    await this.db.transaction(async () => {
      report.events = (await this.db.run(`DELETE FROM events WHERE id IN (${qs})`, all)).changes;
      await this.db.run(`DELETE FROM token_counts WHERE event_id IN (${qs})`, all);
    });

    // Episodes: drop and rebuild from the remaining events.
    for (const ep of await this.db.all<{ id: number; session_id: number; source_event_ids: string }>('SELECT id, session_id, source_event_ids FROM episodes')) {
      if (!touches(ep.source_event_ids)) continue;
      await this.db.run('DELETE FROM episodes WHERE id = ?', [ep.id]);
      await this.indexer.remove('episode', [ep.id]);
      const left = await this.db.get('SELECT 1 FROM events WHERE session_id = ? LIMIT 1', [ep.session_id]);
      if (left) {
        await this.jobs.enqueue('episode', { sessionId: ep.session_id }, `episode:${ep.session_id}`);
        report.episodesRebuilt++;
      }
    }

    // Compactions are cumulative, so dropping one that touches a deleted event also
    // drops every later one; the next turn re-compacts from the log.
    for (const c of await this.db.all<{ id: number; source_event_ids: string }>('SELECT id, source_event_ids FROM compactions')) {
      if (!touches(c.source_event_ids)) continue;
      await this.db.run('DELETE FROM compactions WHERE id = ?', [c.id]);
      report.compactionsDropped++;
    }

    // Facts: remove the source; no sources left → the fact is gone.
    for (const f of await this.db.all<{ id: number; subject: string; attribute: string; is_current: number; source_event_ids: string }>(
      'SELECT id, subject, attribute, is_current, source_event_ids FROM facts')) {
      if (!touches(f.source_event_ids)) continue;
      const left = ids.decode(f.source_event_ids).filter((id) => !gone.has(id));
      if (left.length) {
        await this.db.run('UPDATE facts SET source_event_ids = ? WHERE id = ?', [ids.encode(left), f.id]);
        report.factsUpdated++;
      } else {
        await this.deleteFactRow(f.id, f.subject, f.attribute, !!f.is_current);
        report.factsDeleted++;
      }
    }

    // Playbook rules learned only from deleted feedback go too.
    for (const r of await this.db.all<{ id: number; source_event_ids: string }>('SELECT id, source_event_ids FROM playbook')) {
      if (!touches(r.source_event_ids)) continue;
      const left = ids.decode(r.source_event_ids).filter((id) => !gone.has(id));
      if (left.length) await this.db.run('UPDATE playbook SET source_event_ids = ? WHERE id = ?', [ids.encode(left), r.id]);
      else {
        await this.db.run('DELETE FROM playbook WHERE id = ?', [r.id]);
        report.rulesDeleted++;
      }
    }

    for (const sid of affectedSessions) {
      const left = await this.db.get('SELECT 1 FROM events WHERE session_id = ? LIMIT 1', [sid]);
      if (!left) await this.db.run('DELETE FROM sessions WHERE id = ?', [sid]);
    }
    return report;
  }

  async session(sessionId: number): Promise<ForgetReport> {
    const evs = await this.db.all<{ id: number }>('SELECT id FROM events WHERE session_id = ?', [sessionId]);
    const report = await this.events(evs.map((e) => e.id));
    await this.db.run('DELETE FROM sessions WHERE id = ?', [sessionId]);
    await this.db.run('DELETE FROM compactions WHERE session_id = ?', [sessionId]);
    return report;
  }

  /**
   * Delete one fact. With `withSources`, also delete the messages it came from —
   * otherwise the fact is gone from the facts table but the original sentence is still
   * findable by search (and would be re-extracted only if its job re-ran).
   */
  async fact(factId: number, withSources = false): Promise<ForgetReport | null> {
    const f = await this.db.get<{ id: number; subject: string; attribute: string; is_current: number; source_event_ids: string }>(
      'SELECT * FROM facts WHERE id = ?', [factId]);
    if (!f) return null;
    if (withSources) return this.events(ids.decode(f.source_event_ids));
    await this.deleteFactRow(f.id, f.subject, f.attribute, !!f.is_current);
    return { events: 0, episodesRebuilt: 0, compactionsDropped: 0, factsDeleted: 1, factsUpdated: 0, rulesDeleted: 0 };
  }

  async all(): Promise<void> {
    await this.db.transaction(async () => {
      for (const t of ['events', 'sessions', 'token_counts', 'episodes', 'facts', 'playbook', 'jobs', 'compactions', 'embeddings', 'fts'])
        await this.db.run(`DELETE FROM ${t}`);
    });
    this.indexer.vectors.invalidate();
  }

  private async deleteFactRow(id: number, subject: string, attribute: string, wasCurrent: boolean): Promise<void> {
    await this.db.run('DELETE FROM facts WHERE id = ?', [id]);
    await this.indexer.remove('fact', [id]);
    if (wasCurrent) {
      // The previous value becomes current again.
      const prev = await this.db.get<{ id: number }>(
        'SELECT id FROM facts WHERE subject = ? AND attribute = ? ORDER BY last_seen DESC LIMIT 1', [subject, attribute]);
      if (prev) await this.db.run('UPDATE facts SET is_current = 1 WHERE id = ?', [prev.id]);
    }
  }
}
