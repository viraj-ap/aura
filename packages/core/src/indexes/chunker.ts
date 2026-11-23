/**
 * Split text into chunks that fit the embedder. Sizes are in characters using a
 * conservative ~3 chars/token so we never overflow the embedder's context without
 * paying for a tokenizer round-trip per chunk. Chunks overlap slightly so a fact
 * spanning a boundary is still whole in one of them.
 */
export function chunkText(text: string, maxTokens: number, overlapTokens = 24): string[] {
  const maxChars = Math.max(64, maxTokens * 3);
  const overlap = Math.min(overlapTokens * 3, Math.floor(maxChars / 4));
  const clean = text.trim();
  if (clean.length <= maxChars) return clean ? [clean] : [];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + maxChars, clean.length);
    if (end < clean.length) {
      // Prefer to cut at a sentence, then a line, then a word boundary.
      const window = clean.slice(start, end);
      const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'), window.lastIndexOf('? '), window.lastIndexOf('! '));
      const ws = window.lastIndexOf(' ');
      if (cut > maxChars * 0.5) end = start + cut + 1;
      else if (ws > maxChars * 0.5) end = start + ws;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}
