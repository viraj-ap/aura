import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';

// react-native-webview types its class as `WebViewProps & P` with P = undefined, which TypeScript 6
// collapses to `never`; an explicit empty P restores the real props.
type Web = WebView<object>;

// One invisible WebView that runs small jobs: open a page (or a blank local page), inject a script,
// get back its JSON result. It's the phone's own browser engine, so web search needs no API key or
// server, and pdf.js gets a real canvas + workers. It is mounted only while a job runs,
// so it costs no memory when idle. Jobs run one at a time.

interface Job {
  id: string;
  url?: string;
  script: string;
  timeoutMs: number;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

const queue: Job[] = [];
let wake: (() => void) | null = null;
let seq = 0;

/**
 * Runs `script` (the body of an async function; `return` its result) in `url`, or in a blank
 * page with a stable origin when no url is given.
 */
export function runInWeb<T>(opts: { url?: string; script: string; timeoutMs?: number }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({ id: `job${++seq}`, url: opts.url, script: opts.script, timeoutMs: opts.timeoutMs ?? 10_000,
      resolve: resolve as (v: unknown) => void, reject });
    wake?.();
  });
}

const BLANK = { html: '<!doctype html><meta charset="utf-8"><body></body>', baseUrl: 'https://aura.local/' };

export function HiddenWeb() {
  const [job, setJob] = useState<Job | null>(null);
  const current = useRef<Job | null>(null);
  const ref = useRef<Web>(null);
  const injected = useRef<string | null>(null);

  // Dequeue outside setState (updaters can run twice in dev and would drop a job).
  const pump = () => {
    if (current.current) return;
    current.current = queue.shift() ?? null;
    setJob(current.current);
  };

  useEffect(() => {
    wake = pump;
    pump();
    return () => { wake = null; };
  }, []);

  // Each job gets a deadline; finishing (or failing) moves on to the next one.
  useEffect(() => {
    if (!job) return;
    const timer = setTimeout(() => finish(job, undefined, new Error('Timed out')), job.timeoutMs);
    return () => clearTimeout(timer);
  }, [job]);

  const finish = (j: Job, value: unknown, err?: Error) => {
    if (current.current !== j) return; // already finished (e.g. timeout after the result)
    if (err) j.reject(err); else j.resolve(value);
    current.current = null;
    injected.current = null;
    pump();
  };

  if (!job) return null;

  const onLoadEnd = () => {
    if (injected.current === job.id) return; // redirects fire onLoadEnd more than once
    injected.current = job.id;
    ref.current?.injectJavaScript(`(async () => {
      const post = (m) => window.ReactNativeWebView.postMessage(JSON.stringify(m));
      try { post({ id: ${JSON.stringify(job.id)}, ok: true, value: await (async () => { ${job.script} })() }); }
      catch (e) { post({ id: ${JSON.stringify(job.id)}, ok: false, error: String(e && e.message || e) }); }
    })(); true;`);
  };

  const onMessage = (e: WebViewMessageEvent) => {
    let m: { id: string; ok: boolean; value?: unknown; error?: string };
    try { m = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (m.id !== job.id) return;
    finish(job, m.value, m.ok ? undefined : new Error(m.error ?? 'Script failed'));
  };

  return (
    <View pointerEvents="none" style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }}>
      <WebView<object>
        key={job.id}
        ref={ref}
        source={job.url ? { uri: job.url } : BLANK}
        onLoadEnd={onLoadEnd}
        onMessage={onMessage}
        onError={(e: { nativeEvent: { description?: string } }) => finish(job, undefined, new Error(e.nativeEvent.description || 'Page failed to load'))}
        javaScriptEnabled
        incognito // no cookies or history kept between searches
        cacheEnabled={false}
        mediaPlaybackRequiresUserAction
        style={{ width: 360, height: 640 }}
      />
    </View>
  );
}
