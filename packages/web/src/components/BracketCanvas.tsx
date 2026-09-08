/**
 * The bracket canvas.
 *
 * Lays out the sets, draws the connectors, and applies a single transform for
 * pan/zoom. Both the dashboard viewer and the OBS bracket overlay render through
 * here, which is what guarantees the shot an operator lines up in the director
 * panel is the shot that appears on stream.
 *
 * Camera handling has two modes. When a `camera` prop is supplied the component
 * is controlled — it resolves that camera against the layout and animates to it.
 * Without one it manages its own pan/zoom for free exploration.
 */

import {
  DEFAULT_LAYOUT_OPTIONS,
  cssTransform,
  layoutElimination,
  resolveCamera,
  type BracketType,
  type BracketViewConfig,
  type CameraState,
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

  const layout: EliminationLayout = useMemo(
    () => layoutElimination({ sets: visibleSets, bracketType, entrants: entrants ?? [] }),
    [visibleSets, bracketType, entrants],
  );

  const setsById = useMemo(
    () => new Map(visibleSets.map((s) => [s.id, s])),
    [visibleSets],
  );

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

  const transform = useMemo(() => {
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
    const center = freeCenter ?? { x: fitted.centerX, y: fitted.centerY };
    const zoom = freeCenter ? freeZoom : fitted.zoom;
    return {
      zoom,
      centerX: center.x,
      centerY: center.y,
      transform: cssTransform(zoom, center.x, center.y, viewport),
    };
  }, [controlled, camera, layout, viewport, freeCenter, freeZoom]);

  // `freeCenter` stays null until the viewer actually pans or zooms. Adopting the
  // fitted values eagerly would freeze the framing against the placeholder
  // viewport used before the container is measured, leaving the bracket clipped.
  const handleWheel = useCallback(
    (event: React.WheelEvent) => {
      if (!interactive) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      const next = Math.min(6, Math.max(0.05, (freeCenter ? freeZoom : transform.zoom) * factor));
      setFreeZoom(next);
      if (!freeCenter) setFreeCenter({ x: transform.centerX, y: transform.centerY });
      onManualCamera?.({
        zoom: next,
        centerX: freeCenter?.x ?? transform.centerX,
        centerY: freeCenter?.y ?? transform.centerY,
      });
    },
    [interactive, freeCenter, freeZoom, transform, onManualCamera],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!interactive) return;
      // Let clicks on a match select it rather than starting a drag.
      if ((event.target as HTMLElement).closest('.bd-match')) return;
      const center = freeCenter ?? { x: transform.centerX, y: transform.centerY };
      dragRef.current = { x: event.clientX, y: event.clientY, cx: center.x, cy: center.y };
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    },
    [interactive, freeCenter, transform],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const zoom = freeCenter ? freeZoom : transform.zoom;
      const next = {
        x: drag.cx - (event.clientX - drag.x) / zoom,
        y: drag.cy - (event.clientY - drag.y) / zoom,
      };
      setFreeCenter(next);
      onManualCamera?.({ zoom, centerX: next.x, centerY: next.y });
    },
    [freeCenter, freeZoom, transform.zoom, onManualCamera],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  const animationStyle = camera?.animate
    ? {
        transition: `transform var(--bd-camera-duration-ms, 650ms) var(--bd-camera-easing, ease)`,
      }
    : undefined;

  if (layout.nodes.length === 0) {
    return (
      <div ref={containerRef} className={`bd-canvas ${className ?? ''}`}>
        <div className="bd-canvas__empty">No matches to show yet.</div>
      </div>
    );
  }

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
      <div
        className="bd-canvas__world"
        style={{
          transform: transform.transform,
          transformOrigin: '0 0',
          width: layout.width,
          height: layout.height,
          ...animationStyle,
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
            return (
              <div
                key={column.id}
                className="bd-round-label"
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
          return (
            <div
              key={node.setId}
              className="bd-node"
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
                onClick={onSelectSet}
              />
            </div>
          );
        })}
      </div>
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
