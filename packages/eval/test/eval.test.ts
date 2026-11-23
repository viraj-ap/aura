import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/configs';
import { type Question, history, parseDate, split, subset } from '../src/dataset';
import { judgePrompt } from '../src/judge';
import { wilson } from '../src/report';

const q = (id: string, type: string, extra: Partial<Question> = {}): Question => ({
  question_id: id, question_type: type, question: 'Q?', answer: 'A', question_date: '2023/05/20 (Sat) 02:21',
  haystack_dates: [], haystack_session_ids: [], haystack_sessions: [], answer_session_ids: [], ...extra,
});

describe('dataset', () => {
  it('parses LongMemEval dates as UTC', () => {
    expect(parseDate('2023/05/20 (Sat) 02:21')).toBe(Date.UTC(2023, 4, 20, 2, 21));
  });
  it('orders sessions by date and spaces turns a minute apart', () => {
    const h = history(q('x', 't', {
      haystack_dates: ['2023/05/21 (Sun) 10:00', '2023/05/20 (Sat) 10:00'],
      haystack_session_ids: ['late', 'early'],
      haystack_sessions: [[{ role: 'user', content: 'b' }], [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'a2' }]],
    }));
    expect(h.map((s) => s.haystackId)).toEqual(['early', 'late']);
    expect(h[0]!.turns[1]!.ts - h[0]!.turns[0]!.ts).toBe(60_000);
  });
  it('stratified subset is deterministic and independent of input order', () => {
    const qs = Array.from({ length: 30 }, (_, i) => q(`id${i}`, i % 2 ? 'multi-session' : 'knowledge-update'));
    const a = subset(qs, 3).map((x) => x.question_id);
    const b = subset([...qs].reverse(), 3).map((x) => x.question_id);
    expect(a).toEqual(b);
    expect(a).toHaveLength(6);
  });
  it('dev/test split is disjoint, complete, and contains the per-type-10 subset in dev', () => {
    const qs = Array.from({ length: 100 }, (_, i) => q(`id${i}`, i % 4 ? 'multi-session' : 'knowledge-update'));
    const dev = split(qs, 'dev', ['multi-session', 'knowledge-update']).map((x) => x.question_id);
    const test = split(qs, 'test', ['multi-session', 'knowledge-update']).map((x) => x.question_id);
    expect(new Set([...dev, ...test]).size).toBe(100);
    expect(dev.filter((id) => test.includes(id))).toEqual([]);
    expect(dev).toHaveLength(Math.round(75 * 0.3) + 10); // 23 multi-session + max(10, round(7.5)) knowledge-update
    for (const id of subset(qs, 10, ['multi-session', 'knowledge-update']).map((x) => x.question_id)) expect(dev).toContain(id);
  });
});

describe('judge prompts', () => {
  it('routes by type and abstention', () => {
    expect(judgePrompt(q('x_abs', 'multi-session'), 'r')).toContain('unanswerable');
    expect(judgePrompt(q('x', 'temporal-reasoning'), 'r')).toContain('off-by-one');
    expect(judgePrompt(q('x', 'knowledge-update'), 'r')).toContain('updated answer');
    expect(judgePrompt(q('x', 'single-session-preference'), 'r')).toContain('Rubric');
  });
});

describe('report', () => {
  it('wilson interval brackets the proportion', () => {
    const [lo, hi] = wilson(22, 60);
    expect(lo).toBeLessThan(22 / 60);
    expect(hi).toBeGreaterThan(22 / 60);
    expect(hi - lo).toBeGreaterThan(0.2); // ±12 points at n=60
  });
});

describe('configs', () => {
  it('composes modifiers without mutating the base', () => {
    const c = resolveConfig('c/snip/k20');
    expect(c.aura.retrieval?.snippets).toBe(true);
    expect(c.aura.retrieval?.k).toBe(20);
    expect(resolveConfig('c').aura.retrieval?.k).toBeUndefined();
    expect(() => resolveConfig('c/bogus')).toThrow(/unknown modifier/);
  });
});
