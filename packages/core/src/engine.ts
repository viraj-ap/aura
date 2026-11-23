import { type Assembled, type AttachedPiece, Assembler } from './context/assembler';
import { activeSections, promptBudget } from './context/budget';
import { type CompactResult, Compressor } from './compression/rolling';
import { type AuraConfig, type DeepPartial, defaultConfig, mergeConfig } from './config';
import { Episodes } from './indexes/episodic';
import { Facts } from './indexes/facts';
import { chunkText } from './indexes/chunker';
import { Indexer } from './indexes/indexer';
import { VectorIndex, dot, normalize } from './indexes/vector';
import { JobQueue } from './jobs/queue';
import { EventLog, Sessions } from './log/eventLog';
import { TokenCounter } from './log/tokens';
import { Playbook } from './playbook/playbook';
import { Forget } from './privacy/forget';
import { type MemoryItem, Retriever, ftsQuery } from './selection/retriever';
import { type RouteDecision, route } from './selection/router';
import { type ScrollResult, ScrollLite } from './selection/scrollLite';
import { migrate } from './store/schema';
import type { AuraEvent, Clock, CompletionResult, Embedder, HostHooks, LLM, SqlDb } from './types';
import { systemClock } from './types';
import { oneLine, stripReasoning, truncateChars } from './util/text';

export type Status = 'compressing' | 'searching memory' | 'generating' | 'idle';

export interface SendOptions {
  onToken?: (piece: string) => void;
  onStatus?: (s: Status) => void;
  signal?: AbortSignal;
  /** Eval replays: timestamp for the user message (defaults to the clock). */
  ts?: number;
  /** Files added with `attach()` that this message is about. */
  attachmentIds?: number[];
  /** Web search results for this turn only; never stored. */
  web?: WebSource[];
}

export interface WebSource {
  title: string;
  url: string;
  /** Readable text of the page (or its search snippet). */
  text: string;
}

export interface AttachmentInput {
  kind: 'pdf' | 'image' | 'text';
  name: string;
  /** Extracted text (pdf.js / OCR happen in the host; core stays platform-free). */
  text: string;
  pages?: number;
}

export interface TurnDebug {
  route: RouteDecision;
  retrieval: { method: 'none' | 'hybrid' | 'vector' | 'keyword' | 'scroll' | 'scroll→fallback'; items: MemoryItem[]; ms: number };
  scroll?: ScrollResult;
  compaction?: CompactResult;
  assembled: Assembled;
  generation: Omit<CompletionResult, 'text'>;
}

export interface TurnResult {
  userEvent: AuraEvent;
  assistantEvent: AuraEvent;
  reply: string;
  debug: TurnDebug;
}

export interface AuraDeps {
  db: SqlDb;
  llm: LLM;
  embedder?: Embedder | null;
  clock?: Clock;
  config?: DeepPartial<AuraConfig>;
  hooks?: HostHooks;
}

/**
 * The memory engine. Per message:
 * pause jobs → append → index → compress if needed → route → select (Scroll-lite or
 * hybrid) → budget/rank/order → generate on the cached prefix → append reply → queue jobs.
 */
export class Aura {
  readonly log: EventLog;
  readonly sessions: Sessions;
  readonly tokens: TokenCounter;
  readonly indexer: Indexer;
  readonly retriever: Retriever;
  readonly episodes: Episodes;
  readonly facts: Facts;
  readonly playbook: Playbook;
  readonly jobs: JobQueue;
  readonly forget: Forget;
  readonly scroll: ScrollLite;
  readonly compressor: Compressor;
  readonly assembler: Assembler;
  config: AuraConfig;
  lastDebug: TurnDebug | null = null;

  private llm: LLM;
  private embedder: Embedder | null;
  private clock: Clock;

  private constructor(readonly db: SqlDb, deps: AuraDeps) {
    const clock = deps.clock ?? systemClock;
    this.llm = deps.llm;
    this.embedder = deps.embedder ?? null;
    this.config = mergeConfig(defaultConfig, deps.config);
    const cfg = () => this.config;
    const llm = () => this.llm;

    this.log = new EventLog(db, clock);
    this.sessions = new Sessions(db, clock);
    this.tokens = new TokenCounter(db, llm);
    this.indexer = new Indexer(db, new VectorIndex(db), () => this.embedder, this.config.chunkTokens);
    this.retriever = new Retriever(db, this.indexer, () => this.embedder, cfg, clock);
    this.episodes = new Episodes(db, this.log, this.indexer, llm);
    this.facts = new Facts(db, this.log, this.indexer, llm);
    this.playbook = new Playbook(db, this.log, this.tokens, llm, clock);
    this.jobs = new JobQueue(db, clock, deps.hooks?.canRunBackgroundLLM);
    this.forget = new Forget(db, this.indexer, this.jobs);
    this.scroll = new ScrollLite(db, this.log, this.retriever, this.facts, cfg, clock);
    this.compressor = new Compressor(db, this.log, this.tokens, llm, cfg, clock);
    this.assembler = new Assembler(this.tokens, llm);
    this.clock = clock;

    const slot = () => this.config.jobSlot;
    this.jobs.register('episode', (p, signal) => this.episodes.update(Number(p.sessionId), { signal, slot: slot() }));
    this.jobs.register('facts', async (p, signal) => void (await this.facts.extractFrom(Number(p.eventId), { signal, slot: slot() })));
    this.jobs.register('reflect', async (p, signal) => void (await this.playbook.reflect(Number(p.feedbackEventId), { signal, slot: slot() })));
    this.jobs.register('embed', (_p, signal) => this.embedMissing(signal));
  }

  static async open(deps: AuraDeps): Promise<Aura> {
    await migrate(deps.db);
    const aura = new Aura(deps.db, deps);
    await aura.jobs.recover();
    await aura.registerModel();
    await aura.checkEmbedder();
    return aura;
  }

  get model(): LLM {
    return this.llm;
  }

  get currentEmbedder(): Embedder | null {
    return this.embedder;
  }

  setConfig(patch: DeepPartial<AuraConfig>): void {
    this.config = mergeConfig(this.config, patch);
  }

  /** Switch chat model. Memory is untouched; token counts are cached per model. */
  async setLLM(llm: LLM): Promise<void> {
    await this.jobs.pause();
    this.llm = llm;
    await this.registerModel();
    this.jobs.resume();
  }

  async setEmbedder(embedder: Embedder | null): Promise<void> {
    this.embedder = embedder;
    await this.checkEmbedder();
  }

  // ---------------------------------------------------------------- chat

  async send(sessionId: number, text: string, opts: SendOptions = {}): Promise<TurnResult> {
    await this.jobs.pause(); // the user always comes first
    try {
      return await this.turn(sessionId, text, opts);
    } finally {
      this.jobs.resume();
      opts.onStatus?.('idle');
    }
  }

  private async turn(sessionId: number, text: string, opts: SendOptions): Promise<TurnResult> {
    const cfg = this.config;
    const llm = this.llm;

    const attachmentIds = opts.attachmentIds ?? [];
    const web = opts.web ?? [];
    const userEv = await this.log.append({ sessionId, type: 'message', role: 'user', content: text, modelId: llm.id, ts: opts.ts,
      meta: attachmentIds.length || web.length
        ? { attachmentIds, webSources: web.map((w) => ({ title: w.title, url: w.url })) } : null });
    await this.indexEvent(userEv);
    await this.maybeTitle(sessionId, text);
    const now = userEv.ts;

    // Budget + L5 compression (batched; usually a no-op).
    const budget = promptBudget(llm.contextLength, cfg.ramSafeTokens, cfg.outputReserve);
    const attached = await this.attachedPieces(text, attachmentIds, web);
    const attachedNeed = attached.length;
    // Same split the assembler will use, so compression triggers at the same point it always did.
    const shareSum = activeSections({ attached: attachedNeed }).reduce((a, s) => a + cfg.shares[s], 0);
    const recentCap = Math.floor((budget * cfg.shares.recent) / shareSum);
    let compaction: CompactResult | undefined;
    if (cfg.layers.compression) {
      compaction = await this.compressor.maybeCompact(sessionId, userEv, recentCap, opts.signal, () => opts.onStatus?.('compressing'));
    }
    const summary = cfg.layers.compression ? (await this.compressor.latest(sessionId))?.summary ?? null : null;
    const turns = await this.compressor.workingTurns(sessionId, userEv.id);
    const rules = cfg.layers.playbook ? await this.playbook.forPrompt(cfg.playbookCapTokens) : [];

    const base = {
      systemPrompt: cfg.systemPrompt, rules, summary, turns, query: userEv, facts: [] as MemoryItem[],
      memories: [] as MemoryItem[], now, budget, shares: cfg.shares, edgeOrdering: cfg.layers.edgeOrdering, thinking: cfg.thinking,
      relativeTime: cfg.presentation.relativeTime,
    };

    // L3 selection. Anything already in the recent turns is excluded from retrieval.
    // Attached files are already in the prompt in full or as their best excerpts.
    const exclude = new Set([...turns.map((e) => `event:${e.id}`), `event:${userEv.id}`, ...attachmentIds.map((id) => `event:${id}`)]);
    const retrieval = await this.select(text, base, exclude, opts);

    const facts = cfg.layers.facts ? await this.selectFacts(text) : [];
    const assembled = await this.assembler.assemble({ ...base, facts, memories: retrieval.items, attached });

    opts.onStatus?.('generating');
    const gen = await llm.complete({
      prompt: assembled.prompt, maxTokens: cfg.outputReserve, temperature: cfg.temperature,
      onToken: opts.onToken, signal: opts.signal, purpose: 'chat',
    });
    const reply = stripReasoning(gen.text);
    const assistantEv = await this.log.append({
      sessionId, type: 'message', role: 'assistant', content: reply, modelId: llm.id, ts: opts.ts !== undefined ? opts.ts + 1 : undefined,
      meta: { ruleIds: assembled.ruleIds, memoryKeys: assembled.memoryKeys, factIds: assembled.factIds,
        ...(web.length ? { webSources: web.map((w) => ({ title: w.title, url: w.url })) } : {}),
        ...(gen.stopReason === 'abort' ? { stopped: true } : {}) },
    });
    if (reply) await this.indexEvent(assistantEv);

    // Heat: things that made it into the prompt get warmer.
    await this.facts.touch(assembled.factIds, now);
    await this.episodes.touch(assembled.memoryKeys.filter((k) => k.startsWith('episode:')).map((k) => Number(k.split(':')[1])), now);

    if (cfg.layers.facts) await this.jobs.enqueue('facts', { eventId: userEv.id });
    if (cfg.layers.episodic) await this.jobs.enqueue('episode', { sessionId }, `episode:${sessionId}`);

    const { text: _t, ...generation } = gen;
    const debug: TurnDebug = { route: retrieval.route, retrieval: { method: retrieval.method, items: retrieval.items, ms: retrieval.ms },
      scroll: retrieval.scroll, compaction, assembled, generation };
    this.lastDebug = debug;
    return { userEvent: userEv, assistantEvent: assistantEv, reply, debug };
  }

  private async select(text: string, base: Parameters<Assembler['assemble']>[0], exclude: Set<string>, opts: SendOptions) {
    const cfg = this.config;
    const t0 = Date.now();
    const none = (r: RouteDecision) => ({ route: r, method: 'none' as const, items: [] as MemoryItem[], ms: 0, scroll: undefined as ScrollResult | undefined });
    if (!cfg.layers.retrieval && !cfg.layers.scrollLite) return none({ retrieve: false, reason: 'retrieval off' });

    const total = (await this.db.get<{ n: number }>(`SELECT COUNT(*) n FROM fts`))!.n;
    const r = cfg.layers.router ? route(text, total > exclude.size) : { retrieve: true, reason: 'router off' };
    if (!r.retrieve) return none(r);

    let scroll: ScrollResult | undefined;
    if (cfg.layers.scrollLite && (await this.probePassed())) {
      opts.onStatus?.('searching memory');
      const render = async (block: string) => (await this.assembler.assemble({ ...base, finalOverride: block })).prompt;
      scroll = await this.scroll.run(this.llm, text, render, exclude, opts.signal);
      if (scroll.ok) return { route: r, method: 'scroll' as const, items: scroll.items, ms: Date.now() - t0, scroll };
    }
    if (!cfg.layers.retrieval && !scroll) return none(r);
    const items = await this.retriever.search(text, { k: cfg.retrieval.k, exclude });
    return { route: r, method: scroll ? ('scroll→fallback' as const) : cfg.retrieval.mode,
      items: this.retriever.rerank(items), ms: Date.now() - t0, scroll };
  }

  /** Current facts relevant to the query, plus the hottest ones (name, job…) that matter everywhere. */
  async selectFacts(query: string): Promise<MemoryItem[]> {
    const current = new Set((await this.db.all<{ id: number }>('SELECT id FROM facts WHERE is_current = 1')).map((r) => r.id));
    if (current.size === 0) return [];
    const found = await this.retriever.search(query, { k: 12, types: ['fact'] });
    const hot = await this.db.all<{ id: number }>(
      'SELECT id FROM facts WHERE is_current = 1 ORDER BY heat DESC, confidence DESC, last_seen DESC LIMIT 5');
    const keys = [...new Set([...found.map((m) => m.key), ...hot.map((h) => `fact:${h.id}`)])]
      .filter((k) => current.has(Number(k.split(':')[1])));
    const rel = new Map(found.map((m) => [m.key, m.relevance]));
    return this.retriever.rerank(await this.retriever.hydrate(keys, 'facts', rel));
  }

  // ---------------------------------------------------------------- feedback / ingest / jobs

  /** Thumbs up/down on an assistant message → log it, rate the rules used, queue reflection. */
  async feedback(assistantEventId: number, value: 'up' | 'down', comment = ''): Promise<AuraEvent> {
    const target = await this.log.get(assistantEventId);
    if (!target || target.role !== 'assistant') throw new Error(`event ${assistantEventId} is not an assistant message`);
    const fb = await this.log.append({ sessionId: target.sessionId, type: 'feedback', role: 'user', content: comment,
      modelId: this.llm.id, meta: { targetId: assistantEventId, value } });
    if (this.config.layers.playbook) {
      await this.playbook.rate(((target.meta?.ruleIds as number[]) ?? []), value);
      await this.jobs.enqueue('reflect', { feedbackEventId: fb.id });
    }
    return fb;
  }

  /**
   * Add a file's extracted text to memory. It is chunked and indexed like a message, so
   * it can be asked about now (pass its id in `send`) and found by search in later chats.
   */
  async attach(sessionId: number, file: AttachmentInput): Promise<AuraEvent> {
    const content = file.text.trim();
    if (!content) throw new Error(`No text found in ${file.name}.`);
    const ev = await this.log.append({ sessionId, type: 'attachment', role: 'user', content, modelId: null,
      meta: { kind: file.kind, name: file.name, ...(file.pages ? { pages: file.pages } : {}) } });
    await this.indexEvent(ev);
    return ev;
  }

  /** Add a historical message without generating (eval ingestion, imports). */
  async ingest(sessionId: number, role: 'user' | 'assistant', content: string, ts?: number): Promise<AuraEvent> {
    const ev = await this.log.append({ sessionId, type: 'message', role, content, modelId: null, ts });
    await this.indexEvent(ev);
    if (role === 'user' && this.config.layers.facts) await this.jobs.enqueue('facts', { eventId: ev.id });
    if (this.config.layers.episodic) await this.jobs.enqueue('episode', { sessionId }, `episode:${sessionId}`);
    return ev;
  }

  /**
   * Bulk import of a past conversation (eval haystacks, imports): appends every turn,
   * indexes them with batched embeddings, then queues the same jobs a live chat would.
   */
  async ingestSession(sessionId: number, turns: { role: 'user' | 'assistant'; content: string; ts: number }[]): Promise<AuraEvent[]> {
    const events = await this.db.transaction(async () => {
      const out: AuraEvent[] = [];
      for (const t of turns) out.push(await this.log.append({ sessionId, type: 'message', role: t.role, content: t.content, modelId: null, ts: t.ts }));
      return out;
    });
    const failed = await this.indexer.indexMany(events.filter((e) => e.content.trim()).map((e) => ({ itemType: 'event' as const, itemId: e.id, text: e.content })));
    if (failed.length) await this.jobs.enqueue('embed', {}, 'embed');
    if (this.config.layers.facts) for (const e of events) if (e.role === 'user') await this.jobs.enqueue('facts', { eventId: e.id });
    if (this.config.layers.episodic && events.length) await this.jobs.enqueue('episode', { sessionId }, `episode:${sessionId}`);
    return events;
  }

  /** Fallback retrieval exactly as a chat turn would run it (hybrid/vector/keyword + rerank). For recall@k runs. */
  async retrieve(query: string, k = this.config.retrieval.k, exclude = new Set<string>()): Promise<MemoryItem[]> {
    return this.retriever.rerank(await this.retriever.search(query, { k, exclude }));
  }

  /** Run queued background jobs until the queue is empty or the user sends a message. */
  runBackground(): Promise<void> {
    this.jobs.resume();
    return this.jobs.drain();
  }

  // ---------------------------------------------------------------- Scroll-lite probe

  async probePassed(): Promise<boolean> {
    const r = await this.db.get<{ probe_passed: number | null }>('SELECT probe_passed FROM models WHERE id = ?', [this.llm.id]);
    return r?.probe_passed === 1;
  }

  async runProbe(signal?: AbortSignal): Promise<{ passed: boolean; details: string[] }> {
    const cfg = this.config;
    const render = async (block: string) => this.llm.applyTemplate(
      [{ role: 'system', content: cfg.systemPrompt }, { role: 'user', content: block }], { thinking: false });
    const res = await this.scroll.probe(this.llm, render, signal);
    await this.db.run('UPDATE models SET probe_passed = ? WHERE id = ?', [res.passed ? 1 : 0, this.llm.id]);
    return res;
  }

  // ---------------------------------------------------------------- internals

  /**
   * This turn's attached context as ranked pieces. Each file is split into the same chunks it was
   * embedded with and ranked against the question (cosine on its stored vectors, plus keyword hits),
   * so a long PDF contributes its most relevant parts. Sources are interleaved by rank so one big
   * file can't crowd out the others or the web results.
   */
  private async attachedPieces(query: string, ids: number[], web: WebSource[]): Promise<AttachedPiece[]> {
    const perSource: AttachedPiece[][] = [];
    const files = (await this.log.getMany(ids)).filter((e) => e.type === 'attachment');
    if (files.length) {
      const emb = this.embedder;
      const max = Math.min(this.config.chunkTokens, emb?.maxTokens ?? Infinity);
      let qv: Float32Array | null = null;
      if (emb) try { qv = normalize((await emb.embed([query]))[0]!); } catch { /* keyword ranking only */ }
      const terms = (ftsQuery(query) ?? '').replace(/"/g, '').split(' OR ').filter(Boolean);
      for (const ev of files) {
        const name = String(ev.meta?.name ?? 'file');
        const source = ev.meta?.pages ? `${name} (${String(ev.meta.pages)} pages)` : name;
        const chunks = chunkText(ev.content, max);
        const vecs = qv && emb ? await this.indexer.vectors.itemVectors(emb.id, 'event', ev.id) : [];
        const score = (c: string, i: number) => (vecs[i] && qv ? dot(qv, vecs[i]) : 0)
          + 0.05 * terms.filter((t) => c.toLowerCase().includes(t)).length
          - i * 1e-6; // ties → earlier pages first
        perSource.push(chunks.map((text, i) => ({ kind: 'file' as const, source, text, order: i, s: score(text, i) }))
          .sort((a, b) => b.s - a.s).map(({ s: _s, ...p }) => p));
      }
    }
    web.forEach((w, i) => perSource.push([{ kind: 'web', source: `[${i + 1}] ${w.title} — ${w.url}`, text: w.text, order: 0 }]));
    const out: AttachedPiece[] = [];
    for (let r = 0; perSource.some((ps) => r < ps.length); r++) for (const ps of perSource) if (ps[r]) out.push(ps[r]!);
    return out;
  }

  private async indexEvent(ev: AuraEvent): Promise<void> {
    const ok = await this.indexer.index('event', ev.id, ev.content);
    if (!ok) await this.jobs.enqueue('embed', {}, 'embed');
  }

  private async embedMissing(signal: AbortSignal): Promise<void> {
    const batch = await this.indexer.missingVectors(32);
    for (const { itemType, itemId } of batch) {
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const text = await this.indexer.textOf(itemType, itemId);
      if (text && !(await this.indexer.embed(itemType, itemId, text))) throw new Error('embedder unavailable');
    }
    if (batch.length === 32) await this.jobs.enqueue('embed', {}, 'embed');
  }

  private async registerModel(): Promise<void> {
    await this.db.run(
      `INSERT INTO models(id, name, ctx_len) VALUES (?,?,?)
       ON CONFLICT(id) DO UPDATE SET ctx_len = excluded.ctx_len`,
      [this.llm.id, this.llm.id, this.llm.contextLength]);
  }

  /** A changed embedder makes old vectors meaningless: drop them and re-embed in the background. */
  private async checkEmbedder(): Promise<void> {
    if (!this.embedder) return;
    const prev = await this.db.get<{ value: string }>(`SELECT value FROM kv WHERE key = 'embedder_id'`);
    if (prev?.value === this.embedder.id) return;
    await this.indexer.pruneOtherEmbedders();
    await this.db.run(`INSERT OR REPLACE INTO kv(key, value) VALUES ('embedder_id', ?)`, [this.embedder.id]);
    const anything = await this.db.get('SELECT 1 FROM fts LIMIT 1');
    if (anything) await this.jobs.enqueue('embed', {}, 'embed');
  }

  private async maybeTitle(sessionId: number, text: string): Promise<void> {
    const s = await this.sessions.get(sessionId);
    if (s && s.title === 'New chat') await this.sessions.rename(sessionId, truncateChars(oneLine(text), 48));
  }
}
