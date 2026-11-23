import type { AuraConfig } from '../config';
import type { EventLog } from '../log/eventLog';
import type { TokenCounter } from '../log/tokens';
import { ids } from '../store/schema';
import type { AuraEvent, Clock, LLM, SqlDb } from '../types';
import { summarize } from './summarize';

export interface Compaction {
  id: number;
  summary: string;
  uptoEventId: number;
  sourceEventIds: number[];
}

export interface CompactResult {
  compacted: boolean;
  foldedEvents: number;
  beforeTokens: number;
  afterTokens: number;
  error?: string;
}

/**
 * L5 rolling summary of the current session. Batched: nothing happens until the recent
 * turns hit `trigger` × budget, then the oldest turns are folded into the summary until
 * they're down to `target` × budget. Between compactions the prompt prefix only grows,
 * so llama.cpp's KV-cache reuse keeps working for many turns.
 * Originals stay in the log (and in search), so nothing is truly lost.
 */
export class Compressor {
  constructor(
    private db: SqlDb,
    private log: EventLog,
    private tokens: TokenCounter,
    private llm: () => LLM,
    private cfg: () => AuraConfig,
    private clock: Clock,
  ) {}

  async latest(sessionId: number): Promise<Compaction | null> {
    const r = await this.db.get<{ id: number; summary: string; upto_event_id: number; source_event_ids: string }>(
      'SELECT * FROM compactions WHERE session_id = ? ORDER BY upto_event_id DESC LIMIT 1', [sessionId]);
    return r ? { id: r.id, summary: r.summary, uptoEventId: r.upto_event_id, sourceEventIds: ids.decode(r.source_event_ids) } : null;
  }

  /** Messages after the latest compaction (the working memory), excluding `excludeId`. */
  async workingTurns(sessionId: number, excludeId?: number): Promise<AuraEvent[]> {
    const c = this.cfg().layers.compression ? await this.latest(sessionId) : null;
    const turns = await this.log.listSession(sessionId, { afterId: c?.uptoEventId ?? 0 });
    return turns.filter((e) => e.id !== excludeId);
  }

  async maybeCompact(sessionId: number, query: AuraEvent, recentBudget: number, signal?: AbortSignal, onStart?: () => void): Promise<CompactResult> {
    const { trigger, target } = this.cfg().compression;
    const prev = await this.latest(sessionId);
    const turns = await this.workingTurns(sessionId, query.id);
    const summaryTok = prev ? await this.tokens.count(prev.summary) : 0;
    const cost = await Promise.all(turns.map((e) => this.tokens.countEvent(e)));
    const queryTok = await this.tokens.countEvent(query);
    const total = summaryTok + queryTok + cost.reduce((a, b) => a + b, 0);
    const none = { compacted: false, foldedEvents: 0, beforeTokens: total, afterTokens: total };
    if (total < trigger * recentBudget || turns.length < 3) return none;

    // Fold oldest turns until what's left (plus a summary allowance) fits the target.
    const summaryAllowance = Math.floor(recentBudget * 0.25);
    let remaining = total - summaryTok + summaryAllowance;
    let n = 0;
    while (n < turns.length - 2 && remaining > target * recentBudget) remaining -= cost[n++]!;
    // Keep user/assistant pairs together: don't leave an assistant reply orphaned at the front.
    while (n < turns.length - 2 && turns[n]!.role !== 'user') remaining -= cost[n++]!;
    if (n === 0) return none;

    const folded = turns.slice(0, n);
    onStart?.();
    try {
      const summary = await summarize(this.llm(), prev?.summary ?? null, folded, { maxTokens: summaryAllowance, signal });
      const sources = [...(prev?.sourceEventIds ?? []), ...folded.map((e) => e.id)];
      await this.db.run(
        'INSERT INTO compactions(session_id, upto_event_id, summary, source_event_ids, ts) VALUES (?,?,?,?,?)',
        [sessionId, folded[folded.length - 1]!.id, summary, ids.encode(sources), this.clock.now()]);
      const after = (await this.tokens.count(summary)) + queryTok + cost.slice(n).reduce((a, b) => a + b, 0);
      return { compacted: true, foldedEvents: n, beforeTokens: total, afterTokens: after };
    } catch (e) {
      // Bad/aborted output never blocks the chat: the assembler falls back to truncation.
      return { ...none, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
