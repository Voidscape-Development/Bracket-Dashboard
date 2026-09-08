/**
 * Bracket overlay — the zoomable display.
 *
 * The camera is fully server-driven: whatever the director (or auto-follow)
 * chose arrives over the socket and this animates to it. Two overlays on the
 * same bracket therefore stay independent, which is what lets the stream punch
 * in on a match while the lobby TV keeps showing the whole bracket.
 */
import type { Entrant, OutputView, TournamentSet } from '@bracket/shared';
import { MatchListView, SwissView } from '../components/PoolViews.js';
export interface BracketOverlayProps {
    view: OutputView;
    sets: TournamentSet[];
    entrants: Entrant[];
}
export declare function BracketOverlay({ view, sets, entrants }: BracketOverlayProps): import("react").JSX.Element;
export { MatchListView, SwissView };
//# sourceMappingURL=BracketOverlay.d.ts.map