import type { Clock, SqlDb } from '../types';
import { isAbort } from '../util/llmCall';

export interface Job {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export type JobHandler = (payload: Record<string, unknown>, signal: AbortSignal) => Promise<void>;

const MAX_ATTEMPTS = 3;

/**
 * Persistent queue for background work (summaries, facts, reflection, re-embedding).
 * - The user always wins: pause() aborts the running job mid-generation and puts it
 *   back to 'pending'. Handlers are idempotent, so re-running is safe.
 * - Jobs survive app restarts: anything left 'running' after a crash is reset.
 */
export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private current: AbortController | null = null;
  private paused = false;
  private loop: Promise<void> | null = null;

  constructor(
    private db: SqlDb,
    private clock: Clock,
    private canRun: () => Promise<boolean> = async () => true,
  ) {}

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  async recover(): Promise<void> {
    await this.db.run(`UPDATE jobs SET status = 'pending' WHERE status = 'running'`);
  }

  /** With a dedupe key, a job already pending for the same key isn't queued twice. */
  async enqueue(type: string, payload: Record<string, unknown>, dedupeKey?: string): Promise<void> {
    if (dedupeKey) {
      const dup = await this.db.get(`SELECT 1 FROM jobs WHERE dedupe_key = ? AND status = 'pending'`, [dedupeKey]);
      if (dup) return;
    }
    await this.db.run('INSERT INTO jobs(type, payload, status, dedupe_key, created_at) VALUES (?,?,?,?,?)',
      [type, JSON.stringify(payload), 'pending', dedupeKey ?? null, this.clock.now()]);
  }

  async pendingCount(): Promise<number> {
    return (await this.db.get<{ n: number }>(`SELECT COUNT(*) n FROM jobs WHERE status = 'pending'`))!.n;
  }

  async list(limit = 20): Promise<{ id: number; type: string; status: string; attempts: number; error: string | null }[]> {
    return this.db.all(`SELECT id, type, status, attempts, error FROM jobs ORDER BY id DESC LIMIT ?`, [limit]);
  }

  /** Stop background work now (user sent a message). Returns once the running job has yielded. */
  async pause(): Promise<void> {
    this.paused = true;
    this.current?.abort();
    await this.loop;
  }

  resume(): void {
    this.paused = false;
  }

  get isRunning(): boolean {
    return this.loop !== null;
  }

  /** Drain the queue while not paused. Safe to call repeatedly; only one loop runs. */
  drain(): Promise<void> {
    if (!this.loop) this.loop = this.runLoop().finally(() => (this.loop = null));
    return this.loop;
  }

  private async runLoop(): Promise<void> {
    while (!this.paused) {
      if (!(await this.canRun())) return;
      const row = await this.db.get<{ id: number; type: string; payload: string; attempts: number }>(
        `SELECT id, type, payload, attempts FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1`);
      if (!row) return;
      await this.runOne({ id: row.id, type: row.type, payload: JSON.parse(row.payload), attempts: row.attempts });
    }
  }

  private async runOne(job: Job): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      await this.db.run(`UPDATE jobs SET status = 'failed', error = ? WHERE id = ?`, ['no handler', job.id]);
      return;
    }
    await this.db.run(`UPDATE jobs SET status = 'running' WHERE id = ?`, [job.id]);
    const ctrl = new AbortController();
    this.current = ctrl;
    try {
      await handler(job.payload, ctrl.signal);
      await this.db.run('DELETE FROM jobs WHERE id = ?', [job.id]);
    } catch (e) {
      if (ctrl.signal.aborted || isAbort(e)) {
        await this.db.run(`UPDATE jobs SET status = 'pending' WHERE id = ?`, [job.id]);
      } else {
        const attempts = job.attempts + 1;
        await this.db.run('UPDATE jobs SET status = ?, attempts = ?, error = ? WHERE id = ?',
          [attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts, String(e instanceof Error ? e.message : e), job.id]);
      }
    } finally {
      this.current = null;
    }
  }
}
