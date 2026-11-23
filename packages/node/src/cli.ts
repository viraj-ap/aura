#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { Aura, type Embedder, HashEmbedder, type TurnDebug, formatMemory, formatTs } from '@aura/core';
import { LlamaServerEmbedder, LlamaServerLLM } from './llamaServer';
import { openSqlite } from './sqlite';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

const HELP = `
${c.bold('Chat')}       just type · Ctrl+C while generating = stop · Ctrl+C at the prompt = quit
${c.bold('Debug')}      /debug            toggle the debug panel after every reply
           /prompt           print the exact prompt last sent to the model
${c.bold('Sessions')}   /new · /sessions · /open <id> · /history
${c.bold('Feedback')}   /up [comment] · /down [comment]   (rates the last reply → playbook)
${c.bold('Memory')}     /memory <query>   search memory like the engine does
           /facts · /playbook · /rule add <text> · /rule edit <id> <text> · /rule rm <id>
           /forget event <id> · /forget fact <id> [--sources] · /forget session <id> · /forget all --yes
${c.bold('Engine')}     /jobs · /bg (run background jobs now) · /probe (Scroll-lite capability probe)
           /config · /set <path> <json>   e.g. /set layers.scrollLite true
           /model            reconnect after restarting llama-server with another model
           /quit
`;

async function main() {
  const { values: args } = parseArgs({
    options: {
      db: { type: 'string', default: join(homedir(), '.aura', 'aura.db') },
      llm: { type: 'string', default: 'http://127.0.0.1:8080' },
      embed: { type: 'string', default: 'http://127.0.0.1:8081' },
      'ctx-limit': { type: 'string' },
      scroll: { type: 'boolean', default: false },
      thinking: { type: 'boolean', default: false },
      debug: { type: 'boolean', default: false },
    },
  });

  let llm: LlamaServerLLM;
  try {
    llm = await LlamaServerLLM.connect(args.llm);
  } catch (e) {
    console.error(c.red(`Can't reach llama-server at ${args.llm}.`));
    console.error(`Start one, e.g.:\n  llama-server -m models/Qwen3-0.6B-Q4_K_M.gguf --port 8080 -c 8192 --jinja`);
    process.exit(1);
  }
  let embedder: Embedder;
  try {
    embedder = await LlamaServerEmbedder.connect(args.embed);
  } catch {
    console.error(c.yellow(`No embedding server at ${args.embed} — using the lexical hash embedder (keyword-like vectors).`));
    console.error(c.dim(`  For real semantic search: llama-server -m models/bge-small-en-v1.5-q8_0.gguf --port 8081 --embedding --pooling cls -c 512 -ub 512`));
    embedder = new HashEmbedder();
  }

  mkdirSync(dirname(args.db!), { recursive: true });
  const db = openSqlite(args.db!);
  const aura = await Aura.open({
    db, llm, embedder,
    config: {
      ramSafeTokens: args['ctx-limit'] ? Number(args['ctx-limit']) : undefined,
      thinking: args.thinking,
      layers: { scrollLite: args.scroll },
    },
  });

  let session = (await aura.sessions.list(1))[0] ?? (await aura.sessions.create());
  let debugPanel = args.debug!;
  let lastReplyId: number | null = null;
  let generating: AbortController | null = null;
  let idleTimer: NodeJS.Timeout | null = null;

  console.log(c.bold('AURA') + c.dim(` · model ${llm.id} (ctx ${llm.contextLength}) · embedder ${embedder.id} · ${args.db}`));
  console.log(c.dim(`chat #${session.id} "${session.title}" · ${await aura.log.count()} events in memory · /help for commands`));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: c.cyan('you › ') });
  let closed = false;
  rl.on('close', () => (closed = true));
  rl.on('SIGINT', () => (generating ? generating.abort() : rl.close()));
  const prompt = () => !closed && rl.prompt();

  // Background jobs run only while the user is idle, and stop the moment they type.
  const scheduleBackground = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      const n = await aura.jobs.pendingCount();
      if (n === 0) return;
      await aura.runBackground();
    }, 1500);
  };
  process.stdin.on('keypress', () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (aura.jobs.isRunning) void aura.jobs.pause();
  });

  // Async iteration buffers input lines, so piped scripts work as well as a TTY.
  prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (line === '/quit' || line === '/exit') break;
    if (!line) {
      prompt();
      continue;
    }
    if (line.startsWith('/')) {
      try {
        await command(line);
      } catch (e) {
        console.log(c.red(String(e instanceof Error ? e.message : e)));
      }
      scheduleBackground();
      prompt();
      continue;
    }

    generating = new AbortController();
    process.stdout.write(c.bold('aura › '));
    try {
      const r = await aura.send(session.id, line, {
        signal: generating.signal,
        onStatus: (s) => {
          if (s === 'searching memory' || s === 'compressing') process.stdout.write(c.dim(`[${s}…] `));
        },
        onToken: (t) => process.stdout.write(t),
      });
      lastReplyId = r.assistantEvent.id;
      process.stdout.write('\n');
      footer(r.debug, r.assistantEvent.id);
      if (debugPanel) printDebug(r.debug);
    } catch (e) {
      console.log(c.red(`\nerror: ${e instanceof Error ? e.message : e}`));
    } finally {
      generating = null;
    }
    scheduleBackground();
    prompt();
  }

  if (idleTimer) clearTimeout(idleTimer);
  await aura.jobs.pause();
  db.close();
  console.log(c.dim('bye'));
  process.exit(0);

  function footer(d: TurnDebug, id: number) {
    const a = d.assembled;
    const g = d.generation;
    const tps = g.completionTokens && g.totalMs > g.ttftMs ? ((g.completionTokens - 1) / ((g.totalMs - g.ttftMs) / 1000)).toFixed(0) : '–';
    const parts = [
      `${a.promptTokens}/${a.budget} tok`,
      `cached ${g.cachedTokens}`,
      `${d.retrieval.method}${d.retrieval.items.length ? `: ${a.memoryKeys.length} mem` : ''}`,
      a.factIds.length ? `${a.factIds.length} facts` : '',
      a.ruleIds.length ? `${a.ruleIds.length} rules` : '',
      d.compaction?.compacted ? c.yellow(`compacted ${d.compaction.foldedEvents} turns`) : '',
      a.droppedTurns ? c.yellow(`${a.droppedTurns} turns truncated`) : '',
      `ttft ${g.ttftMs}ms`,
      `${tps} tok/s`,
      g.stopReason !== 'eos' ? c.yellow(g.stopReason) : '',
      `#${id}`,
    ].filter(Boolean);
    console.log(c.dim(`  ↳ ${parts.join(' · ')}`));
  }

  function printDebug(d: TurnDebug) {
    const a = d.assembled;
    console.log(c.dim('┌─ debug ─────────────────────────────────────────────'));
    console.log(c.dim(`│ route: ${d.route.retrieve ? 'retrieve' : 'skip'} (${d.route.reason}) · retrieval: ${d.retrieval.method} in ${d.retrieval.ms}ms`));
    for (const [name, s] of Object.entries(a.sections))
      console.log(c.dim(`│ ${name.padEnd(9)} ${String(s.used).padStart(5)} / ${String(s.budget).padEnd(5)} tok · ${s.items} item(s)`));
    console.log(c.dim(`│ prompt   ${a.promptTokens} / ${a.budget} tok (exact, rendered with the model's template)`));
    if (d.compaction) console.log(c.dim(`│ compaction: ${d.compaction.compacted ? `folded ${d.compaction.foldedEvents} turns, ${d.compaction.beforeTokens}→${d.compaction.afterTokens} tok` : `not needed (${d.compaction.beforeTokens} tok)`}${d.compaction.error ? ' · error: ' + d.compaction.error : ''}`));
    if (d.scroll) for (const t of d.scroll.trace)
      console.log(c.dim(`│ scroll round ${t.round} (${t.ms}ms): ${t.raw.replace(/\s+/g, ' ').slice(0, 140)} → ${t.ops ? `${t.results} results` : 'INVALID'}`));
    const used = new Set(a.memoryKeys);
    for (const m of d.retrieval.items.slice(0, 10))
      console.log(c.dim(`│ ${used.has(m.key) ? '✓' : ' '} ${m.score.toFixed(3)} ${m.via.padEnd(14)} ${formatMemory(m).replace(/\s+/g, ' ').slice(0, 110)}`));
    console.log(c.dim(`│ gen: ${d.generation.promptTokens} prompt (${d.generation.cachedTokens} from KV cache) · ${d.generation.completionTokens} out · ttft ${d.generation.ttftMs}ms · ${d.generation.totalMs}ms`));
    console.log(c.dim('└─ /prompt shows the full prompt ──────────────────────'));
  }

  async function command(line: string) {
    const [cmd, ...rest] = line.split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case '/help': console.log(HELP); break;
      case '/debug':
        debugPanel = !debugPanel;
        console.log(`debug panel ${debugPanel ? 'on' : 'off'}`);
        if (debugPanel && aura.lastDebug) printDebug(aura.lastDebug);
        break;
      case '/prompt':
        console.log(aura.lastDebug ? aura.lastDebug.assembled.prompt : 'no prompt yet');
        break;
      case '/new':
        session = await aura.sessions.create();
        console.log(c.dim(`new chat #${session.id}`));
        break;
      case '/sessions':
        for (const s of await aura.sessions.list(20))
          console.log(`${s.id === session.id ? '*' : ' '} #${String(s.id).padEnd(4)} ${formatTs(s.updatedAt)}  ${s.title}`);
        break;
      case '/open': {
        const s = await aura.sessions.get(Number(arg));
        if (!s) throw new Error(`no chat #${arg}`);
        session = s;
        console.log(c.dim(`opened chat #${s.id} "${s.title}"`));
        break;
      }
      case '/history':
        for (const e of await aura.log.listSession(session.id))
          console.log(`${c.dim(`#${e.id} ${formatTs(e.ts)}`)} ${e.role === 'user' ? c.cyan('you') : c.bold('aura')}: ${e.content}`);
        break;
      case '/up': case '/down':
        if (!lastReplyId) throw new Error('no reply to rate yet');
        await aura.feedback(lastReplyId, cmd === '/up' ? 'up' : 'down', arg);
        console.log(c.dim('feedback saved · reflection queued for when you are idle'));
        break;
      case '/memory': {
        const items = aura.retriever.rerank(await aura.retriever.search(arg, { k: 8, types: ['event', 'episode', 'fact'] }));
        if (!items.length) console.log(c.dim('nothing found'));
        for (const m of items) console.log(`${m.score.toFixed(3)} ${c.dim(m.via)} ${formatMemory(m)}`);
        break;
      }
      case '/facts': {
        const facts = await aura.facts.list();
        if (!facts.length) console.log(c.dim('no facts yet (they are extracted in the background while you are idle)'));
        for (const f of facts)
          console.log(`${f.isCurrent ? ' ' : c.dim('×')} [${f.id}] ${f.subject} · ${f.attribute} = ${c.bold(f.value)} ${c.dim(`conf ${f.confidence} · seen ${formatTs(f.lastSeen, false)} · from #${f.sourceEventIds.join(',#')}`)}`);
        break;
      }
      case '/playbook': {
        const rules = await aura.playbook.list();
        if (!rules.length) console.log(c.dim('no rules yet — rate replies with /up or /down'));
        for (const r of rules) console.log(`[${r.id}] ${r.rule} ${c.dim(`+${r.helpful} −${r.harmful}`)}`);
        break;
      }
      case '/rule': {
        const [sub, id, ...text] = rest;
        if (sub === 'add') console.log(`added rule ${await aura.playbook.add([id, ...text].join(' '))}`);
        else if (sub === 'edit') console.log((await aura.playbook.update(Number(id), text.join(' '))) ? 'updated' : 'no such rule');
        else if (sub === 'rm') console.log((await aura.playbook.remove(Number(id))) ? 'removed' : 'no such rule');
        else throw new Error('usage: /rule add <text> | /rule edit <id> <text> | /rule rm <id>');
        break;
      }
      case '/forget': {
        const [what, id, flag] = rest;
        if (what === 'all') {
          if (id !== '--yes') return void console.log(c.red('This deletes ALL memory. Run "/forget all --yes" to confirm.'));
          await aura.forget.all();
          session = await aura.sessions.create();
          console.log('all memory deleted');
        } else if (what === 'event') console.log(await aura.forget.events([Number(id)]));
        else if (what === 'fact') console.log((await aura.forget.fact(Number(id), flag === '--sources')) ?? 'no such fact');
        else if (what === 'session') {
          console.log(await aura.forget.session(Number(id)));
          if (Number(id) === session.id) session = await aura.sessions.create();
        } else throw new Error('usage: /forget event|fact|session <id> | /forget all');
        break;
      }
      case '/jobs': {
        const jobs = await aura.jobs.list(15);
        if (!jobs.length) console.log(c.dim('queue empty'));
        for (const j of jobs) console.log(`#${j.id} ${j.type.padEnd(8)} ${j.status.padEnd(8)} attempts ${j.attempts}${j.error ? c.red(' ' + j.error.slice(0, 80)) : ''}`);
        break;
      }
      case '/bg': {
        const t = Date.now();
        console.log(c.dim(`running ${await aura.jobs.pendingCount()} job(s)…`));
        await aura.runBackground();
        console.log(c.dim(`done in ${Date.now() - t}ms · ${await aura.jobs.pendingCount()} pending`));
        break;
      }
      case '/probe': {
        console.log(c.dim('probing whether this model can plan memory operations…'));
        const r = await aura.runProbe();
        for (const d of r.details) console.log(c.dim(d));
        console.log(r.passed ? c.green('probe passed — Scroll-lite will be used when enabled (/set layers.scrollLite true)') : c.yellow('probe failed — hybrid search fallback will be used'));
        break;
      }
      case '/config': console.log(JSON.stringify(aura.config, null, 2)); break;
      case '/set': {
        const [path, ...v] = rest;
        if (!path) throw new Error('usage: /set <path> <json>');
        const value = JSON.parse(v.join(' '));
        const patch: Record<string, unknown> = {};
        let cur = patch;
        const keys = path.split('.');
        keys.slice(0, -1).forEach((k) => (cur = (cur[k] = {}) as Record<string, unknown>));
        cur[keys.at(-1)!] = value;
        aura.setConfig(patch);
        console.log(`${path} = ${JSON.stringify(value)}`);
        break;
      }
      case '/model': {
        llm = await LlamaServerLLM.connect(args.llm);
        await aura.setLLM(llm);
        console.log(c.dim(`model ${llm.id} (ctx ${llm.contextLength}) · memory kept`));
        break;
      }
      default: throw new Error(`unknown command ${cmd} — /help`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
