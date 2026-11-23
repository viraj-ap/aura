import { ScrollView, Text } from 'react-native';
import { useTheme } from './theme';

export function NativeMissing({ missing, expoGo }: { missing: string[]; expoGo: boolean }) {
  const t = useTheme();
  const code = { fontFamily: 'monospace', backgroundColor: t.card, color: t.text, padding: 10, borderRadius: 8, fontSize: 12 } as const;
  return (
    <ScrollView style={{ backgroundColor: t.solid }} contentContainerStyle={{ padding: 20, paddingTop: 70, gap: 12 }}>
      <Text style={{ color: t.text, fontSize: 22, fontWeight: '700' }}>AURA needs a development build</Text>
      <Text style={{ color: t.text }}>
        {expoGo
          ? 'You opened AURA in Expo Go. Expo Go cannot run on-device models: they need native code (llama.rn, op-sqlite) that Expo Go does not include.'
          : `This build is missing native code for: ${missing.join(', ')}. It was probably built before these libraries were added. Rebuild the development client.`}
      </Text>
      <Text style={{ color: t.text, fontWeight: '600' }}>Build it once (in the cloud, no Android Studio):</Text>
      <Text selectable style={code}>{'cd apps/mobile\nnpx eas-cli@latest build --profile development --platform android'}</Text>
      <Text style={{ color: t.text, fontWeight: '600' }}>…or locally (Android Studio + JDK 17/21, phone over USB):</Text>
      <Text selectable style={code}>{'cd apps/mobile\nnpx expo run:android --device'}</Text>
      <Text style={{ color: t.text, fontWeight: '600' }}>Then install that app (not Expo Go) and connect it to the dev server:</Text>
      <Text selectable style={code}>{'npx expo start --dev-client'}</Text>
      <Text style={{ color: t.sub, fontSize: 12 }}>Missing: {missing.join(', ') || 'none detected'}</Text>
    </ScrollView>
  );
}
