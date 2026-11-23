import type { Embedder } from '../types';

/**
 * Deterministic, model-free embedder (feature hashing of words + character trigrams).
 * Used by unit tests and as a last-resort fallback when no embedding model is loaded.
 * It only captures lexical overlap — real semantic search needs a real embedder.
 */
export class HashEmbedder implements Embedder {
  readonly id: string;
  readonly maxTokens = 512;

  constructor(private dim = 256) {
    this.id = `hash-${dim}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.one(t));
  }

  private one(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const w of words) {
      v[fnv(w) % this.dim]! += 1;
      const padded = ` ${w} `;
      for (let i = 0; i + 3 <= padded.length; i++) v[fnv(padded.slice(i, i + 3)) % this.dim]! += 0.3;
    }
    return v;
  }
}

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
