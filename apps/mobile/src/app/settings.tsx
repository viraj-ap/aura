import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, Switch, Text, View } from 'react-native';
import type { AuraConfig } from '@aura/core';
import { useAura } from '../state/AuraProvider';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ScreenHeader, Tap } from '../ui/motion';
import { THEMES, type ThemeName, useTheme, useThemeControl } from '../ui/theme';

type LayerKey = keyof AuraConfig['layers'];

const LAYERS: { key: LayerKey; label: string; help: string }[] = [
  { key: 'retrieval', label: 'Search past chats', help: 'Hybrid keyword + meaning search across all chats (L3).' },
  { key: 'scrollLite', label: 'Let the model plan lookups', help: 'Scroll-lite: the model decides what to search. Needs ~1.7B+; falls back automatically if the model fails the check.' },
  { key: 'facts', label: 'Learn facts about me', help: 'Background extraction from your messages only (L2).' },
  { key: 'episodic', label: 'Summarise chats', help: 'Background per-chat summaries that become searchable (L2).' },
  { key: 'compression', label: 'Compress long chats', help: 'Summarise older turns instead of forgetting them (L5).' },
  { key: 'playbook', label: 'Learn from 👍/👎', help: 'Turns your ratings into answer-style rules (L6).' },
];

export default function SettingsScreen() {
  const t = useTheme();
  const { setTheme } = useThemeControl();
  const { aura, model, setConfig, version } = useAura();
  const [probing, setProbing] = useState(false);
  void version; // re-render after config changes
  if (!aura) return null;
  const cfg = aura.config;

  const probe = async () => {
    if (!model) return Alert.alert('Load a model first');
    setProbing(true);
    try {
      const r = await aura.runProbe();
      Alert.alert(r.passed ? 'Passed' : 'Not passed', `${r.passed ? `${model.fileName} can plan memory lookups.` : 'This model will use the regular search instead.'}\n\n${r.details.join('\n')}`);
    } finally {
      setProbing(false);
    }
  };

  const Row = ({ label, help, value, onChange }: { label: string; help: string; value: boolean; onChange: (v: boolean) => void }) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: t.card, borderWidth: 1, borderColor: t.glassBorder, borderRadius: 16, padding: 12, marginBottom: 8 }}>
      <View style={{ flex: 1, paddingRight: 10 }}>
        <Text style={{ color: t.text, fontWeight: '600' }}>{label}</Text>
        <Text style={{ color: t.sub, fontSize: 12 }}>{help}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: t.accent, false: t.border }} thumbColor={t.solid} />
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title="Settings" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14 }}>
        <Text style={{ color: t.text, fontWeight: '700', marginBottom: 8 }}>Theme</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 18 }}>
          {(Object.keys(THEMES) as ThemeName[]).map((n) => <Swatch key={n} name={n} selected={t.name === n} onPress={() => setTheme(n)} />)}
        </View>

        <Text style={{ color: t.text, fontWeight: '700', marginBottom: 8 }}>Memory layers</Text>
        {LAYERS.map((l) => (
          <Row key={l.key} label={l.label} help={l.help} value={cfg.layers[l.key]} onChange={(v) => void setConfig({ layers: { [l.key]: v } })} />
        ))}
        <Text style={{ color: t.link, marginBottom: 16 }} onPress={() => void probe()}>
          {probing ? 'Checking…' : 'Check whether the loaded model can plan lookups'} {probing && <ActivityIndicator size="small" />}
        </Text>

        <Text style={{ color: t.text, fontWeight: '700', marginBottom: 8 }}>Answers</Text>
        <Row label="Short memory snippets" help="Show the model only the matching part of long past messages: half the tokens, faster first word." value={cfg.retrieval.snippets}
          onChange={(v) => void setConfig({ retrieval: { snippets: v } })} />
        <Row label="Thinking mode" help="Let models like Qwen3 reason before answering. Slower; reasoning is never stored." value={cfg.thinking}
          onChange={(v) => void setConfig({ thinking: v })} />

        <Text style={{ color: t.text, fontWeight: '700', marginVertical: 8 }}>About this model</Text>
        <View style={{ backgroundColor: t.card, borderWidth: 1, borderColor: t.glassBorder, borderRadius: 16, padding: 12 }}>
          {model ? (
            <>
              <Text style={{ color: t.text }}>{model.fileName}</Text>
              <Text style={{ color: t.sub, fontSize: 12 }}>
                {model.inspection.shape.architecture} · {model.inspection.shape.blockCount} layers · running at {model.fit.runContext.toLocaleString()} tokens of context
                (model max {model.inspection.shape.contextLength.toLocaleString()}, chosen to fit this phone's memory)
              </Text>
            </>
          ) : <Text style={{ color: t.sub }}>No model loaded.</Text>}
        </View>
        <Text style={{ color: t.link, marginTop: 16 }} onPress={() => router.push('/debug')}>Show the exact prompt of the last reply</Text>
        <Text style={{ color: t.sub, fontSize: 12, marginTop: 16 }}>
          AURA runs fully on this device. The network is used only to download models and, when you turn on the globe for a message,
          to search the web: that query goes to Brave Search (or DuckDuckGo) and the top pages are opened, like in a browser. Web results
          are used for that one answer and are not stored. Photos and PDFs are read on the phone.
        </Text>
      </ScrollView>
    </View>
  );
}

/** A theme preview: its own gradient with a mini frosted composer, ringed when selected. */
function Swatch({ name, selected, onPress }: { name: ThemeName; selected: boolean; onPress: () => void }) {
  const th = THEMES[name];
  const t = useTheme();
  return (
    <Tap onPress={onPress} scale={0.94} accessibilityLabel={`${th.label} theme`}
      style={{ width: '47%', borderRadius: 20, padding: 3, borderWidth: 2, borderColor: selected ? t.accent : 'transparent' }}>
      <View style={{ height: 96, borderRadius: 16, overflow: 'hidden', backgroundImage: th.gradient, justifyContent: 'flex-end', padding: 8 }}>
        <View style={{ height: 26, borderRadius: 13, backgroundColor: th.glass, borderWidth: 1, borderColor: th.glassBorder, flexDirection: 'row',
          alignItems: 'center', justifyContent: 'flex-end', paddingHorizontal: 3 }}>
          <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: th.accent }} />
        </View>
        {selected && (
          <View style={{ position: 'absolute', top: 8, right: 8, width: 22, height: 22, borderRadius: 11, backgroundColor: th.accent, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="checkmark" size={14} color={th.onAccent} />
          </View>
        )}
      </View>
      <Text style={{ color: t.text, fontWeight: selected ? '700' : '500', textAlign: 'center', marginTop: 6, marginBottom: 2 }}>{th.label}</Text>
    </Tap>
  );
}
