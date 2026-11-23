import type { AuraConfig } from '../config';
import type { Facts } from '../indexes/facts';
import type { EventLog } from '../log/eventLog';
import type { Clock, LLM, SqlDb } from '../types';
import { GBNF_COMMON, kv } from '../util/gbnf';
import { stripReasoning, formatDate, formatTs, oneLine, safeJson, truncateChars } from '../util/text';
import { type MemoryItem, type Retriever, ftsQuery } from './retriever';

export type Op =
  | { op: 'search'; query: string }
  | { op: 'keyword'; terms: string }
  | { op: 'filter_by_time'; from: string; to: string; query?: string }
  | { op: 'get_session'; id: number }
  | { op: 'get_event'; id: number }
  | { op: 'get_facts'; subject?: string }
  | { op: 'count'; query: string };

/**
 * A fixed set of operations emitted as grammar-constrained JSON instead of free
 * code. A 0.6B model can't write reliable Python, but under this grammar every
 * output is at least a well-formed plan — the open question is whether it's a *good* one.
 */
export function opsGrammar(maxOps: number): string {
  const lit = (s: string) => String.raw`"\"${s}\""`;
  const head = (name: string) => `"{" ws ${kv('op', lit(name))}`;
  return String.raw`
root ::= "{" ws ${kv('ops', String.raw`"[" ws ( op ( ws "," ws op ){0,${maxOps - 1}} )? ws "]"`)} ws "}"
op ::= search | keyword | time | session | event | facts | count
search ::= ${head('search')} ws "," ws ${kv('query', 'str')} ws "}"
keyword ::= ${head('keyword')} ws "," ws ${kv('terms', 'str')} ws "}"
time ::= ${head('filter_by_time')} ws "," ws ${kv('from', 'date')} ws "," ws ${kv('to', 'date')} ( ws "," ws ${kv('query', 'str')} )? ws "}"
session ::= ${head('get_session')} ws "," ws ${kv('id', 'num')} ws "}"
event ::= ${head('get_event')} ws "," ws ${kv('id', 'num')} ws "}"
facts ::= ${head('get_facts')} ( ws "," ws ${kv('subject', 'shortstr')} )? ws "}"
count ::= ${head('count')} ws "," ws ${kv('query', 'str')} ws "}"
` + GBNF_COMMON;
}

/** Validate shape after parsing; anything off → null (caller falls back to hybrid search). */
export function parseOps(text: string): Op[] | null {
  const j = safeJson<{ ops?: unknown }>(stripReasoning(text));
  if (!j || !Array.isArray(j.ops)) return null;
  const out: Op[] = [];
  for (const o of j.ops as Record<string, unknown>[]) {
    const s = (k: string) => (typeof o[k] === 'string' && (o[k] as string).trim() ? (o[k] as string).trim() : undefined);
    const n = (k: string) => (Number.isInteger(Number(o[k])) ? Number(o[k]) : undefined);
    switch (o?.op) {
      case 'search': if (s('query')) out.push({ op: 'search', query: s('query')! }); else return null; break;
      case 'keyword': if (s('terms')) out.push({ op: 'keyword', terms: s('terms')! }); else return null; break;
      case 'filter_by_time':
        if (!s('from') || !s('to') || isNaN(Date.parse(s('from')!)) || isNaN(Date.parse(s('to')!))) return null;
        out.push({ op: 'filter_by_time', from: s('from')!, to: s('to')!, query: s('query') }); break;
      case 'get_session': if (n('id') !== undefined) out.push({ op: 'get_session', id: n('id')! }); else return null; break;
      case 'get_event': if (n('id') !== undefined) out.push({ op: 'get_event', id: n('id')! }); else return null; break;
      case 'get_facts': out.push({ op: 'get_facts', subject: s('subject') }); break;
      case 'count': if (s('query')) out.push({ op: 'count', query: s('query')! }); else return null; break;
      default: return null;
    }
  }
  return out;
}

export const OPS_DOC = `Available memory operations:
- {"op":"search","query":"..."}: find past messages and chat summaries about a topic
- {"op":"keyword","terms":"..."}: find past messages containing exact words or names
- {"op":"filter_by_time","from":"YYYY-MM-DD","to":"YYYY-MM-DD","query":"..."}: past messages between two dates (query optional)
- {"op":"get_session","id":N}: summary of chat #N
- {"op":"get_event","id":N}: message #N with the messages around it
- {"op":"get_facts","subject":"..."}: stored facts about the user (subject optional), including old values
- {"op":"count","query":"..."}: how many past messages mention something`;

// Measured on Qwen3-0.6B / 1.7B: without examples 0/6 plans were sensible (they defaulted to
// get_session 1 / get_facts); with these three, 5/6 and 4/6. Topics deliberately differ from
// the probe's (restaurant, gym) so the probe still tests generalisation.
export const OPS_EXAMPLES = `Examples:
User message: "What did I tell you about my sister's new job?" → {"ops":[{"op":"search","query":"sister new job"}]}
User message: "When did I start learning guitar?" → {"ops":[{"op":"keyword","terms":"guitar"},{"op":"search","query":"started learning guitar"}]}
User message: "Thanks, that helps!" → {"ops":[]}`;

export interface ScrollTrace {
  round: number;
  raw: string;
  ops: Op[] | null;
  results: number;
  ms: number;
}

export interface ScrollResult {
  ok: boolean;
  /** true when the model asked for no lookup in round 1. */
  skipped: boolean;
  items: MemoryItem[];
  trace: ScrollTrace[];
  error?: string;
}

/** Renders a planning prompt that shares the chat's cached prefix (system + recent turns). */
export type PlanRenderer = (finalUserBlock: string) => Promise<string>;

export class ScrollLite {
  constructor(
    private db: SqlDb,
    private log: EventLog,
    private retriever: Retriever,
    private facts: Facts,
    private cfg: () => AuraConfig,
    private clock: Clock,
  ) {}

  async run(llm: LLM, question: string, render: PlanRenderer, exclude: Set<string>, signal?: AbortSignal): Promise<ScrollResult> {
    const { maxRounds, maxOpsPerRound } = this.cfg().scroll;
    const grammar = opsGrammar(maxOpsPerRound);
    const collected = new Map<string, MemoryItem>();
    const trace: ScrollTrace[] = [];

    for (let round = 1; round <= maxRounds; round++) {
      const t0 = Date.now();
      const prompt = await render(this.planBlock(question, round, [...collected.values()]));
      const res = await llm.complete({ prompt, maxTokens: 60 + 70 * maxOpsPerRound, temperature: 0, grammar, signal, purpose: 'plan' });
      if (res.stopReason === 'abort') return { ok: false, skipped: false, items: [], trace, error: 'aborted' };
      const ops = parseOps(res.text);
      const entry: ScrollTrace = { round, raw: res.text, ops, results: 0, ms: 0 };
      trace.push(entry);
      if (!ops) {
        entry.ms = Date.now() - t0;
        // Invalid in round 1 → caller falls back. In round 2 keep what round 1 found.
        return round === 1
          ? { ok: false, skipped: false, items: [], trace, error: 'invalid operations' }
          : { ok: true, skipped: false, items: this.rank(collected), trace };
      }
      if (ops.length === 0) {
        entry.ms = Date.now() - t0;
        return { ok: true, skipped: round === 1, items: this.rank(collected), trace };
      }
      for (const op of ops) {
        for (const item of await this.execute(op, exclude)) {
          const prev = collected.get(item.key);
          if (!prev || item.relevance > prev.relevance) collected.set(item.key, item);
          entry.results++;
        }
      }
      entry.ms = Date.now() - t0;
    }
    return { ok: true, skipped: false, items: this.rank(collected), trace };
  }

  private rank(collected: Map<string, MemoryItem>): MemoryItem[] {
    return this.retriever.rerank([...collected.values()]);
  }

  planBlock(question: string, round: number, found: MemoryItem[]): string {
    const now = this.clock.now();
    const max = this.cfg().scroll.maxOpsPerRound;
    const lines = [
      'Before answering, decide what to look up in your long-term memory of past chats.',
      OPS_DOC,
      OPS_EXAMPLES,
      `Today is ${formatTs(now, false)}.`,
      `User message: "${question}"`,
    ];
    if (round === 1) {
      lines.push(`Reply with JSON {"ops":[...]} using at most ${max} operations, or {"ops":[]} if no lookup is needed.`);
    } else {
      const shown = found.slice(0, 12).map((m) => `- ${this.label(m)} ${truncateChars(oneLine(m.text), 220)}`);
      lines.push(`Results so far:\n${shown.length ? shown.join('\n') : '(nothing found)'}`);
      lines.push(`If these results are enough to answer, reply {"ops":[]}. Otherwise reply with up to ${max} more operations.`);
    }
    return lines.join('\n\n');
  }

  private label(m: MemoryItem): string {
    if (m.itemType === 'event') return `[message #${m.itemId}, chat #${m.sessionId}, ${formatTs(m.ts)}] ${m.role === 'user' ? 'User' : 'Assistant'}:`;
    if (m.itemType === 'episode') return `[summary of chat #${m.sessionId}, ${formatDate(m.ts)}]`;
    if (m.itemType === 'fact') return `[fact]`;
    return '[note]';
  }

  async execute(op: Op, exclude: Set<string>): Promise<MemoryItem[]> {
    const k = this.cfg().scroll.resultsPerOp;
    const via = `scroll:${op.op}`;
    const tag = (items: MemoryItem[]) => items.map((m) => ({ ...m, via }));
    switch (op.op) {
      case 'search':
        return tag(await this.retriever.search(op.query, { k, exclude, mode: 'hybrid' }));
      case 'keyword':
        return tag(await this.retriever.search(op.terms, { k, exclude, mode: 'keyword', types: ['event'] }));
      case 'filter_by_time': {
        const from = Date.parse(op.from);
        const to = Date.parse(op.to) + 86_400_000; // inclusive end date
        if (op.query) return tag(await this.retriever.search(op.query, { k, exclude, from, to }));
        const evs = (await this.log.listRange(from, to, k)).filter((e) => !exclude.has(`event:${e.id}`));
        return this.retriever.hydrate(evs.map((e) => `event:${e.id}`), via, new Map(evs.map((e) => [`event:${e.id}`, 0.5])));
      }
      case 'get_session': {
        const ep = await this.db.get<{ id: number }>('SELECT id FROM episodes WHERE session_id = ?', [op.id]);
        if (ep) return this.retriever.hydrate([`episode:${ep.id}`], via, new Map([[`episode:${ep.id}`, 1]]));
        const evs = (await this.log.listSession(op.id, { limit: k })).filter((e) => !exclude.has(`event:${e.id}`));
        return this.retriever.hydrate(evs.map((e) => `event:${e.id}`), via, new Map(evs.map((e) => [`event:${e.id}`, 0.8])));
      }
      case 'get_event': {
        const ev = await this.log.get(op.id);
        if (!ev || ev.type !== 'message') return [];
        const around = [...(await this.log.neighbors(ev, 1, 1)), ev].filter((e) => !exclude.has(`event:${e.id}`));
        return this.retriever.hydrate(around.map((e) => `event:${e.id}`), via,
          new Map(around.map((e) => [`event:${e.id}`, e.id === ev.id ? 1 : 0.7])));
      }
      case 'get_facts': {
        const facts = (await this.facts.list({ subject: op.subject })).slice(0, k * 3);
        return this.retriever.hydrate(facts.map((f) => `fact:${f.id}`), via,
          new Map(facts.map((f) => [`fact:${f.id}`, f.isCurrent ? 0.9 : 0.6])));
      }
      case 'count': {
        const match = ftsQuery(op.query);
        const n = match
          ? (await this.db.get<{ n: number }>(`SELECT COUNT(*) n FROM fts WHERE fts MATCH ? AND item_type = 'event'`, [match]))!.n
          : 0;
        return [{ key: `note:count:${op.query}`, itemType: 'note', itemId: 0, ts: this.clock.now(),
          text: `${n} past messages mention "${op.query}".`, relevance: 0.8, importance: 0.5, score: 0, via }];
      }
    }
  }

  /**
   * Capability probe: can this model produce *sensible* operations, not just valid JSON?
   * Both probe questions clearly need a lookup with a non-empty query.
   */
  async probe(llm: LLM, render: PlanRenderer, signal?: AbortSignal): Promise<{ passed: boolean; details: string[] }> {
    const questions = [
      'What was the name of the restaurant I told you about last week?',
      'How many times have I mentioned going to the gym?',
    ];
    const grammar = opsGrammar(this.cfg().scroll.maxOpsPerRound);
    const details: string[] = [];
    let passed = true;
    for (const q of questions) {
      const prompt = await render(this.planBlock(q, 1, []));
      const res = await llm.complete({ prompt, maxTokens: 200, temperature: 0, grammar, signal, purpose: 'plan' });
      const ops = parseOps(res.text);
      const ok = !!ops && ops.some((o) => ['search', 'keyword', 'filter_by_time', 'count'].includes(o.op));
      details.push(`${ok ? 'PASS' : 'FAIL'} ${q} → ${oneLine(res.text).slice(0, 160)}`);
      passed &&= ok;
    }
    return { passed, details };
  }
}
