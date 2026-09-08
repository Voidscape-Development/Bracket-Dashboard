/**
 * Applies a theme.
 *
 * Tokens become inline custom properties on a wrapper element, and the user's
 * raw CSS is injected in a <style> scoped to that wrapper's id. Scoping matters:
 * an overlay's custom CSS must not leak into the dashboard chrome when both are
 * on screen in the theme editor's preview.
 */

import { themeToCssVariables, type Theme } from '@bracket/shared';
import { useId, type CSSProperties, type ReactNode } from 'react';

export interface ThemeStyleProps {
  theme: Theme | null | undefined;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Overlays paint no background of their own so OBS composites cleanly. */
  transparent?: boolean;
}

export function ThemeStyle({
  theme,
  children,
  className,
  style,
  transparent,
}: ThemeStyleProps) {
  const generatedId = useId().replace(/:/g, '');
  const scopeId = `bd-scope-${generatedId}`;

  const vars = theme ? themeToCssVariables(theme.tokens) : {};
  const inline: CSSProperties = {
    ...(vars as CSSProperties),
    ...(transparent ? { background: 'var(--bd-overlay-background, transparent)' } : {}),
    ...style,
  };

  // Prefix each top-level rule with the scope id so custom CSS stays contained.
  const scopedCss = theme?.customCss ? scopeCss(theme.customCss, `#${scopeId}`) : '';

  return (
    <div id={scopeId} className={className} style={inline}>
      {scopedCss && <style dangerouslySetInnerHTML={{ __html: scopedCss }} />}
      {children}
    </div>
  );
}

/**
 * Naive but predictable scoping: prefix selectors, leave at-rules' inner blocks
 * alone. Good enough for the styling users actually write here, and it never
 * silently drops a rule.
 */
function scopeCss(css: string, scope: string): string {
  const out: string[] = [];
  let index = 0;

  while (index < css.length) {
    const braceStart = css.indexOf('{', index);
    if (braceStart === -1) break;

    const selector = css.slice(index, braceStart).trim();

    // Find the matching close brace, accounting for nesting inside at-rules.
    let depth = 0;
    let cursor = braceStart;
    for (; cursor < css.length; cursor++) {
      if (css[cursor] === '{') depth += 1;
      else if (css[cursor] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = css.slice(braceStart + 1, cursor);

    if (selector.startsWith('@')) {
      // Media/supports/keyframes: scope what is inside, keep the wrapper.
      const inner = /keyframes/i.test(selector) ? body : scopeCss(body, scope);
      out.push(`${selector} {${inner}}`);
    } else {
      const scoped = selector
        .split(',')
        .map((part) => {
          const trimmed = part.trim();
          if (!trimmed) return '';
          if (trimmed === ':root' || trimmed === 'html' || trimmed === 'body') return scope;
          return `${scope} ${trimmed}`;
        })
        .filter(Boolean)
        .join(', ');
      out.push(`${scoped} {${body}}`);
    }
    index = cursor + 1;
  }

  return out.join('\n');
}
