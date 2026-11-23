import * as Device from 'expo-device';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { formatBytes, usableMemory } from '@aura/core';
import { CHAT_MODELS, type CatalogEntry, EMBEDDER, hfUrl } from '../models/catalog';
import {
  type DownloadHandle, type Inspection, deleteModel, deviceMemory, fitFor, inspectRemote, listRepoGgufs, localModels,
  resumeDownload, searchGgufRepos, startDownload,
} from '../models/manager';
import { useAura, useModelProgress } from '../state/AuraProvider';
import { FitBadge } from '../ui/FitBadge';
import { ScreenHeader, Tap } from '../ui/motion';
import { type Theme, useTheme } from '../ui/theme';

interface DlState { handle: DownloadHandle; written: number; total: number; paused: boolean }

export default function ModelsScreen() {
  const t = useTheme();
  const { model, loadModel, loadEmbedder, embedderReal, status } = useAura();
  const modelProgress = useModelProgress();
  const [local, setLocal] = useState(localModels());
  const [downloads, setDownloads] = useState<Record<string, DlState>>({});
  const [custom, setCustom] = useState<CatalogEntry[]>([]);
  const [inspections, setInspections] = useState<Record<string, Inspection>>({});
  const [repo, setRepo] = useState('');
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<{ repo: string; downloads: number }[]>([]);
  // settle() runs long after the tap that started a download, so read the loaded model via a ref.
  const modelRef = useRef(model);
  modelRef.current = model;
  const refresh = useCallback(() => setLocal(localModels()), []);
  const device = deviceMemory();
  const has = (file: string) => local.some((l) => l.fileName === file);

  const inspection = (e: CatalogEntry): Inspection | undefined =>
    inspections[e.file] ?? (e.shape ? { shape: e.shape, sizeBytes: e.sizeBytes, exact: true } : undefined);

  const download = (e: CatalogEntry) => {
    try {
      // Native progress fires many times a second; re-render at most ~4×/s.
      let last = 0;
      const handle = startDownload(hfUrl(e.repo, e.file), e.file, e.sizeBytes, (written, total) => {
        const now = Date.now();
        if (now - last < 250 && written < total) return;
        last = now;
        setDownloads((d) => (d[e.file] ? { ...d, [e.file]: { ...d[e.file]!, written, total } } : d));
      });
      setDownloads((d) => ({ ...d, [e.file]: { handle, written: 0, total: e.sizeBytes, paused: false } }));
      void settle(e, handle.done);
    } catch (err) {
      Alert.alert('Cannot download', String(err instanceof Error ? err.message : err));
    }
  };
  const settle = async (e: CatalogEntry, p: Promise<unknown>) => {
    try {
      const f = await p;
      if (!f) return; // paused
      setDownloads(({ [e.file]: _, ...rest }) => rest);
      refresh();
      if (e.file === EMBEDDER.file) await loadEmbedder();
      // Before, a finished download only swapped the button to "Load", which was easy to miss.
      else if (!modelRef.current) await load(e);
      else Alert.alert('Download complete', `${e.label} is ready. Tap Load to switch to it.`);
    } catch (err) {
      setDownloads(({ [e.file]: _, ...rest }) => rest);
      Alert.alert('Download failed', String(err instanceof Error ? err.message : err));
    }
  };
  const togglePause = (e: CatalogEntry) => {
    const d = downloads[e.file];
    if (!d) return;
    if (d.paused) {
      setDownloads((all) => ({ ...all, [e.file]: { ...d, paused: false } }));
      void settle(e, resumeDownload(d.handle, e.file, e.sizeBytes));
    } else {
      d.handle.task.pause();
      setDownloads((all) => ({ ...all, [e.file]: { ...d, paused: true } }));
    }
  };
  const cancel = (e: CatalogEntry) => {
    downloads[e.file]?.handle.task.cancel();
    setDownloads(({ [e.file]: _, ...rest }) => rest);
    deleteModel(`${e.file}.part`);
  };

  const load = async (e: CatalogEntry) => {
    const ins = inspection(e);
    const fit = ins ? fitFor(ins) : null;
    const go = () => loadModel(e.file).catch((err) => Alert.alert('Cannot load', String(err instanceof Error ? err.message : err)));
    if (fit?.verdict === 'tight')
      Alert.alert('This model is tight for your phone', `${fit.reasons.join(' ')}\n\nIt will run with a ${fit.runContext.toLocaleString()}-token context. Other apps may be closed.`,
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Load anyway', onPress: () => void go() }]);
    else void go();
  };

  const remove = (e: CatalogEntry) =>
    Alert.alert(`Delete ${e.label}?`, 'The file is removed; your memory and chats are kept.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { deleteModel(e.file); refresh(); } },
    ]);

  // Lists one repo's GGUFs. Reads headers for the smallest few so they get exact fit verdicts.
  const openRepo = async (r: string) => {
    const files = (await listRepoGgufs(r)).filter((f) => !/mmproj/i.test(f.file));
    if (!files.length) throw new Error(`No .gguf files in ${r}.`);
    const entries = files.map((f) => ({ id: f.file, label: f.file.replace(/\.gguf$/, ''), repo: r, file: f.file, sizeBytes: f.sizeBytes, note: r }));
    setHits([]);
    setCustom(entries);
    for (const e of entries.slice(0, 4)) {
      const ins = await inspectRemote(hfUrl(e.repo, e.file), e.sizeBytes);
      setInspections((m) => ({ ...m, [e.file]: ins }));
    }
  };

  // "owner/repo" (or a pasted HF link) opens that repo; anything else is a free-text search.
  const searchRepo = async () => {
    const q = repo.trim().replace(/^https?:\/\/huggingface\.co\//, '').replace(/\/(tree|blob|resolve)\/.*$/, '');
    if (!q) return;
    setSearching(true);
    try {
      if (/^[\w.-]+\/[\w.-]+$/.test(q)) {
        try { await openRepo(q); return; } catch { /* not an exact repo id: fall through to search */ }
      }
      const found = await searchGgufRepos(q);
      if (!found.length) throw new Error(`No GGUF models found for "${q}".`);
      setCustom([]);
      setHits(found);
    } catch (err) {
      Alert.alert('Search', String(err instanceof Error ? err.message : err));
    } finally {
      setSearching(false);
    }
  };

  const pickRepo = async (r: string) => {
    setSearching(true);
    try { await openRepo(r); } catch (err) {
      Alert.alert('Repo', String(err instanceof Error ? err.message : err));
    } finally {
      setSearching(false);
    }
  };

  // Downloaded files that aren't in the catalog (from a custom repo earlier).
  const known = new Set([...CHAT_MODELS, ...custom, EMBEDDER].map((e) => e.file));
  const orphans: CatalogEntry[] = local.filter((l) => !known.has(l.fileName))
    .map((l) => ({ id: l.fileName, label: l.fileName.replace(/\.gguf$/, ''), repo: '', file: l.fileName, sizeBytes: l.sizeBytes, note: 'Downloaded' }));

  useEffect(() => { refresh(); }, [refresh, status]);

  const card = (e: CatalogEntry, isEmbedder = false) => {
    const ins = isEmbedder ? undefined : inspection(e);
    const fit = ins ? fitFor(ins) : null;
    const d = downloads[e.file];
    const downloaded = has(e.file);
    const active = model?.fileName === e.file;
    return (
      <View key={e.file} style={{ backgroundColor: t.card, borderRadius: 18, padding: 14, marginBottom: 10, borderWidth: active ? 2 : 1, borderColor: active ? t.accent : t.glassBorder }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={{ color: t.text, fontWeight: '600', fontSize: 15, flexShrink: 1 }}>{e.label}{active ? ' · loaded' : ''}</Text>
          <Text style={{ color: t.sub }}>{formatBytes(e.sizeBytes)}</Text>
        </View>
        <Text style={{ color: t.sub, fontSize: 12, marginTop: 2 }}>{e.note}</Text>
        {fit && ins && <FitBadge fit={fit} exact={ins.exact} compact={fit.verdict === 'ok'} />}
        {!fit && !isEmbedder && (
          <Pressable onPress={async () => setInspections({ ...inspections, [e.file]: await inspectRemote(hfUrl(e.repo, e.file), e.sizeBytes) })}>
            <Text style={{ color: t.link, marginTop: 6 }}>Check if it runs on this phone</Text>
          </Pressable>
        )}
        {d && (
          <View style={{ marginTop: 8 }}>
            <View style={{ height: 6, backgroundColor: t.border, borderRadius: 3 }}>
              <View style={{ height: 6, width: `${Math.min(100, (100 * d.written) / (d.total || 1))}%`, backgroundColor: t.accent, borderRadius: 3 }} />
            </View>
            <Text style={{ color: t.sub, fontSize: 12, marginTop: 4 }}>{formatBytes(d.written)} / {formatBytes(d.total)}{d.paused ? ' · paused' : ''}</Text>
          </View>
        )}
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
          {d ? (
            <>
              <Btn t={t} label={d.paused ? 'Resume' : 'Pause'} onPress={() => togglePause(e)} />
              <Btn t={t} label="Cancel" onPress={() => cancel(e)} kind="ghost" />
            </>
          ) : downloaded ? (
            <>
              {!isEmbedder && !active && <Btn t={t} label="Load" disabled={fit?.verdict === 'no' || status === 'loading-model'} onPress={() => void load(e)} />}
              {!active && <Btn t={t} label="Delete" kind="ghost" onPress={() => remove(e)} />}
            </>
          ) : (
            <Btn t={t} label="Download" disabled={fit?.verdict === 'no'} onPress={() => download(e)} />
          )}
        </View>
        {fit?.verdict === 'no' && <Text style={{ color: t.bad, fontSize: 12, marginTop: 6 }}>Blocked to protect your phone. Pick a smaller model.</Text>}
      </View>
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title="Models" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14 }}>
        <View style={{ backgroundColor: t.card, borderWidth: 1, borderColor: t.glassBorder, borderRadius: 18, padding: 12, marginBottom: 14 }}>
          <Text style={{ color: t.text, fontWeight: '600' }}>This phone: {Device.modelName ?? 'Unknown device'}</Text>
          <Text style={{ color: t.sub, fontSize: 13, marginTop: 2 }}>
            {formatBytes(device.totalBytes)} RAM · about {formatBytes(usableMemory(device))} safely usable by one app
          </Text>
          <Text style={{ color: t.sub, fontSize: 12, marginTop: 6 }}>
            Each model is checked against this phone before download: weights + memory for the conversation (KV cache) + working space.
            Models that won't fit are blocked so they can't freeze or crash the phone.
          </Text>
          {status === 'loading-model' && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <ActivityIndicator /><Text style={{ color: t.text }}>Loading model… {Math.round(modelProgress)}%</Text>
            </View>
          )}
        </View>

        <Text style={{ color: t.text, fontWeight: '700', marginBottom: 6 }}>Memory search model {embedderReal ? '✓' : ''}</Text>
        {card(EMBEDDER, true)}

        <Text style={{ color: t.text, fontWeight: '700', marginVertical: 6 }}>Chat models</Text>
        {CHAT_MODELS.map((e) => card(e))}
        {orphans.map((e) => card(e))}

        <Text style={{ color: t.text, fontWeight: '700', marginVertical: 6 }}>Any GGUF on Hugging Face</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
          <TextInput value={repo} onChangeText={setRepo} onSubmitEditing={() => void searchRepo()} returnKeyType="search" placeholder="Search, e.g. qwen3 1.7b" placeholderTextColor={t.sub} autoCapitalize="none" autoCorrect={false}
            style={{ flex: 1, color: t.text, backgroundColor: t.glass, borderWidth: 1, borderColor: t.glassBorder, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9 }} />
          <Btn t={t} label={searching ? '…' : 'Find'} disabled={searching} onPress={() => void searchRepo()} />
        </View>
        {hits.map((h) => (
          <Pressable key={h.repo} onPress={() => void pickRepo(h.repo)} disabled={searching}
            style={{ backgroundColor: t.card, borderWidth: 1, borderColor: t.glassBorder, borderRadius: 16, padding: 12, marginBottom: 8, flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ color: t.text, flexShrink: 1 }}>{h.repo}</Text>
            <Text style={{ color: t.sub, fontSize: 12 }}>{h.downloads.toLocaleString()} ↓</Text>
          </Pressable>
        ))}
        {custom.map((e) => card(e))}
      </ScrollView>
    </View>
  );
}

function Btn({ t, label, onPress, disabled, kind = 'primary' }: { t: Theme; label: string; onPress: () => void; disabled?: boolean; kind?: 'primary' | 'ghost' }) {
  return (
    <Tap onPress={onPress} disabled={disabled}
      style={{ backgroundColor: kind === 'primary' ? t.accent : t.chip, borderWidth: kind === 'ghost' ? 1 : 0, borderColor: t.glassBorder, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 9, opacity: disabled ? 0.4 : 1 }}>
      <Text style={{ color: kind === 'primary' ? t.onAccent : t.text, fontWeight: '600' }}>{label}</Text>
    </Tap>
  );
}
