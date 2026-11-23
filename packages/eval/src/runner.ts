import { execFileSync } from 'node:child_process';
import { Aura, type Embedder, type LLM, ManualClock } from '@aura/core';
import { openSqlite } from '@aura/node';
import type { EvalCache } from './cache';
import type { EvalConfig } from './configs';
import { type Question, history, isAbstention, parseDate } from './dataset';
import type { Judge } from './judge';

export interface RunRecord {
  qid: string;
  type: string;
  abstention: boolean;
  config: string;
  model: string;
  embedder: string;
  judge: string;
  question: string;
  answer: string;
  response: string;
  correct: boolean | null;
  /** Evidence that made it into the final prompt (works for every config, incl. truncation). */
  evidenceSessions: number;
  evidenceSessionsInPrompt: number;
  evidenceTurns: number;
  evidenceTurnsInPrompt: number;
  /** Session-level recall of the retriever's ranked list before budgeting (null for thread configs). */
  recallAny: number | null;
  recallAll: number | null;
  retrievalMethod: string;
  scrollValid: boolean | null;
  promptTokens: number;
  budget: number;
  memories: number;
  droppedTurns: number;
  ttftMs: number;
  genMs: number;
  latencyMs: number;
  ingestMs: number;
  peakServerRssMb: number | null;
  engineRssMb: number;
  error?: string;
}

export interface RunnerDeps {
  llm: LLM;
  embedder: Embedder;
  judge: Judge | null;
  cache: EvalCache;
  /** Prompt budget in tokens (phone-realistic context), independent of the server's -c. */
  ctx: number;
  /** URL of the chat server, to sample its RSS. */
  llmUrl: string;
}

/** Ingest one question's history the way the app would see it, then ask the question. */
export async function runOne(q: Question, cfg: EvalConfig, deps: RunnerDeps): Promise<RunRecord> {
  const sessions = history(q);
  const qts = parseDate(q.question_date);
  const clock = new ManualClock(sessions[0]?.ts ?? qts);
  const db = openSqlite(':memory:');
  const aura = await Aura.open({
    db, llm: deps.llm, embedder: deps.embedder, clock,
    config: { ...cfg.aura, ramSafeTokens: deps.ctx },
  });
  try {
    // ---- ingest (timestamps replayed from the benchmark)
    const t0 = performance.now();
    const evidence = new Map<number, { session: string; hasAnswer: boolean }>(); // eventId → labels
    const order: number[] = []; // thread layout: event ids in chat order
    const sessionOf = new Map<number, string>(); // aura session id → haystack id
    let threadId = 0;
    if (cfg.layout === 'thread') threadId = (await aura.sessions.create('history', sessions[0]?.ts ?? qts)).id;
    for (const hs of sessions) {
      const sid = cfg.layout === 'thread' ? threadId : (await aura.sessions.create(`haystack ${hs.haystackId}`, hs.ts)).id;
      sessionOf.set(sid, hs.haystackId);
      clock.set(hs.ts);
      const evs = await aura.ingestSession(sid, hs.turns.map((t) => ({ role: t.role, content: t.content, ts: t.ts })));
      evs.forEach((e, i) => {
        evidence.set(e.id, { session: hs.haystackId, hasAnswer: !!hs.turns[i]!.has_answer });
        order.push(e.id);
      });
    }
    if (cfg.llmIngest) await aura.runBackground();
    if (cfg.forceScroll) await aura.db.run('UPDATE models SET probe_passed = 1');
    else if (cfg.aura.layers?.scrollLite) await ensureProbe(aura, deps);
    const ingestMs = performance.now() - t0;

    // ---- ask
    clock.set(qts);
    const sid = cfg.layout === 'thread' ? threadId : (await aura.sessions.create('question', qts)).id;
    const sampler = new RssSampler(deps.llmUrl);
    const t1 = performance.now();
    const r = await aura.send(sid, q.question, { ts: qts });
    const latencyMs = performance.now() - t1;
    const peakServerRssMb = sampler.stop();

    // ---- evidence in prompt
    const inPrompt = new Set<number>();
    const keys = new Set(r.debug.assembled.memoryKeys);
    for (const k of keys) if (k.startsWith('event:')) inPrompt.add(Number(k.slice(6)));
    if (cfg.layout === 'thread') order.slice(r.debug.assembled.droppedTurns).forEach((id) => inPrompt.add(id));
    const episodeSessions = new Set<string>();
    for (const k of keys) {
      if (!k.startsWith('episode:')) continue;
      const row = await aura.db.get<{ session_id: number }>('SELECT session_id FROM episodes WHERE id = ?', [Number(k.slice(8))]);
      if (row) episodeSessions.add(sessionOf.get(row.session_id)!);
    }
    const evTurns = [...evidence].filter(([, v]) => v.hasAnswer).map(([id]) => id);
    const evSessions = new Set(q.answer_session_ids);
    // Session level (any turn or the summary of an evidence session), comparable to recall@k.
    const sessionHit = (s: string) => episodeSessions.has(s) || [...evidence].some(([id, v]) => v.session === s && inPrompt.has(id));

    // ---- retrieval recall (ranked list, session level)
    let recallAny: number | null = null;
    let recallAll: number | null = null;
    if (cfg.layout === 'sessions' && evSessions.size && !isAbstention(q)) {
      const got = new Set<string>();
      for (const m of r.debug.retrieval.items) {
        if (m.itemType === 'event') got.add(evidence.get(m.itemId)?.session ?? '');
        if (m.itemType === 'episode' && m.sessionId) got.add(sessionOf.get(m.sessionId) ?? '');
      }
      const hit = [...evSessions].filter((s) => got.has(s)).length;
      recallAny = hit > 0 ? 1 : 0;
      recallAll = hit / evSessions.size;
    }

    const correct = deps.judge ? await deps.judge.judge(q, r.reply) : null;
    const g = r.debug.generation;
    return {
      qid: q.question_id, type: q.question_type, abstention: isAbstention(q), config: cfg.name,
      model: deps.llm.id, embedder: deps.embedder.id, judge: deps.judge?.id ?? '',
      question: q.question, answer: String(q.answer), response: r.reply, correct,
      evidenceSessions: evSessions.size,
      evidenceSessionsInPrompt: [...evSessions].filter(sessionHit).length,
      evidenceTurns: evTurns.length,
      evidenceTurnsInPrompt: evTurns.filter((id) => inPrompt.has(id)).length,
      recallAny, recallAll,
      retrievalMethod: r.debug.retrieval.method,
      scrollValid: r.debug.scroll ? r.debug.scroll.ok : null,
      promptTokens: r.debug.assembled.promptTokens,
      budget: r.debug.assembled.budget,
      memories: r.debug.assembled.memoryKeys.length,
      droppedTurns: r.debug.assembled.droppedTurns,
      ttftMs: g.ttftMs, genMs: g.totalMs, latencyMs: Math.round(latencyMs), ingestMs: Math.round(ingestMs),
      peakServerRssMb, engineRssMb: Math.round(process.memoryUsage().rss / 1e6),
    };
  } finally {
    db.close();
  }
}

/** Probe once per model and remember the result in the eval cache. */
async function ensureProbe(aura: Aura, deps: RunnerDeps): Promise<void> {
  let passed = deps.cache.getJson<boolean>('probe', deps.llm.id);
  if (passed === undefined) {
    passed = (await aura.runProbe()).passed;
    deps.cache.putJson('probe', deps.llm.id, passed);
  }
  await aura.db.run('UPDATE models SET probe_passed = ? WHERE id = ?', [passed ? 1 : 0, deps.llm.id]);
}

/** Polls the llama-server process RSS (macOS/Linux `ps`) while a question runs. */
class RssSampler {
  private peak = 0;
  private timer: NodeJS.Timeout | null = null;
  private static pidCache = new Map<string, number | null>();

  constructor(url: string) {
    const pid = RssSampler.pid(url);
    if (!pid) return;
    const sample = () => {
      try {
        const kb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim());
        if (kb > this.peak) this.peak = kb;
      } catch { /* process gone */ }
    };
    sample();
    this.timer = setInterval(sample, 200);
  }

  stop(): number | null {
    if (!this.timer) return null;
    clearInterval(this.timer);
    return Math.round(this.peak / 1024);
  }

  private static pid(url: string): number | null {
    if (RssSampler.pidCache.has(url)) return RssSampler.pidCache.get(url)!;
    let pid: number | null = null;
    try {
      const port = new URL(url).port;
      pid = Number(execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']).toString().trim().split('\n')[0]) || null;
    } catch { /* lsof missing */ }
    RssSampler.pidCache.set(url, pid);
    return pid;
  }
}
