import { open } from '@op-engineering/op-sqlite';
import { type SqlDb, splitStatements } from '@aura/core';

// op-sqlite behind core's SqlDb interface. FTS5 is enabled in package.json ("op-sqlite": {"fts5": true}).
// Native execute() runs one statement per call, so exec() splits scripts (the schema migration).

type Scalar = string | number | boolean | null | ArrayBuffer | ArrayBufferView;

const toParam = (v: unknown): Scalar => {
  if (v instanceof Uint8Array) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  if (v === undefined) return null;
  return v as Scalar;
};

// Core reads BLOBs as Uint8Array; op-sqlite returns ArrayBuffer.
const fromRow = (row: Record<string, unknown>) => {
  for (const k in row) if (row[k] instanceof ArrayBuffer) row[k] = new Uint8Array(row[k] as ArrayBuffer);
  return row;
};

export function openOpSqlite(name = 'aura.db'): SqlDb & { close(): void } {
  const db = open({ name });
  let depth = 0;
  // Serialize top-level transactions: a background job and the chat must not interleave inside one.
  let lock: Promise<void> = Promise.resolve();

  const execute = async (sql: string, params: unknown[] = []) => db.execute(sql, params.map(toParam) as never);

  const api: SqlDb & { close(): void } = {
    exec: async (sql) => {
      for (const stmt of splitStatements(sql)) await execute(stmt);
    },
    run: async (sql, params) => {
      const r = await execute(sql, params);
      return { changes: r.rowsAffected ?? 0, lastInsertRowid: Number(r.insertId ?? 0) };
    },
    all: async <T>(sql: string, params?: unknown[]) => ((await execute(sql, params)).rows ?? []).map(fromRow) as T[],
    get: async <T>(sql: string, params?: unknown[]) => {
      const rows = (await execute(sql, params)).rows ?? [];
      return (rows[0] ? fromRow(rows[0]) : undefined) as T | undefined;
    },
    transaction: async (fn) => {
      if (depth > 0) {
        const sp = `sp${depth++}`;
        await execute(`SAVEPOINT ${sp}`);
        try {
          const r = await fn();
          await execute(`RELEASE ${sp}`);
          return r;
        } catch (e) {
          await execute(`ROLLBACK TO ${sp}`);
          throw e;
        } finally {
          depth--;
        }
      }
      const prev = lock;
      let release!: () => void;
      lock = new Promise((r) => (release = r));
      await prev;
      depth = 1;
      await execute('BEGIN');
      try {
        const r = await fn();
        await execute('COMMIT');
        return r;
      } catch (e) {
        await execute('ROLLBACK');
        throw e;
      } finally {
        depth = 0;
        release();
      }
    },
    close: () => db.close(),
  };
  return api;
}

/** Called once at startup. WAL keeps reads fast while background jobs write. */
export async function tuneDb(db: SqlDb): Promise<void> {
  await db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
}
