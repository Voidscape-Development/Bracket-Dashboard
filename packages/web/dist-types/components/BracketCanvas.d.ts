/**
 * The bracket canvas.
 *
 * Lays out the sets, draws the connectors, and applies a single transform for
 * pan/zoom. Both the dashboard viewer and the OBS bracket overlay render through
 * here, which is what guarantees the shot an operator lines up in the director
 * panel is the shot that appears on stream.
 *
 * Camera handling has two modes. When a `camera` prop is supplied the component
 * is controlled — it resolves that camera against the layout and animates to it.
 * Without one it manages its own pan/zoom for free exploration.
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
    className?: string;
}
export declare function BracketCanvas({ sets, bracketType, entrants, config, camera, interactive, selectedSetId, onSelectSet, onManualCamera, className, }: BracketCanvasProps): import("react").JSX.Element;
//# sourceMappingURL=BracketCanvas.d.ts.map