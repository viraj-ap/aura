// npm run eval -- --configs a,b,c,oracle --per-type 10 --run iter1
// npm run eval -- --split dev --configs b,c --run dev-0.6b --prefix phase5-   (Phase 5: tune on dev, report test only)
// Needs llama-servers: chat (--llm), embedder (--embed), judge (--judge, or "none").
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { LlamaServerEmbedder, LlamaServerLLM } from '@aura/node';
import { CachedEmbedder, CachedLLM, EvalCache } from './cache';
import { resolveConfig } from './configs';
import { type Question, type Split, TYPES, load, split, subset } from './dataset';
import { Judge } from './judge';
import { markdown, summarize } from './report';
import { type RunRecord, runOne } from './runner';

const ROOT = join(import.meta.dirname, '../../..');

const { values: a } = parseArgs({
  options: {
    configs: { type: 'string', default: 'a,b,c,oracle' },
    // Without --split: the Phase 2 stratified subset (10 per type). With --split: the whole split unless --per-type is given.
    split: { type: 'string' },
    'per-type': { type: 'string' },
    prefix: { type: 'string', default: 'phase2-' },
    // The test split is for the final measurement only; this flag makes running it a deliberate act.
    'final-test': { type: 'boolean', default: false },
    types: { type: 'string', default: TYPES.join(',') },
    data: { type: 'string', default: join(ROOT, 'data/longmemeval/longmemeval_s_cleaned.json') },
    oracle: { type: 'string', default: join(ROOT, 'data/longmemeval/longmemeval_oracle.json') },
    llm: { type: 'string', default: 'http://127.0.0.1:8080' },
    embed: { type: 'string', default: 'http://127.0.0.1:8081' },
    judge: { type: 'string', default: 'http://127.0.0.1:8082' },
    ctx: { type: 'string', default: '8192' },
    run: { type: 'string', default: new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') },
    cache: { type: 'string', default: join(ROOT, '.cache/eval.db') },
    'cache-answers': { type: 'boolean', default: false },
    'no-judge': { type: 'boolean', default: false },
  },
});

const configs = a.configs!.split(',').map(resolveConfig);

const cache = new EvalCache(a.cache!);
const llm = new CachedLLM(await LlamaServerLLM.connect(a.llm), cache, a['cache-answers']);
const embedder = new CachedEmbedder(await LlamaServerEmbedder.connect(a.embed), cache);
const judge = a['no-judge'] ? null : new Judge(await LlamaServerLLM.connect(a.judge), cache);

console.log(`loading ${a.data} …`);
const types = a.types!.split(',');
if (a.split && !['dev', 'test', 'all'].includes(a.split)) throw new Error('--split must be dev, test or all');
if ((a.split === 'test' || a.split === 'all') && !a['final-test'])
  throw new Error(`--split ${a.split} includes held-out test questions: tune on --split dev; pass --final-test only for the final measurement`);
const perType = a['per-type'] ? Number(a['per-type']) : a.split ? Infinity : 10;
const pool = a.split ? split(load(a.data!), a.split as Split, types) : load(a.data!);
const questions = subset(pool, perType, types);
const qDesc = a.split
  ? `${questions.length} (LongMemEval_s **${a.split}** split${a['per-type'] ? `, ${perType} per type` : ''})`
  : `${questions.length} (LongMemEval_s, ${perType} per type, stratified by hashed id)`;
const oracle = configs.some((c) => c.oracle) ? new Map(load(a.oracle!).map((q) => [q.question_id, q])) : new Map<string, Question>();

mkdirSync(join(ROOT, 'results/raw'), { recursive: true });
const rawPath = join(ROOT, `results/raw/${a.run}.jsonl`);
const records: RunRecord[] = existsSync(rawPath)
  ? readFileSync(rawPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunRecord)
  : [];
const done = new Set(records.filter((r) => !r.error).map((r) => `${r.qid}|${r.config}`));

console.log(`run ${a.run}: ${questions.length} questions × ${configs.length} configs · model ${llm.id} · embedder ${embedder.id} · judge ${judge?.id ?? 'none'} · ctx ${a.ctx}`);
const total = questions.length * configs.length;
let i = 0;
const t0 = Date.now();
for (const q of questions) {
  for (const cfg of configs) {
    i++;
    if (done.has(`${q.question_id}|${cfg.name}`)) continue;
    const src = cfg.oracle ? oracle.get(q.question_id) : q;
    if (!src) continue;
    let rec: RunRecord;
    try {
      rec = await runOne(src, cfg, { llm, embedder, judge, cache, ctx: Number(a.ctx), llmUrl: a.llm! });
    } catch (e) {
      rec = { qid: q.question_id, type: q.question_type, config: cfg.name, error: String(e instanceof Error ? e.stack : e) } as RunRecord;
    }
    records.push(rec);
    appendFileSync(rawPath, JSON.stringify(rec) + '\n');
    const eta = ((Date.now() - t0) / i) * (total - i) / 60000;
    console.log(`[${i}/${total}] ${cfg.name.padEnd(10)} ${q.question_type.padEnd(26)} ${rec.error ? 'ERROR ' + rec.error.split('\n')[0] : `${rec.correct === null ? '?' : rec.correct ? '✓' : '✗'} ev ${rec.evidenceSessionsInPrompt}/${rec.evidenceSessions} · ${rec.promptTokens} tok · ${rec.latencyMs} ms`} · cache ${cache.hits}/${cache.hits + cache.misses} · eta ${eta.toFixed(0)}m`);
  }
}

const names = configs.map((c) => c.name);
const md = markdown(records, names, {
  run: a.run!, date: new Date().toISOString().slice(0, 10), questions: qDesc,
  model: llm.id, embedder: embedder.id, judge: judge?.id ?? 'none', 'prompt budget': `${a.ctx} tokens ctx − 256 output reserve`,
});
writeFileSync(join(ROOT, `results/${a.prefix}${a.run}.md`), `# Eval run ${a.run}\n\n${md}\n`);
console.log('\n' + md);
console.log(`\nwrote results/${a.prefix}${a.run}.md`);
void summarize;
process.exit(0);
