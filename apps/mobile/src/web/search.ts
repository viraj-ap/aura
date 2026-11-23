import type { WebSource } from '@aura/core';
import { runInWeb } from './HiddenWeb';
import { readableText } from './readable';

// Web search: the hidden WebView opens a search engine's results page (a real browser gets past
// bot checks), then the top pages are downloaded as plain HTML and stripped to text (no rendering),
// and handed to the model for this turn only.
// Only the query and those page loads leave the phone, and only when the user turns the globe on.
// Engines are tried in order; a challenge page or changed markup yields no hits and we move on.

const RESULTS = 5;
const PAGES_TO_READ = 2;
/**
 * ~300 tokens per page. Prompt size is what heats the phone: on the S23 Ultra (CPU, Qwen3-0.6B) a
 * 2,469-token web turn took 25 s of prefill at ~98 tok/s and the SoC hit 64 °C. Small models answer
 * from the opening paragraphs anyway, so 2 × 1,200 chars + snippets keeps web text to ~800 tokens.
 */
const PAGE_CHARS = 1200;
const MAX_HTML = 1_500_000;
const UA = 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';

interface Hit { title: string; url: string; snippet: string }

const ENGINES: { name: string; url: (q: string) => string; block: string; title: string; snippet: string }[] = [
  { name: 'Brave', url: (q) => `https://search.brave.com/search?q=${q}`,
    block: '[data-type="web"]', title: '.search-snippet-title, .title', snippet: '.generic-snippet, .snippet-description' },
  { name: 'DuckDuckGo', url: (q) => `https://html.duckduckgo.com/html/?q=${q}`,
    block: '.result:not(.result--ad)', title: 'a.result__a', snippet: '.result__snippet' },
];

export async function webSearch(query: string, onStep?: (s: string) => void): Promise<WebSource[]> {
  onStep?.('Searching the web…');
  let hits: Hit[] = [];
  for (const e of ENGINES) {
    try {
      hits = await runInWeb<Hit[]>({ url: e.url(encodeURIComponent(query)), timeoutMs: 12_000, script: resultsScript(e) });
    } catch { hits = []; }
    if (hits.length) break;
  }
  if (!hits.length) throw new Error('No web results right now (the search engines may be asking for a captcha). Try again later.');

  const out: WebSource[] = hits.map((h) => ({ title: h.title, url: h.url, text: h.snippet }));
  for (let i = 0; i < Math.min(PAGES_TO_READ, hits.length); i++) {
    onStep?.(`Reading ${new URL(hits[i]!.url).hostname.replace(/^www\./, '')}…`);
    try {
      const text = await readPage(hits[i]!.url);
      if (text.length > out[i]!.text.length) out[i]!.text = text;
    } catch { /* keep the snippet */ }
  }
  return out;
}

/**
 * Engine selectors first; if they find nothing (markup changed), fall back to any outbound link
 * with a real title, using its surrounding block as the snippet.
 */
const resultsScript = (e: (typeof ENGINES)[number]) => `
  const here = location.hostname.split('.').slice(-2).join('.');
  const clean = (u) => { try { const x = new URL(u, location.href); return x.searchParams.get('uddg') || x.href; } catch (_) { return ''; } };
  const text = (el) => (el ? el.textContent : '').replace(/\\s+/g, ' ').trim();
  const outbound = (a) => a && /^https?:/.test(clean(a.href)) && !new URL(clean(a.href)).hostname.endsWith(here);
  let hits = [...document.querySelectorAll(${JSON.stringify(e.block)})].map((b) => {
    const t = b.querySelector(${JSON.stringify(e.title)});
    const a = (t && t.closest('a')) || (t && t.querySelector('a')) || [...b.querySelectorAll('a[href]')].find(outbound);
    return { title: text(t) || text(a), url: a ? clean(a.href) : '', snippet: text(b.querySelector(${JSON.stringify(e.snippet)})) };
  });
  if (!hits.some((h) => h.title && h.url)) {
    hits = [...document.querySelectorAll('a[href]')].filter((a) => outbound(a) && text(a).length > 15).map((a) => {
      const b = a.closest('li, article, [data-type], .result, div');
      return { title: text(a).slice(0, 120), url: clean(a.href), snippet: text(b).replace(text(a), '').slice(0, 300) };
    });
  }
  const seen = new Set();
  return hits.filter((h) => h.title && /^https?:/.test(h.url) && !seen.has(h.url) && seen.add(h.url)).slice(0, ${RESULTS});`;

/** Download a page and keep its main text. No WebView: no scripts, ads, images or GPU compositing. */
async function readPage(url: string): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8_000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: ctl.signal });
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('html')) return '';
    return readableText((await r.text()).slice(0, MAX_HTML), PAGE_CHARS);
  } finally {
    clearTimeout(timer);
  }
}
