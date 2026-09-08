/**
 * Standings / top 8 board.
 *
 * start.gg reports provisional placements throughout an event, so `finalOnly`
 * exists for broadcasts that should show a placement only once it is locked.
 */

import type { OutputView, Standing, StandingsViewConfig } from '@bracket/shared';
import { useMemo } from 'react';

export interface StandingsOverlayProps {
  view: OutputView;
  standings: Standing[];
}

/** 1st / 2nd / 3rd, and start.gg's tied placements (5th, 7th, 9th...). */
function ordinal(place: number): string {
  const suffix =
    place % 100 >= 11 && place % 100 <= 13
      ? 'th'
      : place % 10 === 1
        ? 'st'
        : place % 10 === 2
          ? 'nd'
          : place % 10 === 3
            ? 'rd'
            : 'th';
  return `${place}${suffix}`;
}

export function StandingsOverlay({ view, standings }: StandingsOverlayProps) {
  const config = view.config as StandingsViewConfig;

  const rows = useMemo(
    () =>
      standings
        .filter((s) => (config.finalOnly ? s.isFinal : true))
        .sort((a, b) => a.placement - b.placement)
        .slice(0, config.maxPlaces),
    [standings, config.finalOnly, config.maxPlaces],
  );

  if (rows.length === 0) return <div className="overlay-root" />;

  return (
    <div className="ov-panel" style={{ display: 'inline-block', minWidth: 360 }}>
      <div className="ov-title">Standings</div>
      <div style={{ padding: '8px 0 14px' }}>
        {rows.map((row) => (
          <div key={row.entrantId} className="ov-standing">
            <span className="ov-standing__place">{ordinal(row.placement)}</span>
            <span className="ov-standing__name">{row.entrantName}</span>
            {!row.isFinal && <span className="bd-badge">provisional</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
