import type { Embedder, SqlDb } from '../types';
import { chunkText } from './chunker';
import { type ItemType, VectorIndex } from './vector';

/**
 * Keeps FTS5 and vectors in sync with searchable items. Runs on every append with
 * no LLM call (only the small embedder), so new messages are searchable instantly.
 */
export class Indexer {
  constructor(
    private db: SqlDb,
    readonly vectors: VectorIndex,
    private embedder: () => Embedder | null,
    private chunkTokens: number,
  ) {}

  /** Returns false if embedding failed (caller queues a retry); FTS is always updated. */
  async index(itemType: ItemType, itemId: number, text: string): Promise<boolean> {
    await this.db.run('DELETE FROM fts WHERE item_type = ? AND item_id = ?', [itemType, itemId]);
    await this.db.run('INSERT INTO fts(content, item_type, item_id) VALUES (?,?,?)', [text, itemType, itemId]);
    return this.embed(itemType, itemId, text);
  }

  /**
   * Bulk version for ingestion: one FTS insert per item, embeddings in batches across items
   * (one HTTP call per batch instead of per message). Returns ids whose embedding failed.
   */
  async indexMany(items: { itemType: ItemType; itemId: number; text: string }[], batchSize = 32): Promise<number[]> {
    for (const it of items) {
      await this.db.run('DELETE FROM fts WHERE item_type = ? AND item_id = ?', [it.itemType, it.itemId]);
      await this.db.run('INSERT INTO fts(content, item_type, item_id) VALUES (?,?,?)', [it.text, it.itemType, it.itemId]);
    }
    const emb = this.embedder();
    if (!emb) return [];
    const max = Math.min(this.chunkTokens, emb.maxTokens);
    const chunks = items.flatMap((it) => chunkText(it.text, max).map((text) => ({ it, text })));
    const vecs = new Map<(typeof items)[number], Float32Array[]>();
    const failed = new Set<number>();
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      try {
        const out = await emb.embed(batch.map((b) => b.text));
        batch.forEach((b, j) => vecs.set(b.it, [...(vecs.get(b.it) ?? []), out[j]!]));
      } catch {
        for (const b of batch) failed.add(b.it.itemId);
      }
    }
    for (const [it, v] of vecs) if (!failed.has(it.itemId)) await this.vectors.add(emb.id, it.itemType, it.itemId, v);
    return [...failed];
  }

  async embed(itemType: ItemType, itemId: number, text: string): Promise<boolean> {
    const emb = this.embedder();
    if (!emb) return true;
    const chunks = chunkText(text, Math.min(this.chunkTokens, emb.maxTokens));
    if (chunks.length === 0) return true;
    try {
      const vecs = await emb.embed(chunks);
      await this.vectors.add(emb.id, itemType, itemId, vecs);
      return true;
    } catch {
      return false;
    }
  }

  async remove(itemType: ItemType, itemIds: number[]): Promise<void> {
    if (itemIds.length === 0) return;
    const qs = itemIds.map(() => '?').join(',');
    await this.db.run(`DELETE FROM fts WHERE item_type = ? AND item_id IN (${qs})`, [itemType, ...itemIds]);
    await this.vectors.remove(itemType, itemIds);
  }

  /** Text that gets indexed for each item type — the single place that defines it. */
  async textOf(itemType: ItemType, itemId: number): Promise<string | undefined> {
    if (itemType === 'event')
      return (await this.db.get<{ content: string }>(`SELECT content FROM events WHERE id = ? AND type IN ('message', 'attachment')`, [itemId]))?.content;
    if (itemType === 'episode')
      return (await this.db.get<{ summary: string }>('SELECT summary FROM episodes WHERE id = ?', [itemId]))?.summary;
    const f = await this.db.get<{ subject: string; attribute: string; value: string }>(
      'SELECT subject, attribute, value FROM facts WHERE id = ?', [itemId]);
    return f && factText(f);
  }

  /**
   * Items with no vector from the current embedder (new embedder, or earlier failures).
   * Used by the resumable 'embed' job: it processes a batch and re-queues itself.
   */
  async missingVectors(limit: number): Promise<{ itemType: ItemType; itemId: number }[]> {
    const emb = this.embedder();
    if (!emb) return [];
    const rows = await this.db.all<{ item_type: string; item_id: number }>(
      `SELECT f.item_type, f.item_id FROM fts f
       WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.item_type = f.item_type
                         AND e.item_id = f.item_id AND e.embedder_id = ?)
       LIMIT ?`, [emb.id, limit]);
    return rows.map((r) => ({ itemType: r.item_type as ItemType, itemId: Number(r.item_id) }));
  }

  /** Drop vectors from embedders other than the current one. */
  async pruneOtherEmbedders(): Promise<void> {
    const emb = this.embedder();
    if (!emb) return;
    await this.db.run('DELETE FROM embeddings WHERE embedder_id <> ?', [emb.id]);
    this.vectors.invalidate();
  }
}

export const factText = (f: { subject: string; attribute: string; value: string }) =>
  `${f.subject} ${f.attribute.replace(/_/g, ' ')}: ${f.value}`;
