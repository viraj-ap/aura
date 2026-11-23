import { describe, expect, it } from 'vitest';
import type { DeepPartial, AuraConfig } from '../src/config';
import { Aura } from '../src/engine';
import { HashEmbedder } from '../src/indexes/hashEmbedder';
import { ManualClock } from '../src/types';
import { DAY, FakeLLM, type Responder, T0, kindOf, lastUserBlock, memoryDb } from './helpers';

/** Responder that acts like a cooperative model for every job type. */
const smartResponder = (overrides: Partial<Record<ReturnType<typeof kindOf>, Responder>> = {}): Responder => (prompt, req) => {
  const kind = kindOf(prompt);
  if (overrides[kind]) return overrides[kind]!(prompt, req);
  switch (kind) {
    case 'facts': {
      const msg = prompt.slice(prompt.lastIndexOf('"""', prompt.lastIndexOf('"""') - 1));
      const facts = (f: string) => `{"states_personal_facts": true, "facts": [${f}]}`;
      if (/dog is called (\w+)/i.test(msg)) return facts(`{"subject":"user","attribute":"dog_name","value":"${msg.match(/dog is called (\w+)/i)![1]}"}`);
      if (/live in (\w+)/i.test(msg)) return facts(`{"subject":"user","attribute":"home_city","value":"${msg.match(/live in (\w+)/i)![1]}"}`);
      if (/vegetarian/i.test(msg)) return facts('{"subject":"user","attribute":"diet","value":"vegetarian"}');
      return '{"states_personal_facts": false}';
    }
    case 'summary': return '- The user talked about things (summary).';
    case 'reflect': return '{"op":"ADD","rule":"Keep answers under three sentences."}';
    case 'plan': return '{"ops":[]}';
    default: return '<think>let me think</think>Sure.';
  }
};

async function setup(config: DeepPartial<AuraConfig> = {}, respond: Responder = smartResponder(), ctx = 2048) {
  const clock = new ManualClock(T0);
  const llm = new FakeLLM(respond, ctx);
  const aura = await Aura.open({ db: memoryDb(), llm, embedder: new HashEmbedder(), clock, config: { outputReserve: 256, ...config } });
  return { aura, llm, clock };
}

describe('Aura engine — end to end with a scripted model', () => {
  it('logs both sides, strips reasoning, and shows the exact prompt in debug', async () => {
    const { aura, llm } = await setup();
    const s = await aura.sessions.create();
    const r = await aura.send(s.id, 'hello there, how are you');
    expect(r.reply).toBe('Sure.');
    expect((await aura.log.get(r.assistantEvent.id))!.content).toBe('Sure.');
    expect(r.debug.assembled.prompt).toBe(llm.prompts('chat').at(-1));
    expect((await aura.sessions.get(s.id))!.title).toBe('hello there, how are you');
  });

  it('recalls something from an earlier session (cross-session retrieval)', async () => {
    const { aura, llm, clock } = await setup({ layers: { facts: false, episodic: false } });
    const s1 = await aura.sessions.create();
    await aura.send(s1.id, 'My dog is called Biscuit and he loves the beach');
    clock.advance(3 * DAY);
    const s2 = await aura.sessions.create();
    const r = await aura.send(s2.id, "What is my dog's name?");
    expect(r.debug.retrieval.method).toBe('hybrid');
    expect(r.debug.retrieval.items.some((m) => m.text.includes('Biscuit'))).toBe(true);
    const final = lastUserBlock(llm.prompts('chat').at(-1)!);
    expect(final).toContain('Biscuit');
    expect(final).toMatch(/2026-01-05 Mon 10:00, chat #1\) User: My dog is called Biscuit/); // timestamped memory
    expect(final.trim().endsWith("User message: What is my dog's name?")).toBe(true); // query last
  });

  it('keeps the system message identical across turns (stable cached prefix)', async () => {
    const { aura, llm } = await setup({ layers: { facts: false, episodic: false } });
    const s = await aura.sessions.create();
    await aura.send(s.id, 'first message about apples');
    await aura.send(s.id, 'second message about pears');
    const [p1, p2] = llm.prompts('chat');
    const sys = (p: string) => p.slice(0, p.indexOf('<|user|>'));
    expect(sys(p1!)).toBe(sys(p2!));
    // Turn 2's prompt starts with turn 1's raw exchange, so the KV cache can reuse it.
    expect(p2!).toContain('<|user|>\nfirst message about apples\n<|assistant|>\nSure.\n');
  });

  it('extracts facts from user messages only and applies them in a later session', async () => {
    const { aura, llm, clock } = await setup();
    const s1 = await aura.sessions.create();
    await aura.send(s1.id, "I'm vegetarian, just so you know");
    await aura.runBackground();
    const facts = await aura.facts.list({ currentOnly: true });
    expect(facts).toMatchObject([{ subject: 'user', attribute: 'diet', value: 'vegetarian' }]);
    // Fact extraction never saw the assistant's reply.
    for (const p of llm.prompts('facts')) expect(p).not.toContain('Sure.');

    clock.advance(7 * DAY);
    const s2 = await aura.sessions.create();
    await aura.send(s2.id, 'Suggest something for dinner tonight');
    expect(lastUserBlock(llm.prompts('chat').at(-1)!)).toContain('Known facts about the user:\n- user diet: vegetarian');
  });

  it('knowledge update: keeps both values, newest is current', async () => {
    const { aura, clock } = await setup();
    const s = await aura.sessions.create();
    await aura.send(s.id, 'I live in Mumbai these days');
    await aura.runBackground();
    clock.advance(30 * DAY);
    await aura.send(s.id, 'Big news, I live in Pune now');
    await aura.runBackground();
    const all = await aura.facts.list();
    expect(all.map((f) => [f.value, f.isCurrent])).toEqual([['Pune', true], ['Mumbai', false]]);
  });

  it('builds an episodic summary per session that becomes searchable', async () => {
    const { aura } = await setup({ layers: { facts: false } });
    const s = await aura.sessions.create();
    await aura.send(s.id, 'Planning a trip to Kyoto in April');
    await aura.runBackground();
    const ep = await aura.episodes.get(s.id);
    expect(ep?.summary).toContain('summary');
    expect(ep?.sourceEventIds).toHaveLength(2);
    const hits = await aura.retriever.search('summary', { k: 5, types: ['episode'] });
    expect(hits[0]?.itemType).toBe('episode');
  });

  it('naive truncation (compression off) drops the oldest turns to stay in budget', async () => {
    const { aura } = await setup({ layers: { compression: false, retrieval: false, facts: false, episodic: false } }, smartResponder(), 1024);
    const s = await aura.sessions.create();
    let r;
    for (let i = 0; i < 40; i++) r = await aura.send(s.id, `Turn ${i}: ` + 'filler words '.repeat(12));
    expect(r!.debug.assembled.promptTokens).toBeLessThanOrEqual(r!.debug.assembled.budget);
    expect(r!.debug.assembled.droppedTurns).toBeGreaterThan(0);
    expect(r!.debug.assembled.prompt).not.toContain('Turn 0:');
  });

  it('rolling compression (L5): long chat stays in budget, compacts in batches, summary kept', async () => {
    const { aura, llm } = await setup({ layers: { facts: false, episodic: false, retrieval: false } }, smartResponder(), 1024);
    const s = await aura.sessions.create();
    const results = [];
    for (let i = 0; i < 60; i++) results.push(await aura.send(s.id, `Turn ${i}: ` + 'filler words '.repeat(12)));
    for (const r of results) expect(r.debug.assembled.promptTokens).toBeLessThanOrEqual(r.debug.assembled.budget);
    const compactions = results.filter((r) => r.debug.compaction?.compacted).length;
    expect(compactions).toBeGreaterThan(0);
    expect(compactions).toBeLessThan(results.length / 3); // batched, not every turn
    expect(llm.prompts('summary').length).toBe(compactions);
    expect(results.at(-1)!.debug.assembled.messages[0]!.content).toContain('Summary of the earlier part of this conversation');
    // Originals are still in the log.
    expect((await aura.log.listSession(s.id))[0]!.content).toContain('Turn 0:');
  });

  it('feedback → reflection adds one rule → rule appears in the next prompt', async () => {
    const { aura, llm } = await setup({ layers: { facts: false, episodic: false } });
    const s = await aura.sessions.create();
    const r = await aura.send(s.id, 'Explain quantum computing');
    await aura.feedback(r.assistantEvent.id, 'down', 'too long');
    await aura.runBackground();
    expect((await aura.playbook.list()).map((x) => x.rule)).toEqual(['Keep answers under three sentences.']);
    const r2 = await aura.send(s.id, 'Explain black holes');
    expect(llm.prompts('chat').at(-1)!.split('<|user|>')[0]).toContain('- Keep answers under three sentences.');
    // Rating the answer that used the rule credits the rule.
    await aura.feedback(r2.assistantEvent.id, 'up');
    expect((await aura.playbook.list())[0]!.helpful).toBe(1);
  });

  it('a user message interrupts a running background job, which resumes later', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let summaryCalls = 0;
    const respond = smartResponder({
      summary: async () => {
        summaryCalls++;
        if (summaryCalls === 1) await gate; // first attempt hangs until interrupted
        return '- summary';
      },
    });
    const { aura } = await setup({ layers: { facts: false } }, respond);
    const s = await aura.sessions.create();
    await aura.send(s.id, 'first message');
    const bg = aura.runBackground();
    await new Promise((r) => setTimeout(r, 10));
    expect(aura.jobs.isRunning).toBe(true);

    const sending = aura.send(s.id, 'second message'); // pause() aborts the job
    release();
    const r = await sending;
    await bg;
    expect(r.reply).toBe('Sure.');
    expect((await aura.jobs.list()).find((j) => j.type === 'episode')?.status).toBe('pending');
    await aura.runBackground();
    expect(await aura.jobs.pendingCount()).toBe(0);
    expect((await aura.episodes.get(s.id))?.sourceEventIds.length).toBe(4);
  });

  it('drops facts whose value does not appear in the message (grounding)', async () => {
    const { aura } = await setup({ layers: { episodic: false } }, smartResponder({
      facts: () => '{"states_personal_facts": true, "facts": [{"subject":"user","attribute":"name","value":"User"},{"subject":"user","attribute":"dog_name","value":"Rex"}]}',
    }));
    const s = await aura.sessions.create();
    await aura.send(s.id, 'My dog is called Rex');
    await aura.runBackground();
    expect((await aura.facts.list()).map((f) => f.value)).toEqual(['Rex']);
  });

  it('bad model output in background jobs never crashes; job retries then fails', async () => {
    const { aura } = await setup({ layers: { episodic: false } }, smartResponder({ facts: () => 'not json at all' }));
    const s = await aura.sessions.create();
    await aura.send(s.id, 'My dog is called Rex');
    for (let i = 0; i < 3; i++) await aura.runBackground();
    expect((await aura.jobs.list())[0]).toMatchObject({ type: 'facts', status: 'failed', attempts: 3 });
  });

  it('switching models keeps memory', async () => {
    const { aura, clock } = await setup({ layers: { facts: false, episodic: false } });
    const s = await aura.sessions.create();
    await aura.send(s.id, 'The wifi password is hunter2');
    clock.advance(DAY);
    await aura.setLLM(new FakeLLM(smartResponder(), 4096, 'other-model'));
    const s2 = await aura.sessions.create();
    const r = await aura.send(s2.id, 'what is the wifi password');
    expect(r.debug.retrieval.items.some((m) => m.text.includes('hunter2'))).toBe(true);
    expect(r.userEvent.modelId).toBe('other-model');
  });

  it('a changed embedder drops old vectors and re-embeds in the background', async () => {
    const { aura } = await setup({ layers: { facts: false, episodic: false } });
    const s = await aura.sessions.create();
    await aura.send(s.id, 'remember the blue umbrella');
    await aura.setEmbedder(new HashEmbedder(128));
    expect((await aura.db.all(`SELECT DISTINCT embedder_id FROM embeddings`))).toEqual([]);
    await aura.runBackground();
    expect((await aura.db.all<{ embedder_id: string }>(`SELECT DISTINCT embedder_id FROM embeddings`)).map((r) => r.embedder_id)).toEqual(['hash-128']);
  });

  it('router skips retrieval for small talk', async () => {
    const { aura } = await setup({ layers: { facts: false, episodic: false } });
    const s = await aura.sessions.create();
    await aura.send(s.id, 'my favourite colour is teal');
    const s2 = await aura.sessions.create();
    const r = await aura.send(s2.id, 'thanks!');
    expect(r.debug.route).toMatchObject({ retrieve: false, reason: 'small talk' });
    expect(r.debug.retrieval.items).toEqual([]);
  });

  it('stop button: aborted generation is logged as stopped', async () => {
    const ctrl = new AbortController();
    const { aura } = await setup({ layers: { facts: false, episodic: false } }, smartResponder({ chat: () => { ctrl.abort(); return 'partial'; } }));
    const s = await aura.sessions.create();
    const r = await aura.send(s.id, 'write me a long story', { signal: ctrl.signal });
    expect(r.debug.generation.stopReason).toBe('abort');
    expect(r.assistantEvent.meta).toMatchObject({ stopped: true });
  });
});

describe('Scroll-lite (L3, model-planned retrieval)', () => {
  const planner = (plans: string[]): Responder => {
    let i = 0;
    return smartResponder({ plan: () => plans[Math.min(i++, plans.length - 1)]! });
  };

  async function withHistory(respond: Responder) {
    const { aura, llm, clock } = await setup({ layers: { scrollLite: true, facts: false, episodic: false } }, respond);
    const s1 = await aura.sessions.create();
    await aura.send(s1.id, 'We had dinner at Trattoria Lucca, the pasta was great');
    clock.advance(2 * DAY);
    await aura.db.run('UPDATE models SET probe_passed = 1');
    return { aura, llm, s2: (await aura.sessions.create()).id };
  }

  it('runs planned operations (2 rounds max) and uses the results', async () => {
    const { aura, llm, s2 } = await withHistory(planner([
      '{"ops":[{"op":"keyword","terms":"Trattoria"}]}',
      '{"ops":[{"op":"get_event","id":1}]}',
      '{"ops":[{"op":"search","query":"never reached"}]}',
    ]));
    const r = await aura.send(s2, 'Which restaurant did we go to?');
    expect(r.debug.retrieval.method).toBe('scroll');
    expect(r.debug.scroll!.trace).toHaveLength(2); // capped at maxRounds
    expect(r.debug.retrieval.items.some((m) => m.text.includes('Trattoria Lucca'))).toBe(true);
    // Round 2 saw round 1's results.
    expect(llm.prompts('plan')[1]).toContain('Results so far:');
    expect(llm.calls.filter((c) => kindOf(c.prompt) === 'plan').every((c) => c.grammar?.includes('root ::='))).toBe(true);
  });

  it('planning prompt shares the chat prompt prefix (KV reuse)', async () => {
    const { aura, llm, s2 } = await withHistory(planner(['{"ops":[{"op":"search","query":"restaurant"}]}', '{"ops":[]}']));
    await aura.send(s2, 'Which restaurant did we go to?');
    const plan = llm.prompts('plan')[0]!;
    const chat = llm.prompts('chat').at(-1)!;
    const prefix = plan.slice(0, plan.lastIndexOf('<|user|>'));
    expect(chat.startsWith(prefix)).toBe(true);
  });

  it('falls back to hybrid search on invalid operations', async () => {
    const { aura, s2 } = await withHistory(planner(['{"ops":[{"op":"delete_everything"}]}']));
    const r = await aura.send(s2, 'Which restaurant did we go to?');
    expect(r.debug.retrieval.method).toBe('scroll→fallback');
    expect(r.debug.retrieval.items.some((m) => m.text.includes('Trattoria'))).toBe(true);
  });

  it('falls back when the probe has not passed', async () => {
    const { aura, s2 } = await withHistory(planner(['{"ops":[]}']));
    await aura.db.run('UPDATE models SET probe_passed = 0');
    const r = await aura.send(s2, 'Which restaurant did we go to?');
    expect(r.debug.retrieval.method).toBe('hybrid');
  });

  it('probe passes for sensible plans and fails for empty ones', async () => {
    const good = await setup({}, planner(['{"ops":[{"op":"search","query":"restaurant last week"}]}']));
    expect((await good.aura.runProbe()).passed).toBe(true);
    expect(await good.aura.probePassed()).toBe(true);
    const bad = await setup({}, planner(['{"ops":[]}']));
    expect((await bad.aura.runProbe()).passed).toBe(false);
  });

  it('count and filter_by_time operations', async () => {
    const { aura } = await withHistory(planner(['{"ops":[]}']));
    const exclude = new Set<string>();
    const [count] = await aura.scroll.execute({ op: 'count', query: 'pasta' }, exclude);
    expect(count!.text).toBe('1 past messages mention "pasta".');
    const inRange = await aura.scroll.execute({ op: 'filter_by_time', from: '2026-01-05', to: '2026-01-05' }, exclude);
    expect(inRange.map((m) => m.role)).toEqual(['assistant', 'user']);
    expect(await aura.scroll.execute({ op: 'filter_by_time', from: '2025-01-01', to: '2025-01-02' }, exclude)).toEqual([]);
  });
});

describe('Privacy — delete cascades', () => {
  it('deleting a message removes it and everything derived from it', async () => {
    const { aura } = await setup();
    const s = await aura.sessions.create();
    const r = await aura.send(s.id, 'My dog is called Biscuit');
    await aura.send(s.id, 'Also I like hiking');
    await aura.runBackground();
    expect(await aura.facts.list()).toHaveLength(1);
    expect(await aura.episodes.get(s.id)).toBeDefined();

    const report = await aura.forget.events([r.userEvent.id]);
    expect(report).toMatchObject({ events: 1, factsDeleted: 1, episodesRebuilt: 1 });
    expect(await aura.facts.list()).toHaveLength(0);
    const hits = await aura.retriever.search('Biscuit', { k: 5, types: ['event', 'fact', 'episode'] });
    expect(hits.filter((m) => /biscuit/i.test(m.text))).toEqual([]);
    expect(await aura.episodes.get(s.id)).toBeUndefined();
    await aura.runBackground(); // episode re-derived from what's left
    expect((await aura.episodes.get(s.id))!.sourceEventIds).not.toContain(r.userEvent.id);
  });

  it('deleting a fact with its sources makes it unfindable by any search', async () => {
    const { aura } = await setup({ layers: { episodic: false } });
    const s = await aura.sessions.create();
    await aura.send(s.id, 'My dog is called Biscuit');
    await aura.runBackground();
    const [fact] = await aura.facts.list();
    await aura.forget.fact(fact!.id, true);
    for (const mode of ['hybrid', 'vector', 'keyword'] as const)
      expect((await aura.retriever.search('Biscuit dog', { k: 5, types: ['event', 'fact', 'episode'], mode }))
        .filter((m) => /biscuit/i.test(m.text))).toEqual([]);
    expect(await aura.db.get(`SELECT 1 FROM fts WHERE fts MATCH '"biscuit"'`)).toBeUndefined();
  });

  it('deleting a session cascades; delete all wipes everything', async () => {
    const { aura } = await setup();
    const s = await aura.sessions.create();
    await aura.send(s.id, 'I live in Lisbon');
    await aura.runBackground();
    await aura.forget.session(s.id);
    expect(await aura.sessions.get(s.id)).toBeUndefined();
    expect(await aura.log.count()).toBe(0);
    expect(await aura.facts.list()).toHaveLength(0);

    const s2 = await aura.sessions.create();
    await aura.send(s2.id, 'hello again');
    await aura.forget.all();
    for (const t of ['events', 'sessions', 'facts', 'episodes', 'embeddings', 'fts', 'jobs'])
      expect((await aura.db.get<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`))!.n).toBe(0);
  });
});

describe('bulk ingestion + retrieve()', () => {
  it('ingests a past session in one go and finds it', async () => {
    const { aura } = await setup({ layers: { facts: false, episodic: false } });
    const s = await aura.sessions.create();
    const evs = await aura.ingestSession(s.id, [
      { role: 'user', content: 'I adopted a cat named Miso', ts: T0 },
      { role: 'assistant', content: 'Congrats on adopting Miso!', ts: T0 + 1000 },
    ]);
    expect(evs.map((e) => e.ts)).toEqual([T0, T0 + 1000]);
    expect((await aura.retrieve('cat Miso')).map((m) => m.itemId)).toEqual(expect.arrayContaining([evs[0]!.id]));
    aura.setConfig({ retrieval: { includeAssistant: false } });
    expect((await aura.retrieve('cat Miso')).every((m) => m.role !== 'assistant')).toBe(true);
  });
});
