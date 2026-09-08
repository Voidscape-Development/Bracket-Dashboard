/**
 * Match scorecard — the lower third.
 *
 * By default it follows the view's camera, so punching in on a match in the
 * director panel also swings the scorecard to that match. Pinning a set id
 * overrides that for a fixed shot.
 */
import { type OutputView, type TournamentSet } from '@bracket/shared';
export interface ScorecardOverlayProps {
    view: OutputView;
    sets: TournamentSet[];
}
export declare function ScorecardOverlay({ view, sets }: ScorecardOverlayProps): import("react").JSX.Element;
//# sourceMappingURL=ScorecardOverlay.d.ts.map