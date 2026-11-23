// Retrieval-only sweep: recall@k from LongMemEval's evidence labels, no LLM needed.
// This is the cheap tuning loop — every variant runs on the same ingested history.
//   npm run recall -- --n 100 --variants b,hybrid,c,c-user
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Aura, type AuraConfig, type DeepPartial, ManualClock, defaultConfig, mergeConfig } from '@aura/core';
import { LlamaServerEmbedder, openSqlite } from '@aura/node';
import { CachedEmbedder, EvalCache } from './cache';
import { TYPES, history, isAbstention, load, parseDate, subset } from './dataset';

const ROOT = join(import.meta.dirname, '../../..');

/** Retrieval variants. `chunkTokens` changes ingestion, so variants are grouped by it. */
export const VARIANTS: Record<string, DeepPartial<AuraConfig>> = {
  b: { retrieval: { mode: 'vector', rerank: false } },
  keyword: { retrieval: { mode: 'keyword', rerank: false } },
  hybrid: { retrieval: { mode: 'hybrid', rerank: false } },
  c: { retrieval: { mode: 'hybrid', rerank: true } },
  'c-norecency': { retrieval: { mode: 'hybrid', rerank: true, weights: { relevance: 0.9, recency: 0, importance: 0.1 } } },
  'c-user': { retrieval: { mode: 'hybrid', rerank: true, includeAssistant: false } },
  'b-user': { retrieval: { mode: 'vector', rerank: false, includeAssistant: false } },
  'c-chunk128': { chunkTokens: 128, retrieval: { mode: 'hybrid', rerank: true } },
  'b-chunk128': { chunkTokens: 128, retrieval: { mode: 'vector', rerank: false } },
};

const { values: a } = parseArgs({
  options: {
    n: { type: 'string', default: '0' }, // per type; 0 = all
    variants: { type: 'string', default: 'b,keyword,hybrid,c,c-norecency,c-user' },
    k: { type: 'string', default: '5,10,20' },
    embed: { type: 'string', default: 'http://127.0.0.1:8081' },
    data: { type: 'string', default: join(ROOT, 'data/longmemeval/longmemeval_s_cleaned.json') },
    cache: { type: 'string', default: join(ROOT, '.cache/eval.db') },
    out: { type: 'string' },
  },
});

const ks = a.k!.split(',').map(Number);
const maxK = Math.max(...ks);
const names = a.variants!.split(',');
for (const v of names) if (!VARIANTS[v]) throw new Error(`unknown variant ${v}`);
const groups = new Map<number, string[]>();
for (const v of names) {
  const ct = (VARIANTS[v]!.chunkTokens as number | undefined) ?? 256;
  groups.set(ct, [...(groups.get(ct) ?? []), v]);
}

const cache = new EvalCache(a.cache!);
const embedder = new CachedEmbedder(await LlamaServerEmbedder.connect(a.embed), cache);
const stub = { id: 'none', contextLength: 8192, countTokens: async (t: string) => Math.ceil(t.length / 4),
  applyTemplate: async () => '', complete: async () => { throw new Error('no LLM in recall runs'); } };

const all = load(a.data!).filter((q) => !isAbstention(q));
const questions = Number(a.n) ? subset(all, Number(a.n)) : all;
console.log(`${questions.length} questions · variants ${names.join(', ')} · k ${ks.join(',')} · embedder ${embedder.id}`);

// stats[variant][k] = { any, all, turn } sums, plus per type
type Acc = { any: number; all: number; turn: number; n: number };
const stats = new Map<string, Map<string, Acc>>(); // variant → "k|type" → acc
const add = (v: string, key: string, any: number, allv: number, turn: number) => {
  const m = stats.get(v) ?? new Map<string, Acc>();
  stats.set(v, m);
  const acc = m.get(key) ?? { any: 0, all: 0, turn: 0, n: 0 };
  acc.any += any; acc.all += allv; acc.turn += turn; acc.n++;
  m.set(key, acc);
};

const t0 = Date.now();
let qi = 0;
for (const q of questions) {
  qi++;
  const sessions = history(q);
  const evidenceSessions = new Set(q.answer_session_ids);
  for (const [chunkTokens, variants] of groups) {
    const clock = new ManualClock(sessions[0]!.ts);
    const db = openSqlite(':memory:');
    const aura = await Aura.open({ db, llm: stub, embedder, clock,
      config: { chunkTokens, layers: { facts: false, episodic: false } } });
    const sessionOf = new Map<number, string>();
    const evidenceTurns = new Set<number>();
    for (const hs of sessions) {
      const sid = (await aura.sessions.create(hs.haystackId, hs.ts)).id;
      const evs = await aura.ingestSession(sid, hs.turns.map((t) => ({ role: t.role, content: t.content, ts: t.ts })));
      evs.forEach((e, i) => {
        sessionOf.set(e.id, hs.haystackId);
        if (hs.turns[i]!.has_answer) evidenceTurns.add(e.id);
      });
    }
    clock.set(parseDate(q.question_date));
    for (const v of variants) {
      // Fresh from defaults each time: setConfig merges, so variants would leak into each other.
      aura.config = mergeConfig(mergeConfig(defaultConfig, VARIANTS[v]!), { layers: { facts: false, episodic: false } });
      const items = await aura.retrieve(q.question, maxK);
      for (const k of ks) {
        const top = items.slice(0, k).filter((m) => m.itemType === 'event');
        const got = new Set(top.map((m) => sessionOf.get(m.itemId)));
        const hit = [...evidenceSessions].filter((s) => got.has(s)).length;
        const turnHit = evidenceTurns.size ? top.filter((m) => evidenceTurns.has(m.itemId)).length / evidenceTurns.size : NaN;
        for (const key of [`${k}|all`, `${k}|${q.question_type}`])
          add(v, key, hit > 0 ? 1 : 0, hit / evidenceSessions.size, Number.isNaN(turnHit) ? 0 : turnHit);
      }
    }
    db.close();
  }
  if (qi % 10 === 0 || qi === questions.length)
    console.log(`  ${qi}/${questions.length} · ${((Date.now() - t0) / 1000).toFixed(0)}s · embed cache ${cache.hits}/${cache.hits + cache.misses}`);
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const lines = [`Retrieval recall on ${questions.length} LongMemEval_s questions (abstention excluded) · embedder ${embedder.id}`, ''];
lines.push(`| Variant | ${ks.map((k) => `R_all@${k} (session)`).join(' | ')} | ${ks.map((k) => `R_any@${k}`).join(' | ')} | ${ks.map((k) => `Turn R@${k}`).join(' | ')} |`);
lines.push(`|---|${ks.map(() => '---').join('|')}|${ks.map(() => '---').join('|')}|${ks.map(() => '---').join('|')}|`);
for (const v of names) {
  const m = stats.get(v)!;
  const g = (k: number, f: keyof Acc) => pct(m.get(`${k}|all`)![f] / m.get(`${k}|all`)!.n);
  lines.push(`| ${v} | ${ks.map((k) => g(k, 'all')).join(' | ')} | ${ks.map((k) => g(k, 'any')).join(' | ')} | ${ks.map((k) => g(k, 'turn')).join(' | ')} |`);
}
const k10 = ks.includes(10) ? 10 : ks[0]!;
lines.push('', `**R_all@${k10} by question type**`, '', `| Type | ${names.join(' | ')} |`, `|---|${names.map(() => '---').join('|')}|`);
for (const t of TYPES) {
  const row = names.map((v) => {
    const acc = stats.get(v)!.get(`${k10}|${t}`);
    return acc ? pct(acc.all / acc.n) : '–';
  });
  lines.push(`| ${t} | ${row.join(' | ')} |`);
}
const md = lines.join('\n');
console.log('\n' + md);
if (a.out) writeFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), a.out), md + '\n');
process.exit(0);
