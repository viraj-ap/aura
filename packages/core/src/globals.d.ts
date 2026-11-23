// Core targets plain ES2022 (no DOM lib) so platform APIs can't sneak in.
// AbortController is the one global both Node and React Native provide that core uses.
declare global {
  interface AbortSignal {
    readonly aborted: boolean;
    addEventListener(type: 'abort', listener: () => void): void;
    removeEventListener(type: 'abort', listener: () => void): void;
  }
  class AbortController {
    readonly signal: AbortSignal;
    abort(): void;
  }
}
export {};
