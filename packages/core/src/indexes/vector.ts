import type { SqlDb } from '../types';

export type ItemType = 'event' | 'episode' | 'fact';

export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function fromBlob(b: Uint8Array): Float32Array {
  // Copy: the driver's buffer may be unaligned or reused.
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

export function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

/** Dot product of two normalized vectors = cosine similarity. */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

interface Entry {
  itemType: ItemType;
  itemId: number;
  chunk: number;
  vec: Float32Array;
}

export interface VectorHit {
  itemType: ItemType;
  itemId: number;
  score: number;
  /** Index of the best-matching chunk (for snippets). */
  chunk: number;
}

/**
 * Brute-force cosine search over vectors cached in memory, per embedder.
 * 10K × 384 floats ≈ 15 MB and a scan takes a few ms — fine for the phone.
 */
export class VectorIndex {
  private cache = new Map<string, Entry[]>();

  constructor(private db: SqlDb) {}

  private async load(embedderId: string): Promise<Entry[]> {
    let entries = this.cache.get(embedderId);
    if (entries) return entries;
    const rows = await this.db.all<{ item_type: string; item_id: number; chunk: number; vector: Uint8Array }>(
      'SELECT item_type, item_id, chunk, vector FROM embeddings WHERE embedder_id = ?', [embedderId]);
    entries = rows.map((r) => ({ itemType: r.item_type as ItemType, itemId: r.item_id, chunk: r.chunk, vec: fromBlob(r.vector) }));
    this.cache.set(embedderId, entries);
    return entries;
  }

  /** One item's chunk vectors (normalized), indexed by chunk number. */
  async itemVectors(embedderId: string, itemType: ItemType, itemId: number): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const e of await this.load(embedderId)) if (e.itemType === itemType && e.itemId === itemId) out[e.chunk] = e.vec;
    return out;
  }

  async add(embedderId: string, itemType: ItemType, itemId: number, vectors: Float32Array[]): Promise<void> {
    const normed = vectors.map(normalize);
    await this.db.transaction(async () => {
      await this.db.run('DELETE FROM embeddings WHERE item_type = ? AND item_id = ? AND embedder_id = ?',
        [itemType, itemId, embedderId]);
      for (let i = 0; i < normed.length; i++)
        await this.db.run('INSERT INTO embeddings(item_type, item_id, chunk, embedder_id, vector) VALUES (?,?,?,?,?)',
          [itemType, itemId, i, embedderId, toBlob(normed[i]!)]);
    });
    const entries = this.cache.get(embedderId);
    if (entries) {
      const kept = entries.filter((e) => !(e.itemType === itemType && e.itemId === itemId));
      kept.push(...normed.map((vec, chunk) => ({ itemType, itemId, chunk, vec })));
      this.cache.set(embedderId, kept);
    }
  }

  async remove(itemType: ItemType, itemIds: number[]): Promise<void> {
    if (itemIds.length === 0) return;
    await this.db.run(`DELETE FROM embeddings WHERE item_type = ? AND item_id IN (${itemIds.map(() => '?').join(',')})`,
      [itemType, ...itemIds]);
    const gone = new Set(itemIds);
    for (const [k, entries] of this.cache)
      this.cache.set(k, entries.filter((e) => !(e.itemType === itemType && gone.has(e.itemId))));
  }

  invalidate(): void {
    this.cache.clear();
  }

  async has(embedderId: string, itemType: ItemType, itemId: number): Promise<boolean> {
    return (await this.load(embedderId)).some((e) => e.itemType === itemType && e.itemId === itemId);
  }

  /** Top-k items; an item's score is its best chunk's score. */
  async search(embedderId: string, query: Float32Array, k: number,
    filter?: (t: ItemType, id: number) => boolean): Promise<VectorHit[]> {
    const q = normalize(query);
    const best = new Map<string, VectorHit>();
    for (const e of await this.load(embedderId)) {
      if (filter && !filter(e.itemType, e.itemId)) continue;
      const score = dot(q, e.vec);
      const key = `${e.itemType}:${e.itemId}`;
      const prev = best.get(key);
      if (!prev || score > prev.score) best.set(key, { itemType: e.itemType, itemId: e.itemId, score, chunk: e.chunk });
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, k);
  }
}
