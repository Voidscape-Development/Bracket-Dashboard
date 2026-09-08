/**
 * Applies a theme.
 *
 * Tokens become inline custom properties on a wrapper element, and the user's
 * raw CSS is injected in a <style> scoped to that wrapper's id. Scoping matters:
 * an overlay's custom CSS must not leak into the dashboard chrome when both are
 * on screen in the theme editor's preview.
 */
import { type Theme } from '@bracket/shared';
import { type CSSProperties, type ReactNode } from 'react';
export interface ThemeStyleProps {
    theme: Theme | null | undefined;
    children: ReactNode;
    className?: string;
    style?: CSSProperties;
    /** Overlays paint no background of their own so OBS composites cleanly. */
    transparent?: boolean;
}
export declare function ThemeStyle({ theme, children, className, style, transparent, }: ThemeStyleProps): import("react").JSX.Element;
//# sourceMappingURL=ThemeStyle.d.ts.map