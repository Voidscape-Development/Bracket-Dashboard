/**
 * App shell and routing.
 *
 * Overlay routes are deliberately outside the authenticated shell: they load
 * before any session check, render no chrome, and paint no background, because
 * they exist to be pointed at by an OBS browser source or a TV in a corner.
 */
export declare function App(): import("react").JSX.Element;
//# sourceMappingURL=App.d.ts.map