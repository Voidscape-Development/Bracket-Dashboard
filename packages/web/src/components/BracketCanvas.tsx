/**
 * The bracket canvas.
 *
 * Lays out the sets, draws the connectors, and applies a single transform for
 * pan/zoom. Both the dashboard viewer and the OBS bracket overlay render through
 * here, which is what guarantees the shot an operator lines up in the director
 * panel is the shot that appears on stream.
 *
 * Camera handling has two modes. When a `camera` prop is supplied the component
 * is controlled — it resolves that camera against the layout and moves to it.
 * Without one it manages its own pan/zoom for free exploration.
 *
 * Two behaviours exist because a bracket on stream is not a bracket in a browser:
 *
 *  - Punching in *dims* the rest of the bracket rather than cropping it, so a
 *    viewer keeps their bearings instead of seeing matches sliced by the frame.
 *  - Jumping a long way (winners to losers) cuts through a cross-fade instead of
 *    gliding, because a pan across a whole bracket reads as a lurch.
 */

import {
  DEFAULT_LAYOUT_OPTIONS,
  cssTransform,
  focusedSetIds,
  layoutElimination,
  resolveCamera,
  shouldFade,
  type BracketType,
  type BracketViewConfig,
  type CameraState,
  type CameraTransform,
  type EliminationLayout,
  type Entrant,
  type Id,
  type TournamentSet,
} from '@bracket/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { MatchCard } from './MatchCard.js';

export interface BracketCanvasProps {
  sets: TournamentSet[];
  bracketType: BracketType;
  entrants?: Entrant[];
  config: BracketViewConfig;
  /** Supply to drive the camera externally (overlay/director). */
  camera?: CameraState;
  /** Allow the viewer to drag and wheel-zoom. */
  interactive?: boolean;
  selectedSetId?: Id | null;
  onSelectSet?: (set: TournamentSet) => void;
  /** Reports user-driven pan/zoom so a caller can persist it. */
  onManualCamera?: (camera: Pick<CameraState, 'zoom' | 'centerX' | 'centerY'>) => void;
  /** Cross-fade length in ms; matches the theme's fade token. */
  fadeMs?: number;
  className?: string;
}

interface Viewport {
  width: number;
  height: number;
}

export function BracketCanvas({
  sets,
  bracketType,
  entrants,
  config,
  camera,
  interactive = false,
  selectedSetId,
  onSelectSet,
  onManualCamera,
  fadeMs = 420,
  className,
}: BracketCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ width: 1920, height: 1080 });

  // Free-camera state, used only when `camera` is not supplied.
  const [freeZoom, setFreeZoom] = useState(1);
  const [freeCenter, setFreeCenter] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);

  const visibleSets = useMemo(() => {
    let out = sets;
    if (!config.showLosers) out = out.filter((s) => s.round >= 0);
    if (config.hideEmptyRounds) {
      // Drop rounds where nothing has resolved yet, which trims the long tail of
      // "TBD vs TBD" columns on a bracket that has only just started.
      const rounds = new Map<number, boolean>();
      for (const set of out) {
        const resolved = set.slots.some((slot) => slot.entrantId !== null);
        rounds.set(set.round, (rounds.get(set.round) ?? false) || resolved);
      }
      out = out.filter((s) => rounds.get(s.round));
    }
    return out;
  }, [sets, config.showLosers, config.hideEmptyRounds]);

  // Station and stream badges add a row under the two slots, so the match box
  // has to grow or the badge is clipped by the card's own overflow.
  const showsMeta = config.showStation || config.showStream || config.highlightLive;
  const layout: EliminationLayout = useMemo(
    () =>
      layoutElimination({
        sets: visibleSets,
        bracketType,
        entrants: entrants ?? [],
        options: showsMeta ? { nodeHeight: 84 } : undefined,
      }),
    [visibleSets, bracketType, entrants, showsMeta],
  );

  const setsById = useMemo(
    () => new Map(visibleSets.map((s) => [s.id, s])),
    [visibleSets],
  );

  /**
   * start.gg's slot placeholders reference the feeding set by id, which is a
   * meaningless number on screen. Map ids to the short match identifiers the
   * bracket actually labels matches with, so an unresolved slot reads
   * "Winner of 3" rather than "Winner of 300006-se1-1".
   */
  const feederLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const set of visibleSets) map.set(set.id, set.identifier);
    return map;
  }, [visibleSets]);

  // Track the real pixel size so 'fit' actually fits.
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        setViewport({ width: rect.width, height: rect.height });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const controlled = camera !== undefined;

  /** The transform the camera wants right now. */
  const target = useMemo<CameraTransform>(() => {
    if (controlled && camera) {
      return resolveCamera(layout, camera, viewport);
    }
    // Uncontrolled: start framed on the whole bracket, then honour the user.
    const fitted = resolveCamera(
      layout,
      {
        mode: 'fit',
        targetSetId: null,
        targetColumnId: null,
        progressionDepth: 2,
        zoom: 1,
        centerX: 0,
        centerY: 0,
        animate: false,
      },
      viewport,
    );
    // `freeCenter` stays null until the viewer actually pans or zooms. Adopting
    // the fitted values eagerly would freeze the framing against the placeholder
    // viewport used before the container is measured, leaving it clipped.
    const center = freeCenter ?? { x: fitted.centerX, y: fitted.centerY };
    const zoom = freeCenter ? freeZoom : fitted.zoom;
    return {
      zoom,
      centerX: center.x,
      centerY: center.y,
      transform: cssTransform(zoom, center.x, center.y, viewport),
    };
  }, [controlled, camera, layout, viewport, freeCenter, freeZoom]);

  // ---- Shot transitions ----------------------------------------------------

  const [applied, setApplied] = useState<CameraTransform>(target);
  const [opacity, setOpacity] = useState(1);
  const [cutting, setCutting] = useState(false);
  const appliedRef = useRef<CameraTransform | null>(null);

  // Keyed on the resolved transform string, which captures the viewport as well
  // as the camera. Keying on zoom/centre alone would miss a container resize:
  // the transform changes but the key does not, so the new framing never lands.
  const targetKey = target.transform;

  useEffect(() => {
    const previous = appliedRef.current;
    const transition = config.transition ?? 'auto';

    const wantFade =
      controlled &&
      previous !== null &&
      (transition === 'fade' ||
        (transition === 'auto' && shouldFade(previous, target, viewport)));

    if (!wantFade) {
      appliedRef.current = target;
      setApplied(target);
      return;
    }

    // Fade out, jump while invisible, fade back in.
    setOpacity(0);
    setCutting(true);
    const half = Math.max(80, fadeMs);
    const jump = window.setTimeout(() => {
      appliedRef.current = target;
      setApplied(target);
    }, half);
    const restore = window.setTimeout(() => {
      setOpacity(1);
      setCutting(false);
    }, half + 40);

    return () => {
      window.clearTimeout(jump);
      window.clearTimeout(restore);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, controlled, config.transition, fadeMs]);

  // ---- Focus ---------------------------------------------------------------

  const focused = useMemo(
    () => (camera && config.focusMode === 'dim' ? focusedSetIds(layout, camera) : null),
    [layout, camera, config.focusMode],
  );

  /** Columns containing at least one focused match, so labels dim in step. */
  const focusedColumns = useMemo(() => {
    if (!focused) return null;
    const ids = new Set<string>();
    for (const column of layout.columns) {
      if (column.setIds.some((id) => focused.has(id))) ids.add(column.id);
    }
    return ids;
  }, [focused, layout.columns]);

  // ---- Interaction ---------------------------------------------------------

  const handleWheel = useCallback(
    (event: React.WheelEvent) => {
      if (!interactive) return;
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      const next = Math.min(6, Math.max(0.05, (freeCenter ? freeZoom : target.zoom) * factor));
      setFreeZoom(next);
      if (!freeCenter) setFreeCenter({ x: target.centerX, y: target.centerY });
      onManualCamera?.({
        zoom: next,
        centerX: freeCenter?.x ?? target.centerX,
        centerY: freeCenter?.y ?? target.centerY,
      });
    },
    [interactive, freeCenter, freeZoom, target, onManualCamera],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!interactive) return;
      // Let clicks on a match select it rather than starting a drag.
      if ((event.target as HTMLElement).closest('.bd-match')) return;
      const center = freeCenter ?? { x: target.centerX, y: target.centerY };
      dragRef.current = { x: event.clientX, y: event.clientY, cx: center.x, cy: center.y };
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    },
    [interactive, freeCenter, target],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const zoom = freeCenter ? freeZoom : target.zoom;
      const next = {
        x: drag.cx - (event.clientX - drag.x) / zoom,
        y: drag.cy - (event.clientY - drag.y) / zoom,
      };
      setFreeCenter(next);
      onManualCamera?.({ zoom, centerX: next.x, centerY: next.y });
    },
    [freeCenter, freeZoom, target.zoom, onManualCamera],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  // During a cut the transform must jump, not glide, or the fade is pointless.
  const animateTransform = camera?.animate && !cutting;
  const empty = layout.nodes.length === 0;

  return (
    <div
      ref={containerRef}
      className={`bd-canvas ${interactive ? 'bd-canvas--interactive' : ''} ${className ?? ''}`}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/*
        The container element is rendered unconditionally, even with nothing to
        show. Swapping it out for an "empty" element would leave the size
        observer attached to a detached node, and the camera would then frame
        every shot against a placeholder viewport.
      */}
      {empty && <div className="bd-canvas__empty">No matches to show yet.</div>}
      {!empty && (
      <div
        className="bd-canvas__world"
        style={{
          transform: applied.transform,
          transformOrigin: '0 0',
          width: layout.width,
          height: layout.height,
          opacity,
          transition: [
            animateTransform
              ? 'transform var(--bd-camera-duration-ms, 650ms) var(--bd-camera-easing, ease)'
              : null,
            `opacity ${fadeMs}ms ease`,
          ]
            .filter(Boolean)
            .join(', '),
        }}
      >
        {config.showConnectors && <Connectors layout={layout} />}

        {config.showRoundLabels &&
          layout.columns.map((column) => {
            // Align every round label in a header row per bracket half, the way
            // start.gg does, rather than letting each label float to its own
            // column's first match.
            const section = layout.sections.find((s) => s.side === column.side);
            const top =
              (section?.top ?? column.top) - DEFAULT_LAYOUT_OPTIONS.headerHeight;
            const dimmed = focusedColumns !== null && !focusedColumns.has(column.id);
            return (
              <div
                key={column.id}
                className={`bd-round-label ${dimmed ? 'bd-dimmed' : ''}`}
                style={{ left: column.x, top, width: column.width }}
              >
                {column.label}
              </div>
            );
          })}

        {layout.sections
          .filter((section) => section.side === 'losers')
          .map((section) => (
            <div
              key={section.side}
              className="bd-section-label"
              style={{ top: section.top - DEFAULT_LAYOUT_OPTIONS.headerHeight - 24 }}
            >
              {section.label}
            </div>
          ))}

        {layout.nodes.map((node) => {
          const set = setsById.get(node.setId);
          if (!set) return null;
          const dimmed = focused !== null && !focused.has(node.setId);
          const isCameraTarget =
            config.highlightFocused && camera?.targetSetId === node.setId;
          return (
            <div
              key={node.setId}
              className={`bd-node ${dimmed ? 'bd-dimmed' : ''}`}
              style={{
                left: node.x,
                top: node.y,
                width: node.width,
                height: node.height,
              }}
            >
              <MatchCard
                set={set}
                showSeeds={config.showSeeds}
                showScores={config.showScores}
                showStation={config.showStation}
                showStream={config.showStream}
                dimCompleted={config.dimCompleted}
                highlightLive={config.highlightLive}
                selected={selectedSetId === set.id}
                cameraTarget={isCameraTarget}
                feederLabels={feederLabels}
                onClick={onSelectSet}
              />
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}

/**
 * Connector paths. Drawn as one SVG in layout space so they scale with the
 * camera and never need re-measuring.
 */
function Connectors({ layout }: { layout: EliminationLayout }) {
  const byId = useMemo(
    () => new Map(layout.nodes.map((n) => [n.setId, n])),
    [layout.nodes],
  );

  const paths = useMemo(() => {
    const out: { id: string; d: string; loser: boolean }[] = [];
    for (const edge of layout.edges) {
      const from = byId.get(edge.fromSetId);
      const to = byId.get(edge.toSetId);
      if (!from || !to) continue;

      const x1 = from.x + from.width;
      const y1 = from.y + from.height / 2;
      const x2 = to.x;
      // Aim at the slot this feeds, so two incoming lines do not overlap.
      const y2 = to.y + to.height * (edge.toSlotIndex === 0 ? 0.28 : 0.72);
      const mid = x1 + Math.max(12, (x2 - x1) / 2);

      out.push({
        id: edge.id,
        d: `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`,
        loser: edge.isLoserFeed,
      });
    }
    return out;
  }, [layout.edges, byId]);

  return (
    <svg
      className="bd-connectors"
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      aria-hidden="true"
    >
      {paths.map((path) => (
        <path
          key={path.id}
          d={path.d}
          className={path.loser ? 'bd-connector bd-connector--loser' : 'bd-connector'}
        />
      ))}
    </svg>
  );
}
