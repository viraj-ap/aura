import { beforeEach, describe, expect, it } from 'vitest';
import { EventLog, Sessions } from '../src/log/eventLog';
import { TokenCounter } from '../src/log/tokens';
import { migrate } from '../src/store/schema';
import { ManualClock, type SqlDb } from '../src/types';
import { FakeLLM, T0, memoryDb } from './helpers';

describe('EventLog (L1)', () => {
  let db: SqlDb;
  let clock: ManualClock;
  let log: EventLog;
  let sid: number;

  beforeEach(async () => {
    db = memoryDb();
    await migrate(db);
    clock = new ManualClock(T0);
    log = new EventLog(db, clock);
    sid = (await new Sessions(db, clock).create()).id;
  });

  it('appends with timestamps from the injected clock', async () => {
    const a = await log.append({ sessionId: sid, type: 'message', role: 'user', content: 'hi' });
    clock.advance(5000);
    const b = await log.append({ sessionId: sid, type: 'message', role: 'assistant', content: 'hello', modelId: 'm1' });
    expect(a.ts).toBe(T0);
    expect(b.ts).toBe(T0 + 5000);
    expect(await log.get(b.id)).toMatchObject({ role: 'assistant', content: 'hello', modelId: 'm1' });
  });

  it('accepts explicit timestamps for eval replays', async () => {
    const e = await log.append({ sessionId: sid, type: 'message', role: 'user', content: 'old', ts: 1000 });
    expect((await log.get(e.id))!.ts).toBe(1000);
  });

  it('lists a session in order, after an id, filtered by type', async () => {
    const ids = [];
    for (const c of ['a', 'b', 'c']) ids.push((await log.append({ sessionId: sid, type: 'message', role: 'user', content: c })).id);
    await log.append({ sessionId: sid, type: 'feedback', role: 'user', content: '', meta: { targetId: ids[0] } });
    expect((await log.listSession(sid)).map((e) => e.content)).toEqual(['a', 'b', 'c']);
    expect((await log.listSession(sid, { afterId: ids[0] })).map((e) => e.content)).toEqual(['b', 'c']);
    expect(await log.listSession(sid, { types: ['feedback'] })).toHaveLength(1);
  });

  it('has no update API (append-only by construction)', () => {
    expect(Object.getOwnPropertyNames(EventLog.prototype).filter((m) => /update|edit|set/i.test(m))).toEqual([]);
  });

  it('round-trips meta', async () => {
    const e = await log.append({ sessionId: sid, type: 'feedback', role: 'user', content: '', meta: { targetId: 3, value: 'up' } });
    expect((await log.get(e.id))!.meta).toEqual({ targetId: 3, value: 'up' });
  });

  it('handles 10K events quickly', async () => {
    const t = performance.now();
    await db.transaction(async () => {
      for (let i = 0; i < 10_000; i++) await log.append({ sessionId: sid, type: 'message', role: i % 2 ? 'assistant' : 'user', content: `message ${i}` });
    });
    const appendMs = performance.now() - t;
    expect(await log.count()).toBe(10_000);
    const t2 = performance.now();
    const tail = await log.listSession(sid, { afterId: 9990 });
    expect(tail).toHaveLength(10);
    expect(performance.now() - t2).toBeLessThan(50);
    expect(appendMs).toBeLessThan(5000);
  });
});

describe('TokenCounter', () => {
  it('caches event counts per (event, model)', async () => {
    const db = memoryDb();
    await migrate(db);
    const clock = new ManualClock(T0);
    const sid = (await new Sessions(db, clock).create()).id;
    const ev = await new EventLog(db, clock).append({ sessionId: sid, type: 'message', role: 'user', content: 'twelve chars' });

    let llm = new FakeLLM(undefined, 2048, 'model-a');
    const tc = new TokenCounter(db, () => llm);
    expect(await tc.countEvent(ev)).toBe(3);
    await tc.countEvent(ev);
    expect(llm.countCalls).toBe(1); // second call served from SQLite

    llm = new FakeLLM(undefined, 2048, 'model-b'); // switching model → new tokenizer → recount
    await tc.countEvent(ev);
    expect(llm.countCalls).toBe(1);
    const rows = await db.all('SELECT model_id FROM token_counts WHERE event_id = ?', [ev.id]);
    expect(rows).toHaveLength(2);
  });
});
