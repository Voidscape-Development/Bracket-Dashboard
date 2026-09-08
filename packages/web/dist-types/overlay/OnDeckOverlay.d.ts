/**
 * Upcoming matches — the venue TV / on-deck ticker.
 *
 * In-progress sets sit above the queue so a player walking past can tell at a
 * glance whether they are up now or next.
 */
import { type OutputView, type TournamentSet } from '@bracket/shared';
export interface OnDeckOverlayProps {
    view: OutputView;
    sets: TournamentSet[];
}
export declare function OnDeckOverlay({ view, sets }: OnDeckOverlayProps): import("react").JSX.Element;
//# sourceMappingURL=OnDeckOverlay.d.ts.map