/**
 * Normalized domain model.
 *
 * Everything the app renders is expressed in these types, never in raw start.gg
 * shapes. The start.gg client maps API responses into these, which keeps the
 * renderer, the sync engine and the overlay protocol insulated from schema
 * churn on the upstream endpoint.
 */

/** start.gg ids are numeric strings; we keep them as strings throughout. */
export type Id = string;

/** Unix seconds, as start.gg returns them. */
export type Timestamp = number;

export const BRACKET_TYPES = [
  'SINGLE_ELIMINATION',
  'DOUBLE_ELIMINATION',
  'ROUND_ROBIN',
  'SWISS',
  'ELIMINATION_ROUNDS',
  'EXHIBITION',
  'CUSTOM_SCHEDULE',
  'MATCHMAKING',
  'RACE',
  'CIRCUIT',
] as const;

export type BracketType = (typeof BRACKET_TYPES)[number];

/** start.gg activity states, shared by events, phases, groups and sets. */
export enum ActivityState {
  Created = 1,
  Active = 2,
  Completed = 3,
  Ready = 4,
  Invalid = 5,
  Called = 6,
  Queued = 7,
}

export interface Tournament {
  id: Id;
  slug: string;
  name: string;
  startAt: Timestamp | null;
  endAt: Timestamp | null;
  timezone: string | null;
  venueName: string | null;
  city: string | null;
  /** Populated on read; the store joins these in. */
  events: TournamentEvent[];
}

export interface TournamentEvent {
  id: Id;
  tournamentId: Id;
  name: string;
  slug: string;
  state: ActivityState | null;
  startAt: Timestamp | null;
  numEntrants: number | null;
  videogameId: Id | null;
  videogameName: string | null;
  videogameImageUrl: string | null;
  phases: Phase[];
}

export interface Phase {
  id: Id;
  eventId: Id;
  name: string;
  phaseOrder: number;
  bracketType: BracketType;
  groupCount: number;
  state: ActivityState | null;
  groups: PhaseGroup[];
}

export interface PhaseGroup {
  id: Id;
  phaseId: Id;
  eventId: Id;
  displayIdentifier: string;
  bracketType: BracketType;
  state: ActivityState | null;
  /** Round metadata keyed by round number, when start.gg supplies it. */
  rounds: RoundInfo[];
}

export interface RoundInfo {
  number: number;
  bestOf: number | null;
}

export interface Entrant {
  id: Id;
  eventId: Id;
  name: string;
  seed: number | null;
  isDisqualified: boolean;
  participants: Participant[];
}

export interface Participant {
  id: Id;
  gamerTag: string;
  prefix: string | null;
  /** Country/state where start.gg exposes it; used for optional flag display. */
  country: string | null;
  imageUrl: string | null;
}

/**
 * A set slot. `entrantId` is null while the feeding match is unresolved, in
 * which case `placeholderText` carries start.gg's "Winner of A1" style label.
 */
export interface SetSlot {
  slotIndex: number;
  entrantId: Id | null;
  entrantName: string | null;
  seed: number | null;
  score: number | null;
  /** 'set' when fed by another set, 'seed' when fed directly from seeding. */
  prereqType: 'set' | 'seed' | null;
  prereqId: string | null;
  placeholderText: string | null;
}

export interface GameResult {
  id: Id;
  orderNum: number;
  winnerId: Id | null;
  /** Character/stage selections keyed by entrant id, where the event has them. */
  selections: GameSelection[];
  stageName: string | null;
}

export interface GameSelection {
  entrantId: Id;
  characterName: string | null;
  characterImageUrl: string | null;
}

export interface TournamentSet {
  id: Id;
  eventId: Id;
  phaseId: Id;
  phaseGroupId: Id;
  /** start.gg's short label, e.g. "A1" or "142". */
  identifier: string;
  /** Positive for winners rounds, negative for losers rounds. */
  round: number;
  fullRoundText: string;
  state: ActivityState;
  winnerId: Id | null;
  loserId: Id | null;
  displayScore: string | null;
  totalGames: number | null;
  bestOf: number | null;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
  /** Remote mtime; the delta sync watermark is derived from this. */
  updatedAt: Timestamp | null;
  stationNumber: number | null;
  stationId: Id | null;
  streamName: string | null;
  streamId: Id | null;
  slots: SetSlot[];
  games: GameResult[];
  /** True while a local report is queued but not yet confirmed by start.gg. */
  pendingLocal?: boolean;
}

export interface Standing {
  eventId: Id;
  entrantId: Id;
  entrantName: string;
  placement: number;
  isFinal: boolean;
}

/** Aggregated live status for an event, used by the dashboard overview grid. */
export interface EventStatus {
  eventId: Id;
  totalSets: number;
  completedSets: number;
  activeSets: number;
  pendingSets: number;
  lastSyncedAt: Timestamp | null;
  /** null when the event has never synced. */
  syncError: string | null;
}
