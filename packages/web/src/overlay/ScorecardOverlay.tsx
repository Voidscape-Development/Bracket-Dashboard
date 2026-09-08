/**
 * Match scorecard — the lower third.
 *
 * By default it follows the view's camera, so punching in on a match in the
 * director panel also swings the scorecard to that match. Pinning a set id
 * overrides that for a fixed shot.
 */

import {
  ActivityState,
  type OutputView,
  type ScorecardViewConfig,
  type TournamentSet,
} from '@bracket/shared';
import { useMemo } from 'react';

export interface ScorecardOverlayProps {
  view: OutputView;
  sets: TournamentSet[];
}

export function ScorecardOverlay({ view, sets }: ScorecardOverlayProps) {
  const config = view.config as ScorecardViewConfig;

  const set = useMemo(() => {
    if (config.setId) return sets.find((s) => s.id === config.setId) ?? null;
    if (config.followCamera && view.camera.targetSetId) {
      const target = sets.find((s) => s.id === view.camera.targetSetId);
      if (target) return target;
    }
    // Nothing chosen: show whatever is live, preferring the latest to start.
    return (
      sets
        .filter((s) => s.state === ActivityState.Active || s.state === ActivityState.Called)
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0] ?? null
    );
  }, [sets, config.setId, config.followCamera, view.camera.targetSetId]);

  if (!set) return <div className="overlay-root" />;

  const winnerId = set.state === ActivityState.Completed ? set.winnerId : null;

  return (
    <div className="ov-panel ov-scorecard" style={{ display: 'inline-flex' }}>
      {config.showRound && (
        <div className="ov-scorecard__round">
          {set.fullRoundText || `Set ${set.identifier}`}
          {config.showGameCount && set.bestOf ? ` · Best of ${set.bestOf}` : ''}
          {set.stationNumber !== null ? ` · Setup ${set.stationNumber}` : ''}
        </div>
      )}

      {set.slots.map((slot) => {
        const characters = config.showCharacters
          ? set.games
              .flatMap((game) => game.selections)
              .filter((selection) => selection.entrantId === slot.entrantId)
              .map((selection) => selection.characterName)
              .filter((name): name is string => Boolean(name))
          : [];
        const uniqueCharacters = [...new Set(characters)];

        return (
          <div
            key={slot.slotIndex}
            className={`ov-scorecard__row ${
              winnerId && slot.entrantId === winnerId ? 'ov-scorecard__row--winner' : ''
            }`}
          >
            {config.showSeeds && slot.seed !== null && (
              <span className="ov-scorecard__seed">#{slot.seed}</span>
            )}
            <span className="ov-scorecard__name">
              {slot.entrantName ?? slot.placeholderText ?? 'TBD'}
              {uniqueCharacters.length > 0 && (
                <span className="ov-scorecard__chars"> {uniqueCharacters.join(' · ')}</span>
              )}
            </span>
            <span className="ov-scorecard__score">
              {slot.score === null ? '0' : slot.score < 0 ? 'DQ' : slot.score}
            </span>
          </div>
        );
      })}
    </div>
  );
}
