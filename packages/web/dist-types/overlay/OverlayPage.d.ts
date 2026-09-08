/**
 * Overlay host.
 *
 * This is what an OBS browser source or a venue TV loads. It authenticates with
 * the view's secret, renders from a snapshot immediately (so the first paint is
 * correct rather than empty), then stays live over the socket.
 *
 * Deliberately unopinionated about chrome: no headers, no controls, no
 * background. Whatever the theme draws is all that appears.
 */
export declare function OverlayPage(): import("react").JSX.Element;
//# sourceMappingURL=OverlayPage.d.ts.map