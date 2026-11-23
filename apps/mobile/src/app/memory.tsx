import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { type Fact, type Rule, formatTs } from '@aura/core';
import { useAura } from '../state/AuraProvider';
import { ScreenHeader } from '../ui/motion';
import { useTheme } from '../ui/theme';

type Tab = 'facts' | 'files' | 'rules' | 'overview';
interface FileRow { id: number; name: string; kind: string; pages?: number; ts: number; chars: number }

export default function MemoryScreen() {
  const t = useTheme();
  const { aura, version, touch, newSession } = useAura();
  const [tab, setTab] = useState<Tab>('facts');
  const [facts, setFacts] = useState<Fact[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [counts, setCounts] = useState({ events: 0, sessions: 0, episodes: 0, jobs: 0 });
  const [editing, setEditing] = useState<{ id: number | null; text: string } | null>(null);

  useEffect(() => {
    if (!aura) return;
    void (async () => {
      setFacts(await aura.facts.list());
      setRules(await aura.playbook.list());
      const rows = await aura.db.all<{ id: number; ts: number; meta: string | null; chars: number }>(
        `SELECT id, ts, meta, length(content) chars FROM events WHERE type = 'attachment' ORDER BY id DESC`);
      setFiles(rows.map((r) => {
        const m = JSON.parse(r.meta ?? '{}') as { name?: string; kind?: string; pages?: number };
        return { id: r.id, ts: r.ts, chars: r.chars, name: m.name ?? 'file', kind: m.kind ?? 'file', pages: m.pages };
      }));
      const n = async (sql: string) => (await aura.db.get<{ n: number }>(sql))!.n;
      setCounts({
        events: await n(`SELECT COUNT(*) n FROM events WHERE type = 'message'`),
        sessions: await n('SELECT COUNT(*) n FROM sessions'),
        episodes: await n('SELECT COUNT(*) n FROM episodes'),
        jobs: await aura.jobs.pendingCount(),
      });
    })();
  }, [aura, version]);

  if (!aura) return null;

  const forgetFact = (f: Fact) =>
    Alert.alert('Forget this fact?', `${f.subject} · ${f.attribute.replace(/_/g, ' ')}: ${f.value}`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Forget fact', onPress: async () => { await aura.forget.fact(f.id); touch(); } },
      // Without this, the original sentence would still be findable by search.
      { text: 'Also delete the messages', style: 'destructive', onPress: async () => { await aura.forget.fact(f.id, true); touch(); } },
    ]);

  const forgetFile = (f: FileRow) =>
    Alert.alert(`Forget ${f.name}?`, 'Its text is removed from memory and search. The file on your phone is not touched.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Forget', style: 'destructive', onPress: async () => { await aura.forget.events([f.id]); touch(); } },
    ]);

  const saveRule = async () => {
    if (!editing?.text.trim()) return setEditing(null);
    if (editing.id === null) await aura.playbook.add(editing.text);
    else await aura.playbook.update(editing.id, editing.text);
    setEditing(null);
    touch();
  };

  const deleteAll = () =>
    Alert.alert('Delete all memory?', 'Every chat, fact, summary and learned rule is permanently removed from this phone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete everything', style: 'destructive', onPress: async () => { await aura.forget.all(); await newSession(); touch(); } },
    ]);

  const Seg = ({ id, label }: { id: Tab; label: string }) => (
    <Pressable onPress={() => setTab(id)} style={{ flex: 1, paddingVertical: 8, borderRadius: 8, backgroundColor: tab === id ? t.chipActive : 'transparent' }}>
      <Text style={{ textAlign: 'center', color: tab === id ? t.text : t.sub, fontWeight: '600', fontSize: 13 }}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title="Memory" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14 }}>
        <View style={{ flexDirection: 'row', backgroundColor: t.card, borderWidth: 1, borderColor: t.glassBorder, borderRadius: 16, padding: 4, marginBottom: 12 }}>
          <Seg id="facts" label={`Facts (${facts.filter((f) => f.isCurrent).length})`} />
          <Seg id="files" label={`Files (${files.length})`} />
          <Seg id="rules" label={`Rules (${rules.length})`} />
          <Seg id="overview" label="Overview" />
        </View>

        {tab === 'facts' && (
          <>
            <Text style={{ color: t.sub, fontSize: 12, marginBottom: 8 }}>
              Learned from your own messages only, in the background. Tap a fact to forget it. Struck-through values were replaced by newer ones.
            </Text>
            {facts.length === 0 && <Text style={{ color: t.sub }}>No facts yet. Tell AURA about yourself and it will remember.</Text>}
            {facts.map((f) => (
              <Pressable key={f.id} onPress={() => forgetFact(f)} style={{ backgroundColor: t.card, borderWidth: 1, borderColor: t.glassBorder, borderRadius: 16, padding: 10, marginBottom: 6 }}>
                <Text style={{ color: t.sub, fontSize: 12 }}>{f.subject} · {f.attribute.replace(/_/g, ' ')}</Text>
                <Text style={{ color: f.isCurrent ? t.text : t.sub, fontSize: 15, textDecorationLine: f.isCurrent ? 'none' : 'line-through' }}>{f.value}</Text>
                <Text style={{ color: t.sub, fontSize: 11 }}>last said {formatTs(f.lastSeen, false)}</Text>
              </Pressable>
            ))}
          </>
        )}

        {tab === 'files' && (
          <>
            <Text style={{ color: t.sub, fontSize: 12, marginBottom: 8 }}>
              Text read from PDFs and photos you attached. AURA can find it in any chat. Tap to forget.
            </Text>
            {files.length === 0 && <Text style={{ color: t.sub }}>No files yet. Use ＋ in a chat to attach a PDF or photo.</Text>}
            {files.map((f) => (
              <Pressable key={f.id} onPress={() => forgetFile(f)} style={{ backgroundColor: t.card, borderWidth: 1, borderColor: t.glassBorder, borderRadius: 16, padding: 10, marginBottom: 6 }}>
                <Text style={{ color: t.text, fontSize: 15 }} numberOfLines={1}>{f.name}</Text>
                <Text style={{ color: t.sub, fontSize: 11 }}>
                  {f.kind === 'pdf' ? `PDF${f.pages ? ` · ${f.pages} pages` : ''}` : 'Photo'} · {f.chars.toLocaleString()} characters · added {formatTs(f.ts, false)}
                </Text>
              </Pressable>
            ))}
          </>
        )}

        {tab === 'rules' && (
          <>
            <Text style={{ color: t.sub, fontSize: 12, marginBottom: 8 }}>
              How AURA should answer you, learned from 👍/👎. Each rating changes at most one rule. Tap to edit, long-press to delete.
            </Text>
            {rules.map((r) => (
              <Pressable key={r.id} onPress={() => setEditing({ id: r.id, text: r.rule })}
                onLongPress={() => Alert.alert('Delete rule?', r.rule, [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: async () => { await aura.playbook.remove(r.id); touch(); } }])}
                style={{ backgroundColor: t.card, borderWidth: 1, borderColor: t.glassBorder, borderRadius: 16, padding: 10, marginBottom: 6 }}>
                <Text style={{ color: t.text }}>{r.rule}</Text>
                <Text style={{ color: t.sub, fontSize: 11 }}>helpful {r.helpful} · harmful {r.harmful}</Text>
              </Pressable>
            ))}
            {editing ? (
              <View style={{ backgroundColor: t.card, borderWidth: 1, borderColor: t.glassBorder, borderRadius: 16, padding: 10 }}>
                <TextInput value={editing.text} onChangeText={(text) => setEditing({ ...editing, text })} autoFocus multiline placeholder="e.g. Keep answers under 5 sentences."
                  placeholderTextColor={t.sub} style={{ color: t.text, minHeight: 40 }} />
                <View style={{ flexDirection: 'row', gap: 16, marginTop: 6 }}>
                  <Pressable onPress={() => void saveRule()}><Text style={{ color: t.accent, fontWeight: '600' }}>Save</Text></Pressable>
                  <Pressable onPress={() => setEditing(null)}><Text style={{ color: t.sub }}>Cancel</Text></Pressable>
                </View>
              </View>
            ) : (
              <Pressable onPress={() => setEditing({ id: null, text: '' })}><Text style={{ color: t.accent, marginTop: 6 }}>+ Add a rule</Text></Pressable>
            )}
          </>
        )}

        {tab === 'overview' && (
          <>
            <View style={{ backgroundColor: t.card, borderWidth: 1, borderColor: t.glassBorder, borderRadius: 16, padding: 12, marginBottom: 12 }}>
              <Text style={{ color: t.text }}>{counts.events.toLocaleString()} messages in {counts.sessions} chats</Text>
              <Text style={{ color: t.text }}>{counts.episodes} chat summaries · {facts.filter((f) => f.isCurrent).length} facts · {rules.length} rules</Text>
              <Text style={{ color: t.sub, marginTop: 4 }}>{counts.jobs} background task(s) waiting (they run while the app is open and idle)</Text>
            </View>
            <Text style={{ color: t.sub, fontSize: 12, marginBottom: 12 }}>
              Everything is stored only on this phone. The network is used only to download models and, when you turn on
              web search (globe) for a message, to run that search. Deleting a chat (menu, long-press) also removes the files,
              summaries and facts built from it.
            </Text>
            <Pressable onPress={deleteAll} style={{ borderWidth: 1, borderColor: t.bad, borderRadius: 10, padding: 12 }}>
              <Text style={{ color: t.bad, textAlign: 'center', fontWeight: '600' }}>Delete all memory</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </View>
  );
}
