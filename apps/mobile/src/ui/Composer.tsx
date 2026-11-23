import Ionicons from '@expo/vector-icons/Ionicons';
import { memo, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, Text, TextInput, View } from 'react-native';
import { Tap } from './motion';
import { type Theme, useTheme } from './theme';

export interface PendingFile {
  key: string;
  name: string;
  kind: 'pdf' | 'image';
  status: 'reading' | 'ready' | 'error';
  eventId?: number;
  error?: string;
}

type Icon = keyof typeof Ionicons.glyphMap;
type Menu = 'attach' | 'tools' | null;

interface Props {
  disabled: boolean;
  streaming: boolean;
  placeholder: string;
  web: boolean;
  thinking: boolean;
  modelLabel: string;
  files: PendingFile[];
  onToggleWeb: () => void;
  onToggleThinking: () => void;
  onOpenModels: () => void;
  onAttach: (source: 'library' | 'camera' | 'pdf') => void;
  onRemoveFile: (f: PendingFile) => void;
  onSend: (text: string) => boolean;
  onStop: () => void;
}

/**
 * Frosted composer: text on top; underneath a row of chips: ＋ (photo / camera / PDF), Tools (web
 * search, think longer), the active modes, the model, and the send ↑ / stop ■ button. Owns its own
 * text so typing never re-renders the message list.
 */
export const Composer = memo(function Composer(p: Props) {
  const t = useTheme();
  const [text, setText] = useState('');
  const [menu, setMenu] = useState<Menu>(null);
  const busyFiles = p.files.some((f) => f.status === 'reading');
  const canSend = !p.disabled && !busyFiles && (text.trim().length > 0 || p.files.some((f) => f.status === 'ready'));

  const send = () => { if (canSend && p.onSend(text)) { setText(''); setMenu(null); } };
  const toggle = (m: Exclude<Menu, null>) => setMenu((cur) => (cur === m ? null : m));

  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: 10 }}>
      {menu && (
        <Popover t={t} onClose={() => setMenu(null)} items={menu === 'attach' ? [
          { icon: 'image-outline', label: 'Photo', onPress: () => p.onAttach('library') },
          { icon: 'camera-outline', label: 'Take a photo', onPress: () => p.onAttach('camera') },
          { icon: 'document-text-outline', label: 'PDF', onPress: () => p.onAttach('pdf') },
        ] : [
          { icon: 'globe-outline', label: 'Search the web', on: p.web, onPress: p.onToggleWeb },
          { icon: 'bulb-outline', label: 'Think longer', on: p.thinking, onPress: p.onToggleThinking },
          { icon: 'hardware-chip-outline', label: 'Change model', onPress: p.onOpenModels },
        ]} left={menu === 'attach' ? 12 : 60} />
      )}

      <View style={{ backgroundColor: t.glass, borderRadius: 28, borderWidth: 1, borderColor: t.glassBorder, padding: 10, gap: 6,
        boxShadow: `0 10px 30px ${t.shadow}` }}>
        {p.files.length > 0 && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {p.files.map((f) => <FileChip key={f.key} f={f} t={t} onRemove={() => p.onRemoveFile(f)} />)}
          </View>
        )}
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={p.placeholder}
          placeholderTextColor={t.sub}
          multiline
          onFocus={() => setMenu(null)}
          style={{ color: t.text, fontSize: 17, maxHeight: 140, minHeight: 40, paddingHorizontal: 8, paddingTop: 8, paddingBottom: 4 }}
        />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Chip t={t} icon={menu === 'attach' ? 'close' : 'add'} round onPress={() => toggle('attach')} label="Attach" active={menu === 'attach'} />
          <Chip t={t} icon="options-outline" text="Tools" onPress={() => toggle('tools')} active={menu === 'tools'} />
          {p.web && <Chip t={t} icon="globe-outline" text="Web" onPress={p.onToggleWeb} tint={t.link} closable />}
          {p.thinking && <Chip t={t} icon="bulb-outline" text="Think" onPress={p.onToggleThinking} tint={t.link} closable />}
          {!p.web && !p.thinking && (
            <Chip t={t} icon="sparkles" text={p.modelLabel} onPress={p.onOpenModels} tint="#e0559a" shrink />
          )}
          <View style={{ flex: 1 }} />
          <SendButton t={t} streaming={p.streaming} enabled={canSend} onSend={send} onStop={p.onStop} />
        </View>
      </View>
    </View>
  );
});

function Chip({ t, icon, text, label, onPress, active, round, tint, closable, shrink }: {
  t: Theme; icon: Icon; text?: string; label?: string; onPress: () => void; active?: boolean; round?: boolean; tint?: string; closable?: boolean; shrink?: boolean;
}) {
  return (
    <Tap onPress={onPress} accessibilityLabel={label ?? text} hitSlop={4} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 40,
      paddingHorizontal: round ? 0 : 14, width: round ? 40 : undefined, justifyContent: 'center', borderRadius: 20, flexShrink: shrink ? 1 : 0,
      backgroundColor: active ? t.chipActive : t.chip, borderWidth: 1, borderColor: t.glassBorder }}>
      <Ionicons name={icon} size={round ? 22 : 17} color={tint ?? t.text} />
      {text && <Text numberOfLines={1} style={{ color: t.text, fontSize: 15, fontWeight: '500', flexShrink: 1 }}>{text}</Text>}
      {closable && <Ionicons name="close" size={14} color={t.sub} />}
    </Tap>
  );
}

/** Dark circle; springs up and fades in when there's something to send, morphs to stop while streaming. */
function SendButton({ t, streaming, enabled, onSend, onStop }: { t: Theme; streaming: boolean; enabled: boolean; onSend: () => void; onStop: () => void }) {
  const on = useRef(new Animated.Value(enabled || streaming ? 1 : 0)).current;
  useEffect(() => {
    Animated.spring(on, { toValue: enabled || streaming ? 1 : 0, useNativeDriver: true, speed: 18, bounciness: 10 }).start();
  }, [enabled, streaming]);
  return (
    <Tap onPress={streaming ? onStop : onSend} disabled={!streaming && !enabled} accessibilityLabel={streaming ? 'Stop' : 'Send'} scale={0.88}>
      <Animated.View style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: t.accent,
        opacity: on.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
        transform: [{ scale: on.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }] }}>
        <Ionicons name={streaming ? 'stop' : 'arrow-up'} size={streaming ? 16 : 21} color={t.onAccent} />
      </Animated.View>
    </Tap>
  );
}

function FileChip({ f, t, onRemove }: { f: PendingFile; t: Theme; onRemove: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: t.chip, borderRadius: 14, paddingLeft: 10, paddingRight: 6,
      paddingVertical: 7, maxWidth: '100%', borderWidth: 1, borderColor: f.status === 'error' ? t.bad : t.glassBorder }}>
      {f.status === 'reading' ? <ActivityIndicator size="small" color={t.sub} />
        : <Ionicons name={f.kind === 'pdf' ? 'document-text-outline' : 'image-outline'} size={16} color={f.status === 'error' ? t.bad : t.sub} />}
      <Text style={{ color: t.text, fontSize: 13, flexShrink: 1 }} numberOfLines={1}>
        {f.status === 'reading' ? `Reading ${f.name}…` : f.status === 'error' ? f.error ?? 'Could not read file' : f.name}
      </Text>
      {f.status !== 'reading' && <Pressable hitSlop={8} onPress={onRemove}><Ionicons name="close" size={16} color={t.sub} /></Pressable>}
    </View>
  );
}

interface Item { icon: Icon; label: string; on?: boolean; onPress: () => void }

/** Frosted menu that pops up above the composer (scale + fade); the pressed row gets a white pill. */
function Popover({ t, items, left, onClose }: { t: Theme; items: Item[]; left: number; onClose: () => void }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: 170, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, []);
  return (
    <Animated.View style={{ position: 'absolute', bottom: '100%', left, zIndex: 5, minWidth: 220, padding: 6, borderRadius: 18,
      backgroundColor: t.glass, borderWidth: 1, borderColor: t.glassBorder, boxShadow: `0 12px 32px ${t.shadow}`,
      opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [8, -4] }) }, { scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }] }}>
      {items.map((it) => (
        <Pressable key={it.label} onPress={() => { onClose(); it.onPress(); }}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 11, borderRadius: 12,
            backgroundColor: pressed || it.on ? t.highlight : 'transparent' })}>
          <Ionicons name={it.icon} size={19} color={t.text} />
          <Text style={{ color: t.text, fontSize: 15, fontWeight: it.on ? '600' : '500', flex: 1 }}>{it.label}</Text>
          {it.on && <Ionicons name="checkmark" size={17} color={t.text} />}
        </Pressable>
      ))}
    </Animated.View>
  );
}
