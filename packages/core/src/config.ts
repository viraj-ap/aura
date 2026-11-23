// Every layer can be switched off here; eval configs (a)–(d) are just presets of this.

export interface SectionShares {
  system: number;
  playbook: number;
  facts: number;
  retrieved: number;
  recent: number;
  /**
   * Attached files and web results for this turn. Only counted when the turn has some, so turns
   * without attachments split the budget exactly as before (Phase 2 numbers stay valid).
   */
  attached: number;
}

export interface AuraConfig {
  systemPrompt: string;
  /** Tokens kept free for the reply. */
  outputReserve: number;
  /** RAM-safe context limit from the host's estimator (weights + KV cache); undefined = trust the model's ctx. */
  ramSafeTokens?: number;
  shares: SectionShares;
  thinking: boolean;
  temperature: number;
  layers: {
    retrieval: boolean; // L3 fallback hybrid search
    scrollLite: boolean; // L3 model-planned operations
    router: boolean; // skip retrieval for chit-chat
    episodic: boolean; // L2 session summaries
    facts: boolean; // L2 semantic memory
    compression: boolean; // L5 rolling summary (off = naive truncation)
    playbook: boolean; // L6
    edgeOrdering: boolean; // L4 best memories at the edges
  };
  retrieval: {
    mode: 'hybrid' | 'vector' | 'keyword';
    k: number;
    rrfK: number;
    /** false = plain top-k by search score (baseline b). */
    rerank: boolean;
    /** false = only the user's own messages are retrievable as events (assistant replies tend to get parroted). */
    includeAssistant: boolean;
    /** Long messages contribute only their best-matching chunk instead of the whole text. */
    snippets: boolean;
    /** Vector hits below this cosine are dropped (otherwise the nearest unrelated items always come back). */
    minVectorScore: number;
    weights: { relevance: number; recency: number; importance: number };
    recencyHalfLifeDays: number;
  };
  compression: {
    /** Compact when recent turns reach this fraction of their budget… */
    trigger: number;
    /** …down to this fraction, so the cached prefix survives many turns. */
    target: number;
  };
  scroll: { maxRounds: number; maxOpsPerRound: number; resultsPerOp: number };
  presentation: {
    /** Add "N days before now" to each memory — small models can't do date arithmetic themselves. */
    relativeTime: boolean;
  };
  playbookCapTokens: number;
  /** llama-server slot for background jobs (keeps the chat slot's KV cache warm). */
  jobSlot?: number;
  /** Chunk size for the embedder, in approx. tokens. */
  chunkTokens: number;
}

export const defaultConfig: AuraConfig = {
  // v2 (Phase 2): small models answered "I don't have access to your personal information"
  // even with the evidence in the prompt; saying plainly that memories are real facts fixes that.
  systemPrompt:
    'You are AURA, a private assistant on the user\'s device with long-term memory. ' +
    'Messages may include memories: real excerpts from your earlier conversations with this same user, with dates. ' +
    'Treat them as things you know about the user and answer from them directly. ' +
    'If memories conflict, trust the most recent one. If the answer is not in the memories or the conversation, say you don\'t know. ' +
    'Be concise.',
  outputReserve: 512,
  shares: { system: 0.1, playbook: 0.05, facts: 0.1, retrieved: 0.35, recent: 0.4, attached: 0.35 },
  thinking: false,
  temperature: 0.7,
  layers: {
    retrieval: true,
    scrollLite: false,
    router: true,
    episodic: true,
    facts: true,
    compression: true,
    playbook: true,
    edgeOrdering: true,
  },
  retrieval: {
    mode: 'hybrid',
    k: 8,
    rrfK: 60,
    rerank: true,
    includeAssistant: true,
    // Phase 2: +1.6 (0.6B) / +8.3 points (1.7B) at half the tokens of full messages.
    snippets: true,
    minVectorScore: 0.15,
    // Phase 2 recall sweep (470 LongMemEval questions): recency 0.2 lowered R_all@5 from 89.1% to 86.7%.
    weights: { relevance: 0.9, recency: 0, importance: 0.1 },
    recencyHalfLifeDays: 30,
  },
  compression: { trigger: 1.0, target: 0.6 },
  scroll: { maxRounds: 2, maxOpsPerRound: 3, resultsPerOp: 4 },
  presentation: { relativeTime: false },
  playbookCapTokens: 200,
  chunkTokens: 256,
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function mergeConfig(base: AuraConfig, patch: DeepPartial<AuraConfig> = {}): AuraConfig {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const b = (base as unknown as Record<string, unknown>)[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object'
        ? mergeConfig(b as AuraConfig, v as DeepPartial<AuraConfig>)
        : v;
  }
  return out as unknown as AuraConfig;
}
