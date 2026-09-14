/**
 * The server's record of what it is doing right now.
 *
 * Work against start.gg is slow enough that silence is indistinguishable from
 * failure: an import is hundreds of paged requests, and a pool-by-pool set read
 * on a large event takes a minute on its own. Every such operation opens a task
 * here, advances it as it goes, and closes it with a result. The hub pushes the
 * snapshot to dashboards, so "processing event data", "pulling set info" and
 * "that one failed, here is why" are things the app says rather than things an
 * operator has to infer.
 *
 * Finished tasks are kept briefly. An import that failed two minutes ago is
 * exactly what someone is looking for when they come to ask why a bracket is
 * empty, and a UI that erases it the instant it ends is no better than no UI.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import type { ActivityKind, ActivitySnapshot, ActivityTask, Id } from '@bracket/shared';

export interface ActivityLogOptions {
  /** Finished tasks retained for the UI. */
  historyLimit?: number;
  /** How long a finished task stays in the snapshot. */
  historyTtlMs?: number;
  /**
   * Minimum gap between `changed` emissions for progress updates. A pool-by-pool
   * read would otherwise push a socket message per pool per event; starts and
   * endings are never throttled because those are the transitions that matter.
   */
  throttleMs?: number;
}

export interface ActivityInit {
  kind: ActivityKind;
  label: string;
  detail?: string | null;
  eventId?: Id | null;
  tournamentId?: Id | null;
  /** Expected units of work, when known up front. */
  total?: number | null;
}

/**
 * A handle on one open task. Deliberately forgiving: every method is safe to
 * call after the task has ended, so a `finally` block never has to check.
 */
export interface ActivityHandle {
  readonly id: string;
  /** Renames the current step and resets any unit counters. */
  step(label: string, detail?: string | null): void;
  /** Sets the sub-step text without touching the label. */
  detail(detail: string | null): void;
  progress(current: number, total?: number | null, detail?: string | null): void;
  succeed(detail?: string | null): void;
  fail(error: unknown): void;
}

const NOOP_HANDLE: ActivityHandle = {
  id: 'noop',
  step: () => {},
  detail: () => {},
  progress: () => {},
  succeed: () => {},
  fail: () => {},
};

/** A handle that discards everything, for call sites with no log attached. */
export function noopActivity(): ActivityHandle {
  return NOOP_HANDLE;
}

export declare interface ActivityLog {
  on(event: 'changed', listener: (snapshot: ActivitySnapshot) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

export class ActivityLog extends EventEmitter {
  private readonly tasks = new Map<string, ActivityTask>();
  private readonly historyLimit: number;
  private readonly historyTtlMs: number;
  private readonly throttleMs: number;
  private throttleTimer: NodeJS.Timeout | null = null;
  private lastEmitAt = 0;

  constructor(options: ActivityLogOptions = {}) {
    super();
    this.historyLimit = options.historyLimit ?? 25;
    this.historyTtlMs = options.historyTtlMs ?? 5 * 60_000;
    this.throttleMs = options.throttleMs ?? 250;
  }

  begin(init: ActivityInit): ActivityHandle {
    const now = Date.now();
    const task: ActivityTask = {
      id: randomUUID(),
      kind: init.kind,
      label: init.label,
      detail: init.detail ?? null,
      eventId: init.eventId ?? null,
      tournamentId: init.tournamentId ?? null,
      status: 'running',
      current: init.total === undefined || init.total === null ? null : 0,
      total: init.total ?? null,
      startedAt: now,
      updatedAt: now,
      endedAt: null,
      error: null,
    };
    this.tasks.set(task.id, task);
    this.publish(true);

    const mutate = (fn: (task: ActivityTask) => void, immediate = false): void => {
      const current = this.tasks.get(task.id);
      if (!current || current.status !== 'running') return;
      fn(current);
      current.updatedAt = Date.now();
      this.publish(immediate);
    };

    return {
      id: task.id,
      step: (label, detail = null) =>
        mutate(
          (t) => {
            t.label = label;
            t.detail = detail;
            t.current = null;
            t.total = null;
          },
          true,
        ),
      detail: (detail) => mutate((t) => { t.detail = detail; }),
      progress: (current, total, detail) =>
        mutate((t) => {
          t.current = current;
          if (total !== undefined) t.total = total;
          if (detail !== undefined) t.detail = detail;
        }),
      succeed: (detail) =>
        mutate(
          (t) => {
            t.status = 'done';
            t.endedAt = Date.now();
            if (detail !== undefined) t.detail = detail;
            if (t.total !== null) t.current = t.total;
          },
          true,
        ),
      fail: (error) =>
        mutate(
          (t) => {
            t.status = 'error';
            t.endedAt = Date.now();
            t.error = error instanceof Error ? error.message : String(error);
          },
          true,
        ),
    };
  }

  /** Records a failure that never had a running task, e.g. a rejected import. */
  record(init: ActivityInit & { error?: unknown }): void {
    const handle = this.begin(init);
    if (init.error === undefined) handle.succeed();
    else handle.fail(init.error);
  }

  snapshot(): ActivitySnapshot {
    this.prune();
    const tasks = [...this.tasks.values()].sort((a, b) => {
      if (a.status === 'running' && b.status !== 'running') return -1;
      if (b.status === 'running' && a.status !== 'running') return 1;
      return b.startedAt - a.startedAt;
    });
    return {
      tasks,
      running: tasks.filter((t) => t.status === 'running').length,
      failed: tasks.filter((t) => t.status === 'error').length,
    };
  }

  /** Drops finished tasks that are old or surplus. Running tasks are never cut. */
  private prune(): void {
    const cutoff = Date.now() - this.historyTtlMs;
    const finished: ActivityTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === 'running') continue;
      if ((task.endedAt ?? 0) < cutoff) this.tasks.delete(task.id);
      else finished.push(task);
    }
    if (finished.length <= this.historyLimit) return;
    finished
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(this.historyLimit)
      .forEach((task) => this.tasks.delete(task.id));
  }

  private publish(immediate: boolean): void {
    if (immediate) {
      if (this.throttleTimer) {
        clearTimeout(this.throttleTimer);
        this.throttleTimer = null;
      }
      this.lastEmitAt = Date.now();
      this.emit('changed', this.snapshot());
      return;
    }

    if (this.throttleTimer) return;
    const wait = Math.max(0, this.throttleMs - (Date.now() - this.lastEmitAt));
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      this.lastEmitAt = Date.now();
      this.emit('changed', this.snapshot());
    }, wait);
    this.throttleTimer.unref?.();
  }

  stop(): void {
    if (this.throttleTimer) clearTimeout(this.throttleTimer);
    this.throttleTimer = null;
  }
}
