import type { AuraConfig } from '../config';
import { chunkText } from '../indexes/chunker';
import type { Indexer } from '../indexes/indexer';
import { factText } from '../indexes/indexer';
import type { ItemType } from '../indexes/vector';
import type { Clock, Embedder, Role, SqlDb } from '../types';
import { safeJson } from '../util/text';

export interface MemoryItem {
  key: string; // "event:12" — unique across item types
  itemType: ItemType | 'note';
  itemId: number;
  sessionId?: number;
  ts: number;
  role?: Role;
  /** For attached files: the file name, so the prompt says where the text came from. */
  source?: string;
  text: string;
  /** 0..1 from search (normalized RRF or cosine). */
  relevance: number;
  importance: number;
  /** Final ranking score after rerank. */
  score: number;
  via: string;
}

export interface SearchOptions {
  k: number;
  types?: ItemType[];
  /** Keys to skip, e.g. events already in the recent-turns window. */
  exclude?: Set<string>;
  mode?: 'hybrid' | 'vector' | 'keyword';
  from?: number;
  to?: number;
}

const STOP = new Set(('a an and are as at be but by did do does for from had has have how i if in is it its ' +
  'me my of on or so that the their them then there these they this to was we were what when where which who ' +
  'why will with you your about can could would should just tell know remember said say').split(' '));

/** Turn free text into a safe FTS5 query: quoted terms OR-ed together (never a syntax error). */
export function ftsQuery(text: string): string | null {
  const terms = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
  const uniq = [...new Set(terms)].slice(0, 16);
  return uniq.length ? uniq.map((t) => `"${t}"`).join(' OR ') : null;
}

/** Reciprocal Rank Fusion: score = Σ 1/(k + rank). Robust to the two lists' incomparable scales. */
export function rrf(lists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists)
    list.forEach((key, rank) => scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1)));
  return scores;
}

export class Retriever {
  constructor(
    private db: SqlDb,
    private indexer: Indexer,
    private embedder: () => Embedder | null,
    private cfg: () => AuraConfig,
    private clock: Clock,
  ) {}

  async search(query: string, opts: SearchOptions): Promise<MemoryItem[]> {
    const types = opts.types ?? ['event', 'episode'];
    const mode = opts.mode ?? this.cfg().retrieval.mode;
    const timeFiltered = opts.from !== undefined || opts.to !== undefined;
    // Over-fetch so exclusions and time filters still leave k results.
    const fetchK = opts.k * (timeFiltered ? 8 : 3);
    const allowed = (t: ItemType, id: number) => types.includes(t) && !opts.exclude?.has(`${t}:${id}`);
    const assistantOk = this.cfg().retrieval.includeAssistant;

    const vecKeys: string[] = [];
    const cos = new Map<string, number>();
    const bestChunk = new Map<string, number>();
    const emb = this.embedder();
    if (mode !== 'keyword' && emb) {
      const [qv] = await emb.embed([query]);
      for (const h of await this.indexer.vectors.search(emb.id, qv!, fetchK, allowed)) {
        if (h.score < this.cfg().retrieval.minVectorScore) break; // sorted, so the rest are lower
        const key = `${h.itemType}:${h.itemId}`;
        vecKeys.push(key);
        cos.set(key, h.score);
        bestChunk.set(key, h.chunk);
      }
    }

    const kwKeys: string[] = [];
    const match = ftsQuery(query);
    if (mode !== 'vector' && match) {
      const rows = await this.db.all<{ item_type: string; item_id: number }>(
        'SELECT item_type, item_id FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT ?', [match, fetchK * 2]);
      for (const r of rows) if (allowed(r.item_type as ItemType, Number(r.item_id))) kwKeys.push(`${r.item_type}:${r.item_id}`);
    }

    let relevance: Map<string, number>;
    let via: string;
    if (mode === 'vector' || (mode === 'hybrid' && kwKeys.length === 0 && vecKeys.length > 0)) {
      relevance = cos;
      via = 'vector';
    } else if (mode === 'keyword' || vecKeys.length === 0) {
      relevance = new Map(kwKeys.map((k, i) => [k, 1 / (1 + i)]));
      via = 'keyword';
    } else {
      const fused = rrf([vecKeys, kwKeys], this.cfg().retrieval.rrfK);
      const max = Math.max(...fused.values());
      relevance = new Map([...fused].map(([k, s]) => [k, s / max]));
      via = 'hybrid';
    }

    const ranked = [...relevance].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    let items = await this.hydrate(ranked, via, relevance);
    if (!assistantOk) items = items.filter((m) => !(m.itemType === 'event' && m.role === 'assistant'));
    if (this.cfg().retrieval.snippets) for (const m of items) m.text = this.snippet(m.text, query, bestChunk.get(m.key));
    if (timeFiltered) items = items.filter((m) => m.ts >= (opts.from ?? -Infinity) && m.ts < (opts.to ?? Infinity));
    return items.slice(0, opts.k);
  }

  /**
   * The part of a long message that matched: the best vector chunk, or (keyword-only hits)
   * the chunk containing the most query terms. Short messages are returned whole.
   */
  snippet(text: string, query: string, chunk?: number): string {
    const chunks = chunkText(text, this.cfg().chunkTokens);
    if (chunks.length <= 1) return text;
    let i = chunk;
    if (i === undefined || !chunks[i]) {
      const terms = (ftsQuery(query) ?? '').replace(/"/g, '').split(' OR ').filter(Boolean);
      const score = (c: string) => terms.filter((t) => c.toLowerCase().includes(t)).length;
      i = chunks.reduce((best, c, j) => (score(c) > score(chunks[best]!) ? j : best), 0);
    }
    return `${i > 0 ? '… ' : ''}${chunks[i]}${i < chunks.length - 1 ? ' …' : ''}`;
  }

  /** Load display text + metadata for keys, preserving order. */
  async hydrate(keys: string[], via: string, relevance = new Map<string, number>()): Promise<MemoryItem[]> {
    const byType = new Map<string, number[]>();
    for (const k of keys) {
      const [t, id] = k.split(':');
      byType.set(t!, [...(byType.get(t!) ?? []), Number(id)]);
    }
    const found = new Map<string, MemoryItem>();
    const q = (n: number) => Array(n).fill('?').join(',');

    const evIds = byType.get('event') ?? [];
    if (evIds.length) {
      const rows = await this.db.all<{ id: number; session_id: number; ts: number; type: string; role: string; content: string; meta: string | null }>(
        `SELECT id, session_id, ts, type, role, content, meta FROM events WHERE type IN ('message', 'attachment') AND id IN (${q(evIds.length)})`, evIds);
      for (const r of rows) {
        const source = r.type === 'attachment' ? String(safeJson<{ name?: string }>(r.meta ?? '')?.name ?? 'file') : undefined;
        found.set(`event:${r.id}`, { key: `event:${r.id}`, itemType: 'event', itemId: r.id, sessionId: r.session_id,
          ts: r.ts, role: r.role as Role, source, text: r.content, relevance: relevance.get(`event:${r.id}`) ?? 0,
          importance: r.role === 'user' ? 0.6 : 0.4, score: 0, via });
      }
    }
    const epIds = byType.get('episode') ?? [];
    if (epIds.length) {
      const rows = await this.db.all<{ id: number; session_id: number; ts_end: number; summary: string; heat: number }>(
        `SELECT id, session_id, ts_end, summary, heat FROM episodes WHERE id IN (${q(epIds.length)})`, epIds);
      for (const r of rows)
        found.set(`episode:${r.id}`, { key: `episode:${r.id}`, itemType: 'episode', itemId: r.id, sessionId: r.session_id,
          ts: r.ts_end, text: r.summary, relevance: relevance.get(`episode:${r.id}`) ?? 0,
          importance: 0.5 + Math.min(0.5, r.heat / 10), score: 0, via });
    }
    const fIds = byType.get('fact') ?? [];
    if (fIds.length) {
      const rows = await this.db.all<{ id: number; subject: string; attribute: string; value: string; last_seen: number; is_current: number; heat: number; confidence: number }>(
        `SELECT * FROM facts WHERE id IN (${q(fIds.length)})`, fIds);
      for (const r of rows)
        found.set(`fact:${r.id}`, { key: `fact:${r.id}`, itemType: 'fact', itemId: r.id, ts: r.last_seen,
          text: factText(r) + (r.is_current ? '' : ' (outdated)'), relevance: relevance.get(`fact:${r.id}`) ?? 0,
          importance: r.confidence * (r.is_current ? 1 : 0.3), score: 0, via });
    }
    return keys.map((k) => found.get(k)).filter((m): m is MemoryItem => !!m);
  }

  /** Blend relevance with recency and importance (config weights). Baseline (b) skips this. */
  rerank(items: MemoryItem[]): MemoryItem[] {
    const { rerank, weights, recencyHalfLifeDays } = this.cfg().retrieval;
    const now = this.clock.now();
    for (const m of items) {
      if (!rerank) {
        m.score = m.relevance;
        continue;
      }
      const ageDays = Math.max(0, now - m.ts) / 86_400_000;
      const recency = Math.pow(0.5, ageDays / recencyHalfLifeDays);
      m.score = weights.relevance * m.relevance + weights.recency * recency + weights.importance * m.importance;
    }
    return items.sort((a, b) => b.score - a.score);
  }
}
