import { describe, expect, it } from 'vitest';
import { allocate } from '../src/context/budget';
import { defaultConfig } from '../src/config';
import { Aura } from '../src/engine';
import { HashEmbedder } from '../src/indexes/hashEmbedder';
import { ManualClock } from '../src/types';
import { FakeLLM, T0, lastUserBlock, memoryDb } from './helpers';

async function setup(ctx = 2048) {
  const llm = new FakeLLM(() => 'ok', ctx);
  const aura = await Aura.open({ db: memoryDb(), llm, embedder: new HashEmbedder(), clock: new ManualClock(T0), config: { outputReserve: 256 } });
  return { aura, llm };
}

// ~40 paragraphs of filler with one fact buried in the middle: far bigger than a 2K context.
const longDoc = Array.from({ length: 40 }, (_, i) =>
  i === 23 ? 'Section 24. The warranty period for the Zephyr blender is 7 years from purchase.'
    : `Section ${i + 1}. General terms about shipping, returns, packaging and customer service apply here in full detail.`).join('\n\n');

describe('attachments', () => {
  it('a short file goes into the prompt whole, labelled with its name', async () => {
    const { aura, llm } = await setup();
    const s = await aura.sessions.create();
    const f = await aura.attach(s.id, { kind: 'image', name: 'receipt.jpg', text: 'Total: $42.10 at Corner Cafe' });
    await aura.send(s.id, 'how much did I pay?', { attachmentIds: [f.id] });
    const block = lastUserBlock(llm.calls.at(-1)!.prompt);
    expect(block).toContain('Files the user attached');
    expect(block).toContain('receipt.jpg');
    expect(block).toContain('$42.10');
  });

  it('a long file is cut to the budget but keeps the part that answers the question', async () => {
    const { aura, llm } = await setup();
    const s = await aura.sessions.create();
    const f = await aura.attach(s.id, { kind: 'pdf', name: 'terms.pdf', text: longDoc, pages: 9 });
    const r = await aura.send(s.id, 'how long is the warranty for the Zephyr blender?', { attachmentIds: [f.id] });
    const block = lastUserBlock(llm.calls.at(-1)!.prompt);
    expect(block).toContain('7 years');
    expect(block).toContain('terms.pdf (9 pages)');
    expect(r.debug.assembled.promptTokens).toBeLessThanOrEqual(r.debug.assembled.budget);
    expect(r.debug.assembled.sections.attached.items).toBeGreaterThan(0);
  });

  it('is found by search in a later chat, and forgetting it removes every trace', async () => {
    const { aura, llm } = await setup();
    const s1 = await aura.sessions.create();
    const f = await aura.attach(s1.id, { kind: 'pdf', name: 'terms.pdf', text: longDoc });
    const s2 = await aura.sessions.create();
    await aura.send(s2.id, 'what was the Zephyr blender warranty again?');
    expect(lastUserBlock(llm.calls.at(-1)!.prompt)).toContain('File "terms.pdf"');

    await aura.forget.events([f.id]);
    expect(await aura.db.get('SELECT 1 FROM fts WHERE item_type = ? AND item_id = ?', ['event', f.id])).toBeUndefined();
    expect(await aura.db.get('SELECT 1 FROM embeddings WHERE item_type = ? AND item_id = ?', ['event', f.id])).toBeUndefined();
    // The chat-2 question itself still matches; the file's text must not.
    expect((await aura.retrieve('Zephyr blender warranty 7 years')).filter((m) => m.source || m.text.includes('7 years'))).toEqual([]);
  });

  it('web results are cited, stored on the reply as sources, and never added to memory', async () => {
    const { aura, llm } = await setup();
    const s = await aura.sessions.create();
    const r = await aura.send(s.id, 'who won the race?', { web: [{ title: 'Race report', url: 'https://example.com/r', text: 'Driver X won the Grand Prix.' }] });
    const block = lastUserBlock(llm.calls.at(-1)!.prompt);
    expect(block).toContain('[1] Race report — https://example.com/r');
    expect(block).toContain('Driver X won');
    expect(r.assistantEvent.meta?.webSources).toEqual([{ title: 'Race report', url: 'https://example.com/r' }]);
    expect((await aura.retrieve('Driver X Grand Prix')).some((m) => m.text.includes('Driver X won'))).toBe(false);
  });

  it('turns without attachments split the budget exactly as before', () => {
    const needs = { system: 50, playbook: 0, facts: 0, retrieved: 900, recent: 900 };
    const { attached: _a, ...shares } = defaultConfig.shares;
    // Old behaviour: shares without 'attached' (re-added as 0 so the type matches).
    expect(allocate(1000, defaultConfig.shares, needs)).toEqual(allocate(1000, { ...shares, attached: 0 }, needs));
  });
});
