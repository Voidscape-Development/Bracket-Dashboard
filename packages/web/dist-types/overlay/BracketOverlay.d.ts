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
import type { BracketType, Entrant, OutputView, TournamentSet } from '@bracket/shared';
export interface BracketOverlayProps {
    view: OutputView;
    sets: TournamentSet[];
    entrants: Entrant[];
    /** Resolved server-side from the view's phase target. */
    bracketType: BracketType;
    fadeMs?: number;
}
export declare function BracketOverlay({ view, sets, entrants, bracketType, fadeMs, }: BracketOverlayProps): import("react").JSX.Element;
//# sourceMappingURL=BracketOverlay.d.ts.map