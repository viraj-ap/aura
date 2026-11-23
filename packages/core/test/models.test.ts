import { readFileSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assessFit, estimateMemory, roughShape } from '../src/models/fit';
import { NeedMoreBytes, modelShape, parseGgufHeader, readGgufHeader } from '../src/models/gguf';

/** Build a tiny synthetic GGUF header. */
function gguf(kvs: [string, 'u32' | 'str' | 'strarr', unknown][]): Uint8Array {
  const parts: number[] = [];
  const u32 = (n: number) => parts.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);
  const u64 = (n: number) => { u32(n); u32(0); };
  const str = (s: string) => { const b = [...new TextEncoder().encode(s)]; u64(b.length); parts.push(...b); };
  parts.push(...new TextEncoder().encode('GGUF')); u32(3); u64(0); u64(kvs.length);
  for (const [k, t, v] of kvs) {
    str(k);
    if (t === 'u32') { u32(4); u32(v as number); }
    else if (t === 'str') { u32(8); str(v as string); }
    else { u32(9); u32(8); u64((v as string[]).length); for (const s of v as string[]) str(s); }
  }
  return new Uint8Array(parts);
}

const qwenLike = gguf([
  ['general.architecture', 'str', 'qwen3'], ['general.name', 'str', 'Tiny Qwen ✓'],
  ['qwen3.context_length', 'u32', 40960], ['qwen3.block_count', 'u32', 28], ['qwen3.embedding_length', 'u32', 2048],
  ['qwen3.attention.head_count', 'u32', 16], ['qwen3.attention.head_count_kv', 'u32', 8], ['qwen3.attention.key_length', 'u32', 128],
  ['tokenizer.ggml.tokens', 'strarr', Array.from({ length: 200 }, (_, i) => `tok${i}`)],
]);

describe('GGUF header', () => {
  it('reads metadata and skips big arrays', () => {
    const h = parseGgufHeader(qwenLike);
    expect(h.version).toBe(3);
    expect(h.metadata['general.name']).toBe('Tiny Qwen ✓');
    expect(h.metadata['tokenizer.ggml.tokens']).toEqual({ skippedArray: 200 });
    const s = modelShape(h.metadata);
    expect(s).toMatchObject({ architecture: 'qwen3', blockCount: 28, headCountKv: 8, keyLength: 128, valueLength: 128, contextLength: 40960 });
  });
  it('asks for more bytes when truncated, and the reader grows the range', async () => {
    expect(() => parseGgufHeader(qwenLike.slice(0, 100))).toThrow(NeedMoreBytes);
    const reads: number[] = [];
    const h = await readGgufHeader(async (s, e) => { reads.push(e + 1); return qwenLike.slice(s, e + 1); }, { initial: 64 });
    expect(h.metadata['qwen3.block_count']).toBe(28);
    expect(reads.length).toBeGreaterThan(1);
  });
  it('rejects non-GGUF data', () => expect(() => parseGgufHeader(new Uint8Array(32))).toThrow(/not a GGUF/));

  const real = '../../models/Qwen3-1.7B-Q4_K_M.gguf';
  it.skipIf(!existsSync(real))('parses a real model file', () => {
    const fd = openSync(real, 'r');
    const buf = new Uint8Array(8 << 20);
    readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const s = modelShape(parseGgufHeader(buf).metadata);
    expect(s).toMatchObject({ architecture: 'qwen3', blockCount: 28, headCountKv: 8, keyLength: 128 });
  });
});

describe('device fit', () => {
  const shape = modelShape(parseGgufHeader(qwenLike).metadata);
  const GB = 1024 ** 3;
  const file = 1.03 * GB; // Qwen3-1.7B Q4_K_M

  it('matches the Phase 2 laptop measurement (2.09 GB at 8K ctx) within ~10%', () => {
    const e = estimateMemory(file, shape, 8192);
    expect(e.total / GB).toBeGreaterThan(2.0);
    expect(e.total / GB).toBeLessThan(2.4);
  });
  it('ok on an 8 GB phone, tight/smaller context on 4 GB, no on 2 GB', () => {
    const at = (gb: number) => assessFit(file, shape, { totalBytes: gb * GB, platform: 'android' }, { context: 4096 });
    expect(at(8).verdict).toBe('ok');
    const four = at(4);
    expect(four.verdict).not.toBe('ok');
    expect(four.maxSafeContext).toBeLessThan(4096);
    expect(at(2).verdict).toBe('no');
  });
  it('respects currently-free memory when the OS reports it', () => {
    const r = assessFit(file, shape, { totalBytes: 8 * GB, availableBytes: 1.2 * GB, platform: 'android' });
    expect(r.verdict).toBe('no');
  });
  it('rough shape is conservative', () => {
    const r = estimateMemory(file, roughShape(file), 4096);
    expect(r.kvCache).toBeGreaterThanOrEqual(estimateMemory(file, shape, 4096).kvCache);
  });
});
