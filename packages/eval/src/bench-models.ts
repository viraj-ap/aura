// Model-size benchmark that runs in the background, with no terminal (or Claude) attached.
//
//   npm run bench-models -- start qwen3-1.7b qwen3-4b llama3.2-3b qwen3-8b   download (if needed) + eval each, detached
//   npm run bench-models -- start                     same, with the default list below
//   npm run bench-models -- start qwen3-4b --configs c,c/snip
//   npm run bench-models -- download qwen3-4b …       just fetch the files (the only step that needs internet)
//   npm run bench-models -- summary                   rebuild results/phase5-dev-models.md (all models side by side)
//   npm run bench-models -- status                    one progress bar per model
//   npm run bench-models -- watch                     same, refreshed every 2 s (Ctrl+C leaves the run going)
//   npm run bench-models -- stop                      stops the worker and the servers it started; `start` resumes later
//
// Each model gets its own llama-server (same flags as the 0.6B/1.7B runs) and its own run file
// results/raw/dev-<model>.jsonl, so results land next to the Phase 5 baselines and resume after a stop.
// Runs never overlap with another eval: the worker waits until no other `src/cli.ts` is running,
// because two models sharing the GPU would corrupt each other's TTFT numbers.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { markdown, summarize } from './report';
import type { RunRecord } from './runner';

const ROOT = join(import.meta.dirname, '../../..');
const DIR = join(ROOT, '.cache/bench');
const STATE = join(DIR, 'state.json');
const LOG = join(DIR, 'worker.log');

/** The biggest models in the app's catalog, plus Qwen3-8B as a desktop-only reference (needs a 16 GB phone). */
const MODELS: Record<string, { repo: string; file: string; note?: string }> = {
  'qwen3-4b': { repo: 'unsloth/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf' },
  'llama3.2-3b': { repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF', file: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf' },
  'qwen3-8b': { repo: 'unsloth/Qwen3-8B-GGUF', file: 'Qwen3-8B-Q4_K_M.gguf', note: 'same model as the judge: self-judging bias possible' },
  'qwen3-1.7b': { repo: 'unsloth/Qwen3-1.7B-GGUF', file: 'Qwen3-1.7B-Q4_K_M.gguf' },
  'qwen3-0.6b': { repo: 'unsloth/Qwen3-0.6B-GGUF', file: 'Qwen3-0.6B-Q4_K_M.gguf' },
  'llama3.2-1b': { repo: 'bartowski/Llama-3.2-1B-Instruct-GGUF', file: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf' },
  'gemma3-1b': { repo: 'unsloth/gemma-3-1b-it-GGUF', file: 'gemma-3-1b-it-Q4_K_M.gguf' },
};

const PORTS = { model: 8094, embed: 8091, judge: 8092 };
// The Part A baselines were run by hand under these names; reuse them so those runs resume instead of restarting.
const RUN_NAMES: Record<string, string> = { 'qwen3-0.6b': '0.6b', 'qwen3-1.7b': '1.7b' };
const DEFAULT_MODELS = 'qwen3-1.7b,qwen3-4b,llama3.2-3b,qwen3-8b';

interface ModelState {
  key: string;
  phase: 'queued' | 'downloading' | 'waiting' | 'starting' | 'running' | 'done' | 'failed';
  bytes?: number;
  totalBytes?: number;
  done: number;
  total: number;
  correct: number;
  judged: number;
  errors: number;
  startedAt?: number;
  etaMin?: number;
  message?: string;
  run: string;
}
interface State { pid: number; startedAt: number; split: string; configs: string; models: ModelState[]; finishedAt?: number; serverPids: number[] }

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    models: { type: 'string' },
    configs: { type: 'string', default: 'b,c,c/snip,d,oracle' },
    split: { type: 'string', default: 'dev' },
  },
});
const cmd = positionals[0] ?? 'status';
// Models can be given as plain arguments (`start qwen3-4b qwen3-8b`) or with --models.
const modelList = positionals.slice(1).length ? positionals.slice(1).join(',') : a.models ?? DEFAULT_MODELS;

const readState = (): State | null => (existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')) as State) : null);
const writeState = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 2));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const up = async (port: number) => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ commands

if (cmd === 'start') {
  mkdirSync(DIR, { recursive: true });
  const prev = readState();
  if (prev && !prev.finishedAt && alive(prev.pid)) {
    console.log(`already running (pid ${prev.pid}). \`npm run bench-models -- status\` to see progress.`);
    process.exit(0);
  }
  if (a.split !== 'dev') throw new Error('the background benchmark only runs the dev split; test is for the final measurement');
  for (const m of modelList.split(',')) if (!MODELS[m]) throw new Error(`unknown model ${m}; known: ${Object.keys(MODELS).join(', ')}`);
  const log = openSync(LOG, 'a');
  // caffeinate -i keeps the Mac from idle-sleeping until the worker exits (overnight runs).
  const child = spawn('caffeinate', ['-i', 'npx', 'tsx', join(import.meta.dirname, 'bench-models.ts'), 'worker', '--models', modelList, '--configs', a.configs!, '--split', a.split!],
    { cwd: join(ROOT, 'packages/eval'), detached: true, stdio: ['ignore', log, log] });
  child.unref();
  closeSync(log);
  console.log(`started in the background (pid ${child.pid}): ${modelList.split(',').join(' → ')}. Log: .cache/bench/worker.log`);
  console.log('Progress: npm run bench-models -- status   (or `watch`)   ·   stop: npm run bench-models -- stop');
  process.exit(0);
}

if (cmd === 'status' || cmd === 'watch') {
  const show = () => {
    const s = readState();
    if (!s) return 'nothing started yet: npm run bench-models -- start';
    const running = !s.finishedAt && alive(s.pid);
    const lines = [`bench-models · split ${s.split} · configs ${s.configs} · ${s.finishedAt ? `finished ${new Date(s.finishedAt).toLocaleString()}` : running ? `running (pid ${s.pid})` : 'stopped (start again to resume)'}`, ''];
    for (const m of s.models) lines.push(row(m));
    const sum = summaryTable(s.models.map((m) => m.key));
    if (sum) lines.push('', sum);
    lines.push('', 'Per model: results/phase5-<run>.md · all models: results/phase5-dev-models.md');
    return lines.join('\n');
  };
  if (cmd === 'status') {
    console.log(show());
    process.exit(0);
  }
  for (;;) {
    process.stdout.write('\x1b[2J\x1b[H' + show() + '\n\n(Ctrl+C to leave; the run keeps going)\n');
    await sleep(2000);
  }
}

if (cmd === 'stop') {
  const s = readState();
  if (!s) { console.log('nothing to stop'); process.exit(0); }
  // `start` detaches the worker into its own process group; the eval child and the servers it
  // started are in that group too, so one signal to the group stops everything.
  if (alive(s.pid)) {
    const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(s.pid)]).toString().trim());
    try { process.kill(-pgid, 'SIGTERM'); } catch { process.kill(s.pid, 'SIGTERM'); }
  }
  for (const pid of s.serverPids) if (alive(pid)) process.kill(pid, 'SIGTERM');
  console.log('stopped. `npm run bench-models -- start` resumes where it left off.');
  process.exit(0);
}

if (cmd === 'summary') {
  const keys = positionals.length > 1 ? modelList.split(',') : readState()?.models.map((m) => m.key) ?? modelList.split(',');
  writeSummary(keys);
  console.log(summaryTable(keys) || 'no finished rows yet');
  process.exit(0);
}

if (cmd === 'download') {
  // Fetch the model files now (needs internet) so `start` can later run fully offline.
  for (const key of modelList.split(',')) {
    const spec = MODELS[key];
    if (!spec) throw new Error(`unknown model ${key}; known: ${Object.keys(MODELS).join(', ')}`);
    await download(spec.repo, spec.file, (b, t) => process.stdout.write(`\r${key.padEnd(12)} ${bar(b / t)} ${(100 * b / t).toFixed(0).padStart(3)}%  ${(b / 1e9).toFixed(2)}/${(t / 1e9).toFixed(2)} GB`));
    process.stdout.write(`\r${key.padEnd(12)} ${bar(1)} done${' '.repeat(20)}\n`);
  }
  process.exit(0);
}

if (cmd === 'worker') await worker();

// ------------------------------------------------------------------ summary across models

function runName(key: string) { return `${a.split}-${RUN_NAMES[key] ?? key}`; }

function loadRun(key: string): RunRecord[] {
  const raw = join(ROOT, `results/raw/${runName(key)}.jsonl`);
  return existsSync(raw) ? readFileSync(raw, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunRecord) : [];
}

/** Accuracy per model × config (n in brackets while a run is incomplete). */
function summaryTable(keys: string[]): string {
  const configs = a.configs!.split(',');
  const rows = keys.map((k) => {
    const S = summarize(loadRun(k), configs);
    if (!S.some((x) => x.n)) return null;
    return `| ${k} | ${S.map((x) => (x.n ? `${(100 * x.accuracy).toFixed(1)}%${x.n < 151 ? ` (${x.n})` : ''}` : '–')).join(' | ')} |`;
  }).filter(Boolean);
  if (!rows.length) return '';
  return [`Accuracy on the ${a.split} split (151 questions; (n) = still running)`, '',
    `| Model | ${configs.join(' | ')} |`, `|---|${configs.map(() => '---').join('|')}|`, ...rows].join('\n');
}

function writeSummary(keys: string[]) {
  const configs = a.configs!.split(',');
  const parts = [`# Model sizes on the ${a.split} split`, '', summaryTable(keys), ''];
  for (const k of keys) {
    const rs = loadRun(k);
    if (!rs.length) continue;
    const r0 = rs.find((r) => !r.error);
    parts.push(`## ${k}`, '', markdown(rs, configs, { model: r0?.model ?? k, judge: r0?.judge ?? '', run: runName(k) }), '');
  }
  if (keys.includes('qwen3-8b')) parts.push('Note: Qwen3-8B is also the judge, so its scores may carry self-preference bias.', '');
  writeFileSync(join(ROOT, `results/phase5-${a.split}-models.md`), parts.join('\n'));
}

// ------------------------------------------------------------------ progress bar

function bar(frac: number, width = 28) {
  const n = Math.round(Math.max(0, Math.min(1, frac)) * width);
  return '█'.repeat(n) + '░'.repeat(width - n);
}

function row(m: ModelState): string {
  const name = m.key.padEnd(12);
  if (m.phase === 'downloading' && m.totalBytes) {
    const f = (m.bytes ?? 0) / m.totalBytes;
    return `${name} download ${bar(f)} ${(100 * f).toFixed(0).padStart(3)}%  ${((m.bytes ?? 0) / 1e9).toFixed(2)}/${(m.totalBytes / 1e9).toFixed(2)} GB`;
  }
  const f = m.total ? m.done / m.total : 0;
  const acc = m.judged ? `  acc so far ${((100 * m.correct) / m.judged).toFixed(1)}%` : '';
  const eta = m.phase === 'running' && m.etaMin !== undefined ? `  eta ${m.etaMin}m` : '';
  const err = m.errors ? `  ${m.errors} errors` : '';
  const tag = { queued: 'queued  ', downloading: 'download', waiting: 'waiting ', starting: 'starting', running: 'eval    ', done: 'done ✓  ', failed: 'FAILED  ' }[m.phase];
  return `${name} ${tag} ${bar(f)} ${String(m.done).padStart(4)}/${m.total || '?'}${eta}${acc}${err}${m.message ? `  (${m.message})` : ''}`;
}

// ------------------------------------------------------------------ worker

async function worker() {
  const keys = modelList.split(',');
  const state: State = {
    pid: process.pid, startedAt: Date.now(), split: a.split!, configs: a.configs!, serverPids: [],
    models: keys.map((key) => ({ key, phase: 'queued', done: 0, total: 0, correct: 0, judged: 0, errors: 0, run: runName(key) })),
  };
  const save = () => writeState(state);
  save();
  const started: ChildProcess[] = [];
  const cleanup = () => { for (const p of started) { try { p.kill(); } catch { /* gone */ } } };
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('exit', cleanup);

  // Download everything first: it doesn't touch the GPU, so it can overlap another eval.
  for (const m of state.models) {
    const spec = MODELS[m.key]!;
    m.phase = 'downloading';
    save();
    try {
      await download(spec.repo, spec.file, (bytes, total) => { m.bytes = bytes; m.totalBytes = total; save(); });
      m.phase = 'queued';
    } catch (e) {
      m.phase = 'failed';
      m.message = `download: ${String(e)}`;
    }
    save();
  }

  // Shared servers: reuse the ones already up (same flags as Phase 2/5), start the rest.
  const serve = (args: string[]) => {
    const p = spawn('llama-server', args, { cwd: ROOT, stdio: 'ignore' });
    started.push(p);
    state.serverPids.push(p.pid!);
    save();
    return p;
  };
  if (!(await up(PORTS.embed))) serve(['-m', 'models/bge-small-en-v1.5-q8_0.gguf', '--port', String(PORTS.embed), '--embedding', '--pooling', 'cls', '-c', '2048', '-np', '4', '-ub', '512', '-b', '2048']);
  if (!(await up(PORTS.judge))) serve(['-m', 'models/Qwen3-8B-Q4_K_M.gguf', '--port', String(PORTS.judge), '-c', '4096', '-np', '1', '--jinja']);

  for (const m of state.models) {
    if (m.phase === 'failed') continue;
    const spec = MODELS[m.key]!;
    m.phase = 'waiting';
    save();
    while (otherEvalRunning()) { m.message = 'another eval is using the machine'; save(); await sleep(15_000); }
    m.message = undefined;

    m.phase = 'starting';
    save();
    const server = serve(['-m', `models/${spec.file}`, '--port', String(PORTS.model), '-c', '8192', '-np', '1', '--jinja']);
    for (let i = 0; i < 300 && !(await up(PORTS.model)); i++) await sleep(1000);
    for (let i = 0; i < 300 && !((await up(PORTS.embed)) && (await up(PORTS.judge))); i++) await sleep(1000);
    if (!(await up(PORTS.model))) { m.phase = 'failed'; m.message = 'llama-server did not start'; save(); server.kill(); continue; }

    m.phase = 'running';
    m.startedAt = Date.now();
    m.message = spec.note;
    save();
    const code = await runEval(m, save);
    server.kill();
    await sleep(2000); // let the port free up before the next model
    m.phase = code === 0 ? 'done' : 'failed';
    if (code !== 0) m.message = `eval exited ${code}; see .cache/bench/worker.log`;
    save();
    writeSummary(keys);
  }
  state.finishedAt = Date.now();
  save();
  cleanup();
  process.exit(0);
}

function runEval(m: ModelState, save: () => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'src/cli.ts', '--split', a.split!, '--configs', a.configs!, '--run', m.run, '--prefix', 'phase5-',
      '--llm', `http://127.0.0.1:${PORTS.model}`, '--embed', `http://127.0.0.1:${PORTS.embed}`, '--judge', `http://127.0.0.1:${PORTS.judge}`],
    { cwd: join(ROOT, 'packages/eval'), stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let firstDone = -1;
    const onData = (d: Buffer) => {
      process.stdout.write(d);
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        // "[i/total] config type ✓ ev …" — one line per question × config (resumed ones are skipped silently).
        const p = line.match(/^\[(\d+)\/(\d+)\]/);
        if (!p) continue;
        m.done = Number(p[1]);
        m.total = Number(p[2]);
        if (firstDone < 0) firstDone = m.done - 1;
        if (/ERROR/.test(line)) m.errors++;
        else if (/ ✓ /.test(line)) { m.correct++; m.judged++; }
        else if (/ ✗ /.test(line)) m.judged++;
        // ETA from this session's pace only (resumed rows were free).
        const pace = (Date.now() - m.startedAt!) / Math.max(1, m.done - firstDone);
        m.etaMin = Math.round((pace * (m.total - m.done)) / 60_000);
        save();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d: Buffer) => process.stdout.write(d));
    child.on('exit', (code) => {
      // Resumed runs only print new rows; count the finished file so the bar ends at 100%.
      const raw = join(ROOT, `results/raw/${m.run}.jsonl`);
      if (existsSync(raw)) {
        const rs = readFileSync(raw, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { correct: boolean | null; error?: string });
        const ok = rs.filter((r) => !r.error);
        m.done = Math.max(m.done, ok.length);
        m.judged = ok.filter((r) => r.correct !== null).length;
        m.correct = ok.filter((r) => r.correct).length;
      }
      resolve(code ?? 1);
    });
  });
}

/** Another eval process (e.g. the Phase 5 baselines) that isn't ours. */
function otherEvalRunning(): boolean {
  try {
    const out = execFileSync('pgrep', ['-f', 'tsx src/cli.ts']).toString().trim().split('\n').filter(Boolean).map(Number);
    return out.some((pid) => pid !== process.pid);
  } catch {
    return false; // pgrep exits 1 when nothing matches
  }
}

/** Resumable download into models/ (a .part file, then renamed), same as the app's manager. */
async function download(repo: string, file: string, onProgress: (bytes: number, total: number) => void): Promise<void> {
  const dest = join(ROOT, 'models', file);
  if (existsSync(dest)) {
    const n = statSync(dest).size;
    onProgress(n, n);
    return;
  }
  mkdirSync(join(ROOT, 'models'), { recursive: true });
  const part = `${dest}.part`;
  for (let attempt = 1; ; attempt++) {
    const have = existsSync(part) ? statSync(part).size : 0;
    try {
      const res = await fetch(`https://huggingface.co/${repo}/resolve/main/${file}`, { headers: have ? { range: `bytes=${have}-` } : {} });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const resumed = res.status === 206;
      const total = (resumed ? have : 0) + Number(res.headers.get('content-length') ?? 0);
      const out = createWriteStream(part, { flags: resumed ? 'a' : 'w' });
      let bytes = resumed ? have : 0;
      let last = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
        bytes += chunk.length;
        if (Date.now() - last > 1000) { onProgress(bytes, total); last = Date.now(); }
      }
      await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
      // Sanity check: right size and a GGUF header.
      const fd = openSync(part, 'r');
      const magic = Buffer.alloc(4);
      readSync(fd, magic, 0, 4, 0);
      closeSync(fd);
      if (magic.toString('ascii') !== 'GGUF' || (total && statSync(part).size !== total)) throw new Error('incomplete or not a GGUF file');
      renameSync(part, dest);
      onProgress(total, total);
      return;
    } catch (e) {
      if (attempt >= 8) throw e;
      await sleep(5000 * attempt); // flaky connections: retry and resume
    }
  }
}
