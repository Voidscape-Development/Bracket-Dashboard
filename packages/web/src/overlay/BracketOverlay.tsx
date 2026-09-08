/**
 * Bracket overlay — the zoomable display.
 *
 * The camera is fully server-driven: whatever the director (or auto-follow)
 * chose arrives over the socket and this animates to it. Two overlays on the
 * same bracket therefore stay independent, which is what lets the stream punch
 * in on a match while the lobby TV keeps showing the whole bracket.
 */

import type { BracketViewConfig, Entrant, OutputView, TournamentSet } from '@bracket/shared';
import { useMemo } from 'react';

import { BracketCanvas } from '../components/BracketCanvas.js';
import { MatchListView, RoundRobinView, SwissView } from '../components/PoolViews.js';

export interface BracketOverlayProps {
  view: OutputView;
  sets: TournamentSet[];
  entrants: Entrant[];
}

export function BracketOverlay({ view, sets, entrants }: BracketOverlayProps) {
  const config = view.config as BracketViewConfig;

  const scoped = useMemo(() => {
    if (!view.phaseGroupId) return sets;
    const filtered = sets.filter((s) => s.phaseGroupId === view.phaseGroupId);
    return filtered.length > 0 ? filtered : sets;
  }, [sets, view.phaseGroupId]);

  // Infer the bracket shape from the data. An overlay only ever points at one
  // phase group, and negative rounds are the reliable tell for double elim.
  const bracketType = useMemo(() => {
    if (scoped.some((s) => s.round < 0)) return 'DOUBLE_ELIMINATION' as const;
    // A round robin has every entrant meeting every other, so identifiers repeat
    // across rounds while entrants stay resolved from the start.
    const allSeeded = scoped.length > 0 && scoped.every((s) => s.slots.every((x) => x.prereqType !== 'set'));
    if (allSeeded && scoped.length > 2) return 'ROUND_ROBIN' as const;
    return 'SINGLE_ELIMINATION' as const;
  }, [scoped]);

  if (bracketType === 'ROUND_ROBIN') {
    return (
      <RoundRobinView
        sets={scoped}
        bracketType="ROUND_ROBIN"
        entrants={entrants}
        showSeeds={config.showSeeds}
      />
    );
  }

  if (scoped.length === 0) {
    return <div className="overlay-root" />;
  }

  return (
    <BracketCanvas
      sets={scoped}
      bracketType={bracketType}
      entrants={entrants}
      config={config}
      camera={view.camera}
      className="overlay-root"
    />
  );
}

export { MatchListView, SwissView };
