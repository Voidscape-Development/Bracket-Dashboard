/**
 * The bracket canvas.
 *
 * Lays out the sets, draws the connectors, and applies a single transform for
 * pan/zoom. Both the dashboard viewer and the OBS bracket overlay render through
 * here, which is what guarantees the shot an operator lines up in the director
 * panel is the shot that appears on stream.
 *
 * Camera handling has two modes. When a `camera` prop is supplied the component
 * is controlled — it resolves that camera against the layout and moves to it.
 * Without one it manages its own pan/zoom for free exploration.
 *
 * Two behaviours exist because a bracket on stream is not a bracket in a browser:
 *
 *  - Punching in *dims* the rest of the bracket rather than cropping it, so a
 *    viewer keeps their bearings instead of seeing matches sliced by the frame.
 *  - Jumping a long way (winners to losers) cuts through a cross-fade instead of
 *    gliding, because a pan across a whole bracket reads as a lurch.
 */
import { type BracketType, type BracketViewConfig, type CameraState, type Entrant, type Id, type TournamentSet } from '@bracket/shared';
export interface BracketCanvasProps {
    sets: TournamentSet[];
    bracketType: BracketType;
    entrants?: Entrant[];
    config: BracketViewConfig;
    /** Supply to drive the camera externally (overlay/director). */
    camera?: CameraState;
    /** Allow the viewer to drag and wheel-zoom. */
    interactive?: boolean;
    selectedSetId?: Id | null;
    onSelectSet?: (set: TournamentSet) => void;
    /** Reports user-driven pan/zoom so a caller can persist it. */
    onManualCamera?: (camera: Pick<CameraState, 'zoom' | 'centerX' | 'centerY'>) => void;
    /** Cross-fade length in ms; matches the theme's fade token. */
    fadeMs?: number;
    className?: string;
}
export declare function BracketCanvas({ sets, bracketType, entrants, config, camera, interactive, selectedSetId, onSelectSet, onManualCamera, fadeMs, className, }: BracketCanvasProps): import("react").JSX.Element;
//# sourceMappingURL=BracketCanvas.d.ts.map