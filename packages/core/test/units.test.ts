import { describe, expect, it } from 'vitest';
import { allocate, edgeOrder, promptBudget } from '../src/context/budget';
import { chunkText } from '../src/indexes/chunker';
import { HashEmbedder } from '../src/indexes/hashEmbedder';
import { dot, normalize } from '../src/indexes/vector';
import { ftsQuery, rrf } from '../src/selection/retriever';
import { route } from '../src/selection/router';
import { opsGrammar, parseOps } from '../src/selection/scrollLite';
import { safeJson, stripReasoning } from '../src/util/text';
import { mergeConfig, defaultConfig } from '../src/config';

describe('stripReasoning', () => {
  it('removes complete think blocks', () => expect(stripReasoning('<think>hmm\nok</think>\n\nAnswer')).toBe('Answer'));
  it('handles a template-prefilled <think> (only the close tag in output)', () => expect(stripReasoning('reasoning…</think>Answer')).toBe('Answer'));
  it('drops an unterminated think at the end', () => expect(stripReasoning('Answer <think>never closed')).toBe('Answer'));
  it('leaves plain text alone', () => expect(stripReasoning('  plain ')).toBe('plain'));
});

describe('safeJson', () => {
  it('parses fenced json', () => expect(safeJson('```json\n{"a":1}\n```')).toEqual({ a: 1 }));
  it('finds json inside junk', () => expect(safeJson('sure! [1,2] done')).toEqual([1, 2]));
  it('returns undefined on garbage', () => expect(safeJson('nope')).toBeUndefined());
});

describe('chunkText', () => {
  it('keeps short text whole', () => expect(chunkText('hello world', 100)).toEqual(['hello world']));
  it('splits long text into bounded, overlapping chunks', () => {
    const text = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const chunks = chunkText(text, 64);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(64 * 3);
    expect(chunks.join(' ')).toContain('Sentence number 199');
  });
});

describe('vectors', () => {
  it('hash embedder: lexical overlap → higher cosine', async () => {
    const e = new HashEmbedder();
    const [a, b, c] = (await e.embed(['my dog is named Biscuit', 'what is my dog called, Biscuit?', 'quarterly tax filing deadline'])).map(normalize);
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
  });
});

describe('RRF', () => {
  it('rewards items ranked well in both lists', () => {
    const s = rrf([['a', 'b', 'c'], ['b', 'd', 'a']], 60);
    expect([...s].sort((x, y) => y[1] - x[1])[0]![0]).toBe('b'); // b: ranks 2 and 1 beats a: ranks 1 and 3
    expect(s.get('d')).toBeCloseTo(1 / 62);
  });
});

describe('ftsQuery', () => {
  it('quotes terms and drops stopwords', () => expect(ftsQuery('What is my dog\'s name?')).toBe('"dog" OR "name"'));
  it('never produces FTS syntax from user text', () => expect(ftsQuery('a AND (b OR "c") NEAR*')).toBe('"near"'));
  it('returns null when nothing is searchable', () => expect(ftsQuery('what is it?')).toBeNull());
});

describe('router', () => {
  it('skips small talk', () => expect(route('thanks!', true).retrieve).toBe(false));
  it('skips when there is no memory', () => expect(route('what is my name?', false).retrieve).toBe(false));
  it('retrieves for real questions', () => expect(route('what did I say about Pune?', true).retrieve).toBe(true));
});

describe('budget', () => {
  const shares = defaultConfig.shares;
  it('prompt budget = min(ctx, ram) − reserve', () => {
    expect(promptBudget(4096, undefined, 512)).toBe(3584);
    expect(promptBudget(32768, 8000, 512)).toBe(7488);
  });
  it('gives each section its need up to its share', () => {
    const g = allocate(1000, shares, { system: 50, playbook: 10, facts: 20, retrieved: 100, recent: 100 });
    expect(g).toEqual({ system: 50, playbook: 10, facts: 20, retrieved: 100, recent: 100, attached: 0 });
  });
  it('redistributes unused share to sections that need more', () => {
    const g = allocate(1000, shares, { system: 50, playbook: 0, facts: 0, retrieved: 900, recent: 900 });
    expect(g.recent + g.retrieved + g.system).toBe(1000);
    expect(g.recent).toBeGreaterThan(400); // more than its 40% share
  });
  it('never exceeds the total', () => {
    const g = allocate(500, shares, { system: 999, playbook: 999, facts: 999, retrieved: 999, recent: 999 });
    expect(Object.values(g).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(500);
  });
});

describe('edgeOrder', () => {
  it('puts #1 last (next to the query), #2 first, weakest in the middle', () => {
    expect(edgeOrder([1, 2, 3, 4, 5])).toEqual([2, 4, 5, 3, 1]);
  });
});

describe('Scroll-lite parsing', () => {
  it('accepts valid ops', () => {
    expect(parseOps('{"ops":[{"op":"search","query":"dog name"},{"op":"get_event","id":12}]}'))
      .toEqual([{ op: 'search', query: 'dog name' }, { op: 'get_event', id: 12 }]);
  });
  it('accepts an empty plan', () => expect(parseOps('{"ops":[]}')).toEqual([]));
  it('rejects unknown ops, missing args and bad dates', () => {
    expect(parseOps('{"ops":[{"op":"rm -rf"}]}')).toBeNull();
    expect(parseOps('{"ops":[{"op":"search"}]}')).toBeNull();
    expect(parseOps('{"ops":[{"op":"filter_by_time","from":"yesterday","to":"2026-01-01"}]}')).toBeNull();
    expect(parseOps('not json')).toBeNull();
  });
  it('builds a grammar with every operation', () => {
    const g = opsGrammar(3);
    for (const op of ['search', 'keyword', 'filter_by_time', 'get_session', 'get_event', 'get_facts', 'count']) expect(g).toContain(op);
    expect(g).toContain('{0,2}');
  });
});

describe('mergeConfig', () => {
  it('deep-merges without touching the base', () => {
    const c = mergeConfig(defaultConfig, { layers: { retrieval: false }, retrieval: { k: 3 } });
    expect(c.layers.retrieval).toBe(false);
    expect(c.layers.compression).toBe(true);
    expect(c.retrieval.k).toBe(3);
    expect(defaultConfig.layers.retrieval).toBe(true);
  });
});

describe('playbook delta grammar', () => {
  it('only allows ADD/NONE when there are no rules, and only existing ids otherwise', async () => {
    const { deltaGrammar } = await import('../src/playbook/playbook');
    const empty = deltaGrammar([]);
    expect(empty).not.toMatch(/update|remove|\bid ::=/);
    const g = deltaGrammar([2, 5]);
    expect(g).toContain('id ::= "2" | "5"');
    expect(g).toContain('update | remove');
  });
});

describe('snippets', () => {
  it('returns only the matching chunk of a long message', async () => {
    const { Retriever } = await import('../src/selection/retriever');
    const cfg = mergeConfig(defaultConfig, { chunkTokens: 64 });
    const r = new Retriever(null as never, null as never, () => null, () => cfg, { now: () => 0 });
    const text = 'Filler about weather and clouds. '.repeat(20) + 'The vet said Biscuit needs a rabies shot in May. ' + 'More filler about traffic. '.repeat(20);
    const s = r.snippet(text, 'when is the rabies shot for Biscuit');
    expect(s).toContain('rabies');
    expect(s.length).toBeLessThan(text.length / 3);
    expect(r.snippet('short message', 'x')).toBe('short message');
  });
});

describe('relative time', () => {
  it('formats ages small models can use directly', async () => {
    const { relativeAge } = await import('../src/context/assembler');
    const D = 86_400_000;
    expect(relativeAge(0, 0)).toBe('today');
    expect(relativeAge(0, 3 * D)).toBe('3 days before now');
    expect(relativeAge(0, 21 * D)).toBe('21 days (~3 weeks) before now');
    expect(relativeAge(0, 90 * D)).toBe('90 days (~3 months) before now');
  });
});

describe('splitStatements (op-sqlite runs one statement per call)', () => {
  it('splits the real schema into statements that recreate it exactly', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { splitStatements } = await import('../src/util/sql');
    const { migrate } = await import('../src/store/schema');
    const { memoryDb } = await import('./helpers');
    // Reference: migrate through exec() of the whole script.
    const ref = memoryDb();
    await migrate(ref);
    const want = await ref.all<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name`);
    // Same migration, but exec() splits and runs one statement at a time.
    const raw = new Database(':memory:');
    const oneByOne = { ...memoryDb(), exec: async (sql: string) => { for (const s of splitStatements(sql)) raw.prepare(s).run(); },
      run: async (sql: string, p: unknown[] = []) => { const r = raw.prepare(sql).run(...p); return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) }; },
      get: async <T>(sql: string, p: unknown[] = []) => raw.prepare(sql).get(...p) as T, all: async <T>(sql: string) => raw.prepare(sql).all() as T[] };
    await migrate(oneByOne);
    expect(raw.prepare(`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name`).all()).toEqual(want);
  });
  it('ignores semicolons in strings, parentheses and comments', async () => {
    const { splitStatements } = await import('../src/util/sql');
    expect(splitStatements(`INSERT INTO t VALUES ('a;b'); -- c;d\nSELECT 1;`)).toEqual([`INSERT INTO t VALUES ('a;b')`, 'SELECT 1']);
  });
});
