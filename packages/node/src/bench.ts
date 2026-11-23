// Retrieval latency at 10K events (target: retrieval + assembly ≤ 300 ms).
// Uses 384-dim vectors (same size as bge-small) from the hash embedder so the run needs no model.
import { Aura, HashEmbedder, ManualClock } from '@aura/core';
import { openSqlite } from './sqlite';

const N = Number(process.env.N ?? 10_000);
const fakeLlm = { id: 'bench', contextLength: 8192, countTokens: async (t: string) => Math.ceil(t.length / 4),
  applyTemplate: async (m: { content: string }[]) => m.map((x) => x.content).join('\n'), complete: async () => { throw new Error('unused'); } };
const clock = new ManualClock(Date.UTC(2026, 0, 1));
const aura = await Aura.open({ db: openSqlite(':memory:'), llm: fakeLlm, embedder: new HashEmbedder(384), clock, config: { layers: { facts: false, episodic: false } } });
const topics = ['dog', 'trip', 'Kyoto', 'budget', 'gym', 'recipe', 'pasta', 'meeting', 'sister', 'birthday', 'car', 'rent', 'movie', 'book', 'piano'];
let t = performance.now();
let sid = (await aura.sessions.create()).id;
for (let i = 0; i < N; i++) {
  if (i % 40 === 0) sid = (await aura.sessions.create()).id;
  clock.advance(60_000);
  await aura.ingest(sid, i % 2 ? 'assistant' : 'user', `Message ${i} about ${topics[i % topics.length]} and ${topics[(i * 7) % topics.length]}, with some extra words to make it realistic.`);
}
console.log(`ingest ${N} events: ${Math.round(performance.now() - t)}ms (${((performance.now() - t) / N).toFixed(2)} ms/event incl. FTS + vector)`);
const times: number[] = [];
for (const q of ['what did I say about Kyoto?', 'my sister birthday plans', 'pasta recipe', 'gym schedule', 'car rent budget']) {
  t = performance.now();
  const items = aura.retriever.rerank(await aura.retriever.search(q, { k: 8 }));
  times.push(performance.now() - t);
  if (!items.length) throw new Error('no results');
}
times.sort((a, b) => a - b);
console.log(`hybrid search + rerank over ${N} events: median ${times[2]!.toFixed(1)}ms, max ${times[4]!.toFixed(1)}ms (first call includes loading vectors)`);
