import type { ChatMessage, LLM } from '../types';
import { stripReasoning } from './text';

export interface BackgroundCall {
  messages: ChatMessage[];
  maxTokens: number;
  grammar?: string;
  signal?: AbortSignal;
  slot?: number;
}

/** Background/structured call: temperature 0, reasoning off, reasoning stripped anyway. */
export async function callLLM(llm: LLM, c: BackgroundCall): Promise<string> {
  const prompt = await llm.applyTemplate(c.messages, { thinking: false });
  const res = await llm.complete({
    prompt, maxTokens: c.maxTokens, temperature: 0, grammar: c.grammar, signal: c.signal, slot: c.slot, purpose: 'job',
  });
  if (res.stopReason === 'abort') throw new AbortError();
  return stripReasoning(res.text);
}

export class AbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

export const isAbort = (e: unknown) =>
  e instanceof Error && (e.name === 'AbortError' || (e as { code?: string }).code === 'ABORT_ERR');
