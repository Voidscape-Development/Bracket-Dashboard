/**
 * Upcoming matches — the venue TV / on-deck ticker.
 *
 * In-progress sets sit above the queue so a player walking past can tell at a
 * glance whether they are up now or next.
 */

import {
  ActivityState,
  type OnDeckViewConfig,
  type OutputView,
  type TournamentSet,
} from '@bracket/shared';
import { useMemo } from 'react';

export interface OnDeckOverlayProps {
  view: OutputView;
  sets: TournamentSet[];
}

export function OnDeckOverlay({ view, sets }: OnDeckOverlayProps) {
  const config = view.config as OnDeckViewConfig;

  const rows = useMemo(() => {
    const isLive = (s: TournamentSet) =>
      s.state === ActivityState.Active || s.state === ActivityState.Called;
    const isReady = (s: TournamentSet) =>
      s.state !== ActivityState.Completed && s.slots.every((slot) => slot.entrantId);

    let pool = sets.filter((s) => (config.includeInProgress ? isReady(s) || isLive(s) : isReady(s) && !isLive(s)));

    if (config.stationFilter !== null) {
      pool = pool.filter((s) => s.stationNumber === config.stationFilter);
    }
    if (config.streamFilter) {
      pool = pool.filter((s) => s.streamName === config.streamFilter);
    }

    return pool
      .sort(
        (a, b) =>
          Number(isLive(b)) - Number(isLive(a)) ||
          Math.abs(a.round) - Math.abs(b.round) ||
          a.identifier.localeCompare(b.identifier, undefined, { numeric: true }),
      )
      .slice(0, config.maxMatches);
  }, [sets, config]);

  if (rows.length === 0) return <div className="overlay-root" />;

  return (
    <div className="ov-panel" style={{ display: 'inline-block', minWidth: 420 }}>
      <div className="ov-title">
        {config.stationFilter !== null
          ? `Setup ${config.stationFilter}`
          : config.streamFilter
            ? config.streamFilter
            : 'Up next'}
      </div>
      <div className={`ov-list ${config.orientation === 'horizontal' ? 'ov-list--horizontal' : ''}`}>
        {rows.map((set) => {
          const live = set.state === ActivityState.Active || set.state === ActivityState.Called;
          return (
            <div key={set.id} className="ov-row">
              {config.showRound && (
                <span className="ov-row__round">{set.fullRoundText || `Set ${set.identifier}`}</span>
              )}
              <span className="ov-row__players">
                {set.slots.map((s) => s.entrantName ?? 'TBD').join('  vs  ')}
              </span>
              {live && <span className="bd-badge bd-badge--live">Now</span>}
              {config.showStation && set.stationNumber !== null && (
                <span className="bd-badge">Setup {set.stationNumber}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
