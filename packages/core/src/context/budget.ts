import type { SectionShares } from '../config';

export type Section = keyof SectionShares;
export const SECTIONS: Section[] = ['system', 'playbook', 'facts', 'retrieved', 'recent', 'attached'];

/** Per-section token needs; 'attached' may be left out (= 0). */
export type Needs = Omit<Record<Section, number>, 'attached'> & { attached?: number };

/** Sections that take part in the split: 'attached' only when this turn has attachments or web results. */
export function activeSections(needs: Partial<Record<Section, number>>): Section[] {
  return SECTIONS.filter((s) => s !== 'attached' || (needs.attached ?? 0) > 0);
}

/** Prompt budget = min(context length, RAM-safe limit) − output reserve. */
export function promptBudget(contextLength: number, ramSafeTokens: number | undefined, outputReserve: number): number {
  return Math.max(0, Math.min(contextLength, ramSafeTokens ?? Infinity) - outputReserve);
}

/**
 * Split `total` across sections. Each section first gets min(need, share × total);
 * whatever is left over (sections that needed less than their share) is handed out
 * in `priority` order to sections that still need more. So an empty facts table
 * doesn't waste 10% of the context.
 */
export function allocate(
  total: number,
  shares: SectionShares,
  needs: Needs,
  priority: Section[] = ['recent', 'attached', 'retrieved', 'facts', 'playbook', 'system'],
): Record<Section, number> {
  const active = activeSections(needs);
  const sum = active.reduce((s, k) => s + shares[k], 0) || 1;
  const grant = { attached: 0 } as Record<Section, number>;
  let used = 0;
  for (const s of active) {
    grant[s] = Math.min(needs[s] ?? 0, Math.floor((total * shares[s]) / sum));
    used += grant[s];
  }
  let pool = total - used;
  for (const s of priority) {
    if (pool <= 0) break;
    if (!active.includes(s)) continue;
    const extra = Math.min(pool, (needs[s] ?? 0) - grant[s]);
    if (extra > 0) {
      grant[s] += extra;
      pool -= extra;
    }
  }
  return grant;
}

/**
 * Best items at both edges, weakest in the middle (Lost in the Middle).
 * Input is ranked best-first; output puts #1 last (right before the query) and #2 first.
 */
export function edgeOrder<T>(ranked: T[]): T[] {
  const front: T[] = [];
  const back: T[] = [];
  ranked.forEach((item, i) => (i % 2 === 0 ? back : front).push(item));
  return [...front, ...back.reverse()];
}
