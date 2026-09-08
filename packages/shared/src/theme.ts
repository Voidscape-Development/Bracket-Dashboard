/**
 * Theme model.
 *
 * A theme is a flat bag of design tokens plus an optional raw CSS escape hatch.
 * Tokens are emitted as CSS custom properties on the overlay root, so the visual
 * editor, the presets and hand-written CSS all drive the same variables and a
 * user's custom CSS can override anything the editor exposes.
 */

export interface ThemeTokens {
  // Surfaces
  bgPage: string;
  bgSurface: string;
  bgSurfaceAlt: string;
  bgElevated: string;
  /** Overlays default to fully transparent so OBS composites cleanly. */
  overlayBackground: string;

  // Text
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textOnAccent: string;

  // Accents and state
  accent: string;
  accentAlt: string;
  winner: string;
  loser: string;
  live: string;
  pending: string;
  border: string;

  // Typography
  fontFamily: string;
  fontFamilyDisplay: string;
  fontSizeBase: string;
  fontSizeScore: string;
  fontSizeRoundLabel: string;
  fontWeightName: string;
  letterSpacing: string;
  textTransformRoundLabel: 'none' | 'uppercase' | 'lowercase' | 'capitalize';

  // Shape
  radius: string;
  borderWidth: string;
  slotGap: string;
  matchPadding: string;
  shadow: string;

  // Connectors
  connectorColor: string;
  connectorWidth: string;
  connectorLoserColor: string;
  connectorStyle: 'orthogonal' | 'curved' | 'straight';

  // Motion
  cameraDurationMs: string;
  cameraEasing: string;
  /** Cross-fade length used when cutting between distant shots. */
  fadeDurationMs: string;

  // Frame chrome — the fixed panel and title bar the bracket moves inside.
  frameBackground: string;
  frameBorder: string;
  frameBorderWidth: string;
  frameRadius: string;
  framePadding: string;
  frameShadow: string;
  titleBackground: string;
  titleColor: string;
  titleAccent: string;
  titleFontSize: string;
  titleFontWeight: string;
  titleLetterSpacing: string;
  titleTextTransform: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  titleHeight: string;
  titleGap: string;

  /** Background art painted behind the frame. `none` leaves it transparent. */
  backgroundImage: string;
  backgroundSize: string;
  backgroundPosition: string;
  backgroundOpacity: string;

  // Focus treatment
  /** Opacity applied to matches outside the current shot. */
  dimmedOpacity: string;
  /** Outline colour on the match the camera is centred on. */
  focusAccent: string;
  focusAccentWidth: string;
}

export interface Theme {
  id: string;
  name: string;
  /** Built-in themes cannot be deleted, only duplicated. */
  builtIn: boolean;
  tokens: ThemeTokens;
  customCss: string;
  updatedAt: number;
}

export const DEFAULT_THEME_TOKENS: ThemeTokens = {
  bgPage: '#0d0f14',
  bgSurface: '#161a22',
  bgSurfaceAlt: '#1d222c',
  bgElevated: '#232936',
  overlayBackground: 'transparent',

  textPrimary: '#f2f5fa',
  textSecondary: '#aab4c5',
  textMuted: '#6f7b8f',
  textOnAccent: '#0d0f14',

  accent: '#5b8cff',
  accentAlt: '#b06bff',
  winner: '#3ddc84',
  loser: '#7a8497',
  live: '#ff4d5e',
  pending: '#3a4353',
  border: '#2b3240',

  fontFamily: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
  fontFamilyDisplay: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
  fontSizeBase: '15px',
  fontSizeScore: '17px',
  fontSizeRoundLabel: '12px',
  fontWeightName: '600',
  letterSpacing: '0em',
  textTransformRoundLabel: 'uppercase',

  radius: '6px',
  borderWidth: '1px',
  slotGap: '2px',
  matchPadding: '8px',
  shadow: '0 2px 10px rgba(0,0,0,0.35)',

  connectorColor: '#39424f',
  connectorWidth: '2px',
  connectorLoserColor: '#5a4550',
  connectorStyle: 'orthogonal',

  cameraDurationMs: '650',
  cameraEasing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  fadeDurationMs: '420',

  frameBackground: 'rgba(12, 9, 6, 0.88)',
  frameBorder: 'rgba(255, 255, 255, 0.06)',
  frameBorderWidth: '1px',
  frameRadius: '14px',
  framePadding: '0px',
  frameShadow: '0 18px 60px rgba(0, 0, 0, 0.55)',
  titleBackground: 'rgba(8, 6, 4, 0.95)',
  titleColor: '#ffffff',
  titleAccent: '#f5b32a',
  titleFontSize: '26px',
  titleFontWeight: '800',
  titleLetterSpacing: '0.01em',
  titleTextTransform: 'uppercase',
  titleHeight: '58px',
  titleGap: '10px',

  backgroundImage: 'none',
  backgroundSize: 'cover',
  backgroundPosition: 'center',
  backgroundOpacity: '1',

  dimmedOpacity: '0.16',
  focusAccent: '#f5b32a',
  focusAccentWidth: '2px',
};

/** Ships with the app so a new user has something usable immediately. */
export const BUILT_IN_THEMES: Theme[] = [
  {
    id: 'startgg-dark',
    name: 'start.gg Dark',
    builtIn: true,
    tokens: { ...DEFAULT_THEME_TOKENS },
    customCss: '',
    updatedAt: 0,
  },
  {
    id: 'startgg-light',
    name: 'start.gg Light',
    builtIn: true,
    tokens: {
      ...DEFAULT_THEME_TOKENS,
      bgPage: '#f4f6fa',
      bgSurface: '#ffffff',
      bgSurfaceAlt: '#eef1f6',
      bgElevated: '#ffffff',
      textPrimary: '#12161d',
      textSecondary: '#4a5568',
      textMuted: '#8792a6',
      textOnAccent: '#ffffff',
      border: '#d9dfe9',
      pending: '#e3e8f0',
      loser: '#98a2b3',
      connectorColor: '#c6cedb',
      connectorLoserColor: '#e0c4cc',
      shadow: '0 1px 4px rgba(18,22,29,0.12)',
    },
    customCss: '',
    updatedAt: 0,
  },
  {
    id: 'broadcast-contrast',
    name: 'Broadcast High Contrast',
    builtIn: true,
    tokens: {
      ...DEFAULT_THEME_TOKENS,
      bgSurface: 'rgba(8, 10, 15, 0.92)',
      bgSurfaceAlt: 'rgba(20, 24, 33, 0.92)',
      accent: '#ffd54a',
      textOnAccent: '#0a0c11',
      winner: '#5ef08f',
      live: '#ff2d55',
      fontSizeBase: '17px',
      fontSizeScore: '20px',
      fontWeightName: '700',
      borderWidth: '2px',
      shadow: '0 4px 18px rgba(0,0,0,0.6)',
    },
    customCss: '',
    updatedAt: 0,
  },
  {
    // Modelled on the framed, gold-on-dark broadcast look: a fixed titled panel
    // with the bracket moving inside it and off-shot matches faded back.
    id: 'broadcast-frame',
    name: 'Broadcast Frame',
    builtIn: true,
    tokens: {
      ...DEFAULT_THEME_TOKENS,
      bgSurface: 'rgba(38, 26, 14, 0.92)',
      bgSurfaceAlt: 'rgba(28, 19, 10, 0.92)',
      textPrimary: '#ffffff',
      textSecondary: '#e8d3a8',
      textMuted: '#8a7350',
      accent: '#f5b32a',
      textOnAccent: '#1a1206',
      winner: '#ffd97a',
      loser: '#8a7350',
      live: '#ff6b4a',
      border: 'rgba(245, 179, 42, 0.28)',
      pending: 'rgba(245, 179, 42, 0.15)',
      radius: '4px',
      fontWeightName: '700',
      fontSizeBase: '16px',
      fontSizeScore: '16px',
      fontSizeRoundLabel: '13px',
      slotGap: '1px',
      matchPadding: '9px',
      shadow: 'none',
      connectorColor: 'rgba(245, 179, 42, 0.22)',
      connectorLoserColor: 'rgba(245, 179, 42, 0.12)',
      dimmedOpacity: '0.14',
      focusAccent: '#f5b32a',
    },
    customCss: '',
    updatedAt: 0,
  },
];

const TOKEN_CSS_PREFIX = '--bd-';

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Maps tokens to the CSS custom properties the renderers consume. */
export function themeToCssVariables(tokens: ThemeTokens): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens)) {
    out[`${TOKEN_CSS_PREFIX}${kebab(key)}`] = String(value);
  }
  return out;
}

export function themeToCssText(theme: Theme, selector = ':root'): string {
  const vars = themeToCssVariables(theme.tokens);
  const body = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  return `${selector} {\n${body}\n}\n${theme.customCss ?? ''}`;
}

/** Fills in any token a stored/imported theme is missing after an upgrade. */
export function normalizeTheme(partial: Partial<Theme> & { id: string; name: string }): Theme {
  return {
    id: partial.id,
    name: partial.name,
    builtIn: partial.builtIn ?? false,
    tokens: { ...DEFAULT_THEME_TOKENS, ...(partial.tokens ?? {}) },
    customCss: partial.customCss ?? '',
    updatedAt: partial.updatedAt ?? Date.now(),
  };
}
