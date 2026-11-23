// Live end-to-end check against real llama-servers (chat on :8080, embedder on :8081).
// Usage: npm run smoke -w @aura/node   — uses a throwaway DB, prints what each layer did.
import { Aura, ManualClock, formatMemory } from '@aura/core';
import { LlamaServerEmbedder, LlamaServerLLM } from './llamaServer';
import { openSqlite } from './sqlite';

const DAY = 86_400_000;
const llm = await LlamaServerLLM.connect(process.env.AURA_LLM ?? 'http://127.0.0.1:8080');
const embedder = await LlamaServerEmbedder.connect(process.env.AURA_EMBED ?? 'http://127.0.0.1:8081');
const clock = new ManualClock(Date.UTC(2026, 9, 1, 9, 0));
const aura = await Aura.open({ db: openSqlite(':memory:'), llm, embedder, clock, config: { temperature: 0, outputReserve: 256 } });
console.log(`model ${llm.id} ctx ${llm.contextLength} · embedder ${embedder.id}`);

// "memory" checks: did the right information reach the prompt? (engine bugs → fail)
// "model" checks: did the model use it? (depends on model size → warn only)
let ok = 0, fail = 0, warn = 0;
const check = (name: string, cond: boolean, detail = '', kind: 'memory' | 'model' = 'memory') => {
  if (cond) ok++;
  else if (kind === 'model') warn++;
  else fail++;
  console.log(`${cond ? '✅' : kind === 'model' ? '⚠️ ' : '❌'} ${kind === 'model' ? '[model] ' : ''}${name}${detail ? ' — ' + detail : ''}`);
};
const say = async (sid: number, text: string) => {
  const t = performance.now();
  const r = await aura.send(sid, text);
  const d = r.debug;
  console.log(`\n> ${text}\n< ${r.reply.slice(0, 300)}`);
  console.log(`  [${d.assembled.promptTokens}/${d.assembled.budget} tok · cached ${d.generation.cachedTokens} · ${d.retrieval.method} ${d.assembled.memoryKeys.length} mem · ${d.assembled.factIds.length} facts · ttft ${d.generation.ttftMs}ms · total ${Math.round(performance.now() - t)}ms]`);
  return r;
};

// Session 1: personal facts.
const s1 = (await aura.sessions.create()).id;
await say(s1, "Hi! I'm Viraj. My dog is called Biscuit and I live in Mumbai.");
await say(s1, "I'm vegetarian, so please keep that in mind for recipes.");
let t = performance.now();
await aura.runBackground();
console.log(`\n[background jobs: ${Math.round(performance.now() - t)}ms]`);
const facts = await aura.facts.list();
for (const f of facts) console.log(`  fact: ${f.subject} · ${f.attribute} = ${f.value} (${f.isCurrent ? 'current' : 'old'})`);
check('facts extracted from user messages', facts.length >= 2, `${facts.length} facts`);
check('dog name fact', facts.some((f) => /biscuit/i.test(f.value)));
const ep = await aura.episodes.get(s1);
check('episode summary written', !!ep, ep?.summary.slice(0, 160).replace(/\n/g, ' '));

// Session 2, days later: recall across sessions.
clock.advance(5 * DAY);
const s2 = (await aura.sessions.create()).id;
const r1 = await say(s2, "What's my dog's name?");
check('dog name reached the prompt', /biscuit/i.test(r1.debug.assembled.prompt));
check('cross-session recall (dog)', /biscuit/i.test(r1.reply), r1.reply.slice(0, 80), 'model');
const r2 = await say(s2, 'Suggest a quick dinner for me tonight.');
check('preference applied (vegetarian)', !/chicken|beef|pork|fish|mutton|lamb/i.test(r2.reply), r2.reply.slice(0, 80), 'model');
check('stable prefix reused from KV cache', r2.debug.generation.cachedTokens > 0, `${r2.debug.generation.cachedTokens} cached`);

// Knowledge update.
clock.advance(20 * DAY);
await say(s2, 'Update: I moved from Mumbai to Pune last week.');
await aura.runBackground();
const city = (await aura.facts.list()).filter((f) => /city|live|location|resid/i.test(f.attribute));
for (const f of city) console.log(`  city fact: ${f.attribute} = ${f.value} (${f.isCurrent ? 'current' : 'old'})`);
check('knowledge update: Pune is current', city.some((f) => /pune/i.test(f.value) && f.isCurrent));
const s3 = (await aura.sessions.create()).id;
const r3 = await say(s3, 'Which city do I live in now?');
check('updated city is current in the facts section', /home.city: Pune/i.test(r3.debug.assembled.prompt));
check('answers with the updated city', /pune/i.test(r3.reply), r3.reply.slice(0, 80), 'model');

// Compression: a long chat in a small budget.
aura.setConfig({ ramSafeTokens: 1200 });
const s4 = (await aura.sessions.create()).id;
await say(s4, 'Remember this code for later: the locker combination is 4-8-15.');
let compacted = 0;
for (let i = 0; i < 8; i++) {
  const r = await say(s4, `Tell me one short fun fact about the number ${i + 2}.`);
  if (r.debug.compaction?.compacted) compacted++;
}
const r4 = await say(s4, 'What was the locker combination I told you at the start of this chat?');
check('compaction happened in a tight budget', compacted > 0, `${compacted} compactions`);
check('turn-1 detail survives compaction (in prompt)', r4.debug.assembled.prompt.includes('4-8-15'));
check('still recalls turn 1 after compaction', /4-8-15|4, 8, 15|4 8 15/.test(r4.reply), r4.reply.slice(0, 100), 'model');
aura.setConfig({ ramSafeTokens: undefined as unknown as number });

// Playbook.
const r5 = await say(s3, 'Explain how a rainbow forms.');
await aura.feedback(r5.assistantEvent.id, 'down', 'too long, keep it to two sentences');
await aura.runBackground();
const rules = await aura.playbook.list();
for (const r of rules) console.log(`  rule [${r.id}]: ${r.rule}`);
check('reflection produced a rule', rules.length > 0);

// Scroll-lite probe + one planned retrieval.
const probe = await aura.runProbe();
for (const d of probe.details) console.log('  ' + d);
console.log(`  probe ${probe.passed ? 'PASSED' : 'FAILED'} for ${llm.id}`);
if (probe.passed) {
  aura.setConfig({ layers: { scrollLite: true } });
  const r6 = await say((await aura.sessions.create()).id, 'What did I tell you about my diet?');
  for (const tr of r6.debug.scroll?.trace ?? []) console.log(`  round ${tr.round} (${tr.ms}ms): ${tr.raw.replace(/\s+/g, ' ').slice(0, 160)}`);
  for (const m of r6.debug.retrieval.items.slice(0, 4)) console.log(`  · ${formatMemory(m).slice(0, 120)}`);
  check('Scroll-lite produced a valid plan', r6.debug.retrieval.method === 'scroll', r6.debug.retrieval.method, 'model');
}

console.log(`\n${ok} passed, ${fail} failed, ${warn} model warnings`);
process.exit(fail ? 1 : 0);
