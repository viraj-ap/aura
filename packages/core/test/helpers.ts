import Database from 'better-sqlite3';
import type { ChatMessage, CompletionRequest, CompletionResult, LLM, SqlDb } from '../src/types';

/** Test-only SqlDb over in-memory better-sqlite3 (the real adapter lives in @aura/node). */
export function memoryDb(): SqlDb {
  const d = new Database(':memory:');
  const conv = (p: unknown[] = []) => p.map((v) => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v) : v));
  return {
    exec: async (sql) => void d.exec(sql),
    run: async (sql, p) => {
      const r = d.prepare(sql).run(...conv(p));
      return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
    },
    all: async <T>(sql: string, p?: unknown[]) => d.prepare(sql).all(...conv(p)) as T[],
    get: async <T>(sql: string, p?: unknown[]) => d.prepare(sql).get(...conv(p)) as T | undefined,
    transaction: async (fn) => {
      d.exec('BEGIN');
      try {
        const r = await fn();
        d.exec('COMMIT');
        return r;
      } catch (e) {
        d.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

export type Responder = (prompt: string, req: CompletionRequest) => string | Promise<string>;

/**
 * Scripted LLM. 1 token ≈ 4 chars. The template is a simple tagged format so tests can
 * inspect exactly what was sent. `respond` decides the output per prompt.
 */
export class FakeLLM implements LLM {
  calls: { prompt: string; grammar?: string }[] = [];
  countCalls = 0;

  constructor(
    public respond: Responder = () => 'ok',
    readonly contextLength = 2048,
    readonly id = 'fake-llm',
  ) {}

  async countTokens(text: string): Promise<number> {
    this.countCalls++;
    return Math.ceil(text.length / 4);
  }

  async applyTemplate(messages: ChatMessage[]): Promise<string> {
    return messages.map((m) => `<|${m.role}|>\n${m.content}\n`).join('') + '<|assistant|>\n';
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push({ prompt: req.prompt, grammar: req.grammar });
    if (req.signal?.aborted) return result('', 'abort');
    const text = await this.respond(req.prompt, req);
    if (req.signal?.aborted) return result('', 'abort');
    for (const piece of text.match(/.{1,8}/gs) ?? []) req.onToken?.(piece);
    return result(text, 'eos', Math.ceil(req.prompt.length / 4));
  }

  /** Prompts of calls that look like the given kind of job. */
  prompts(kind: 'chat' | 'facts' | 'summary' | 'reflect' | 'plan'): string[] {
    return this.calls.map((c) => c.prompt).filter((p) => kindOf(p) === kind);
  }
}

export function kindOf(prompt: string): 'chat' | 'facts' | 'summary' | 'reflect' | 'plan' {
  if (prompt.includes('You keep a memory of personal facts')) return 'facts';
  if (prompt.includes('You compress chat history')) return 'summary';
  if (prompt.includes('You maintain a short list of rules')) return 'reflect';
  if (prompt.includes('Available memory operations')) return 'plan';
  return 'chat';
}

const result = (text: string, stopReason: CompletionResult['stopReason'], promptTokens = 0): CompletionResult => ({
  text, promptTokens, cachedTokens: 0, completionTokens: Math.ceil(text.length / 4), ttftMs: 1, totalMs: 1, stopReason,
});

/** The final user block of a rendered FakeLLM prompt. */
export function lastUserBlock(prompt: string): string {
  const i = prompt.lastIndexOf('<|user|>\n');
  return prompt.slice(i + 9, prompt.lastIndexOf('<|assistant|>'));
}

export const DAY = 86_400_000;
export const T0 = Date.UTC(2026, 0, 5, 10, 0); // Mon 2026-01-05 10:00 UTC
