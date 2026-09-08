/**
 * One match, styled to read like a start.gg bracket cell but driven entirely by
 * theme variables so a user can restyle it without touching this file.
 */
import { type TournamentSet } from '@bracket/shared';
export interface MatchCardProps {
    set: TournamentSet;
    showSeeds: boolean;
    showScores: boolean;
    showStation: boolean;
    showStream: boolean;
    dimCompleted: boolean;
    highlightLive: boolean;
    selected?: boolean;
    /** The match the overlay camera is centred on; outlined with the focus accent. */
    cameraTarget?: boolean;
    /** Set id -> short match identifier, for readable "Winner of …" placeholders. */
    feederLabels?: Map<string, string>;
    onClick?: (set: TournamentSet) => void;
}
export declare function MatchCard({ set, showSeeds, showScores, showStation, showStream, dimCompleted, highlightLive, selected, cameraTarget, feederLabels, onClick, }: MatchCardProps): import("react").JSX.Element;
//# sourceMappingURL=MatchCard.d.ts.map