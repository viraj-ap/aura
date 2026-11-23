/**
 * Remove reasoning before anything is logged. Handles:
 *  - complete <think>…</think> blocks
 *  - output that starts mid-thought because the template pre-filled "<think>" (only "</think>" appears)
 *  - an unterminated <think> at the end (generation was stopped while thinking)
 */
export function stripReasoning(text: string): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const close = t.indexOf('</think>');
  if (close !== -1) t = t.slice(close + '</think>'.length);
  const open = t.indexOf('<think>');
  if (open !== -1) t = t.slice(0, open);
  return t.trim();
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-11-03 Tue 14:02" in UTC so eval replays are deterministic regardless of machine timezone. */
export function formatTs(ms: number, withTime = true): string {
  const d = new Date(ms);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${DAYS[d.getUTCDay()]}`;
  return withTime ? `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : date;
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function truncateChars(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Parse JSON from model output, tolerating code fences and trailing junk. Never throws. */
export function safeJson<T>(text: string): T | undefined {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const m = cleaned.match(/[[{][\s\S]*[\]}]/);
    if (!m) return undefined;
    try {
      return JSON.parse(m[0]) as T;
    } catch {
      return undefined;
    }
  }
}
