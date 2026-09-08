/**
 * Camera resolution and auto-follow.
 *
 * Shared because both ends need the same answer: the overlay resolves the camera
 * to a transform for rendering, and the server resolves auto-follow to a target
 * so it can push the same shot to every client watching a view.
 */

import { ActivityState, type Id, type TournamentSet } from './domain.js';
import {
  boundsOf,
  progressionFrom,
  type EliminationLayout,
  type LayoutNode,
  type Rect,
} from './layout.js';
import type { AutoFollowConfig, CameraState } from './views.js';

export interface Viewport {
  width: number;
  height: number;
}

export interface CameraTransform {
  zoom: number;
  /** Layout-space point that sits at the centre of the viewport. */
  centerX: number;
  centerY: number;
  /** Ready-to-use CSS transform for a layout-space container. */
  transform: string;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 6;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

function fitRect(rect: Rect, viewport: Viewport, maxZoom = 2.5): CameraTransform {
  const zoom = clampZoom(
    Math.min(
      viewport.width / Math.max(rect.width, 1),
      viewport.height / Math.max(rect.height, 1),
      maxZoom,
    ),
  );
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  return { zoom, centerX, centerY, transform: cssTransform(zoom, centerX, centerY, viewport) };
}

export function cssTransform(
  zoom: number,
  centerX: number,
  centerY: number,
  viewport: Viewport,
): string {
  const tx = viewport.width / 2 - centerX * zoom;
  const ty = viewport.height / 2 - centerY * zoom;
  return `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${zoom.toFixed(4)})`;
}

/**
 * Resolves a camera state against a layout. Falls back to framing the whole
 * bracket whenever the requested target no longer exists — a match can vanish
 * from a layout when a phase is reseeded mid-tournament, and an overlay must
 * never end up staring at empty space.
 */
export function resolveCamera(
  layout: EliminationLayout,
  camera: CameraState,
  viewport: Viewport,
): CameraTransform {
  const all = layout.nodes;

  const frame = (
    nodes: LayoutNode[],
    maxZoom?: number,
    padding = 32,
  ): CameraTransform | null => {
    const rect = boundsOf(nodes, padding);
    return rect ? fitRect(rect, viewport, maxZoom) : null;
  };

  switch (camera.mode) {
    case 'manual': {
      const zoom = clampZoom(camera.zoom);
      return {
        zoom,
        centerX: camera.centerX,
        centerY: camera.centerY,
        transform: cssTransform(zoom, camera.centerX, camera.centerY, viewport),
      };
    }
    case 'match': {
      const node = all.find((n) => n.setId === camera.targetSetId);
      const result = node ? frame([node], 3) : null;
      if (result) return result;
      break;
    }
    case 'column': {
      const column = layout.columns.find((c) => c.id === camera.targetColumnId);
      const nodes = column ? all.filter((n) => column.setIds.includes(n.setId)) : [];
      const result = frame(nodes, 2);
      if (result) return result;
      break;
    }
    case 'progression': {
      if (camera.targetSetId) {
        const nodes = progressionFrom(layout, camera.targetSetId, camera.progressionDepth);
        const result = frame(nodes, 2.5);
        if (result) return result;
      }
      break;
    }
    case 'fit':
    default:
      break;
  }

  // Extra padding on the full-bracket shot so round and section headers, which
  // sit above the topmost match, stay inside the frame.
  return frame(all, 1.5, 56) ?? {
    zoom: 1,
    centerX: 0,
    centerY: 0,
    transform: cssTransform(1, 0, 0, viewport),
  };
}

/**
 * The set ids the current shot is *about*. In `dim` focus mode everything stays
 * on screen and anything outside this list is faded back, which reads far better
 * on stream than cropping neighbouring matches at the frame edge.
 *
 * Returns null for a full-bracket shot, meaning "nothing is dimmed".
 */
export function focusedSetIds(
  layout: EliminationLayout,
  camera: CameraState,
): Set<Id> | null {
  switch (camera.mode) {
    case 'match':
      return camera.targetSetId ? new Set([camera.targetSetId]) : null;

    case 'progression': {
      if (!camera.targetSetId) return null;
      const nodes = progressionFrom(layout, camera.targetSetId, camera.progressionDepth);
      return nodes.length > 0 ? new Set(nodes.map((n) => n.setId)) : null;
    }

    case 'column': {
      const column = layout.columns.find((c) => c.id === camera.targetColumnId);
      return column ? new Set(column.setIds) : null;
    }

    case 'fit':
    case 'manual':
    default:
      return null;
  }
}

/**
 * Whether moving between two shots should cut through a fade rather than glide.
 * A pan across a whole bracket takes an age and reads as a lurch; a pan between
 * neighbouring rounds reads as intent. The threshold is in viewport widths.
 */
export function shouldFade(
  from: CameraTransform | null,
  to: CameraTransform,
  viewport: Viewport,
  thresholdViewports = 1.1,
): boolean {
  if (!from) return false;
  const dx = (to.centerX - from.centerX) * to.zoom;
  const dy = (to.centerY - from.centerY) * to.zoom;
  const distance = Math.hypot(dx, dy);
  const zoomRatio = Math.max(to.zoom / from.zoom, from.zoom / to.zoom);
  return (
    distance > viewport.width * thresholdViewports ||
    // A large zoom swing is just as disorienting as a long pan.
    zoomRatio > 2.5
  );
}

/** A set is "interesting" to auto-follow when it is live or has been called. */
function isLive(set: TournamentSet): boolean {
  return set.state === ActivityState.Active || set.state === ActivityState.Called;
}

export interface AutoFollowPick {
  setId: Id;
  reason: string;
}

/**
 * Chooses which set the camera should be on. Returns null when nothing warrants
 * a move, in which case the caller leaves the current shot alone rather than
 * snapping back to a fit — an unattended TV should not twitch.
 */
export function pickAutoFollowTarget(
  sets: TournamentSet[],
  config: AutoFollowConfig,
  previousSetId: Id | null,
  now: number = Date.now(),
): AutoFollowPick | null {
  if (!config.enabled) return null;

  const live = sets.filter(isLive);

  switch (config.rule) {
    case 'entrant': {
      if (!config.entrantId) return null;
      const involved = sets.filter((s) =>
        s.slots.some((slot) => slot.entrantId === config.entrantId),
      );
      const active = involved.find(isLive);
      if (active) return { setId: active.id, reason: 'entrant is playing' };
      // Otherwise sit on their next scheduled match.
      const next = involved
        .filter((s) => s.state === ActivityState.Created || s.state === ActivityState.Ready)
        .sort((a, b) => Math.abs(a.round) - Math.abs(b.round))[0];
      return next ? { setId: next.id, reason: 'entrant is up next' } : null;
    }

    case 'stream': {
      if (!config.streamName) return null;
      const onStream = sets.filter((s) => s.streamName === config.streamName);
      const active = onStream.find(isLive) ?? onStream[0];
      return active ? { setId: active.id, reason: 'assigned to stream' } : null;
    }

    case 'deepest': {
      if (live.length === 0) return null;
      const best = live
        .slice()
        .sort((a, b) => {
          // Grand finals and later winners rounds first, then deeper losers rounds.
          const rank = (s: TournamentSet) =>
            /grand/i.test(s.fullRoundText ?? '') ? 1000 : Math.abs(s.round);
          return rank(b) - rank(a);
        })[0];
      return best ? { setId: best.id, reason: 'furthest-along live set' } : null;
    }

    case 'rotate': {
      if (live.length === 0) return null;
      const slot = Math.floor(now / Math.max(2000, config.rotateIntervalMs)) % live.length;
      const pick = live[slot];
      return pick ? { setId: pick.id, reason: 'rotating live sets' } : null;
    }

    case 'live':
    default: {
      if (live.length === 0) return null;
      // Prefer staying put while the current set is still live, so the camera
      // does not hop away mid-match when another set starts.
      if (previousSetId && live.some((s) => s.id === previousSetId)) return null;
      const newest = live
        .slice()
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
      return newest ? { setId: newest.id, reason: 'most recently started set' } : null;
    }
  }
}
