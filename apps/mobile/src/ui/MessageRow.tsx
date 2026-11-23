import Ionicons from '@expo/vector-icons/Ionicons';
import { memo, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { Markdown } from './Markdown';
import { FadeIn, Tap } from './motion';
import { useTheme } from './theme';

export interface Msg {
  id: number;
  role: 'user' | 'assistant' | 'file';
  content: string;
  /** Files: display name + kind. */
  name?: string;
  kind?: 'pdf' | 'image' | 'text';
  pages?: number;
  sources?: { title: string; url: string }[];
  stats?: string;
  rated?: 'up' | 'down';
  /** Added in this session: slides in. History renders still. */
  fresh?: boolean;
}

interface Props {
  m: Msg;
  onRate?: (m: Msg, v: 'up' | 'down') => void;
  onStats?: (m: Msg) => void;
}

/** One message. Memoized: rows only re-render when their own message changes. */
export const MessageRow = memo(function MessageRow(props: Props) {
  return <FadeIn enabled={!!props.m.fresh} from={props.m.role === 'assistant' ? 6 : 12}><Row {...props} /></FadeIn>;
});

function Row({ m, onRate, onStats }: Props) {
  const t = useTheme();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void (require('expo-clipboard') as typeof import('expo-clipboard')).setStringAsync(m.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  if (m.role === 'file')
    return (
      <View style={{ alignSelf: 'flex-end', flexDirection: 'row', alignItems: 'center', gap: 10, maxWidth: '80%', backgroundColor: t.card,
        borderWidth: 1, borderColor: t.glassBorder, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 10 }}>
        <Ionicons name={m.kind === 'pdf' ? 'document-text-outline' : 'image-outline'} size={22} color={t.sub} />
        <View style={{ flexShrink: 1 }}>
          <Text style={{ color: t.text, fontWeight: '600' }} numberOfLines={1}>{m.name}</Text>
          <Text style={{ color: t.sub, fontSize: 12 }}>
            {m.kind === 'pdf' ? `PDF${m.pages ? ` · ${m.pages} pages` : ''}` : 'Photo · text read on this phone'}
          </Text>
        </View>
      </View>
    );

  if (m.role === 'user')
    return (
      <View style={{ alignSelf: 'flex-end', maxWidth: '85%', backgroundColor: t.userBubble, borderRadius: 22, borderBottomRightRadius: 8,
        borderWidth: 1, borderColor: t.glassBorder, paddingHorizontal: 15, paddingVertical: 10 }}>
        <Text selectable style={{ color: t.userText, fontSize: 16, lineHeight: 22 }}>{m.content}</Text>
      </View>
    );

  // Assistant: full-width text, no bubble; quiet actions underneath.
  return (
    <Pressable onLongPress={() => onStats?.(m)} delayLongPress={400}>
      <Markdown text={m.content || '(no reply)'} selectable />
      {!!m.sources?.length && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          {m.sources.map((s, i) => (
            <Tap key={s.url} onPress={() => void Linking.openURL(s.url)}
              style={{ backgroundColor: t.chip, borderWidth: 1, borderColor: t.glassBorder, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6, maxWidth: '100%' }}>
              <Text style={{ color: t.sub, fontSize: 12 }} numberOfLines={1}>[{i + 1}] {hostOf(s.url)}</Text>
            </Tap>
          ))}
        </View>
      )}
      {m.id > 0 && (
        <View style={{ flexDirection: 'row', gap: 18, marginTop: 8, alignItems: 'center' }}>
          <Tap hitSlop={10} scale={0.8} onPress={copy} accessibilityLabel="Copy">
            <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={17} color={copied ? t.ok : t.sub} />
          </Tap>
          {m.rated !== 'down' && (
            <Tap hitSlop={10} scale={0.8} disabled={!!m.rated} onPress={() => onRate?.(m, 'up')}>
              <Ionicons name={m.rated === 'up' ? 'thumbs-up' : 'thumbs-up-outline'} size={17} color={t.sub} />
            </Tap>
          )}
          {m.rated !== 'up' && (
            <Tap hitSlop={10} scale={0.8} disabled={!!m.rated} onPress={() => onRate?.(m, 'down')}>
              <Ionicons name={m.rated === 'down' ? 'thumbs-down' : 'thumbs-down-outline'} size={17} color={t.sub} />
            </Tap>
          )}
        </View>
      )}
    </Pressable>
  );
}

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
