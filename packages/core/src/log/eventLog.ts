import type { AuraEvent, Clock, EventType, Role, Session, SqlDb } from '../types';

interface EventRow {
  id: number;
  session_id: number;
  ts: number;
  type: string;
  role: string;
  content: string;
  model_id: string | null;
  meta: string | null;
}

const toEvent = (r: EventRow): AuraEvent => ({
  id: r.id,
  sessionId: r.session_id,
  ts: r.ts,
  type: r.type as EventType,
  role: r.role as Role,
  content: r.content,
  modelId: r.model_id,
  meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null,
});

export interface AppendInput {
  sessionId: number;
  type: EventType;
  role: Role;
  content: string;
  modelId?: string | null;
  meta?: Record<string, unknown> | null;
  /** Eval replays pass historical timestamps; otherwise the clock decides. */
  ts?: number;
}

/**
 * L1: append-only source of truth. There is deliberately no update method — every
 * index (FTS, vectors, summaries, facts) is derived from this and can be rebuilt.
 * The only removal path is user deletion in privacy/forget.ts.
 */
export class EventLog {
  constructor(
    private db: SqlDb,
    private clock: Clock,
  ) {}

  async append(input: AppendInput): Promise<AuraEvent> {
    const ts = input.ts ?? this.clock.now();
    const meta = input.meta ? JSON.stringify(input.meta) : null;
    const { lastInsertRowid } = await this.db.run(
      'INSERT INTO events(session_id, ts, type, role, content, model_id, meta) VALUES (?,?,?,?,?,?,?)',
      [input.sessionId, ts, input.type, input.role, input.content, input.modelId ?? null, meta],
    );
    await this.db.run('UPDATE sessions SET updated_at = MAX(updated_at, ?) WHERE id = ?', [ts, input.sessionId]);
    return { id: lastInsertRowid, sessionId: input.sessionId, ts, type: input.type, role: input.role,
      content: input.content, modelId: input.modelId ?? null, meta: input.meta ?? null };
  }

  async get(id: number): Promise<AuraEvent | undefined> {
    const r = await this.db.get<EventRow>('SELECT * FROM events WHERE id = ?', [id]);
    return r && toEvent(r);
  }

  async getMany(ids: number[]): Promise<AuraEvent[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.all<EventRow>(
      `SELECT * FROM events WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ids);
    return rows.map(toEvent);
  }

  /** Messages (and optionally other types) of a session in order, optionally after an event id. */
  async listSession(sessionId: number, opts: { afterId?: number; types?: EventType[]; limit?: number } = {}): Promise<AuraEvent[]> {
    const types = opts.types ?? ['message'];
    const rows = await this.db.all<EventRow>(
      `SELECT * FROM events WHERE session_id = ? AND id > ? AND type IN (${types.map(() => '?').join(',')})
       ORDER BY id LIMIT ?`,
      [sessionId, opts.afterId ?? 0, ...types, opts.limit ?? -1],
    );
    return rows.map(toEvent);
  }

  /** Messages in [from, to) across all sessions, newest first. */
  async listRange(from: number, to: number, limit = 50): Promise<AuraEvent[]> {
    const rows = await this.db.all<EventRow>(
      `SELECT * FROM events WHERE type = 'message' AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT ?`,
      [from, to, limit]);
    return rows.map(toEvent);
  }

  async neighbors(ev: AuraEvent, before = 1, after = 1): Promise<AuraEvent[]> {
    const prev = await this.db.all<EventRow>(
      `SELECT * FROM events WHERE session_id = ? AND id < ? AND type = 'message' ORDER BY id DESC LIMIT ?`,
      [ev.sessionId, ev.id, before]);
    const next = await this.db.all<EventRow>(
      `SELECT * FROM events WHERE session_id = ? AND id > ? AND type = 'message' ORDER BY id LIMIT ?`,
      [ev.sessionId, ev.id, after]);
    return [...prev.reverse(), ...next].map(toEvent);
  }

  async count(): Promise<number> {
    return (await this.db.get<{ n: number }>('SELECT COUNT(*) n FROM events'))!.n;
  }
}

export class Sessions {
  constructor(
    private db: SqlDb,
    private clock: Clock,
  ) {}

  async create(title = 'New chat', ts = this.clock.now()): Promise<Session> {
    const { lastInsertRowid } = await this.db.run(
      'INSERT INTO sessions(title, created_at, updated_at) VALUES (?,?,?)', [title, ts, ts]);
    return { id: lastInsertRowid, title, createdAt: ts, updatedAt: ts };
  }

  async get(id: number): Promise<Session | undefined> {
    const r = await this.db.get<{ id: number; title: string; created_at: number; updated_at: number }>(
      'SELECT * FROM sessions WHERE id = ?', [id]);
    return r && { id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  async list(limit = 50): Promise<Session[]> {
    const rows = await this.db.all<{ id: number; title: string; created_at: number; updated_at: number }>(
      'SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?', [limit]);
    return rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  async rename(id: number, title: string): Promise<void> {
    await this.db.run('UPDATE sessions SET title = ? WHERE id = ?', [title, id]);
  }
}
