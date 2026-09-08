/**
 * Reporting commands.
 *
 * Every write to start.gg is modelled as a command placed on a durable outbox.
 * The UI applies it optimistically to the local store, so overlays react
 * instantly, and a worker drains the queue whenever the connection is up. Each
 * command records the state it was written against (`baseVersion`) so a replay
 * after an outage can tell "start.gg hasn't changed" from "someone else already
 * reported this".
 */

import type { Id, Timestamp } from './domain.js';

export interface GameReport {
  /** 1-based game number. */
  gameNum: number;
  winnerId: Id;
  /** Optional per-entrant character selection, where the game supports it. */
  selections?: { entrantId: Id; characterId?: number; characterName?: string }[];
  stageId?: number;
}

export interface ReportSetCommand {
  kind: 'reportSet';
  setId: Id;
  eventId: Id;
  winnerId: Id;
  /** Final set score per entrant, e.g. [{entrantId, score: 2}, ...]. */
  scores: { entrantId: Id; score: number }[];
  /** Present when the operator logged the set game by game. */
  games?: GameReport[];
  /** True when the loss is a disqualification rather than a played set. */
  isDq?: boolean;
}

export interface MarkInProgressCommand {
  kind: 'markInProgress';
  setId: Id;
  eventId: Id;
}

export interface ResetSetCommand {
  kind: 'resetSet';
  setId: Id;
  eventId: Id;
  /** Also reset the sets downstream that this result fed into. */
  resetDependents: boolean;
}

export interface AssignStationCommand {
  kind: 'assignStation';
  setId: Id;
  eventId: Id;
  stationId: Id | null;
  stationNumber: number | null;
}

export interface AssignStreamCommand {
  kind: 'assignStream';
  setId: Id;
  eventId: Id;
  streamId: Id | null;
  streamName: string | null;
}

export interface UpdateSeedingCommand {
  kind: 'updateSeeding';
  phaseId: Id;
  eventId: Id;
  /** seedId -> new seed number. */
  seedMapping: { seedId: Id; seedNum: number }[];
}

export type ReportCommand =
  | ReportSetCommand
  | MarkInProgressCommand
  | ResetSetCommand
  | AssignStationCommand
  | AssignStreamCommand
  | UpdateSeedingCommand;

export type CommandKind = ReportCommand['kind'];

/** Permission required to enqueue each command kind. */
export const COMMAND_PERMISSION = {
  reportSet: 'set:report',
  markInProgress: 'set:markInProgress',
  resetSet: 'set:reset',
  assignStation: 'set:assignStation',
  assignStream: 'set:assignStream',
  updateSeeding: 'seeding:update',
} as const;

export type OutboxStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'conflict'
  | 'abandoned';

/**
 * What the target looked like locally when the command was written. Compared
 * against start.gg at send time to detect that someone changed it meanwhile.
 */
export interface BaseVersion {
  setId?: Id;
  state?: number;
  winnerId?: Id | null;
  updatedAt?: Timestamp | null;
  displayScore?: string | null;
  /**
   * Set when a human has reviewed a conflict and chosen to send anyway. The
   * worker then skips conflict detection for this command — otherwise it would
   * re-detect the same disagreement and re-block it forever.
   */
  overrideConflict?: boolean;
}

export interface ConflictDetail {
  reason: 'remote-changed' | 'already-reported' | 'rejected';
  message: string;
  /** Local intent, rendered side by side with the remote value in the UI. */
  local: Record<string, unknown>;
  remote: Record<string, unknown>;
  detectedAt: Timestamp;
}

export interface OutboxEntry {
  id: string;
  command: ReportCommand;
  status: OutboxStatus;
  attempts: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  nextAttemptAt: Timestamp | null;
  lastError: string | null;
  baseVersion: BaseVersion;
  conflict: ConflictDetail | null;
  /** Who queued it, for the audit trail. */
  userId: string | null;
  username: string | null;
}

export type ConflictResolution =
  /** Re-send the local command, overwriting start.gg. */
  | 'force-local'
  /** Drop the local command and keep what start.gg has. */
  | 'keep-remote'
  /** Leave it queued for a human to look at again later. */
  | 'defer';
