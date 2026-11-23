import { File, Paths } from 'expo-file-system';
import { createContext, createElement, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

// Four themes in the "frosted glass on a grainy gradient" style. Each screen sits on `gradient`
// (drawn natively with RN's CSS backgroundImage, no extra library); surfaces are translucent
// `card`/`glass` so the gradient shows through, and `solid` is for panels that must be opaque.

export type ThemeName = 'dusk' | 'mist' | 'paper' | 'midnight';

interface Palette {
  name: ThemeName;
  label: string;
  scheme: 'light' | 'dark';
  /** Screen backdrop: CSS gradient(s), layered top to bottom. */
  gradient: string;
  grain: number;
  bg: string; solid: string; card: string; glass: string; glassBorder: string; chip: string; chipActive: string;
  text: string; sub: string; border: string;
  accent: string; onAccent: string; link: string; highlight: string;
  userBubble: string; userText: string; code: string;
  ok: string; warn: string; bad: string; okBg: string; warnBg: string; badBg: string;
  scrim: string; shadow: string;
}

const status = {
  light: { ok: '#15803d', warn: '#b45309', bad: '#b91c1c', okBg: 'rgba(220,252,231,0.75)', warnBg: 'rgba(254,243,199,0.75)', badBg: 'rgba(254,226,226,0.75)' },
  dark: { ok: '#4ade80', warn: '#fbbf24', bad: '#f87171', okBg: 'rgba(20,48,31,0.7)', warnBg: 'rgba(58,44,12,0.7)', badBg: 'rgba(59,21,21,0.7)' },
};

const lightGlass = {
  bg: 'transparent', card: 'rgba(255,255,255,0.42)', glass: 'rgba(255,255,255,0.5)', glassBorder: 'rgba(255,255,255,0.65)',
  chip: 'rgba(255,255,255,0.55)', chipActive: '#ffffff', text: '#1d1b26', sub: 'rgba(29,27,38,0.58)', border: 'rgba(29,27,38,0.1)',
  accent: '#16141c', onAccent: '#ffffff', highlight: 'rgba(255,255,255,0.92)',
  userBubble: 'rgba(255,255,255,0.7)', userText: '#1d1b26', code: 'rgba(255,255,255,0.55)',
  scrim: 'rgba(20,16,30,0.28)', shadow: 'rgba(40,20,60,0.16)', ...status.light,
};

export const THEMES: Record<ThemeName, Palette> = {
  // The reference screenshot: warm sand top-left, coral top-right, lilac/indigo bottom-left.
  dusk: {
    ...lightGlass, name: 'dusk', label: 'Dusk', scheme: 'light', grain: 0.5, solid: '#f3e4df', link: '#5b4bd6',
    gradient: 'radial-gradient(circle at 0% 0%, #f1e2c9 0%, transparent 55%), radial-gradient(circle at 100% 15%, #ea8f74 0%, transparent 60%), radial-gradient(circle at 0% 100%, #7b74d6 0%, transparent 65%), linear-gradient(160deg, #e9cfc0 0%, #c9a3b4 55%, #a493c9 100%)',
  },
  mist: {
    ...lightGlass, name: 'mist', label: 'Mist', scheme: 'light', grain: 0.45, solid: '#e4eef0', link: '#2563eb',
    gradient: 'radial-gradient(circle at 0% 0%, #dff3ea 0%, transparent 55%), radial-gradient(circle at 100% 10%, #9fd0e6 0%, transparent 60%), radial-gradient(circle at 10% 100%, #8f9be6 0%, transparent 65%), linear-gradient(165deg, #d9ece9 0%, #b9cfe2 55%, #a5acdc 100%)',
  },
  paper: {
    ...lightGlass, name: 'paper', label: 'Paper', scheme: 'light', grain: 0.3, solid: '#f7f4ee', link: '#9a5b2e',
    card: 'rgba(255,255,255,0.6)', glass: 'rgba(255,255,255,0.72)', chip: 'rgba(255,255,255,0.8)', userBubble: 'rgba(235,228,216,0.9)',
    gradient: 'linear-gradient(180deg, #faf8f3 0%, #f2ede4 100%)',
  },
  midnight: {
    name: 'midnight', label: 'Midnight', scheme: 'dark', grain: 0.55,
    gradient: 'radial-gradient(circle at 100% 0%, #6b2d4f 0%, transparent 55%), radial-gradient(circle at 0% 100%, #2a2f7a 0%, transparent 65%), radial-gradient(circle at 100% 100%, #8a3b25 0%, transparent 50%), linear-gradient(170deg, #17141f 0%, #1c1830 60%, #241629 100%)',
    bg: 'transparent', solid: '#1b1726', card: 'rgba(255,255,255,0.07)', glass: 'rgba(30,26,44,0.6)', glassBorder: 'rgba(255,255,255,0.1)',
    chip: 'rgba(255,255,255,0.08)', chipActive: 'rgba(255,255,255,0.22)', text: '#f2eef8', sub: 'rgba(242,238,248,0.58)', border: 'rgba(255,255,255,0.1)',
    accent: '#f2eef8', onAccent: '#16141c', link: '#a5b4fc', highlight: 'rgba(255,255,255,0.14)',
    userBubble: 'rgba(255,255,255,0.12)', userText: '#f2eef8', code: 'rgba(0,0,0,0.3)',
    scrim: 'rgba(0,0,0,0.5)', shadow: 'rgba(0,0,0,0.45)', ...status.dark,
  },
};

export type Theme = Palette;

// The choice lives in a tiny file (not SQLite) so it's known synchronously at startup, before the
// engine opens: no flash of the wrong theme.
const prefFile = () => new File(Paths.document, 'theme.json');
function loadPref(): ThemeName {
  try {
    const f = prefFile();
    if (f.exists) {
      const n = JSON.parse(f.textSync()).name as ThemeName;
      if (n in THEMES) return n;
    }
  } catch { /* first run or unreadable: default */ }
  return 'dusk';
}

const Ctx = createContext<{ theme: Theme; setTheme: (n: ThemeName) => void }>({ theme: THEMES.dusk, setTheme: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [name, setName] = useState<ThemeName>(loadPref);
  const setTheme = useCallback((n: ThemeName) => {
    setName(n);
    try { prefFile().write(JSON.stringify({ name: n })); } catch { /* keep in memory only */ }
  }, []);
  const value = useMemo(() => ({ theme: THEMES[name], setTheme }), [name, setTheme]);
  return createElement(Ctx.Provider, { value }, children);
}

export const useTheme = (): Theme => useContext(Ctx).theme;
export const useThemeControl = () => useContext(Ctx);

/** 8-pt spacing scale. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
