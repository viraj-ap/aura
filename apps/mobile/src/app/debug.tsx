import { ScrollView, Text, View } from 'react-native';
import { formatMemory } from '@aura/core';
import { useAura } from '../state/AuraProvider';
import { ScreenHeader } from '../ui/motion';
import { useTheme } from '../ui/theme';

/** Debug panel: what went into the last prompt, and the exact prompt text. */
export default function DebugScreen() {
  const t = useTheme();
  const { aura } = useAura();
  const d = aura?.lastDebug;
  if (!d) return <View style={{ flex: 1 }}><ScreenHeader title="Last prompt" /><Text style={{ color: t.sub, padding: 16 }}>Send a message first.</Text></View>;
  const a = d.assembled;
  const mono = { fontFamily: 'monospace', fontSize: 11, color: t.text } as const;
  const used = new Set(a.memoryKeys);
  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title="Last prompt" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 10 }}>
        <View style={{ backgroundColor: t.card, borderWidth: 1, borderColor: t.glassBorder, borderRadius: 16, padding: 10 }}>
          <Text style={{ color: t.text, fontWeight: '600' }}>{a.promptTokens} / {a.budget} tokens · {d.generation.cachedTokens} reused from cache</Text>
          <Text style={{ color: t.sub, fontSize: 12 }}>route: {d.route.retrieve ? 'retrieve' : 'skip'} ({d.route.reason}) · retrieval: {d.retrieval.method} in {d.retrieval.ms} ms · TTFT {d.generation.ttftMs} ms</Text>
          {Object.entries(a.sections).map(([k, s]) => (
            <Text key={k} style={mono}>{k.padEnd(10)} {String(s.used).padStart(5)} / {String(s.budget).padEnd(5)} tok · {s.items} item(s)</Text>
          ))}
          {d.compaction?.compacted && <Text style={{ color: t.warn, fontSize: 12 }}>compressed {d.compaction.foldedEvents} older turns ({d.compaction.beforeTokens}→{d.compaction.afterTokens} tok)</Text>}
        </View>
        {d.scroll && (
          <View style={{ backgroundColor: t.card, borderWidth: 1, borderColor: t.glassBorder, borderRadius: 16, padding: 10 }}>
            <Text style={{ color: t.text, fontWeight: '600' }}>Planned lookups</Text>
            {d.scroll.trace.map((tr) => <Text key={tr.round} style={mono}>round {tr.round} ({tr.ms} ms): {tr.raw.replace(/\s+/g, ' ')} → {tr.ops ? `${tr.results} results` : 'invalid'}</Text>)}
          </View>
        )}
        {d.retrieval.items.length > 0 && (
          <View style={{ backgroundColor: t.card, borderWidth: 1, borderColor: t.glassBorder, borderRadius: 16, padding: 10 }}>
            <Text style={{ color: t.text, fontWeight: '600' }}>Retrieved ({used.size} used)</Text>
            {d.retrieval.items.slice(0, 12).map((m) => (
              <Text key={m.key} style={[mono, { color: used.has(m.key) ? t.text : t.sub }]} numberOfLines={2}>
                {used.has(m.key) ? '✓' : ' '} {m.score.toFixed(2)} {formatMemory(m)}
              </Text>
            ))}
          </View>
        )}
        <Text style={{ color: t.text, fontWeight: '600' }}>Exact prompt sent to the model</Text>
        <Text selectable style={[mono, { backgroundColor: t.card, borderWidth: 1, borderColor: t.glassBorder, borderRadius: 16, padding: 10 }]}>{a.prompt}</Text>
      </ScrollView>
    </View>
  );
}
