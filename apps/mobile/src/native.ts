import { requireOptionalNativeModule } from 'expo';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { NativeModules, TurboModuleRegistry } from 'react-native';

// AURA's native modules are not in Expo Go; they need a development build. Checked before anything
// imports them, so a missing module (Expo Go, or a dev client built before it was added) shows a
// fix-it screen instead of a crash. Screens that use them require() them lazily for the same reason.

export const inExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

export function missingNativeModules(): string[] {
  const missing: string[] = [];
  const g = globalThis as { __OPSQLiteProxy?: unknown };
  if (g.__OPSQLiteProxy == null && NativeModules.OPSQLite == null) missing.push('op-sqlite');
  if (TurboModuleRegistry.get('RNLlama') == null && NativeModules.RNLlama == null) missing.push('llama.rn');
  if (TurboModuleRegistry.get('RNCWebViewModule') == null && NativeModules.RNCWebViewModule == null) missing.push('react-native-webview');
  for (const [mod, pkg] of [['ExpoTextExtractor', 'expo-text-extractor'], ['ExponentImagePicker', 'expo-image-picker'],
    ['ExpoDocumentPicker', 'expo-document-picker'], ['ExpoClipboard', 'expo-clipboard']] as const)
    if (requireOptionalNativeModule(mod) == null) missing.push(pkg);
  return missing;
}
