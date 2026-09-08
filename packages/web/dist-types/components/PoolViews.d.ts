/**
 * Round robin and Swiss renderers.
 *
 * Neither is a tree, so neither uses the bracket canvas: round robin reads as
 * standings plus a head-to-head grid the way start.gg shows a pool, and Swiss as
 * standings plus a column per round.
 */
import { type BracketType, type Entrant, type Id, type TournamentSet } from '@bracket/shared';
export interface PoolViewProps {
    sets: TournamentSet[];
    bracketType: BracketType;
    entrants?: Entrant[];
    onSelectSet?: (set: TournamentSet) => void;
    selectedSetId?: Id | null;
    showSeeds?: boolean;
}
export declare function RoundRobinView({ sets, bracketType, entrants, onSelectSet, selectedSetId, showSeeds, }: PoolViewProps): import("react").JSX.Element;
export declare function SwissView({ sets, bracketType, entrants, onSelectSet, selectedSetId, showSeeds, }: PoolViewProps): import("react").JSX.Element;
/** Fallback for bracket types with no bespoke renderer (exhibition, matchmaking). */
export declare function MatchListView({ sets, onSelectSet, selectedSetId }: PoolViewProps): import("react").JSX.Element;
//# sourceMappingURL=PoolViews.d.ts.map