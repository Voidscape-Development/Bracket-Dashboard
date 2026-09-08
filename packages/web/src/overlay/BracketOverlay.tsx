/**
 * Bracket overlay — the zoomable display.
 *
 * The camera is fully server-driven: whatever the director (or auto-follow)
 * chose arrives over the socket and this moves to it. Two overlays on the same
 * bracket therefore stay independent, which is what lets the stream punch in on
 * a match while the lobby TV keeps showing the whole bracket.
 *
 * The phase and bracket type both come from the server. An event's phases number
 * their rounds independently, so a client that guessed would happily interleave
 * pool round 1 with top-cut round 1.
 */

import type {
  BracketType,
  BracketViewConfig,
  Entrant,
  OutputView,
  TournamentSet,
} from '@bracket/shared';

import { BracketCanvas } from '../components/BracketCanvas.js';
import { OverlayFrame } from '../components/OverlayFrame.js';
import { MatchListView, RoundRobinView, SwissView } from '../components/PoolViews.js';

export interface BracketOverlayProps {
  view: OutputView;
  sets: TournamentSet[];
  entrants: Entrant[];
  /** Resolved server-side from the view's phase target. */
  bracketType: BracketType;
  fadeMs?: number;
}

export function BracketOverlay({
  view,
  sets,
  entrants,
  bracketType,
  fadeMs,
}: BracketOverlayProps) {
  const config = view.config as BracketViewConfig;

  const body = () => {
    if (sets.length === 0) return null;

    switch (bracketType) {
      case 'ROUND_ROBIN':
        return (
          <RoundRobinView
            sets={sets}
            bracketType={bracketType}
            entrants={entrants}
            showSeeds={config.showSeeds}
          />
        );
      case 'SWISS':
        return (
          <SwissView
            sets={sets}
            bracketType={bracketType}
            entrants={entrants}
            showSeeds={config.showSeeds}
          />
        );
      case 'SINGLE_ELIMINATION':
      case 'DOUBLE_ELIMINATION':
      case 'ELIMINATION_ROUNDS':
        return (
          <BracketCanvas
            sets={sets}
            bracketType={bracketType}
            entrants={entrants}
            config={config}
            camera={view.camera}
            fadeMs={fadeMs}
          />
        );
      default:
        return <MatchListView sets={sets} bracketType={bracketType} entrants={entrants} />;
    }
  };

  const content = body();
  // Render nothing rather than an empty frame, so a bracket that has not been
  // seeded yet does not put a hollow box on stream.
  if (!content) return <div className="overlay-root" />;

  return (
    <OverlayFrame
      showFrame={config.showFrame}
      showTitle={config.showTitle}
      title={config.title}
    >
      {content}
    </OverlayFrame>
  );
}
