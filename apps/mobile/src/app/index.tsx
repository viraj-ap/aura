import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { type AuraEvent, type Status, type WebSource, stripReasoning } from '@aura/core';
import { useAura } from '../state/AuraProvider';
import { Composer, type PendingFile } from '../ui/Composer';
import { Markdown } from '../ui/Markdown';
import { FadeIn, Tap, TypingDots } from '../ui/motion';
import { type Msg, MessageRow } from '../ui/MessageRow';
import { SideDrawer } from '../ui/SideDrawer';
import { type Stream, createStream, useStream } from '../ui/stream';
import { useTheme } from '../ui/theme';

// Native-backed modules load lazily (see native.ts): an old dev client must reach the fix-it screen, not crash.
const attachments = () => require('../attachments/extract') as typeof import('../attachments/extract');
const webSearch: typeof import('../web/search').webSearch = (...a) => (require('../web/search') as typeof import('../web/search')).webSearch(...a);

const DOWN_REASONS = ['Too long', 'Wrong / made up', "Didn't remember"];
const SUGGESTIONS = ['What do you remember about me?', 'Summarize this PDF', 'Help me plan my week'];

const toMsg = (e: AuraEvent): Msg => e.type === 'attachment'
  ? { id: e.id, role: 'file', content: '', name: String(e.meta?.name ?? 'file'), kind: e.meta?.kind as Msg['kind'], pages: e.meta?.pages as number | undefined }
  : { id: e.id, role: e.role as 'user' | 'assistant', content: e.content, sources: e.meta?.webSources as Msg['sources'] };

export default function ChatScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { aura, session, model, status, error, scheduleBackground, touch, newSession, setConfig } = useAura();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [phase, setPhase] = useState<Status | string>('idle');
  const [web, setWeb] = useState(false);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [drawer, setDrawer] = useState(false);
  const stream = useMemo(() => createStream(), []);
  const abort = useRef<AbortController | null>(null);

  // History (messages + attached files) from the event log.
  useEffect(() => {
    if (!aura || !session) return;
    setFiles([]);
    void aura.log.listSession(session.id, { types: ['message', 'attachment'] }).then((evs) => setMsgs(evs.map(toMsg)));
  }, [aura, session]);

  const attach = useCallback(async (source: 'library' | 'camera' | 'pdf') => {
    if (!aura || !session) return;
    let picked;
    try {
      picked = source === 'pdf' ? await attachments().pickPdf() : await attachments().pickImage(source);
    } catch (e) {
      return Alert.alert('Attach', String(e instanceof Error ? e.message : e));
    }
    if (!picked) return;
    const key = `${Date.now()}`;
    setFiles((f) => [...f, { key, name: picked.name, kind: picked.kind, status: 'reading' }]);
    try {
      const ev = await aura.attach(session.id, await attachments().extract(picked));
      setFiles((f) => f.map((x) => (x.key === key ? { ...x, status: 'ready', eventId: ev.id } : x)));
    } catch (e) {
      setFiles((f) => f.map((x) => (x.key === key ? { ...x, status: 'error', error: String(e instanceof Error ? e.message : e) } : x)));
    }
  }, [aura, session]);

  const removeFile = useCallback((f: PendingFile) => {
    setFiles((all) => all.filter((x) => x.key !== f.key));
    if (f.eventId && aura) void aura.forget.events([f.eventId]); // never sent → don't keep it in memory
  }, [aura]);

  const send = useCallback((raw: string): boolean => {
    const ready = files.filter((f) => f.status === 'ready');
    const text = raw.trim() || (ready.length ? 'Summarize the attached file.' : '');
    if (!text || !aura || !session || streaming) return false;
    if (!model) {
      Alert.alert('No model loaded', 'Download and load a model first.', [{ text: 'Open Models', onPress: () => router.push('/models') }]);
      return false;
    }
    void (async () => {
      setFiles((all) => all.filter((f) => f.status !== 'ready'));
      setMsgs((m) => [...m, ...ready.map((f): Msg => ({ id: f.eventId!, role: 'file', content: '', name: f.name, kind: f.kind, fresh: true })),
        { id: -Date.now(), role: 'user', content: text, fresh: true }]);
      setStreaming(true);
      stream.reset();
      abort.current = new AbortController();
      let raw = '';
      try {
        let sources: WebSource[] = [];
        if (web) {
          try {
            sources = await webSearch(text, setPhase);
          } catch (e) {
            setPhase(`Web search failed: ${e instanceof Error ? e.message : e}`);
          }
        }
        const r = await aura.send(session.id, text, {
          signal: abort.current.signal,
          attachmentIds: ready.map((f) => f.eventId!),
          web: sources,
          onStatus: setPhase,
          onToken: (tok) => {
            raw += tok;
            // Strip reasoning only on publish-sized steps, not per token (O(n²) on long replies).
            stream.set(raw.includes('<think>') && !raw.includes('</think>') ? '' : stripReasoning(raw));
          },
        });
        const d = r.debug;
        const stats = [
          `${d.assembled.promptTokens} prompt tokens (${d.generation.cachedTokens} cached)`,
          d.assembled.memoryKeys.length ? `${d.assembled.memoryKeys.length} memories` : '',
          d.assembled.factIds.length ? `${d.assembled.factIds.length} facts` : '',
          d.assembled.sections.attached.items ? `${d.assembled.sections.attached.items} file/web excerpts` : '',
          d.retrieval.method === 'scroll' ? 'planned lookup' : '',
          `first token ${d.generation.ttftMs} ms`,
          d.generation.completionTokens && d.generation.totalMs > d.generation.ttftMs
            ? `${(d.generation.completionTokens / ((d.generation.totalMs - d.generation.ttftMs) / 1000)).toFixed(1)} tok/s` : '',
          d.generation.stopReason === 'abort' ? 'stopped' : '',
        ].filter(Boolean).join('\n');
        setMsgs((m) => [
          ...m.slice(0, -1),
          // Same key as the optimistic row would change identity; keep it un-animated (it's already on screen).
          { id: r.userEvent.id, role: 'user', content: text },
          { id: r.assistantEvent.id, role: 'assistant', content: r.reply, sources: sources.map((s) => ({ title: s.title, url: s.url })), stats, fresh: true },
        ]);
        touch();
        scheduleBackground(); // summaries / facts run once the user goes quiet
      } catch (e) {
        Alert.alert('Error', String(e instanceof Error ? e.message : e));
      } finally {
        setStreaming(false);
        setPhase('idle');
        stream.reset();
        abort.current = null;
      }
    })();
    return true;
  }, [aura, session, model, streaming, files, web, stream, touch, scheduleBackground]);

  const rate = useCallback((m: Msg, value: 'up' | 'down') => {
    if (!aura) return;
    const done = async (comment = '') => {
      await aura.feedback(m.id, value, comment);
      setMsgs((all) => all.map((x) => (x.id === m.id ? { ...x, rated: value } : x)));
      scheduleBackground(); // reflection → playbook
    };
    if (value === 'up') return void done();
    Alert.alert('What was wrong?', undefined, DOWN_REASONS.map((r) => ({ text: r, onPress: () => void done(r.toLowerCase()) })), { cancelable: true });
  }, [aura, scheduleBackground]);

  const showStats = useCallback((m: Msg) => {
    Alert.alert('About this reply', m.stats ?? 'Stats are shown for replies from this session.', [
      { text: 'Show prompt', onPress: () => router.push('/debug') }, { text: 'OK' },
    ]);
  }, []);

  const stop = useCallback(() => abort.current?.abort(), []);
  const toggleWeb = useCallback(() => setWeb((w) => !w), []);
  const thinking = aura?.config.thinking ?? false;
  const toggleThinking = useCallback(() => void setConfig({ thinking: !thinking }), [setConfig, thinking]);
  const openModels = useCallback(() => router.push('/models'), []);
  const onAttach = useCallback((s: 'library' | 'camera' | 'pdf') => void attach(s), [attach]);

  // Inverted list: newest at the bottom with no scrollToEnd per token; it stays pinned as text grows.
  const data = useMemo(() => [...msgs].reverse(), [msgs]);
  const renderItem = useCallback(({ item }: { item: Msg }) => <MessageRow m={item} onRate={rate} onStats={showStats} />, [rate, showStats]);
  const loading = status === 'loading-model' || status === 'starting';
  const modelName = model ? model.fileName.replace(/\.gguf$/i, '').replace(/-Q\d.*$/i, '') : loading ? 'Loading…' : 'Choose a model';

  return (
    <View style={{ flex: 1, paddingTop: insets.top }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, height: 56 }}>
        <Tap hitSlop={8} onPress={() => setDrawer(true)} accessibilityLabel="Menu" style={circle(t)}>
          <Ionicons name="menu" size={21} color={t.text} />
        </Tap>
        <Tap onPress={openModels} scale={0.97} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 40, borderRadius: 20,
          backgroundColor: t.glass, borderWidth: 1, borderColor: t.glassBorder, maxWidth: 220 }}>
          {loading ? <ActivityIndicator size="small" color={t.sub} /> : <Ionicons name="sparkles" size={14} color="#e0559a" />}
          <Text style={{ color: t.text, fontSize: 15, fontWeight: '600', flexShrink: 1 }} numberOfLines={1}>{modelName}</Text>
          <Ionicons name="chevron-down" size={14} color={t.sub} />
        </Tap>
        <Tap hitSlop={8} onPress={() => void newSession()} accessibilityLabel="New chat" style={circle(t)}>
          <Ionicons name="create-outline" size={20} color={t.text} />
        </Tap>
      </View>
      {error && <Text style={{ color: t.bad, fontSize: 12, textAlign: 'center', paddingHorizontal: 16 }}>{error}</Text>}

      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        {msgs.length === 0 && !streaming ? (
          <View key={session?.id} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, gap: 14 }}>
            <FadeIn from={14}><Text style={{ color: t.text, fontSize: 28, fontWeight: '600', textAlign: 'center' }}>What can I help with?</Text></FadeIn>
            <FadeIn delay={80}><Text style={{ color: t.sub, textAlign: 'center', fontSize: 15 }}>Runs on this phone and remembers across chats.</Text></FadeIn>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 8 }}>
              {SUGGESTIONS.map((s, i) => (
                <FadeIn key={s} delay={160 + i * 70}>
                  <Tap onPress={() => (s.includes('PDF') ? void attach('pdf') : send(s))}
                    style={{ backgroundColor: t.chip, borderWidth: 1, borderColor: t.glassBorder, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10 }}>
                    <Text style={{ color: t.text, fontSize: 14 }}>{s}</Text>
                  </Tap>
                </FadeIn>
              ))}
            </View>
          </View>
        ) : (
          <FlatList
            inverted
            data={data}
            keyExtractor={(m) => String(m.id)}
            renderItem={renderItem}
            contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12, gap: 18 }}
            ListHeaderComponent={streaming ? <StreamingRow stream={stream} phase={phase} /> : undefined}
            keyboardShouldPersistTaps="handled"
            removeClippedSubviews
            windowSize={9}
            maxToRenderPerBatch={8}
            initialNumToRender={12}
          />
        )}
        <View style={{ paddingBottom: insets.bottom }}>
          <Composer
            disabled={loading}
            streaming={streaming}
            placeholder={model ? (web ? 'Ask the web anything' : 'Ask anything') : 'Load a model to start'}
            web={web}
            thinking={thinking}
            modelLabel={modelName}
            files={files}
            onToggleWeb={toggleWeb}
            onToggleThinking={toggleThinking}
            onOpenModels={openModels}
            onAttach={onAttach}
            onRemoveFile={removeFile}
            onSend={send}
            onStop={stop}
          />
        </View>
      </KeyboardAvoidingView>
      <SideDrawer open={drawer} onClose={() => setDrawer(false)} />
    </View>
  );
}

const circle = (t: ReturnType<typeof useTheme>) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center' as const, justifyContent: 'center' as const,
  backgroundColor: t.glass, borderWidth: 1, borderColor: t.glassBorder });

const PHASE_LABEL: Record<string, string> = {
  'searching memory': 'Searching memory…',
  compressing: 'Tidying up older messages…',
};

/** The reply being generated. The only component that re-renders while tokens stream. */
function StreamingRow({ stream, phase }: { stream: Stream; phase: string }) {
  const text = useStream(stream);
  if (text) return <Markdown text={text} />;
  const label = PHASE_LABEL[phase] ?? (phase === 'generating' || phase === 'idle' ? null : phase);
  return <TypingDots label={label} />;
}
