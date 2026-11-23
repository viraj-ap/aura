import { useSyncExternalStore } from 'react';

/**
 * Holds the reply while it streams, outside React state. Tokens arrive 20–60×/s; publishing at most
 * every `ms` and only to the one row that shows it keeps the rest of the chat from re-rendering
 * per token (the main cause of lag while generating).
 */
export function createStream(ms = 60) {
  let value = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const emit = () => { timer = null; listeners.forEach((l) => l()); };
  return {
    get: () => value,
    set(v: string) {
      value = v;
      if (!timer) timer = setTimeout(emit, ms);
    },
    reset() {
      value = '';
      if (timer) clearTimeout(timer);
      emit();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
  };
}

export type Stream = ReturnType<typeof createStream>;

export const useStream = (s: Stream) => useSyncExternalStore(s.subscribe, s.get);
