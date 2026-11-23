import type { SectionShares } from '../config';
import type { TokenCounter } from '../log/tokens';
import type { MemoryItem } from '../selection/retriever';
import type { AuraEvent, ChatMessage, LLM } from '../types';
import { formatTs } from '../util/text';
import { type Needs, type Section, allocate, edgeOrder } from './budget';

// Rough per-message template overhead (role markers, newlines). Only used for planning;
// the final prompt is always rendered and counted exactly.
const MSG_OVERHEAD = 8;

/**
 * One piece of this turn's attached context, ranked best-first. A short file is one piece;
 * a long one is several chunks, and only the best that fit are kept (then shown in page order).
 */
export interface AttachedPiece {
  kind: 'file' | 'web';
  /** Header for its group, e.g. `report.pdf (12 pages)` or `[1] Title — https://…`. */
  source: string;
  text: string;
  /** Position inside its source, to restore reading order after ranking. */
  order: number;
}

export interface AssembleInput {
  systemPrompt: string;
  rules: { id: number; rule: string }[];
  summary: string | null;
  /** Working-memory messages of this session, oldest first, excluding the query. */
  turns: AuraEvent[];
  query: AuraEvent;
  facts: MemoryItem[];
  memories: MemoryItem[];
  /** Attached files and web results for this turn. */
  attached?: AttachedPiece[];
  now: number;
  budget: number;
  shares: SectionShares;
  edgeOrdering: boolean;
  thinking: boolean;
  relativeTime?: boolean;
  /** Replace the final user block (Scroll-lite planning reuses the same prefix). */
  finalOverride?: string;
}

export interface SectionReport {
  budget: number;
  used: number;
  items: number;
}

export interface Assembled {
  messages: ChatMessage[];
  prompt: string;
  promptTokens: number;
  budget: number;
  sections: Record<Section, SectionReport>;
  memoryKeys: string[];
  factIds: number[];
  ruleIds: number[];
  /** Turns that didn't fit (naive truncation when compression is off or overflowed). */
  droppedTurns: number;
}

/**
 * L4. Layout, chosen so the KV-cached prefix survives as long as possible:
 *
 *   system  = system prompt + playbook + rolling summary   ← stable; changes rarely
 *   turns   = recent user/assistant messages              ← append-only between compactions
 *   user    = facts + memories (edge-ordered) + now + query ← volatile, so it goes last
 *
 * Putting the per-query memories in the final message (instead of the system prompt)
 * is where caching and attention ordering meet: they're right next to the query
 * (good for attention) and after everything cacheable (good for TTFT).
 */
export class Assembler {
  constructor(
    private tokens: TokenCounter,
    private llm: () => LLM,
  ) {}

  async assemble(input: AssembleInput): Promise<Assembled> {
    const t = (s: string) => this.tokens.count(s);

    // Measure every candidate piece once.
    const sysTok = await t(input.systemPrompt);
    const ruleLines = input.rules.map((r) => `- ${r.rule}`);
    const ruleTok = await Promise.all(ruleLines.map(t));
    const summaryText = input.summary ? `Summary of the earlier part of this conversation:\n${input.summary}` : '';
    const summaryTok = await t(summaryText);
    const turnTok = await Promise.all(input.turns.map(async (e) => (await this.tokens.countEvent(e)) + MSG_OVERHEAD));
    const queryTok = (await this.tokens.countEvent(input.query)) + MSG_OVERHEAD + 24;
    const factLines = input.facts.map((f) => `- ${f.text}`);
    const factTok = await Promise.all(factLines.map(t));
    const memLines = input.memories.map((m) => formatMemory(m, input.relativeTime ? input.now : undefined));
    const memTok = await Promise.all(memLines.map(t));
    const attached = input.attached ?? [];
    const attTok = await Promise.all(attached.map((p) => t(p.text)));
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

    const needs: Needs = {
      system: sysTok + MSG_OVERHEAD,
      playbook: ruleTok.length ? sum(ruleTok) + 12 : 0,
      facts: factTok.length ? sum(factTok) + 12 : 0,
      retrieved: memTok.length ? sum(memTok) + 20 : 0,
      recent: summaryTok + sum(turnTok) + queryTok,
      // Per piece: its text plus a share of the group headers.
      attached: attTok.length ? sum(attTok) + 30 + 12 * attTok.length : 0,
    };

    // Exact-fit loop: plan with estimates, render, count for real, shrink if over.
    let shrink = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      const grant = allocate(Math.max(0, input.budget - shrink), input.shares, needs);

      const rules = takeWhileFits(input.rules, ruleTok, grant.playbook - 12);
      const facts = takeWhileFits(input.facts, factTok, grant.facts - 12);
      const mems = takeWhileFits(input.memories, memTok, grant.retrieved - 20);
      const att = takeWhileFits(attached, attTok.map((n) => n + 12), grant.attached - 30);

      // Newest turns first; summary and query come out of the same section.
      let room = grant.recent - queryTok - summaryTok;
      let keepFrom = input.turns.length;
      while (keepFrom > 0 && turnTok[keepFrom - 1]! <= room) room -= turnTok[--keepFrom]!;
      // Templates expect user first after the system message.
      while (keepFrom < input.turns.length && input.turns[keepFrom]!.role !== 'user') keepFrom++;
      const turns = input.turns.slice(keepFrom);

      const system = [input.systemPrompt];
      if (rules.length) system.push(`Rules learned from the user's feedback:\n${rules.map((r) => `- ${r.rule}`).join('\n')}`);
      if (summaryText) system.push(summaryText);

      const finalBlock = input.finalOverride ?? renderFinal(input, facts, mems, att);
      const messages: ChatMessage[] = [
        { role: 'system', content: system.join('\n\n') },
        ...turns.map((e) => ({ role: e.role, content: e.content })),
        { role: 'user', content: finalBlock },
      ];
      const prompt = await this.llm().applyTemplate(messages, { thinking: input.thinking });
      const promptTokens = await t(prompt);

      if (promptTokens <= input.budget || attempt === 11) {
        const used = (xs: number[], n: number) => sum(xs.slice(0, n));
        return {
          messages, prompt, promptTokens, budget: input.budget,
          sections: {
            system: { budget: grant.system, used: sysTok, items: 1 },
            playbook: { budget: grant.playbook, used: used(ruleTok, rules.length), items: rules.length },
            facts: { budget: grant.facts, used: used(factTok, facts.length), items: facts.length },
            retrieved: { budget: grant.retrieved, used: used(memTok, mems.length), items: mems.length },
            recent: { budget: grant.recent, used: summaryTok + sum(turnTok.slice(keepFrom)) + queryTok, items: turns.length },
            attached: { budget: grant.attached, used: used(attTok, att.length), items: att.length },
          },
          memoryKeys: mems.map((m) => m.key),
          factIds: facts.map((f) => f.itemId),
          ruleIds: rules.map((r) => r.id),
          droppedTurns: keepFrom,
        };
      }
      // Over budget (template overhead was underestimated): shrink and retry.
      shrink += promptTokens - input.budget + 16;
    }
    throw new Error('unreachable');
  }
}

function takeWhileFits<T>(items: T[], cost: number[], room: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < items.length; i++) {
    if (cost[i]! > room) break; // keep rank order: never skip a better item for a cheaper worse one
    room -= cost[i]!;
    out.push(items[i]!);
  }
  return out;
}

export function formatMemory(m: MemoryItem, now?: number): string {
  const when = formatTs(m.ts) + (now === undefined ? '' : `, ${relativeAge(m.ts, now)}`);
  if (m.itemType === 'episode') return `(${when}, summary of chat #${m.sessionId}) ${m.text}`;
  if (m.itemType === 'event' && m.source) return `(${when}, chat #${m.sessionId}) File "${m.source}": ${m.text}`;
  if (m.itemType === 'event') return `(${when}, chat #${m.sessionId}) ${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`;
  if (m.itemType === 'fact') return `(as of ${when}) ${m.text}`;
  return m.text;
}

export function relativeAge(ts: number, now: number): string {
  const days = Math.floor((now - ts) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day before now';
  if (days < 14) return `${days} days before now`;
  if (days < 60) return `${days} days (~${Math.round(days / 7)} weeks) before now`;
  return `${days} days (~${Math.round(days / 30)} months) before now`;
}

function renderFinal(input: AssembleInput, facts: MemoryItem[], mems: MemoryItem[], att: AttachedPiece[]): string {
  const parts: string[] = [];
  if (facts.length) parts.push(`Known facts about the user:\n${facts.map((f) => `- ${f.text}`).join('\n')}`);
  if (mems.length) {
    const ordered = input.edgeOrdering ? edgeOrder(mems) : mems;
    const now = input.relativeTime ? input.now : undefined;
    parts.push(`Memories from past conversations (may be outdated; newer wins):\n${ordered.map((m) => `- ${formatMemory(m, now)}`).join('\n')}`);
  }
  // Attached context goes after memories: it's what this question is about, so it sits closest to it.
  const files = renderAttached(att.filter((p) => p.kind === 'file'));
  if (files) parts.push(`Files the user attached (excerpts):\n${files}`);
  const web = renderAttached(att.filter((p) => p.kind === 'web'));
  if (web) parts.push(`Web search results (fresh; cite them as [1], [2]):\n${web}`);
  // Always state the time: every config gets the date (temporal questions), memories or not.
  parts.push(`Current time: ${formatTs(input.now)}`);
  parts.push(`User message: ${input.query.content}`);
  return parts.join('\n\n');
}

/** Groups pieces by source (in rank order of each source's best piece), each in reading order. */
function renderAttached(pieces: AttachedPiece[]): string {
  const groups = new Map<string, AttachedPiece[]>();
  for (const p of pieces) groups.set(p.source, [...(groups.get(p.source) ?? []), p]);
  return [...groups].map(([source, ps]) =>
    `${source}:\n${ps.sort((a, b) => a.order - b.order).map((p) => p.text).join('\n…\n')}`).join('\n\n');
}
