import { TYPES } from './dataset';
import type { RunRecord } from './runner';

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
/** Wilson 95% interval for a proportion — with 60 questions, sampling error dwarfs run-to-run noise. */
export function wilson(k: number, n: number): [number, number] {
  if (!n) return [NaN, NaN];
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

const pct = (x: number) => (Number.isNaN(x) ? '–' : `${(100 * x).toFixed(1)}%`);
const num = (x: number) => (Number.isNaN(x) ? '–' : Math.round(x).toLocaleString('en-US'));

export interface Summary {
  config: string;
  n: number;
  accuracy: number;
  ci: [number, number];
  evidenceAllInPrompt: number;
  evidenceTurnRecall: number;
  recallAny: number;
  recallAll: number;
  promptTokens: number;
  ttftMs: number;
  latencyMs: number;
  peakServerRssMb: number;
  errors: number;
}

export function summarize(records: RunRecord[], configs: string[]): Summary[] {
  return configs.map((config) => {
    const rs = records.filter((r) => r.config === config && !r.error);
    const withEvidence = rs.filter((r) => r.evidenceSessions > 0 && !r.abstention);
    const judged = rs.filter((r) => r.correct !== null);
    return {
      config,
      n: rs.length,
      accuracy: mean(judged.map((r) => (r.correct ? 1 : 0))),
      ci: wilson(judged.filter((r) => r.correct).length, judged.length),
      evidenceAllInPrompt: mean(withEvidence.map((r) => (r.evidenceSessionsInPrompt === r.evidenceSessions ? 1 : 0))),
      evidenceTurnRecall: mean(withEvidence.filter((r) => r.evidenceTurns).map((r) => r.evidenceTurnsInPrompt / r.evidenceTurns)),
      recallAny: mean(rs.filter((r) => r.recallAny !== null).map((r) => r.recallAny!)),
      recallAll: mean(rs.filter((r) => r.recallAll !== null).map((r) => r.recallAll!)),
      promptTokens: mean(rs.map((r) => r.promptTokens)),
      ttftMs: median(rs.map((r) => r.ttftMs)),
      latencyMs: median(rs.map((r) => r.latencyMs)),
      peakServerRssMb: Math.max(0, ...rs.map((r) => r.peakServerRssMb ?? 0)),
      errors: records.filter((r) => r.config === config && r.error).length,
    };
  });
}

export function markdown(records: RunRecord[], configs: string[], meta: Record<string, string>): string {
  const S = summarize(records, configs);
  const lines: string[] = [];
  lines.push(...Object.entries(meta).map(([k, v]) => `- **${k}:** ${v}`), '');
  lines.push('| Config | N | Accuracy (95% CI) | All evidence sessions in prompt | Evidence turns in prompt | Recall any / all (ranked list) | Prompt tokens | TTFT (median) | Latency (median) | Peak server RSS |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const s of S)
    lines.push(`| ${s.config} | ${s.n}${s.errors ? ` (+${s.errors} err)` : ''} | **${pct(s.accuracy)}** (${pct(s.ci[0])}–${pct(s.ci[1])}) | ${pct(s.evidenceAllInPrompt)} | ${pct(s.evidenceTurnRecall)} | ${Number.isNaN(s.recallAny) ? '–' : `${pct(s.recallAny)} / ${pct(s.recallAll)}`} | ${num(s.promptTokens)} | ${num(s.ttftMs)} ms | ${num(s.latencyMs)} ms | ${s.peakServerRssMb ? `${num(s.peakServerRssMb)} MB` : '–'} |`);

  lines.push('', '**Accuracy by question type**', '');
  const types = [...TYPES, 'abstention'];
  lines.push(`| Type | ${configs.join(' | ')} |`, `|---|${configs.map(() => '---').join('|')}|`);
  for (const t of types) {
    const row = configs.map((c) => {
      const rs = records.filter((r) => r.config === c && !r.error && r.correct !== null && (t === 'abstention' ? r.abstention : r.type === t && !r.abstention));
      return rs.length ? `${pct(mean(rs.map((r) => (r.correct ? 1 : 0))))} (${rs.length})` : '–';
    });
    lines.push(`| ${t} | ${row.join(' | ')} |`);
  }
  return lines.join('\n');
}
