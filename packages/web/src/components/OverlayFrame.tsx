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

export function OverlayFrame({ showFrame, showTitle, title, children }: OverlayFrameProps) {
  const trimmed = title.trim();
  const withTitle = showTitle && trimmed.length > 0;

  if (!showFrame && !withTitle) {
    return <div className="ov-frame ov-frame--bare">{children}</div>;
  }

  const [lead, ...rest] = trimmed.split('|');
  const tail = rest.join('|').trim();

  return (
    <div className="ov-frame">
      {withTitle && (
        <div className="ov-frame__title">
          <span className="ov-frame__title-lead">{lead?.trim()}</span>
          {tail && (
            <>
              <span className="ov-frame__title-sep">|</span>
              <span className="ov-frame__title-rest">{tail}</span>
            </>
          )}
        </div>
      )}
      <div className={showFrame ? 'ov-frame__panel' : 'ov-frame__panel ov-frame__panel--bare'}>
        {children}
      </div>
    </div>
  );
}
