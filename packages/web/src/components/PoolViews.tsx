/**
 * Round robin and Swiss renderers.
 *
 * Neither is a tree, so neither uses the bracket canvas: round robin reads as
 * standings plus a head-to-head grid the way start.gg shows a pool, and Swiss as
 * standings plus a column per round.
 */

import {
  ActivityState,
  layoutRoundRobin,
  layoutSwiss,
  type BracketType,
  type Entrant,
  type Id,
  type TournamentSet,
} from '@bracket/shared';
import { useMemo } from 'react';

import { MatchCard } from './MatchCard.js';

export interface PoolViewProps {
  sets: TournamentSet[];
  bracketType: BracketType;
  entrants?: Entrant[];
  onSelectSet?: (set: TournamentSet) => void;
  selectedSetId?: Id | null;
  showSeeds?: boolean;
}

export function RoundRobinView({
  sets,
  bracketType,
  entrants,
  onSelectSet,
  selectedSetId,
  showSeeds = true,
}: PoolViewProps) {
  const layout = useMemo(
    () => layoutRoundRobin({ sets, bracketType, entrants: entrants ?? [] }),
    [sets, bracketType, entrants],
  );
  const cellIndex = useMemo(() => {
    const map = new Map<string, (typeof layout.cells)[number]>();
    for (const cell of layout.cells) map.set(`${cell.rowEntrantId}:${cell.colEntrantId}`, cell);
    return map;
  }, [layout.cells]);

  const setsById = useMemo(() => new Map(sets.map((s) => [s.id, s])), [sets]);

  return (
    <div className="bd-pool">
      <div className="bd-pool__standings">
        <h3 className="bd-pool__heading">Standings</h3>
        <table className="bd-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Entrant</th>
              <th>W–L</th>
              <th>Games</th>
            </tr>
          </thead>
          <tbody>
            {layout.rows.map((row) => (
              <tr key={row.entrantId}>
                <td className="bd-table__rank">{row.rank}</td>
                <td>
                  {showSeeds && row.seed !== null && (
                    <span className="bd-slot__seed">{row.seed}</span>
                  )}
                  {row.entrantName}
                </td>
                <td>
                  {row.wins}–{row.losses}
                </td>
                <td className="bd-table__muted">
                  {row.gamesWon}–{row.gamesLost}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bd-pool__grid">
        <h3 className="bd-pool__heading">Head to head</h3>
        <div className="bd-scroll-x">
          <table className="bd-table bd-table--matrix">
            <thead>
              <tr>
                <th />
                {layout.rows.map((row) => (
                  <th key={row.entrantId} title={row.entrantName}>
                    {row.entrantName.slice(0, 8)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {layout.rows.map((rowEntrant) => (
                <tr key={rowEntrant.entrantId}>
                  <th scope="row">{rowEntrant.entrantName}</th>
                  {layout.rows.map((colEntrant) => {
                    if (rowEntrant.entrantId === colEntrant.entrantId) {
                      return <td key={colEntrant.entrantId} className="bd-cell--self" />;
                    }
                    const cell = cellIndex.get(
                      `${rowEntrant.entrantId}:${colEntrant.entrantId}`,
                    );
                    const set = cell?.setId ? setsById.get(cell.setId) : null;
                    return (
                      <td
                        key={colEntrant.entrantId}
                        className={`bd-cell bd-cell--${cell?.result ?? 'none'}`}
                        onClick={set && onSelectSet ? () => onSelectSet(set) : undefined}
                      >
                        {cell?.score ?? (cell?.result === 'pending' ? '–' : '')}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bd-pool__matches">
        <h3 className="bd-pool__heading">Matches</h3>
        <div className="bd-match-list">
          {layout.setIds.map((id) => {
            const set = setsById.get(id);
            if (!set) return null;
            return (
              <MatchCard
                key={id}
                set={set}
                showSeeds={showSeeds}
                showScores
                showStation
                showStream={false}
                dimCompleted={false}
                highlightLive
                selected={selectedSetId === id}
                onClick={onSelectSet}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function SwissView({
  sets,
  bracketType,
  entrants,
  onSelectSet,
  selectedSetId,
  showSeeds = true,
}: PoolViewProps) {
  const layout = useMemo(
    () => layoutSwiss({ sets, bracketType, entrants: entrants ?? [] }),
    [sets, bracketType, entrants],
  );
  const setsById = useMemo(() => new Map(sets.map((s) => [s.id, s])), [sets]);

  return (
    <div className="bd-swiss">
      <div className="bd-swiss__standings">
        <h3 className="bd-pool__heading">Standings</h3>
        <table className="bd-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Entrant</th>
              <th>W–L</th>
            </tr>
          </thead>
          <tbody>
            {layout.standings.map((row) => (
              <tr key={row.entrantId}>
                <td className="bd-table__rank">{row.rank}</td>
                <td>{row.entrantName}</td>
                <td>
                  {row.wins}–{row.losses}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bd-swiss__rounds bd-scroll-x">
        {layout.rounds.map((round) => (
          <div key={round.round} className="bd-swiss__round">
            <div className="bd-round-label bd-round-label--static">{round.label}</div>
            <div className="bd-match-list">
              {round.setIds.map((id) => {
                const set = setsById.get(id);
                if (!set) return null;
                return (
                  <MatchCard
                    key={id}
                    set={set}
                    showSeeds={showSeeds}
                    showScores
                    showStation
                    showStream={false}
                    dimCompleted={false}
                    highlightLive
                    selected={selectedSetId === id}
                    onClick={onSelectSet}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Fallback for bracket types with no bespoke renderer (exhibition, matchmaking). */
export function MatchListView({ sets, onSelectSet, selectedSetId }: PoolViewProps) {
  const ordered = useMemo(
    () =>
      sets
        .slice()
        .sort(
          (a, b) =>
            Number(b.state === ActivityState.Active) - Number(a.state === ActivityState.Active) ||
            a.round - b.round,
        ),
    [sets],
  );

  return (
    <div className="bd-match-list bd-match-list--wrap">
      {ordered.map((set) => (
        <MatchCard
          key={set.id}
          set={set}
          showSeeds
          showScores
          showStation
          showStream
          dimCompleted={false}
          highlightLive
          selected={selectedSetId === set.id}
          onClick={onSelectSet}
        />
      ))}
    </div>
  );
}
