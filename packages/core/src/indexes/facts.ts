import type { EventLog } from '../log/eventLog';
import { ids } from '../store/schema';
import type { LLM, SqlDb } from '../types';
import { GBNF_COMMON, kv } from '../util/gbnf';
import { callLLM } from '../util/llmCall';
import { formatTs, safeJson } from '../util/text';
import type { Indexer } from './indexer';

export interface Fact {
  id: number;
  subject: string;
  attribute: string;
  value: string;
  confidence: number;
  isCurrent: boolean;
  sourceEventIds: number[];
  firstSeen: number;
  lastSeen: number;
  heat: number;
}

export interface ExtractedFact {
  subject: string;
  attribute: string;
  value: string;
  confidence?: number;
}

// Gate first, then the list: {"states_personal_facts": false} or {…: true, "facts": [1–4 facts]}.
// Measured on Qwen3-0.6B: with a plain array grammar the model answered [] for every
// message; a yes/no decision first, then a non-empty list, gets the obvious facts out.
// Confidence is not asked for — small models don't calibrate it; grounding (below) is the guard.
export const FACT_GRAMMAR = String.raw`
root ::= "{" ws "\"states_personal_facts\"" ws ":" ws ( "true" ws "," ws ${kv('facts', 'facts')} | "false" ) ws "}"
facts ::= "[" ws fact ( ws "," ws fact ){0,3} ws "]"
fact ::= "{" ws ${kv('subject', 'shortstr')} ws "," ws ${kv('attribute', 'shortstr')} ws "," ws ${kv('value', 'str')} ws "}"
` + GBNF_COMMON;

export const FACT_SYSTEM = `You keep a memory of personal facts about the user. Read the user's message and decide whether it states personal facts (their name, family, pets, where they live, job, diet, health, likes and dislikes, plans, things they ask you to remember). Questions and requests for information are not personal facts.
If it does, list each fact with subject "user" (or the person/pet it is about, like "user's dog"), a short snake_case attribute such as name, dog_name, home_city, job, diet, and the value.`;

/**
 * Hallucination guard: keep a fact only if some content word of its value appears in
 * the message it came from. Drops placeholders like "User" or "User's home city".
 */
export function grounded(value: string, message: string): boolean {
  const msg = message.toLowerCase();
  const words = value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const content = words.filter((w) => w.length >= 3 || /\d/.test(w)).filter((w) => !['user', 'the', 'and'].includes(w));
  return content.length > 0 && content.some((w) => msg.includes(w));
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const normSubject = (s: string) => {
  const n = norm(s);
  return ['i', 'me', 'myself', 'the user', 'user', 'my'].includes(n) ? 'user' : n.replace(/^my /, "user's ");
};
const normAttr = (s: string) => norm(s).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

interface FactRow {
  id: number; subject: string; attribute: string; value: string; confidence: number; is_current: number;
  source_event_ids: string; first_seen: number; last_seen: number; heat: number;
}
const toFact = (r: FactRow): Fact => ({
  id: r.id, subject: r.subject, attribute: r.attribute, value: r.value, confidence: r.confidence,
  isCurrent: !!r.is_current, sourceEventIds: ids.decode(r.source_event_ids), firstSeen: r.first_seen,
  lastSeen: r.last_seen, heat: r.heat,
});

/** L2 semantic memory: (subject, attribute, value) facts with history and heat. */
export class Facts {
  constructor(
    private db: SqlDb,
    private log: EventLog,
    private indexer: Indexer,
    private llm: () => LLM,
  ) {}

  /** Job handler: extract from one user message (never from assistant output). */
  async extractFrom(eventId: number, opts: { signal?: AbortSignal; slot?: number } = {}): Promise<Fact[]> {
    const ev = await this.log.get(eventId);
    if (!ev || ev.role !== 'user' || ev.type !== 'message') return [];
    const out = await callLLM(this.llm(), {
      messages: [
        { role: 'system', content: FACT_SYSTEM },
        { role: 'user', content: `User's message (sent ${formatTs(ev.ts)}): """${ev.content}"""` },
      ],
      maxTokens: 400,
      grammar: FACT_GRAMMAR,
      signal: opts.signal,
      slot: opts.slot,
    });
    const parsed = safeJson<{ states_personal_facts?: boolean; facts?: ExtractedFact[] }>(out);
    if (!parsed || typeof parsed.states_personal_facts !== 'boolean') throw new Error(`fact extraction: invalid JSON: ${out.slice(0, 120)}`);
    const saved: Fact[] = [];
    for (const f of parsed.facts ?? []) {
      if (!f || typeof f.value !== 'string' || !f.value.trim() || !grounded(f.value, ev.content)) continue;
      saved.push(await this.upsert({ ...f, confidence: f.confidence ?? 0.8 }, eventId, ev.ts));
    }
    return saved;
  }

  /**
   * Same subject+attribute+value → reinforce. Different value → keep both, newest is
   * current (knowledge updates: "I moved to Pune" supersedes "I live in Mumbai").
   * Idempotent per source event, so a re-run job doesn't double count.
   */
  async upsert(f: ExtractedFact, sourceEventId: number, ts: number): Promise<Fact> {
    const subject = normSubject(f.subject);
    const attribute = normAttr(f.attribute);
    const value = f.value.trim();
    const confidence = Math.max(0.1, Math.min(1, Number(f.confidence) || 0.5));
    const fact = await this.db.transaction(async () => {
      const existing = await this.db.all<FactRow>('SELECT * FROM facts WHERE subject = ? AND attribute = ?', [subject, attribute]);
      const same = existing.find((r) => norm(r.value) === norm(value));
      if (same) {
        const sources = ids.encode([...ids.decode(same.source_event_ids), sourceEventId]);
        // Re-stating an old value makes it current again if it's the newest mention.
        const newest = ts >= Math.max(...existing.map((r) => r.last_seen));
        if (newest) await this.db.run('UPDATE facts SET is_current = 0 WHERE subject = ? AND attribute = ?', [subject, attribute]);
        await this.db.run(
          'UPDATE facts SET confidence = MAX(confidence, ?), source_event_ids = ?, last_seen = MAX(last_seen, ?), is_current = ? WHERE id = ?',
          [confidence, sources, ts, newest ? 1 : same.is_current, same.id]);
        return toFact((await this.db.get<FactRow>('SELECT * FROM facts WHERE id = ?', [same.id]))!);
      }
      const newest = existing.every((r) => r.last_seen <= ts);
      if (newest) await this.db.run('UPDATE facts SET is_current = 0 WHERE subject = ? AND attribute = ?', [subject, attribute]);
      const { lastInsertRowid } = await this.db.run(
        `INSERT INTO facts(subject, attribute, value, confidence, is_current, source_event_ids, first_seen, last_seen)
         VALUES (?,?,?,?,?,?,?,?)`,
        [subject, attribute, value, confidence, newest ? 1 : 0, ids.encode([sourceEventId]), ts, ts]);
      return toFact((await this.db.get<FactRow>('SELECT * FROM facts WHERE id = ?', [lastInsertRowid]))!);
    });
    await this.indexer.index('fact', fact.id, `${fact.subject} ${fact.attribute.replace(/_/g, ' ')}: ${fact.value}`);
    return fact;
  }

  async list(opts: { currentOnly?: boolean; subject?: string } = {}): Promise<Fact[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.currentOnly) where.push('is_current = 1');
    if (opts.subject) {
      where.push('subject LIKE ?');
      params.push(`%${norm(opts.subject)}%`);
    }
    const rows = await this.db.all<FactRow>(
      `SELECT * FROM facts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY subject, attribute, last_seen DESC`, params);
    return rows.map(toFact);
  }

  async count(): Promise<number> {
    return (await this.db.get<{ n: number }>('SELECT COUNT(*) n FROM facts WHERE is_current = 1'))!.n;
  }

  /** Heat = log(uses + 1); recency is added at ranking time (Retriever.rerank) so it never goes stale. */
  async touch(factIds: number[], now: number): Promise<void> {
    // Math in JS: SQLite's ln() only exists when compiled with math functions.
    for (const id of factIds) {
      const r = await this.db.get<{ uses: number }>('SELECT uses FROM facts WHERE id = ?', [id]);
      if (!r) continue;
      await this.db.run('UPDATE facts SET uses = ?, last_used = ?, heat = ? WHERE id = ?',
        [r.uses + 1, now, Math.log(r.uses + 2), id]);
    }
  }
}
