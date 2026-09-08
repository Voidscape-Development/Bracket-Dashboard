/**
 * Output views.
 *
 * A "view" is one addressable display surface: an event/phase-group plus a
 * renderer kind, a theme and its own camera. Each view has its own id and secret
 * key, so the same bracket can be open as a director-driven stream overlay and
 * as an unattended venue TV at the same time and the two never interfere.
 */

import type { Id } from './domain.js';

export const VIEW_KINDS = ['bracket', 'ondeck', 'standings', 'scorecard'] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

export type CameraMode =
  /** Frame the whole bracket. */
  | 'fit'
  /** Frame one match. */
  | 'match'
  /** Frame one round column. */
  | 'column'
  /** Frame a match plus the rounds it feeds into. */
  | 'progression'
  /** Operator-driven pan/zoom, held until changed. */
  | 'manual';

export interface CameraState {
  mode: CameraMode;
  /** Set id for 'match' and 'progression'. */
  targetSetId: Id | null;
  /** Column id for 'column'. */
  targetColumnId: string | null;
  /** How many rounds ahead 'progression' reveals. */
  progressionDepth: number;
  /** Manual transform, also the resolved transform the overlay animates to. */
  zoom: number;
  centerX: number;
  centerY: number;
  /** Animate to the next camera state instead of cutting. */
  animate: boolean;
}

export const DEFAULT_CAMERA: CameraState = {
  mode: 'fit',
  targetSetId: null,
  targetColumnId: null,
  progressionDepth: 2,
  zoom: 1,
  centerX: 0,
  centerY: 0,
  animate: true,
};

export type AutoFollowRule =
  /** Latest set to go in-progress. */
  | 'live'
  /** Furthest-along live set, biased to finals. */
  | 'deepest'
  /** Follow a specific entrant through the bracket. */
  | 'entrant'
  /** Cycle through live sets on a timer. */
  | 'rotate'
  /** Follow whatever is assigned to a stream. */
  | 'stream';

export interface AutoFollowConfig {
  enabled: boolean;
  rule: AutoFollowRule;
  /** For 'entrant'. */
  entrantId: Id | null;
  /** For 'stream'. */
  streamName: string | null;
  /** For 'rotate', milliseconds per shot. */
  rotateIntervalMs: number;
  /** Camera mode auto-follow applies when it moves. */
  shot: Extract<CameraMode, 'match' | 'progression' | 'column'>;
  /** Operator input pauses auto-follow for this long. */
  resumeAfterManualMs: number;
}

export const DEFAULT_AUTO_FOLLOW: AutoFollowConfig = {
  enabled: false,
  rule: 'live',
  entrantId: null,
  streamName: null,
  rotateIntervalMs: 12000,
  shot: 'progression',
  resumeAfterManualMs: 30000,
};

/** How a punch-in treats the matches outside the shot. */
export type FocusMode =
  /** Only what fits in the frame is visible; the rest is cropped away. */
  | 'crop'
  /** Everything stays rendered, with off-shot matches faded back. */
  | 'dim';

/** How the camera gets from one shot to the next. */
export type ShotTransition =
  /** Always glide. Good within a bracket half, slow across a whole bracket. */
  | 'pan'
  /** Always cut through a cross-fade. */
  | 'fade'
  /** Glide for nearby shots, fade for distant ones. */
  | 'auto';

export interface BracketViewConfig {
  kind: 'bracket';
  showRoundLabels: boolean;
  showSeeds: boolean;
  showScores: boolean;
  showStation: boolean;
  showStream: boolean;
  /** Dim matches that are already decided. */
  dimCompleted: boolean;
  /** Pulse/highlight sets currently in progress. */
  highlightLive: boolean;
  /** Hide rounds with no entrants resolved yet. */
  hideEmptyRounds: boolean;
  showConnectors: boolean;
  /** Render the losers bracket (double elim only). */
  showLosers: boolean;

  /** Draw the fixed panel the bracket moves inside. */
  showFrame: boolean;
  /** Draw the title bar above the panel. */
  showTitle: boolean;
  /**
   * Title text. Supports one `|` to split a highlighted lead-in from the rest,
   * e.g. "MY MAJOR | MELEE TOP 8".
   */
  title: string;
  focusMode: FocusMode;
  transition: ShotTransition;
  /** Outline the match the camera is centred on. */
  highlightFocused: boolean;
}

export interface OnDeckViewConfig {
  kind: 'ondeck';
  maxMatches: number;
  /** Restrict to a station number, e.g. only setup 4. */
  stationFilter: number | null;
  streamFilter: string | null;
  showRound: boolean;
  showStation: boolean;
  /** Include in-progress sets above the queue. */
  includeInProgress: boolean;
  orientation: 'vertical' | 'horizontal';
}

export interface StandingsViewConfig {
  kind: 'standings';
  maxPlaces: number;
  /** Only show places that are mathematically locked. */
  finalOnly: boolean;
  showSeeds: boolean;
  layout: 'list' | 'top8-bracket-style';
}

export interface ScorecardViewConfig {
  kind: 'scorecard';
  /** Pin a specific set, or follow the view's camera target. */
  setId: Id | null;
  followCamera: boolean;
  showRound: boolean;
  showGameCount: boolean;
  showCharacters: boolean;
  showSeeds: boolean;
}

export type ViewConfig =
  | BracketViewConfig
  | OnDeckViewConfig
  | StandingsViewConfig
  | ScorecardViewConfig;

export interface OutputView {
  id: string;
  name: string;
  kind: ViewKind;
  /** Unguessable path segment; lets OBS and TVs load without a login. */
  secret: string;
  eventId: Id | null;
  /**
   * Phase to display. An event's phases (pools, then top cut) have unrelated
   * round numbering, so a bracket view renders exactly one phase at a time.
   */
  phaseId: Id | null;
  /** A specific pool within the phase; null means the phase's first group. */
  phaseGroupId: Id | null;
  /**
   * Re-point the view at whichever phase is currently live as the event
   * progresses, so an unattended display follows pools into top cut on its own.
   */
  followActivePhase: boolean;
  themeId: string;
  config: ViewConfig;
  camera: CameraState;
  autoFollow: AutoFollowConfig;
  /** Canvas hint shown in the UI and used by the fit calculation. */
  width: number;
  height: number;
  createdAt: number;
  updatedAt: number;
}

export function defaultConfigFor(kind: ViewKind): ViewConfig {
  switch (kind) {
    case 'bracket':
      return {
        kind: 'bracket',
        showRoundLabels: true,
        showSeeds: true,
        showScores: true,
        showStation: true,
        showStream: false,
        dimCompleted: false,
        highlightLive: true,
        hideEmptyRounds: false,
        showConnectors: true,
        showLosers: true,
        showFrame: false,
        showTitle: false,
        title: '',
        focusMode: 'dim',
        transition: 'auto',
        highlightFocused: true,
      };
    case 'ondeck':
      return {
        kind: 'ondeck',
        maxMatches: 8,
        stationFilter: null,
        streamFilter: null,
        showRound: true,
        showStation: true,
        includeInProgress: true,
        orientation: 'vertical',
      };
    case 'standings':
      return {
        kind: 'standings',
        maxPlaces: 8,
        finalOnly: false,
        showSeeds: true,
        layout: 'list',
      };
    case 'scorecard':
      return {
        kind: 'scorecard',
        setId: null,
        followCamera: true,
        showRound: true,
        showGameCount: true,
        showCharacters: true,
        showSeeds: true,
      };
  }
}

/** `/overlay/:id/:secret` — the string a user pastes into an OBS browser source. */
export function overlayPath(view: Pick<OutputView, 'id' | 'secret'>): string {
  return `/overlay/${view.id}/${view.secret}`;
}
