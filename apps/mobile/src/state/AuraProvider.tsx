import * as Battery from 'expo-battery';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { Aura, type AuraConfig, type DeepPartial, HashEmbedder, type LLM, type Session } from '@aura/core';
import type { LlamaRnEmbedder, LlamaRnLLM } from '../adapters/llamaRn';
import { EMBEDDER } from '../models/catalog';
import { type Inspection, fitFor, inspectLocal, modelFile } from '../models/manager';

/** Placeholder until a model is loaded, so memory screens work without one. */
const NO_MODEL: LLM = {
  id: 'none', contextLength: 4096,
  countTokens: async (t) => Math.ceil(t.length / 4),
  applyTemplate: async (m) => m.map((x) => x.content).join('\n'),
  complete: async () => { throw new Error('No model loaded — pick one on the Models tab.'); },
};

export interface LoadedModel {
  fileName: string;
  inspection: Inspection;
  fit: ReturnType<typeof fitFor>;
}

interface AuraState {
  aura: Aura | null;
  status: 'starting' | 'ready' | 'loading-model' | 'error';
  error: string | null;
  model: LoadedModel | null;
  embedderReal: boolean;
  session: Session | null;
  /** Bumped after anything that changes stored memory, so lists re-read. */
  version: number;
  loadModel(fileName: string): Promise<void>;
  loadEmbedder(): Promise<void>;
  setSession(s: Session): void;
  newSession(): Promise<void>;
  setConfig(patch: DeepPartial<AuraConfig>): Promise<void>;
  touch(): void;
  scheduleBackground(): void;
}

// Native adapters are required lazily: every screen imports useAura from this file, and
// llama.rn / op-sqlite throw at import time when their native code is missing (Expo Go).
const llamaRn = () => require('../adapters/llamaRn') as typeof import('../adapters/llamaRn');
const opSqlite = () => require('../adapters/opSqlite') as typeof import('../adapters/opSqlite');

const Ctx = createContext<AuraState | null>(null);
// Load progress ticks many times a second; in its own context only the screen showing it re-renders.
const ProgressCtx = createContext(0);

export const useModelProgress = () => useContext(ProgressCtx);

export function useAura(): AuraState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAura outside AuraProvider');
  return v;
}

const KV = { model: 'app.model', config: 'app.config', session: 'app.session' };

export function AuraProvider({ children }: { children: ReactNode }) {
  const [aura, setAura] = useState<Aura | null>(null);
  const [status, setStatus] = useState<AuraState['status']>('starting');
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<LoadedModel | null>(null);
  const [modelProgress, setModelProgress] = useState(0);
  const [embedderReal, setEmbedderReal] = useState(false);
  const [session, setSessionState] = useState<Session | null>(null);
  const [version, setVersion] = useState(0);
  const llmRef = useRef<LlamaRnLLM | null>(null);
  const embRef = useRef<LlamaRnEmbedder | null>(null);
  const bgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const auraRef = useRef<Aura | null>(null);

  const kvGet = async (a: Aura, key: string) => (await a.db.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', [key]))?.value;
  const kvSet = async (a: Aura, key: string, value: string) => void a.db.run('INSERT OR REPLACE INTO kv(key, value) VALUES (?,?)', [key, value]);

  const loadModelInto = useCallback(async (a: Aura, fileName: string) => {
    const inspection = await inspectLocal(fileName);
    const fit = fitFor(inspection);
    // The safety gate: never load a model the device can't hold.
    if (fit.verdict === 'no') throw new Error(`This phone can't run ${fileName} safely. ${fit.reasons.join(' ')}`);
    setStatus('loading-model');
    setModelProgress(0);
    await a.jobs.pause();
    const old = llmRef.current;
    llmRef.current = null;
    await old?.release(); // free the previous model's memory before loading the next
    const llm = await llamaRn().LlamaRnLLM.load(modelFile(fileName).uri, { nCtx: fit.runContext, onProgress: setModelProgress });
    llmRef.current = llm;
    await a.setLLM(llm);
    a.setConfig({ ramSafeTokens: fit.runContext });
    await kvSet(a, KV.model, fileName);
    setModel({ fileName, inspection, fit });
    setStatus('ready');
  }, []);

  const loadEmbedderInto = useCallback(async (a: Aura) => {
    const f = modelFile(EMBEDDER.file);
    if (!f.exists) return;
    const emb = await llamaRn().LlamaRnEmbedder.load(f.uri);
    await embRef.current?.release();
    embRef.current = emb;
    await a.setEmbedder(emb); // a changed embedder triggers background re-embedding
    setEmbedderReal(true);
  }, []);

  // ---- startup
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { openOpSqlite, tuneDb } = opSqlite();
        const db = openOpSqlite();
        await tuneDb(db);
        const a = await Aura.open({
          db, llm: NO_MODEL, embedder: new HashEmbedder(384),
          hooks: {
            // No background LLM jobs under 20% battery unless charging.
            canRunBackgroundLLM: async () => {
              const [level, state] = await Promise.all([Battery.getBatteryLevelAsync(), Battery.getBatteryStateAsync()]);
              return level < 0 || level >= 0.2 || state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL;
            },
          },
        });
        if (cancelled) return;
        auraRef.current = a;
        const saved = await kvGet(a, KV.config);
        if (saved) a.setConfig(JSON.parse(saved));
        const sid = Number(await kvGet(a, KV.session));
        setSessionState((sid && (await a.sessions.get(sid))) || (await a.sessions.list(1))[0] || (await a.sessions.create()));
        setAura(a);
        setStatus('ready');
        await loadEmbedderInto(a);
        const last = await kvGet(a, KV.model);
        if (last && modelFile(last).exists) await loadModelInto(a, last).catch((e) => setError(String(e.message ?? e)));
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
        setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [loadEmbedderInto, loadModelInto]);

  // ---- background jobs: only while the app is open and idle
  const scheduleBackground = useCallback(() => {
    if (bgTimer.current) clearTimeout(bgTimer.current);
    bgTimer.current = setTimeout(() => {
      const a = auraRef.current;
      if (a && AppState.currentState === 'active' && llmRef.current)
        void a.runBackground().then(() => setVersion((v) => v + 1));
      // 20 s of quiet, not 2.5 s: summaries/facts are extra full-load model passes, and stacking
      // them right after a long reply kept the SoC hot (S23 Ultra, 2026-11-12). Sending a message
      // still cancels them instantly.
    }, 20_000);
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') void auraRef.current?.jobs.pause();
      else scheduleBackground();
    });
    return () => sub.remove();
  }, [scheduleBackground]);

  // Memoized: a new object every render made every screen re-render on any provider update.
  const value = useMemo<AuraState>(() => ({
    aura, status, error, model, embedderReal, session, version,
    loadModel: async (fileName) => {
      if (!aura) return;
      setError(null);
      try {
        await loadModelInto(aura, fileName);
      } catch (e) {
        setStatus('ready');
        throw e;
      }
    },
    loadEmbedder: async () => { if (aura) await loadEmbedderInto(aura); },
    setSession: (s) => {
      setSessionState(s);
      if (aura) void kvSet(aura, KV.session, String(s.id));
    },
    newSession: async () => {
      if (!aura) return;
      const s = await aura.sessions.create();
      setSessionState(s);
      await kvSet(aura, KV.session, String(s.id));
    },
    setConfig: async (patch) => {
      if (!aura) return;
      aura.setConfig(patch);
      const { layers, retrieval, thinking } = aura.config;
      await kvSet(aura, KV.config, JSON.stringify({ layers, retrieval: { snippets: retrieval.snippets, k: retrieval.k }, thinking }));
      setVersion((v) => v + 1);
    },
    touch: () => setVersion((v) => v + 1),
    scheduleBackground,
  }), [aura, status, error, model, embedderReal, session, version, loadModelInto, loadEmbedderInto, scheduleBackground]);
  return (
    <Ctx.Provider value={value}>
      <ProgressCtx.Provider value={modelProgress}>{children}</ProgressCtx.Provider>
    </Ctx.Provider>
  );
}
