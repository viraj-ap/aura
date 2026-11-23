import Database from 'better-sqlite3';
import type { SqlDb } from '@aura/core';

/** better-sqlite3 behind the async SqlDb interface. Calls are synchronous underneath. */
export function openSqlite(path: string): SqlDb & { close(): void } {
  const d = new Database(path);
  d.pragma('journal_mode = WAL'); // readers don't block the writer; survives crashes
  d.pragma('synchronous = NORMAL');
  d.pragma('foreign_keys = ON');

  // Cache prepared statements: the same few dozen SQL strings run on every message.
  const stmts = new Map<string, Database.Statement>();
  const prep = (sql: string) => {
    let s = stmts.get(sql);
    if (!s) stmts.set(sql, (s = d.prepare(sql)));
    return s;
  };
  const conv = (p: unknown[] = []) =>
    p.map((v) => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v));
  let depth = 0;

  return {
    exec: async (sql) => void d.exec(sql),
    run: async (sql, p) => {
      const r = prep(sql).run(...conv(p));
      return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
    },
    all: async <T>(sql: string, p?: unknown[]) => prep(sql).all(...conv(p)) as T[],
    get: async <T>(sql: string, p?: unknown[]) => prep(sql).get(...conv(p)) as T | undefined,
    // Nested calls become savepoints so core code can compose transactional helpers.
    transaction: async (fn) => {
      const sp = `sp${depth++}`;
      d.exec(depth === 1 ? 'BEGIN' : `SAVEPOINT ${sp}`);
      try {
        const r = await fn();
        d.exec(depth === 1 ? 'COMMIT' : `RELEASE ${sp}`);
        return r;
      } catch (e) {
        d.exec(depth === 1 ? 'ROLLBACK' : `ROLLBACK TO ${sp}`);
        throw e;
      } finally {
        depth--;
      }
    },
    close: () => d.close(),
  };
}
