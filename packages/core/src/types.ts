// Platform contracts. Everything in packages/core talks to the outside world only
// through these interfaces, so the same engine runs in Node (llama-server +
// better-sqlite3), in the eval harness, and in React Native (llama.rn + op-sqlite).

export type Role = 'user' | 'assistant' | 'system';
/** 'attachment' = text extracted from a PDF or photo the user added; searchable like a message. */
export type EventType = 'message' | 'feedback' | 'operation' | 'attachment';

export interface AuraEvent {
  id: number;
  sessionId: number;
  ts: number; // ms since epoch, from the injectable Clock
  type: EventType;
  role: Role;
  content: string;
  modelId: string | null;
  meta: Record<string, unknown> | null;
}

export interface Session {
  id: number;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Clock for tests and eval replays: time only moves when you move it. */
export class ManualClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface CompletionRequest {
  prompt: string;
  maxTokens: number;
  temperature?: number;
  /** GBNF grammar; output is guaranteed to match it (unless cut off by maxTokens). */
  grammar?: string;
  stop?: string[];
  signal?: AbortSignal;
  onToken?: (piece: string) => void;
  /** Background jobs may run on a different slot so they don't evict the chat's KV cache. */
  slot?: number;
  /** What the call is for. Lets hosts route or cache deterministic background work (eval caches 'job'). */
  purpose?: 'chat' | 'plan' | 'job';
}

export interface CompletionResult {
  text: string;
  promptTokens: number;
  /** Prompt tokens served from the KV cache instead of being re-processed. */
  cachedTokens: number;
  completionTokens: number;
  ttftMs: number;
  totalMs: number;
  stopReason: 'eos' | 'length' | 'stop' | 'abort';
}

export interface TemplateOptions {
  /** false = disable <think> reasoning when the template supports it (background jobs). */
  thinking: boolean;
}

export interface LLM {
  /** Stable id of the loaded model (token counts are cached per id). */
  readonly id: string;
  readonly contextLength: number;
  countTokens(text: string): Promise<number>;
  /** Render messages with the model's own (GGUF-embedded) chat template, ending at the assistant turn. */
  applyTemplate(messages: ChatMessage[], opts: TemplateOptions): Promise<string>;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export interface Embedder {
  /** Stable id; every stored vector records it so a changed embedder triggers re-embedding. */
  readonly id: string;
  /** Max input tokens; longer texts are chunked before embedding. */
  readonly maxTokens: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Minimal async SQL surface. better-sqlite3 (sync) and op-sqlite (async) both fit it.
 * Params are positional (`?`). BLOB params/results are Uint8Array.
 */
export interface SqlDb {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid: number }>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** Run fn inside BEGIN/COMMIT. Keep fn DB-only (no network awaits) so nothing else interleaves. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

/** Host hooks for things only the platform knows. */
export interface HostHooks {
  /** Mobile: false when battery < 20% and not charging. */
  canRunBackgroundLLM?: () => Promise<boolean>;
}
