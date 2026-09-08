/**
 * WebSocket protocol between the server, the dashboard and the overlays.
 *
 * Overlays subscribe with a view id + secret and receive only what that view
 * needs. The dashboard subscribes with a session and can additionally issue
 * director commands, which the server fans out to every client watching that
 * view.
 */

import type { OutboxEntry } from './commands.js';
import type {
  BracketType,
  Entrant,
  EventStatus,
  Id,
  Phase,
  PhaseGroup,
  Standing,
  TournamentEvent,
  TournamentSet,
} from './domain.js';
import type { Theme } from './theme.js';
import type { AutoFollowConfig, CameraState, OutputView } from './views.js';

export interface ConnectionStatus {
  /** Whether the server can currently reach start.gg. */
  online: boolean;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  /** Commands still waiting to reach start.gg. */
  queuedCommands: number;
  conflictCount: number;
  /** Requests made in the trailing minute, so the UI can show call volume. */
  requestsLastMinute: number;
}

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export interface SubscribeDashboardMessage {
  type: 'subscribe:dashboard';
  /** Restrict the stream to these events; empty means all. */
  eventIds?: Id[];
}

export interface SubscribeViewMessage {
  type: 'subscribe:view';
  viewId: string;
  secret: string;
}

export interface CameraCommandMessage {
  type: 'camera:set';
  viewId: string;
  camera: Partial<CameraState>;
  /** Sent by an overlay/operator dragging; pauses auto-follow. */
  manualInput?: boolean;
}

export interface AutoFollowCommandMessage {
  type: 'autofollow:set';
  viewId: string;
  autoFollow: Partial<AutoFollowConfig>;
}

export interface PingMessage {
  type: 'ping';
  t: number;
}

export type ClientMessage =
  | SubscribeDashboardMessage
  | SubscribeViewMessage
  | CameraCommandMessage
  | AutoFollowCommandMessage
  | PingMessage;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/** Full state an overlay needs on connect, so it can render without REST calls. */
export interface ViewSnapshotMessage {
  type: 'view:snapshot';
  view: OutputView;
  theme: Theme;
  event: TournamentEvent | null;
  /** The phase this view resolved to; overlays never pick one themselves. */
  phase: Phase | null;
  phaseGroup: PhaseGroup | null;
  /** Authoritative bracket type for the renderer, not inferred from the sets. */
  bracketType: BracketType;
  sets: TournamentSet[];
  entrants: Entrant[];
  standings: Standing[];
  status: ConnectionStatus;
  serverTime: number;
}

/** Incremental set changes; the payload carries only what changed. */
export interface SetsChangedMessage {
  type: 'sets:changed';
  eventId: Id;
  upserted: TournamentSet[];
  removedIds: Id[];
  /** Bumped on every applied change so clients can detect a missed message. */
  revision: number;
}

export interface StandingsChangedMessage {
  type: 'standings:changed';
  eventId: Id;
  standings: Standing[];
}

export interface EventStatusMessage {
  type: 'event:status';
  statuses: EventStatus[];
}

export interface CameraChangedMessage {
  type: 'camera:changed';
  viewId: string;
  camera: CameraState;
  /** Set when the move came from auto-follow rather than an operator. */
  source: 'operator' | 'autofollow' | 'restore';
}

export interface ViewUpdatedMessage {
  type: 'view:updated';
  view: OutputView;
  theme: Theme;
}

export interface ThemeUpdatedMessage {
  type: 'theme:updated';
  theme: Theme;
}

export interface StatusMessage {
  type: 'status';
  status: ConnectionStatus;
}

export interface OutboxChangedMessage {
  type: 'outbox:changed';
  entries: OutboxEntry[];
  queued: number;
  conflicts: number;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export interface PongMessage {
  type: 'pong';
  t: number;
}

export type ServerMessage =
  | ViewSnapshotMessage
  | SetsChangedMessage
  | StandingsChangedMessage
  | EventStatusMessage
  | CameraChangedMessage
  | ViewUpdatedMessage
  | ThemeUpdatedMessage
  | StatusMessage
  | OutboxChangedMessage
  | ErrorMessage
  | PongMessage;
