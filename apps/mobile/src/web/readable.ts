// HTML → the page's main text, without a browser. Result pages used to be rendered in the hidden
// WebView (scripts, ads, images, a GPU-composited renderer); downloading the HTML and stripping it
// costs a fraction of the CPU, memory and battery. Plain TS so it runs on Hermes and in tests.

const DROP = ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'nav', 'header', 'footer', 'aside', 'form', 'button', 'select', 'figure'];
const BLOCK = /<\/?(?:p|div|section|article|main|h[1-6]|li|ul|ol|tr|table|blockquote|pre|br|hr|dd|dt)\b[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/gi;
// A tag, skipping over quoted attribute values (Wikipedia puts raw '>' inside data-mw="…").
const TAG = /<[a-zA-Z/!][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function readableText(html: string, maxChars: number): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of DROP) s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  // Prefer the article body when the page marks one.
  const main = largest(s, /<article\b[\s\S]*?<\/article>/gi) ?? largest(s, /<main\b[\s\S]*?<\/main>/gi);
  if (main) s = main;
  s = s.replace(BLOCK, '\n').replace(TAG, ' ');
  s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  const lines = s.split('\n').map((l) => l.replace(/\s+/g, ' ').trim())
    // Menus and bylines are short; keep lines that read like sentences, or short ones inside prose.
    .filter((l, i, all) => l.length > 40 || (l.length > 0 && (all[i - 1]?.length ?? 0) > 80));
  return lines.join('\n').slice(0, maxChars);
}

function largest(s: string, re: RegExp): string | null {
  let best: string | null = null;
  for (const m of s.match(re) ?? []) if (!best || m.length > best.length) best = m;
  return best && best.replace(TAG, '').trim().length > 400 ? best : null;
}
