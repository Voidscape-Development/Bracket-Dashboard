/**
 * One match, styled to read like a start.gg bracket cell but driven entirely by
 * theme variables so a user can restyle it without touching this file.
 */

import { ActivityState, type TournamentSet } from '@bracket/shared';

export interface MatchCardProps {
  set: TournamentSet;
  showSeeds: boolean;
  showScores: boolean;
  showStation: boolean;
  showStream: boolean;
  dimCompleted: boolean;
  highlightLive: boolean;
  selected?: boolean;
  onClick?: (set: TournamentSet) => void;
}

/** start.gg encodes a disqualification as a score of -1. */
function formatScore(score: number | null): string {
  if (score === null) return '–';
  if (score < 0) return 'DQ';
  return String(score);
}

export function MatchCard({
  set,
  showSeeds,
  showScores,
  showStation,
  showStream,
  dimCompleted,
  highlightLive,
  selected,
  onClick,
}: MatchCardProps) {
  const isLive = set.state === ActivityState.Active || set.state === ActivityState.Called;
  const isDone = set.state === ActivityState.Completed;

  const classes = [
    'bd-match',
    isLive && highlightLive ? 'bd-match--live' : '',
    isDone ? 'bd-match--done' : '',
    isDone && dimCompleted ? 'bd-match--dim' : '',
    selected ? 'bd-match--selected' : '',
    set.pendingLocal ? 'bd-match--pending' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      onClick={onClick ? () => onClick(set) : undefined}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick(set);
              }
            }
          : undefined
      }
      data-set-id={set.id}
    >
      <div className="bd-match__slots">
        {set.slots.map((slot) => {
          const isWinner = isDone && slot.entrantId !== null && slot.entrantId === set.winnerId;
          const isLoser = isDone && slot.entrantId !== null && slot.entrantId !== set.winnerId;
          return (
            <div
              key={slot.slotIndex}
              className={[
                'bd-slot',
                isWinner ? 'bd-slot--winner' : '',
                isLoser ? 'bd-slot--loser' : '',
                slot.entrantId ? '' : 'bd-slot--empty',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {showSeeds && slot.seed !== null && (
                <span className="bd-slot__seed">{slot.seed}</span>
              )}
              <span className="bd-slot__name" title={slot.entrantName ?? undefined}>
                {slot.entrantName ?? slot.placeholderText ?? 'TBD'}
              </span>
              {showScores && (
                <span className="bd-slot__score">{formatScore(slot.score)}</span>
              )}
            </div>
          );
        })}
      </div>

      {(showStation || showStream || isLive) && (
        <div className="bd-match__meta">
          {isLive && <span className="bd-badge bd-badge--live">LIVE</span>}
          {set.pendingLocal && <span className="bd-badge bd-badge--pending">SYNCING</span>}
          {showStation && set.stationNumber !== null && (
            <span className="bd-badge">Setup {set.stationNumber}</span>
          )}
          {showStream && set.streamName && (
            <span className="bd-badge bd-badge--stream">{set.streamName}</span>
          )}
        </div>
      )}
    </div>
  );
}
