import type { AuraEvent, LLM } from '../types';
import { callLLM } from '../util/llmCall';
import { formatTs } from '../util/text';

// The "must keep" list is what LongMemEval questions actually ask about. When eval
// failures show a category being lost, add it here (ACON-style prompt tuning, P2).
export const SUMMARY_SYSTEM = `You compress chat history into memory notes for an assistant.
Write short factual bullet points in third person ("The user ...").
MUST KEEP, exactly as stated: names of people, pets, places and things; numbers, amounts, prices, quantities; dates, times and deadlines; decisions made; plans and commitments; preferences, likes and dislikes the user stated; changes ("moved from X to Y"); unanswered questions.
DROP: greetings, filler, politeness, the assistant's generic advice.
Never invent or guess anything. If an earlier summary is given, merge the new information into it and keep everything still true; when something changed, keep the newest value and note the change.`;

export function renderTurns(events: AuraEvent[]): string {
  return events
    .map((e) => `[${formatTs(e.ts)}] ${e.role === 'user' ? 'User' : 'Assistant'}: ${e.content}`)
    .join('\n');
}

export async function summarize(
  llm: LLM,
  previous: string | null,
  events: AuraEvent[],
  opts: { maxTokens: number; signal?: AbortSignal; slot?: number },
): Promise<string> {
  const parts = [];
  if (previous) parts.push(`Earlier summary:\n${previous}`);
  parts.push(`New conversation:\n${renderTurns(events)}`);
  parts.push(`Write the updated summary as bullet points, at most ~${Math.max(40, Math.floor(opts.maxTokens * 0.6))} words.`);
  const text = await callLLM(llm, {
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: parts.join('\n\n') },
    ],
    maxTokens: opts.maxTokens,
    signal: opts.signal,
    slot: opts.slot,
  });
  if (!text.trim()) throw new Error('empty summary');
  return text.trim();
}
