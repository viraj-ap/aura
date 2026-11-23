import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { ChatMessage, CompletionRequest, CompletionResult, Embedder, LLM, TemplateOptions } from '@aura/core';

export const sha = (...parts: string[]) => createHash('sha1').update(parts.join('\u0000')).digest('hex');

/**
 * Persistent cache for everything deterministic. LongMemEval questions share haystack
 * sessions, so embeddings and background-job outputs (facts, summaries — temperature 0)
 * computed for one question are reused by every other question and every later run.
 */
export class EvalCache {
  readonly db: Database.Database;
  private getStmt: Database.Statement;
  private putStmt: Database.Statement;
  hits = 0;
  misses = 0;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    // It's a cache: no fsync per write (WAL + NORMAL is still crash-safe), and wait for
    // another eval process instead of failing. Per-row fsync made runs I/O-bound.
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 60000');
    this.db.exec('CREATE TABLE IF NOT EXISTS cache(kind TEXT, key TEXT, value BLOB, PRIMARY KEY(kind, key))');
    this.getStmt = this.db.prepare('SELECT value FROM cache WHERE kind = ? AND key = ?');
    this.putStmt = this.db.prepare('INSERT OR REPLACE INTO cache(kind, key, value) VALUES (?,?,?)');
  }

  get(kind: string, key: string): Buffer | undefined {
    const r = this.getStmt.get(kind, key) as { value: Buffer } | undefined;
    if (r) this.hits++;
    else this.misses++;
    return r?.value;
  }

  put(kind: string, key: string, value: Buffer | string): void {
    this.putStmt.run(kind, key, typeof value === 'string' ? Buffer.from(value) : value);
  }

  getJson<T>(kind: string, key: string): T | undefined {
    const v = this.get(kind, key);
    return v ? (JSON.parse(v.toString()) as T) : undefined;
  }

  putJson(kind: string, key: string, value: unknown): void {
    this.put(kind, key, JSON.stringify(value));
  }
}

export class CachedEmbedder implements Embedder {
  constructor(private inner: Embedder, private cache: EvalCache) {}
  get id() { return this.inner.id; }
  get maxTokens() { return this.inner.maxTokens; }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: (Float32Array | undefined)[] = texts.map((t) => {
      const b = this.cache.get('emb', sha(this.id, t));
      return b ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : undefined;
    });
    const missing = texts.map((t, i) => (out[i] ? -1 : i)).filter((i) => i >= 0);
    if (missing.length) {
      const fresh = await this.inner.embed(missing.map((i) => texts[i]!));
      this.cache.db.transaction(() => missing.forEach((i, j) => {
        out[i] = fresh[j]!;
        this.cache.put('emb', sha(this.id, texts[i]!), Buffer.from(fresh[j]!.buffer, fresh[j]!.byteOffset, fresh[j]!.byteLength));
      }))();
    }
    return out as Float32Array[];
  }
}

/**
 * Caches token counts and templates always, and completions for background jobs
 * (purpose 'job', temperature 0). Answers are NOT cached unless `cacheAnswers`, so
 * re-runs actually re-generate (needed to measure run-to-run variance).
 */
export class CachedLLM implements LLM {
  constructor(private inner: LLM, private cache: EvalCache, private cacheAnswers = false) {}
  get id() { return this.inner.id; }
  get contextLength() { return this.inner.contextLength; }

  async countTokens(text: string): Promise<number> {
    const k = sha(this.id, text);
    const hit = this.cache.get('tok', k);
    if (hit) return Number(hit.toString());
    const n = await this.inner.countTokens(text);
    this.cache.put('tok', k, String(n));
    return n;
  }

  async applyTemplate(messages: ChatMessage[], opts: TemplateOptions): Promise<string> {
    const k = sha(this.id, JSON.stringify(messages), String(opts.thinking));
    const hit = this.cache.get('tpl', k);
    if (hit) return hit.toString();
    const p = await this.inner.applyTemplate(messages, opts);
    this.cache.put('tpl', k, p);
    return p;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const cacheable = req.temperature === 0 && (req.purpose === 'job' || this.cacheAnswers);
    const k = sha(this.id, req.prompt, req.grammar ?? '', String(req.maxTokens), req.purpose ?? '');
    if (cacheable) {
      const hit = this.cache.getJson<CompletionResult>('gen', k);
      if (hit) return { ...hit, ttftMs: 0, totalMs: 0 };
    }
    const r = await this.inner.complete(req);
    if (cacheable && r.stopReason !== 'abort') this.cache.putJson('gen', k, r);
    return r;
  }
}
