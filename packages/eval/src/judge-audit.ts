// Judge audit (Phase 5, Part A.2): how often does the fixed 8B judge agree with a human?
//   npm run judge-audit -- --export --runs main-0.6b,main-1.7b,wide-0.6b   → results/judge-audit.md (a checklist to hand-label)
//   npm run judge-audit -- --score                                           → agreement + Cohen's kappa from your labels
// Sampling is seeded, so re-exporting gives the same 50 rows. The score is only computed from rows you labeled.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { wilson } from './report';
import type { RunRecord } from './runner';

const ROOT = join(import.meta.dirname, '../../..');
const { values: a } = parseArgs({
  options: {
    export: { type: 'boolean', default: false },
    score: { type: 'boolean', default: false },
    runs: { type: 'string', default: 'main-0.6b,main-1.7b,wide-0.6b' },
    n: { type: 'string', default: '50' },
    seed: { type: 'string', default: 'phase5-judge-audit' },
    file: { type: 'string', default: join(ROOT, 'results/judge-audit.md') },
    // Put the judge's verdicts in a key at the end instead of next to each row, so they can't anchor your label.
    blind: { type: 'boolean', default: false },
  },
});

const quote = (s: string) => s.trim().split('\n').map((l) => `> ${l}`).join('\n');
const LABEL = /\*\*Your label:\*\*.*/;

if (a.export) {
  if (existsSync(a.file!) && /\[[xX]\]/.test(readFileSync(a.file!, 'utf8')))
    throw new Error(`${a.file} already has labels; refusing to overwrite`);
  const seen = new Set<string>();
  const pool: RunRecord[] = [];
  for (const run of a.runs!.split(',')) {
    for (const line of readFileSync(join(ROOT, `results/raw/${run}.jsonl`), 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line) as RunRecord;
      const key = `${r.qid}|${r.response}`; // same answer judged twice counts once
      if (r.error || r.correct === null || seen.has(key)) continue;
      seen.add(key);
      pool.push(r);
    }
  }
  // Seeded random order: sort by hash(seed, qid, config, model).
  const h = (r: RunRecord) => createHash('sha1').update(`${a.seed}|${r.qid}|${r.config}|${r.model}`).digest('hex');
  const rows = pool.sort((x, y) => (h(x) < h(y) ? -1 : 1)).slice(0, Number(a.n));

  const out: string[] = [
    '# Judge audit',
    '',
    `${rows.length} rows sampled at random (seed \`${a.seed}\`) from ${pool.length} judged answers in runs ${a.runs!.split(',').map((r) => `\`${r}\``).join(', ')}.`,
    'Judge: Qwen3-8B Q4_K_M with LongMemEval\'s per-type prompts (yes = the response contains the gold answer).',
    '',
    '**How to label:** for each row put an `x` in exactly one box: `correct`, `wrong`, or `unsure` (unsure rows are left out of the score).',
    'Use the same rule as the judge: correct if the response contains the gold answer (or, for preference questions, satisfies the rubric;',
    'for abstention questions, correctly says it can\'t be answered). Off-by-one day counts are fine on temporal questions.',
    'Then run `npm run judge-audit -- --score`.',
    '',
  ];
  rows.forEach((r, i) => {
    out.push(
      '---', '',
      `## ${i + 1}. \`${r.qid}\` · ${r.type}${r.abstention ? ' (abstention)' : ''} · config ${r.config} · ${r.model}`, '',
      `**Question:** ${r.question}`, '',
      `**Gold answer:** ${r.answer}`, '',
      '**Model answer:**', '', quote(r.response || '(empty)'), '',
      ...(a.blind ? [] : [`**Judge verdict:** ${r.correct ? 'yes (correct)' : 'no (wrong)'}`, '']),
      '**Your label:** [ ] correct · [ ] wrong · [ ] unsure', '',
    );
  });
  if (a.blind) {
    out.push('---', '', '## Judge verdicts (look after labeling)', '', '| # | qid | Judge |', '|---|---|---|');
    rows.forEach((r, i) => out.push(`| ${i + 1} | \`${r.qid}\` | ${r.correct ? 'yes' : 'no'} |`));
  }
  writeFileSync(a.file!, out.join('\n') + '\n');
  console.log(`wrote ${a.file} (${rows.length} rows; judge said yes on ${rows.filter((r) => r.correct).length})`);
}

if (a.score) {
  const text = readFileSync(a.file!, 'utf8');
  const blocks = text.split(/^---$/m);
  const verdictKey = new Map<number, boolean>();
  for (const m of text.matchAll(/^\| (\d+) \| `[^`]+` \| (yes|no) \|$/gm)) verdictKey.set(Number(m[1]), m[2] === 'yes');
  type Row = { i: number; type: string; judge: boolean; human: boolean | 'unsure' | null };
  const rows: Row[] = [];
  for (const b of blocks) {
    const head = b.match(/^## (\d+)\. `[^`]+` · ([a-z-]+)/m);
    if (!head) continue;
    const i = Number(head[1]);
    const v = b.match(/\*\*Judge verdict:\*\* (yes|no)/);
    const judge = v ? v[1] === 'yes' : verdictKey.get(i);
    if (judge === undefined) continue;
    const label = b.match(LABEL)?.[0] ?? '';
    const ticked = [...label.matchAll(/\[[xX]\]\s*(correct|wrong|unsure)/g)].map((m) => m[1]);
    const human = ticked.length !== 1 ? null : ticked[0] === 'unsure' ? 'unsure' : ticked[0] === 'correct';
    rows.push({ i, type: head[2]!, judge, human });
  }
  const labeled = rows.filter((r): r is Row & { human: boolean } => typeof r.human === 'boolean');
  const unlabeled = rows.filter((r) => r.human === null).map((r) => r.i);
  const unsure = rows.filter((r) => r.human === 'unsure').length;
  if (!labeled.length) {
    console.log(`No labels yet in ${a.file} (${rows.length} rows). Tick one box per row, then re-run.`);
    process.exit(0);
  }
  const agree = labeled.filter((r) => r.judge === r.human).length;
  const n = labeled.length;
  const tp = labeled.filter((r) => r.judge && r.human).length; // both yes
  const fp = labeled.filter((r) => r.judge && !r.human).length; // judge too lenient
  const fn = labeled.filter((r) => !r.judge && r.human).length; // judge too strict
  const tn = n - tp - fp - fn;
  const po = agree / n;
  const pe = ((tp + fp) / n) * ((tp + fn) / n) + ((tn + fn) / n) * ((tn + fp) / n);
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);
  const [lo, hi] = wilson(agree, n);
  const judgeAcc = (tp + fp) / n, humanAcc = (tp + fn) / n;
  const lines = [
    `Labeled ${n} of ${rows.length} rows (${unsure} unsure, ${unlabeled.length} unlabeled${unlabeled.length ? `: ${unlabeled.join(', ')}` : ''}).`,
    '',
    `- **Agreement:** ${agree}/${n} = ${(100 * po).toFixed(1)}% (95% CI ${(100 * lo).toFixed(1)}–${(100 * hi).toFixed(1)})`,
    `- **Cohen's kappa:** ${kappa.toFixed(2)}`,
    `- Judge says correct on ${(100 * judgeAcc).toFixed(1)}%, you on ${(100 * humanAcc).toFixed(1)}% → judge bias ${(100 * (judgeAcc - humanAcc)).toFixed(1)} points`,
    `- Judge too lenient (yes, you: wrong): ${fp} · too strict (no, you: correct): ${fn}`,
    '',
    '| Type | n | Agree |', '|---|---|---|',
    ...[...new Set(labeled.map((r) => r.type))].sort().map((t) => {
      const rs = labeled.filter((r) => r.type === t);
      return `| ${t} | ${rs.length} | ${rs.filter((r) => r.judge === r.human).length}/${rs.length} |`;
    }),
    '',
    `Disagreements: ${labeled.filter((r) => r.judge !== r.human).map((r) => `#${r.i}`).join(', ') || 'none'}`,
  ];
  console.log(lines.join('\n'));
  writeFileSync(join(ROOT, 'results/judge-audit-score.md'), `# Judge audit score\n\n${lines.join('\n')}\n`);
  console.log('\nwrote results/judge-audit-score.md');
}

if (!a.export && !a.score) console.log('pass --export or --score');
