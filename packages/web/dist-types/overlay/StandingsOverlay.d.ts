/**
 * Standings / top 8 board.
 *
 * start.gg reports provisional placements throughout an event, so `finalOnly`
 * exists for broadcasts that should show a placement only once it is locked.
 */
import type { OutputView, Standing } from '@bracket/shared';
export interface StandingsOverlayProps {
    view: OutputView;
    standings: Standing[];
}
export declare function StandingsOverlay({ view, standings }: StandingsOverlayProps): import("react").JSX.Element;
//# sourceMappingURL=StandingsOverlay.d.ts.map