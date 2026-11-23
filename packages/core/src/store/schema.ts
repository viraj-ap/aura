import type { SqlDb } from '../types';

// Ids are small integers on purpose: Scroll-lite asks the model to emit them
// (get_event 12), and short numbers are far easier for a 0.6B model than UUIDs.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS sessions(
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

  CREATE TABLE IF NOT EXISTS events(
    id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, ts INTEGER NOT NULL,
    type TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, model_id TEXT, meta TEXT);
  CREATE INDEX IF NOT EXISTS events_session ON events(session_id, id);
  CREATE INDEX IF NOT EXISTS events_ts ON events(ts);

  CREATE TABLE IF NOT EXISTS models(
    id TEXT PRIMARY KEY, name TEXT, path TEXT, ctx_len INTEGER, template TEXT, probe_passed INTEGER);

  CREATE TABLE IF NOT EXISTS token_counts(
    event_id INTEGER NOT NULL, model_id TEXT NOT NULL, count INTEGER NOT NULL,
    PRIMARY KEY(event_id, model_id));

  CREATE TABLE IF NOT EXISTS episodes(
    id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL UNIQUE, ts_start INTEGER, ts_end INTEGER,
    summary TEXT NOT NULL, source_event_ids TEXT NOT NULL, heat REAL NOT NULL DEFAULT 0,
    uses INTEGER NOT NULL DEFAULT 0, last_used INTEGER);

  CREATE TABLE IF NOT EXISTS facts(
    id INTEGER PRIMARY KEY, subject TEXT NOT NULL, attribute TEXT NOT NULL, value TEXT NOT NULL,
    confidence REAL NOT NULL, is_current INTEGER NOT NULL, source_event_ids TEXT NOT NULL,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, heat REAL NOT NULL DEFAULT 0,
    uses INTEGER NOT NULL DEFAULT 0, last_used INTEGER);
  CREATE INDEX IF NOT EXISTS facts_key ON facts(subject, attribute, is_current);

  CREATE TABLE IF NOT EXISTS playbook(
    id INTEGER PRIMARY KEY, rule TEXT NOT NULL, helpful INTEGER NOT NULL DEFAULT 0,
    harmful INTEGER NOT NULL DEFAULT 0, source_event_ids TEXT NOT NULL, created_at INTEGER NOT NULL);

  CREATE TABLE IF NOT EXISTS jobs(
    id INTEGER PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
    dedupe_key TEXT, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, id);

  -- L5 rolling summaries of a session's older turns. Derived, never the source of truth.
  CREATE TABLE IF NOT EXISTS compactions(
    id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, upto_event_id INTEGER NOT NULL,
    summary TEXT NOT NULL, source_event_ids TEXT NOT NULL, ts INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS compactions_session ON compactions(session_id, upto_event_id);

  -- One row per chunk per embedder. Vectors are Float32 BLOBs, searched brute-force in JS
  -- (fine at 10K items); sqlite-vec can replace the scan later behind the same VectorIndex.
  CREATE TABLE IF NOT EXISTS embeddings(
    item_type TEXT NOT NULL, item_id INTEGER NOT NULL, chunk INTEGER NOT NULL,
    embedder_id TEXT NOT NULL, vector BLOB NOT NULL,
    PRIMARY KEY(item_type, item_id, chunk, embedder_id));

  -- One FTS table for every searchable item type (events, episodes, facts).
  CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
    content, item_type UNINDEXED, item_id UNINDEXED, tokenize='porter unicode61');

  CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

export async function migrate(db: SqlDb): Promise<void> {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_version(v INTEGER NOT NULL)');
  const row = await db.get<{ v: number }>('SELECT v FROM schema_version');
  let v = row?.v ?? 0;
  if (!row) await db.run('INSERT INTO schema_version(v) VALUES (0)');
  while (v < MIGRATIONS.length) {
    await db.exec(MIGRATIONS[v]!);
    v++;
    await db.run('UPDATE schema_version SET v = ?', [v]);
  }
}

export const ids = {
  encode: (xs: number[]): string => JSON.stringify([...new Set(xs)].sort((a, b) => a - b)),
  decode: (s: string | null | undefined): number[] => (s ? (JSON.parse(s) as number[]) : []),
};
