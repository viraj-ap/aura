import { type AuraConfig, type DeepPartial, mergeConfig } from '@aura/core';

export interface EvalConfig {
  name: string;
  description: string;
  /**
   * 'thread': the whole history is one chat and the question is its next message
   *           (PocketPal mode — whatever fits in the context window survives).
   * 'sessions': each haystack session is its own chat; the question opens a new chat
   *           and memory has to bring the past back.
   */
  layout: 'thread' | 'sessions';
  /** Use LongMemEval's oracle history (only the evidence sessions). */
  oracle?: boolean;
  /** Needs LLM background jobs during ingestion (episodes, facts). */
  llmIngest?: boolean;
  /** Ignore a failed capability probe (measures raw Scroll-lite). */
  forceScroll?: boolean;
  aura: DeepPartial<AuraConfig>;
}

const OFF = { retrieval: false, scrollLite: false, router: false, episodic: false, facts: false, compression: false, playbook: false, edgeOrdering: false };
// Snippets are pinned off in the base configs (core now defaults to on) so 'c' stays the measured baseline; '/snip' turns them on.
const BASE: DeepPartial<AuraConfig> = { temperature: 0, outputReserve: 256, thinking: false };

export const CONFIGS: Record<string, EvalConfig> = {
  a: {
    name: 'a', description: 'naive truncation (whole history as one chat, oldest turns dropped)',
    layout: 'thread', aura: { ...BASE, layers: OFF },
  },
  oracle: {
    name: 'oracle', description: 'only the evidence sessions exist and every turn is retrieved, presented exactly like c (the model\'s ceiling)',
    layout: 'sessions', oracle: true,
    aura: { ...BASE, layers: { ...OFF, retrieval: true, edgeOrdering: true }, retrieval: { mode: 'vector', rerank: false, k: 200, minVectorScore: -1, snippets: false } },
  },
  'oracle-thread': {
    name: 'oracle-thread', description: 'only the evidence sessions, as one chat (PocketPal presentation)',
    layout: 'thread', oracle: true, aura: { ...BASE, layers: OFF },
  },
  b: {
    name: 'b', description: 'plain vector top-k, no rerank, no ordering',
    layout: 'sessions',
    aura: { ...BASE, layers: { ...OFF, retrieval: true }, retrieval: { mode: 'vector', rerank: false, snippets: false } },
  },
  c: {
    name: 'c', description: 'AURA fallback retrieval: hybrid + rerank + edge ordering (no LLM ingestion)',
    layout: 'sessions',
    aura: { ...BASE, layers: { ...OFF, retrieval: true, edgeOrdering: true }, retrieval: { mode: 'hybrid', rerank: true, snippets: false } },
  },
  'c+': {
    name: 'c+', description: 'c + episodic summaries + facts (LLM ingestion, cached)',
    layout: 'sessions', llmIngest: true,
    aura: { ...BASE, layers: { ...OFF, retrieval: true, edgeOrdering: true, episodic: true, facts: true }, retrieval: { mode: 'hybrid', rerank: true, snippets: false } },
  },
  d: {
    name: 'd', description: 'c + Scroll-lite (falls back to c if the probe fails)',
    layout: 'sessions',
    aura: { ...BASE, layers: { ...OFF, retrieval: true, edgeOrdering: true, scrollLite: true }, retrieval: { mode: 'hybrid', rerank: true, snippets: false } },
  },
  'd!': {
    name: 'd!', description: 'c + Scroll-lite forced on (ignores the probe)',
    layout: 'sessions', forceScroll: true,
    aura: { ...BASE, layers: { ...OFF, retrieval: true, edgeOrdering: true, scrollLite: true }, retrieval: { mode: 'hybrid', rerank: true, snippets: false } },
  },
};

/** Composable tuning modifiers: "c/snip/k20" = config c + snippets + k=20. */
// The original Phase 1 system prompt, kept so the prompt change can be A/B-tested.
export const SYSTEM_PROMPT_V1 = 'You are AURA, a helpful assistant running privately on the user\'s device. ' +
  'You remember past conversations through the memories provided with each message. ' +
  'Use them when relevant, prefer the most recent information when memories conflict, ' +
  'and say so honestly when you do not know. Be concise.';

export const MODS: Record<string, DeepPartial<AuraConfig>> = {
  sp1: { systemPrompt: SYSTEM_PROMPT_V1 },
  snip: { retrieval: { snippets: true } },
  reltime: { presentation: { relativeTime: true } },
  user: { retrieval: { includeAssistant: false } },
  rec: { retrieval: { weights: { relevance: 0.7, recency: 0.2, importance: 0.1 } } }, // Phase 1 weights
  noedge: { layers: { edgeOrdering: false } },
  vec: { retrieval: { mode: 'vector' } },
  k5: { retrieval: { k: 5 } },
  k12: { retrieval: { k: 12 } },
  k20: { retrieval: { k: 20 } },
  k30: { retrieval: { k: 30 } },
};

export function resolveConfig(name: string): EvalConfig {
  const [base, ...mods] = name.split('/');
  const cfg = CONFIGS[base!];
  if (!cfg) throw new Error(`unknown config ${base}; known: ${Object.keys(CONFIGS).join(', ')}`);
  let aura = cfg.aura;
  for (const m of mods) {
    if (!MODS[m]) throw new Error(`unknown modifier ${m}; known: ${Object.keys(MODS).join(', ')}`);
    aura = mergeConfig(aura as AuraConfig, MODS[m]!);
  }
  return { ...cfg, name, aura };
}
