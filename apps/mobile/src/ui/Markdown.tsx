import { memo } from 'react';
import { Text, View } from 'react-native';
import { type Theme, useTheme } from './theme';

// Just enough Markdown for chat replies: code fences, headings, bullet/numbered lists, **bold**,
// *italic* and `code`. Small models emit little else, and a hand-rolled renderer keeps the
// streaming path cheap (no AST library, one pass per update) and adds no native dependency.

type Block =
  | { k: 'code'; text: string }
  | { k: 'h'; level: number; text: string }
  | { k: 'li'; marker: string; text: string }
  | { k: 'p'; text: string };

function parse(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.replace(/\r/g, '').split('\n');
  let para: string[] = [];
  const flush = () => { if (para.length) out.push({ k: 'p', text: para.join('\n') }); para = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i]!);
      out.push({ k: 'code', text: code.join('\n') }); // an unclosed fence (still streaming) runs to the end
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (h) { flush(); out.push({ k: 'h', level: h[1]!.length, text: h[2]! }); }
    else if (li) { flush(); out.push({ k: 'li', marker: /\d/.test(li[1]!) ? li[1]! : '•', text: li[2]! }); }
    else if (!line.trim()) flush();
    else para.push(line);
  }
  flush();
  return out;
}

/** **bold**, *italic*, `code` → nested Text spans. */
function inline(text: string, t: Theme, base: object) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g).filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**') && p.length > 4) return <Text key={i} style={{ fontWeight: '700' }}>{p.slice(2, -2)}</Text>;
    if (p.startsWith('`') && p.endsWith('`') && p.length > 2)
      return <Text key={i} style={{ fontFamily: 'monospace', backgroundColor: t.code, fontSize: 14 }}>{p.slice(1, -1)}</Text>;
    if (p.startsWith('*') && p.endsWith('*') && p.length > 2) return <Text key={i} style={{ fontStyle: 'italic' }}>{p.slice(1, -1)}</Text>;
    return <Text key={i} style={base}>{p}</Text>;
  });
}

export const Markdown = memo(function Markdown({ text, selectable = false }: { text: string; selectable?: boolean }) {
  const t = useTheme();
  const body = { color: t.text, fontSize: 16, lineHeight: 24 };
  return (
    <View style={{ gap: 8 }}>
      {parse(text).map((b, i) => {
        if (b.k === 'code')
          return (
            <View key={i} style={{ backgroundColor: t.code, borderRadius: 10, padding: 12 }}>
              <Text selectable={selectable} style={{ fontFamily: 'monospace', fontSize: 13, color: t.text }}>{b.text}</Text>
            </View>
          );
        if (b.k === 'h')
          return <Text key={i} selectable={selectable} style={{ ...body, fontWeight: '700', fontSize: b.level === 1 ? 20 : b.level === 2 ? 18 : 16 }}>{inline(b.text, t, {})}</Text>;
        if (b.k === 'li')
          return (
            <View key={i} style={{ flexDirection: 'row', paddingLeft: 4 }}>
              <Text style={{ ...body, width: 22, color: t.sub }}>{b.marker}</Text>
              <Text selectable={selectable} style={{ ...body, flex: 1 }}>{inline(b.text, t, {})}</Text>
            </View>
          );
        return <Text key={i} selectable={selectable} style={body}>{inline(b.text, t, {})}</Text>;
      })}
    </View>
  );
});
