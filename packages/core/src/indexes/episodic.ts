import { summarize } from '../compression/summarize';
import type { EventLog } from '../log/eventLog';
import { ids } from '../store/schema';
import type { LLM, SqlDb } from '../types';
import type { Indexer } from './indexer';

export interface Episode {
  id: number;
  sessionId: number;
  tsStart: number;
  tsEnd: number;
  summary: string;
  sourceEventIds: number[];
}

/**
 * L2 episodic memory: one running summary per session, updated incrementally by a
 * background job (previous summary + new messages → new summary). Indexed like
 * events so whole-conversation context shows up in search.
 */
export class Episodes {
  constructor(
    private db: SqlDb,
    private log: EventLog,
    private indexer: Indexer,
    private llm: () => LLM,
  ) {}

  async get(sessionId: number): Promise<Episode | undefined> {
    const r = await this.db.get<{ id: number; session_id: number; ts_start: number; ts_end: number; summary: string; source_event_ids: string }>(
      'SELECT * FROM episodes WHERE session_id = ?', [sessionId]);
    return r && { id: r.id, sessionId: r.session_id, tsStart: r.ts_start, tsEnd: r.ts_end, summary: r.summary,
      sourceEventIds: ids.decode(r.source_event_ids) };
  }

  /** Job handler. Processes new messages in batches so a long session never overflows the model. */
  async update(sessionId: number, opts: { signal?: AbortSignal; slot?: number; batchChars?: number } = {}): Promise<void> {
    const prev = await this.get(sessionId);
    const after = prev ? Math.max(0, ...prev.sourceEventIds) : 0;
    const fresh = await this.log.listSession(sessionId, { afterId: after });
    if (fresh.length === 0) return;

    const llm = this.llm();
    const batchChars = opts.batchChars ?? Math.max(2000, llm.contextLength * 2);
    let summary = prev?.summary ?? null;
    let sources = prev?.sourceEventIds ?? [];
    let tsStart = prev?.tsStart ?? fresh[0]!.ts;
    let tsEnd = prev?.tsEnd ?? fresh[0]!.ts;

    for (let i = 0; i < fresh.length; ) {
      const batch = [];
      let chars = 0;
      while (i < fresh.length && (batch.length === 0 || chars + fresh[i]!.content.length < batchChars)) {
        chars += fresh[i]!.content.length;
        batch.push(fresh[i++]!);
      }
      summary = await summarize(llm, summary, batch, { maxTokens: 300, signal: opts.signal, slot: opts.slot });
      sources = [...sources, ...batch.map((e) => e.id)];
      tsStart = Math.min(tsStart, batch[0]!.ts);
      tsEnd = Math.max(tsEnd, batch[batch.length - 1]!.ts);
    }

    await this.db.run(
      `INSERT INTO episodes(session_id, ts_start, ts_end, summary, source_event_ids) VALUES (?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET ts_start = excluded.ts_start, ts_end = excluded.ts_end,
         summary = excluded.summary, source_event_ids = excluded.source_event_ids`,
      [sessionId, tsStart, tsEnd, summary!, ids.encode(sources)]);
    const ep = (await this.get(sessionId))!;
    await this.indexer.index('episode', ep.id, ep.summary);
  }

  async touch(episodeIds: number[], now: number): Promise<void> {
    for (const id of episodeIds)
      await this.db.run('UPDATE episodes SET uses = uses + 1, last_used = ?, heat = uses + 1 WHERE id = ?', [now, id]);
  }
}
