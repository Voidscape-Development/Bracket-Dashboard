/**
 * Activity reporting.
 *
 * Everything the server does against start.gg is slow, paged and invisible: an
 * import of a twelve-event tournament is a few hundred requests spread over a
 * minute or two, and until it finishes the dashboard looks exactly like a
 * dashboard that has silently failed. These types are the shared vocabulary for
 * saying what is happening while it happens.
 *
 * A task is one unit of work a person would recognise — "import Genesis",
 * "read sets for Melee Singles" — not one HTTP request. Requests are counted
 * separately, on the connection status, because a per-request feed is noise.
 */

import type { Id } from './domain.js';

export type ActivityKind =
  | 'import'
  /** Whole-tournament structure read. */
  | 'structure'
  | 'entrants'
  | 'sets'
  | 'standings'
  | 'stations'
  /** Sending a queued report to start.gg. */
  | 'report';

export type ActivityStatus = 'running' | 'done' | 'error';

export interface ActivityTask {
  id: string;
  kind: ActivityKind;
  /** Short sentence naming the work, e.g. "Reading sets — Melee Singles". */
  label: string;
  /** The current step, e.g. "Pool C (3 of 12)". Null when there is nothing to add. */
  detail: string | null;
  eventId: Id | null;
  tournamentId: Id | null;
  status: ActivityStatus;
  /**
   * Units finished and expected. Both null means "running, length unknown" —
   * the UI shows an indeterminate bar rather than inventing a percentage.
   */
  current: number | null;
  total: number | null;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  error: string | null;
}

export interface ActivitySnapshot {
  /** Running tasks first, then recently finished ones, newest first. */
  tasks: ActivityTask[];
  running: number;
  /** Tasks that ended in an error and are still within the retention window. */
  failed: number;
}

export const EMPTY_ACTIVITY: ActivitySnapshot = {
  tasks: [],
  running: 0,
  failed: 0,
};

/** Percentage for a task with countable units, or null when indeterminate. */
export function activityPercent(task: ActivityTask): number | null {
  if (task.status === 'done') return 100;
  if (task.current === null || task.total === null || task.total <= 0) return null;
  return Math.min(100, Math.round((task.current / task.total) * 100));
}

/** One line summarising everything in flight, for a collapsed indicator. */
export function summariseActivity(snapshot: ActivitySnapshot): string | null {
  const running = snapshot.tasks.filter((t) => t.status === 'running');
  const first = running[0];
  if (!first) return null;
  const extra = running.length - 1;
  const detail = first.detail ? ` — ${first.detail}` : '';
  return `${first.label}${detail}${extra > 0 ? ` (+${extra} more)` : ''}`;
}
