/**
 * The fixed frame an overlay's content lives inside.
 *
 * A titled bar above a rounded panel, both anchored to the output while the
 * bracket pans and zooms within them. Keeping the chrome still is what makes a
 * moving bracket read as a camera move rather than the whole graphic sliding
 * around.
 *
 * Everything is optional and off by default: a bare bracket on a transparent
 * background is still the right answer for many scenes.
 */
import type { ReactNode } from 'react';
export interface OverlayFrameProps {
    showFrame: boolean;
    showTitle: boolean;
    /** One `|` splits an accented lead-in from the rest of the title. */
    title: string;
    children: ReactNode;
}
export declare function OverlayFrame({ showFrame, showTitle, title, children }: OverlayFrameProps): import("react").JSX.Element;
//# sourceMappingURL=OverlayFrame.d.ts.map