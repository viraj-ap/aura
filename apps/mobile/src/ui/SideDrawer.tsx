import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, BackHandler, Dimensions, FlatList, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Session } from '@aura/core';
import { useAura } from '../state/AuraProvider';
import { Backdrop, FadeIn, Tap } from './motion';
import { useTheme } from './theme';

const WIDTH = Math.min(320, Dimensions.get('window').width * 0.82);

/**
 * Left drawer: new chat, the chat list, then Models / Memory / Settings. Plain Animated + Modal-free
 * overlay (no gesture/reanimated native deps); Android back closes it.
 */
export function SideDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { aura, session, setSession, newSession, touch, version } = useAura();
  const [list, setList] = useState<Session[]>([]);
  const x = useRef(new Animated.Value(-WIDTH)).current;
  const [mounted, setMounted] = useState(open);

  useEffect(() => { if (open && aura) void aura.sessions.list(200).then(setList); }, [open, aura, version]);

  useEffect(() => {
    if (open) setMounted(true);
    // Spring in (clamped so the edge never pulls off the screen), quick timing out.
    (open ? Animated.spring(x, { toValue: 0, useNativeDriver: true, speed: 16, bounciness: 4, overshootClamping: true })
      : Animated.timing(x, { toValue: -WIDTH, duration: 180, useNativeDriver: true }))
      .start(() => { if (!open) setMounted(false); });
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [open]);

  if (!mounted) return null;

  const go = (path: '/models' | '/memory' | '/settings') => { onClose(); router.push(path); };
  const remove = (s: Session) =>
    Alert.alert('Delete this chat?', 'Its messages, files, summary and the facts learned from it are removed.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await aura!.forget.session(s.id);
        if (s.id === session?.id) await newSession();
        touch();
      } },
    ]);
  const opacity = x.interpolate({ inputRange: [-WIDTH, 0], outputRange: [0, 1] });

  return (
    <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, zIndex: 10 }}>
      <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: t.scrim, opacity }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close menu" />
      </Animated.View>
      <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: WIDTH, backgroundColor: t.solid, overflow: 'hidden',
        borderTopRightRadius: 28, borderBottomRightRadius: 28, boxShadow: `8px 0 30px ${t.shadow}`,
        transform: [{ translateX: x }], paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8 }}>
        <Backdrop />
        <Tap onPress={() => { onClose(); void newSession(); }} scale={0.97}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 12, padding: 13, borderRadius: 18,
            backgroundColor: t.glass, borderWidth: 1, borderColor: t.glassBorder }}>
          <Ionicons name="create-outline" size={20} color={t.text} />
          <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>New chat</Text>
        </Tap>

        <Text style={{ color: t.sub, fontSize: 12, marginTop: 18, marginBottom: 4, marginHorizontal: 24 }}>Chats</Text>
        <FlatList
          style={{ flex: 1 }}
          data={list}
          keyExtractor={(s) => String(s.id)}
          ListEmptyComponent={<Text style={{ color: t.sub, marginHorizontal: 24, marginTop: 6 }}>No chats yet.</Text>}
          renderItem={({ item: s, index }) => (
            <FadeIn delay={Math.min(index, 8) * 25} from={6}>
              <Pressable onPress={() => { setSession(s); onClose(); }} onLongPress={() => remove(s)}
                style={({ pressed }) => ({ marginHorizontal: 12, paddingHorizontal: 12, paddingVertical: 11, borderRadius: 14,
                  backgroundColor: s.id === session?.id ? t.glass : pressed ? t.card : 'transparent' })}>
                <Text style={{ color: t.text, fontSize: 15, fontWeight: s.id === session?.id ? '600' : '400' }} numberOfLines={1}>{s.title}</Text>
              </Pressable>
            </FadeIn>
          )}
        />

        <View style={{ borderTopWidth: 1, borderColor: t.border, paddingTop: 8, marginHorizontal: 12 }}>
          {([['/models', 'hardware-chip-outline', 'Models'], ['/memory', 'albums-outline', 'Memory'], ['/settings', 'settings-outline', 'Settings']] as const)
            .map(([path, icon, label]) => (
              <Pressable key={path} onPress={() => go(path)}
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, backgroundColor: pressed ? t.card : 'transparent' })}>
                <Ionicons name={icon} size={20} color={t.text} />
                <Text style={{ color: t.text, fontSize: 15 }}>{label}</Text>
              </Pressable>
            ))}
          <Text style={{ color: t.sub, fontSize: 11, paddingHorizontal: 12, paddingTop: 4 }}>Runs on this phone · long-press a chat to delete</Text>
        </View>
      </Animated.View>
    </View>
  );
}
