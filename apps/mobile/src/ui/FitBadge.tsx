import { Text, View } from 'react-native';
import type { FitResult } from '@aura/core';
import { useTheme } from './theme';

const LABEL = { ok: 'Runs well on this phone', tight: 'Tight: may slow the phone', no: "Won't run safely" } as const;

/** The device-fit verdict for a model: colour-coded label + the reasons behind it. */
export function FitBadge({ fit, exact = true, compact = false }: { fit: FitResult; exact?: boolean; compact?: boolean }) {
  const t = useTheme();
  const color = fit.verdict === 'ok' ? t.ok : fit.verdict === 'tight' ? t.warn : t.bad;
  const bg = fit.verdict === 'ok' ? t.okBg : fit.verdict === 'tight' ? t.warnBg : t.badBg;
  return (
    <View style={{ backgroundColor: bg, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, marginTop: 6 }}>
      <Text style={{ color, fontWeight: '600', fontSize: 13 }}>
        {fit.verdict === 'ok' ? '✓ ' : fit.verdict === 'tight' ? '! ' : '✕ '}{LABEL[fit.verdict]}{exact ? '' : ' (estimate)'}
      </Text>
      {!compact && fit.reasons.map((r) => <Text key={r} style={{ color: t.text, fontSize: 12, marginTop: 2 }}>{r}</Text>)}
    </View>
  );
}
