import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  has_answer?: boolean;
}

export interface Question {
  question_id: string;
  question_type: string;
  question: string;
  answer: string | number;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Turn[][];
  answer_session_ids: string[];
}

export const TYPES = [
  'single-session-user', 'single-session-assistant', 'single-session-preference',
  'multi-session', 'knowledge-update', 'temporal-reasoning',
] as const;

export const isAbstention = (q: Question) => q.question_id.endsWith('_abs');

/** "2023/05/20 (Sat) 02:21" → ms (UTC, so replays don't depend on the machine's timezone). */
export function parseDate(s: string): number {
  const m = s.match(/(\d{4})\/(\d{2})\/(\d{2})\D+(\d{2}):(\d{2})/);
  if (!m) throw new Error(`bad date ${s}`);
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
}

export function load(path: string): Question[] {
  return JSON.parse(readFileSync(path, 'utf8')) as Question[];
}

/**
 * Deterministic stratified subset: `perType` questions of each type, picked by a hash of
 * the id (so the subset is stable across runs and doesn't depend on file order).
 */
export function subset(qs: Question[], perType: number, types: readonly string[] = TYPES): Question[] {
  const h = (id: string) => createHash('sha1').update(id).digest('hex');
  return types.flatMap((t) =>
    qs.filter((q) => q.question_type === t).sort((a, b) => (h(a.question_id) < h(b.question_id) ? -1 : 1)).slice(0, perType));
}

export type Split = 'dev' | 'test' | 'all';

/**
 * Dev/test split. Per type, questions are ordered by the same id hash as `subset`
 * and the first max(10, round(30%)) go to dev: 151 dev / 349 test. Reusing `subset`'s order means
 * the 60 questions Phase 2 tuned on (10 per type) are all in dev, so test is held out from both phases.
 * (The Phase 2 n=500 runs did touch test questions; those numbers predate the split.)
 */
export function split(qs: Question[], which: Split, types: readonly string[] = TYPES): Question[] {
  if (which === 'all') return types.flatMap((t) => subset(qs, Infinity, [t]));
  return types.flatMap((t) => {
    const all = subset(qs, Infinity, [t]);
    const nDev = Math.max(10, Math.round(all.length * 0.3));
    return which === 'dev' ? all.slice(0, nDev) : all.slice(nDev);
  });
}

export interface HistorySession {
  haystackId: string;
  ts: number;
  turns: (Turn & { ts: number })[];
}

/** Sessions in chronological order; turns one minute apart inside a session. */
export function history(q: Question): HistorySession[] {
  return q.haystack_sessions
    .map((turns, i) => {
      const ts = parseDate(q.haystack_dates[i]!);
      return { haystackId: q.haystack_session_ids[i]!, ts, turns: turns.map((t, j) => ({ ...t, ts: ts + j * 60_000 })) };
    })
    .sort((a, b) => a.ts - b.ts);
}
