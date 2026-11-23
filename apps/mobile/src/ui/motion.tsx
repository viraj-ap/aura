import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, Pressable, type PressableProps, type StyleProp, Text, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './theme';

// Small, tasteful motion. Everything runs on the native driver (transform/opacity only), so
// animations stay smooth even while the JS thread is busy streaming a reply.

/** Pressable that dips to `scale` while pressed and springs back. */
export function Tap({ children, style, scale = 0.95, disabled, ...rest }: PressableProps & { style?: StyleProp<ViewStyle>; scale?: number; children: ReactNode }) {
  const s = useRef(new Animated.Value(1)).current;
  const to = (v: number) => Animated.spring(s, { toValue: v, useNativeDriver: true, speed: 40, bounciness: v === 1 ? 8 : 0 }).start();
  return (
    <Pressable {...rest} disabled={disabled} onPressIn={(e) => { to(scale); rest.onPressIn?.(e); }} onPressOut={(e) => { to(1); rest.onPressOut?.(e); }}>
      <Animated.View style={[style, { transform: [{ scale: s }] }]}>{children}</Animated.View>
    </Pressable>
  );
}

/** Fades and rises into place on mount (`from` px below). Off → renders statically. */
export function FadeIn({ children, enabled = true, delay = 0, from = 10, style }: { children: ReactNode; enabled?: boolean; delay?: number; from?: number; style?: StyleProp<ViewStyle> }) {
  const v = useRef(new Animated.Value(enabled ? 0 : 1)).current;
  useEffect(() => {
    if (enabled) Animated.timing(v, { toValue: 1, duration: 260, delay, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, []);
  return (
    <Animated.View style={[style, { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [from, 0] }) }] }]}>
      {children}
    </Animated.View>
  );
}

/** Three dots breathing in sequence: "the model is working". */
export function TypingDots({ label }: { label?: string | null }) {
  const t = useTheme();
  const dots = [useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current];
  useEffect(() => {
    const loop = Animated.loop(Animated.stagger(150, dots.map((d) => Animated.sequence([
      Animated.timing(d, { toValue: 1, duration: 320, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(d, { toValue: 0, duration: 320, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]))));
    loop.start();
    return () => loop.stop();
  }, []);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 }}>
      <View style={{ flexDirection: 'row', gap: 5 }}>
        {dots.map((d, i) => (
          <Animated.View key={i} style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: t.text,
            opacity: d.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.85] }),
            transform: [{ translateY: d.interpolate({ inputRange: [0, 1], outputRange: [0, -3] }) }] }} />
        ))}
      </View>
      {label ? <Text style={{ color: t.sub, fontSize: 14 }}>{label}</Text> : null}
    </View>
  );
}

/** The theme's gradient with a film-grain tile on top, filling its parent. Theme changes cross-fade. */
export function Backdrop() {
  const t = useTheme();
  const [layers, setLayers] = useState<{ under: string | null; over: string }>({ under: null, over: t.gradient });
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (t.gradient === layers.over) return;
    setLayers({ under: layers.over, over: t.gradient });
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: 420, easing: Easing.inOut(Easing.quad), useNativeDriver: true }).start();
  }, [t.gradient]);
  const fill = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;
  return (
    <View pointerEvents="none" style={fill}>
      {layers.under && <View style={[fill, { backgroundImage: layers.under }]} />}
      <Animated.View style={[fill, { backgroundImage: layers.over, opacity: fade }]} />
      <Image source={require('../../assets/grain.png')} resizeMode="repeat" style={[fill, { width: '100%', height: '100%', opacity: t.grain }]} />
    </View>
  );
}

/** Header for pushed screens: frosted round back button + title, on the shared backdrop. */
export function ScreenHeader({ title, right }: { title: string; right?: ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ paddingTop: insets.top + 6, paddingHorizontal: 12, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Tap onPress={() => router.back()} accessibilityLabel="Back" hitSlop={8}
        style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: t.glass, borderWidth: 1, borderColor: t.glassBorder }}>
        <Ionicons name="chevron-back" size={20} color={t.text} />
      </Tap>
      <Text style={{ flex: 1, color: t.text, fontSize: 20, fontWeight: '600' }}>{title}</Text>
      {right}
    </View>
  );
}
