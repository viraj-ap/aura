// Can this model run on a phone?  npm run fit -- models/Qwen3-1.7B-Q4_K_M.gguf [--ctx 4096]
// or straight from Hugging Face (reads only the header via HTTP Range, no download):
//   npm run fit -- https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { assessFit, formatBytes, modelShape, readGgufHeader } from '@aura/core';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { ctx: { type: 'string', default: '4096' } } });
const arg = positionals[0];
if (!arg) throw new Error('usage: npm run fit -- <file.gguf | https://…gguf> [--ctx N]');
// npm runs workspace scripts from the package dir; resolve local paths against where you typed the command.
const src = /^https?:/.test(arg) ? arg : resolve(process.env.INIT_CWD ?? process.cwd(), arg);

let size: number;
let read: (s: number, e: number) => Promise<Uint8Array>;
if (/^https?:/.test(src)) {
  const head = await fetch(src, { method: 'HEAD', redirect: 'follow' });
  size = Number(head.headers.get('x-linked-size') ?? head.headers.get('content-length'));
  read = async (s, e) => new Uint8Array(await (await fetch(src, { headers: { Range: `bytes=${s}-${e}` } })).arrayBuffer());
} else {
  size = statSync(src).size;
  read = async (s, e) => {
    const fd = openSync(src, 'r');
    const buf = new Uint8Array(Math.min(e + 1, size) - s);
    readSync(fd, buf, 0, buf.length, s);
    closeSync(fd);
    return buf;
  };
}
const shape = modelShape((await readGgufHeader(read)).metadata);
console.log(`${shape.name ?? src} · ${shape.architecture} · ${formatBytes(size)} · ${shape.blockCount} layers · ${shape.headCountKv} KV heads × ${shape.keyLength} · max ctx ${shape.contextLength}`);
const icon = { ok: '✅ runs well', tight: '⚠️  tight', no: '⛔ will not run safely' } as const;
for (const gb of [3, 4, 6, 8, 12, 16]) {
  const r = assessFit(size, shape, { totalBytes: gb * 1024 ** 3, platform: 'android' }, { context: Number(values.ctx) });
  console.log(`${String(gb).padStart(2)} GB phone: ${icon[r.verdict].padEnd(22)} needs ${formatBytes(r.estimate.total)} of ${formatBytes(r.usableBytes)} usable · safe ctx ${r.maxSafeContext || '—'}`);
}
