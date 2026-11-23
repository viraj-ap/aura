import type { AuraEvent, LLM, SqlDb } from '../types';

/**
 * Token counts depend on the tokenizer, so they're cached per (event, model).
 * Event counts persist in SQLite; arbitrary strings (formatted memories, summaries)
 * get a bounded in-memory cache.
 */
export class TokenCounter {
  private mem = new Map<string, number>();
  private static MAX_MEM = 5000;

  constructor(
    private db: SqlDb,
    private llm: () => LLM,
  ) {}

  get modelId(): string {
    return this.llm().id;
  }

  async count(text: string): Promise<number> {
    if (!text) return 0;
    const key = `${this.modelId}\u0000${text}`;
    const hit = this.mem.get(key);
    if (hit !== undefined) return hit;
    const n = await this.llm().countTokens(text);
    if (this.mem.size >= TokenCounter.MAX_MEM) this.mem.delete(this.mem.keys().next().value!);
    this.mem.set(key, n);
    return n;
  }

  async countEvent(ev: AuraEvent): Promise<number> {
    const modelId = this.modelId;
    const row = await this.db.get<{ count: number }>(
      'SELECT count FROM token_counts WHERE event_id = ? AND model_id = ?', [ev.id, modelId]);
    if (row) return row.count;
    const n = await this.llm().countTokens(ev.content);
    await this.db.run('INSERT OR REPLACE INTO token_counts(event_id, model_id, count) VALUES (?,?,?)',
      [ev.id, modelId, n]);
    return n;
  }
}
