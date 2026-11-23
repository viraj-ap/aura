import type { EventLog } from '../log/eventLog';
import type { TokenCounter } from '../log/tokens';
import { ids } from '../store/schema';
import type { Clock, LLM, SqlDb } from '../types';
import { GBNF_COMMON, kv } from '../util/gbnf';
import { callLLM } from '../util/llmCall';
import { safeJson, truncateChars } from '../util/text';

export interface Rule {
  id: number;
  rule: string;
  helpful: number;
  harmful: number;
  sourceEventIds: number[];
}

export type Delta =
  | { op: 'ADD'; rule: string }
  | { op: 'UPDATE'; id: number; rule: string }
  | { op: 'REMOVE'; id: number }
  | { op: 'NONE' };

// Exactly one delta per reflection — never a rewrite of the whole list. ACE shows that
// letting a model rewrite its context wholesale gradually erases detail ("context collapse").
export function deltaGrammar(ruleIds: number[]): string {
  // Only ids that exist are expressible, so the model can't UPDATE/REMOVE a rule that
  // isn't there (Qwen3-0.6B did exactly that with an empty playbook).
  const withIds = ruleIds.length > 0;
  return String.raw`
root ::= "{" ws ( add | ${withIds ? 'update | remove | ' : ''}none ) ws "}"
add ::= ${kv('op', String.raw`"\"ADD\""`)} ws "," ws ${kv('rule', 'str')}
none ::= ${kv('op', String.raw`"\"NONE\""`)}
${withIds ? String.raw`update ::= ${kv('op', String.raw`"\"UPDATE\""`)} ws "," ws ${kv('id', 'id')} ws "," ws ${kv('rule', 'str')}
remove ::= ${kv('op', String.raw`"\"REMOVE\""`)} ws "," ws ${kv('id', 'id')}
id ::= ${ruleIds.map((n) => `"${n}"`).join(' | ')}` : ''}
` + GBNF_COMMON;
}

export const REFLECT_SYSTEM = `You maintain a short list of rules that tell an assistant how this user wants to be answered.
Given one rated exchange, propose AT MOST ONE change:
- {"op":"ADD","rule":"..."} a new short, general, actionable rule (e.g. "Keep answers under 5 sentences.")
- {"op":"UPDATE","id":N,"rule":"..."} refine an existing rule
- {"op":"REMOVE","id":N} delete a rule that caused the bad answer
- {"op":"NONE"} if nothing should change
Rules are about style and behaviour only. Never put personal facts in rules. Don't add a rule that duplicates an existing one.`;

/** Rules whose harmful count exceeds helpful by this much are hidden from the prompt. */
const RETIRE_MARGIN = 3;

export class Playbook {
  constructor(
    private db: SqlDb,
    private log: EventLog,
    private tokens: TokenCounter,
    private llm: () => LLM,
    private clock: Clock,
  ) {}

  async list(): Promise<Rule[]> {
    const rows = await this.db.all<{ id: number; rule: string; helpful: number; harmful: number; source_event_ids: string }>(
      'SELECT * FROM playbook ORDER BY (helpful - harmful) DESC, id');
    return rows.map((r) => ({ id: r.id, rule: r.rule, helpful: r.helpful, harmful: r.harmful, sourceEventIds: ids.decode(r.source_event_ids) }));
  }

  /** Rules for the prompt: best-rated first, retired rules skipped, capped at `capTokens`. */
  async forPrompt(capTokens: number): Promise<Rule[]> {
    const out: Rule[] = [];
    let used = 0;
    for (const r of await this.list()) {
      if (r.harmful - r.helpful >= RETIRE_MARGIN) continue;
      const n = await this.tokens.count(`- ${r.rule}`);
      if (used + n > capTokens) break;
      used += n;
      out.push(r);
    }
    return out;
  }

  async add(rule: string, sources: number[] = []): Promise<number> {
    const { lastInsertRowid } = await this.db.run(
      'INSERT INTO playbook(rule, source_event_ids, created_at) VALUES (?,?,?)',
      [truncateChars(rule.trim(), 200), ids.encode(sources), this.clock.now()]);
    return lastInsertRowid;
  }

  async update(id: number, rule: string, source?: number): Promise<boolean> {
    const r = await this.db.get<{ source_event_ids: string }>('SELECT source_event_ids FROM playbook WHERE id = ?', [id]);
    if (!r) return false;
    const sources = ids.decode(r.source_event_ids);
    if (source !== undefined) sources.push(source);
    await this.db.run('UPDATE playbook SET rule = ?, source_event_ids = ? WHERE id = ?',
      [truncateChars(rule.trim(), 200), ids.encode(sources), id]);
    return true;
  }

  async remove(id: number): Promise<boolean> {
    return (await this.db.run('DELETE FROM playbook WHERE id = ?', [id])).changes > 0;
  }

  /** Credit/blame the rules that were in the prompt when the rated answer was generated. */
  async rate(ruleIds: number[], value: 'up' | 'down'): Promise<void> {
    const col = value === 'up' ? 'helpful' : 'harmful';
    for (const id of ruleIds) await this.db.run(`UPDATE playbook SET ${col} = ${col} + 1 WHERE id = ?`, [id]);
  }

  /** Job handler: reflect on one feedback event and apply at most one delta. */
  async reflect(feedbackEventId: number, opts: { signal?: AbortSignal; slot?: number } = {}): Promise<Delta> {
    const fb = await this.log.get(feedbackEventId);
    const targetId = Number(fb?.meta?.targetId);
    const target = targetId ? await this.log.get(targetId) : undefined;
    if (!fb || !target) return { op: 'NONE' };
    const [question] = (await this.log.neighbors(target, 1, 0)).filter((e) => e.role === 'user');
    const rules = await this.list();
    const value = fb.meta?.value === 'up' ? 'thumbs UP (good answer)' : 'thumbs DOWN (bad answer)';
    const comment = fb.content ? `\nUser comment: "${fb.content}"` : '';

    const out = await callLLM(this.llm(), {
      messages: [
        { role: 'system', content: REFLECT_SYSTEM },
        { role: 'user', content:
          `Current rules:\n${rules.length ? rules.map((r) => `[${r.id}] ${r.rule}`).join('\n') : '(none)'}\n\n` +
          `User asked: ${truncateChars(question?.content ?? '(unknown)', 600)}\n` +
          `Assistant answered: ${truncateChars(target.content, 1200)}\n` +
          `Rating: ${value}${comment}\n\nOutput one JSON change.` },
      ],
      maxTokens: 120,
      grammar: deltaGrammar(rules.map((r) => r.id)),
      signal: opts.signal,
      slot: opts.slot,
    });
    const d = safeJson<Delta>(out);
    if (!d || !d.op) throw new Error(`reflection: invalid JSON: ${out.slice(0, 120)}`);
    const known = new Set(rules.map((r) => r.id));
    if (d.op === 'ADD' && !rules.some((r) => r.rule.toLowerCase() === d.rule.trim().toLowerCase()))
      await this.add(d.rule, [feedbackEventId]);
    else if (d.op === 'UPDATE' && known.has(d.id)) await this.update(d.id, d.rule, feedbackEventId);
    else if (d.op === 'REMOVE' && known.has(d.id)) await this.remove(d.id);
    else return { op: 'NONE' };
    return d;
  }
}
