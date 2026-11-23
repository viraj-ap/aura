import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import { inExpoGo, missingNativeModules } from '../native';
import { AuraProvider } from '../state/AuraProvider';
import { Backdrop } from '../ui/motion';
import { NativeMissing } from '../ui/NativeMissing';
import { ThemeProvider, useTheme } from '../ui/theme';

const missing = missingNativeModules();

export default function RootLayout() {
  return (
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  );
}

function Root() {
  const t = useTheme();
  if (missing.length) return <NativeMissing missing={missing} expoGo={inExpoGo} />;
  const { HiddenWeb } = require('../web/HiddenWeb') as typeof import('../web/HiddenWeb'); // lazy: needs native WebView
  return (
    <AuraProvider>
      <StatusBar style={t.scheme === 'dark' ? 'light' : 'dark'} />
      {/* One gradient behind every screen; screens are transparent and draw their own headers. */}
      <View style={{ flex: 1, backgroundColor: t.solid }}>
        <Backdrop />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: 'transparent' }, animation: 'fade_from_bottom' }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="models" />
          <Stack.Screen name="memory" />
          <Stack.Screen name="settings" />
          <Stack.Screen name="debug" options={{ animation: 'slide_from_bottom' }} />
        </Stack>
      </View>
      <HiddenWeb />
    </AuraProvider>
  );
}
