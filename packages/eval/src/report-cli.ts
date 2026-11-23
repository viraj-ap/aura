// Rebuild a run's markdown from its raw JSONL:  npm run report -- --run main-0.6b
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { markdown } from './report';
import type { RunRecord } from './runner';

const ROOT = join(import.meta.dirname, '../../..');
const { values: a } = parseArgs({ options: { run: { type: 'string' }, configs: { type: 'string' }, prefix: { type: 'string', default: 'phase2-' } } });
const records = readFileSync(join(ROOT, `results/raw/${a.run}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunRecord);
const configs = a.configs?.split(',') ?? [...new Set(records.map((r) => r.config))];
const r0 = records.find((r) => !r.error)!;
const md = markdown(records, configs, {
  run: a.run!, questions: `${new Set(records.map((r) => r.qid)).size} (LongMemEval_s, stratified by type)`,
  model: r0.model, embedder: r0.embedder, judge: r0.judge || 'none', 'prompt budget': `${r0.budget} tokens`,
});
writeFileSync(join(ROOT, `results/${a.prefix}${a.run}.md`), `# Eval run ${a.run}\n\n${md}\n`);
console.log(md);
