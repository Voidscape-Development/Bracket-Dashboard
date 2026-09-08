/**
 * Theme editor.
 *
 * Visual controls for every token, a raw CSS box for anything the controls do
 * not cover, and a live preview on a checkerboard so transparency is visible —
 * the same thing OBS will composite against.
 */

import {
  DEFAULT_THEME_TOKENS,
  defaultConfigFor,
  hasPermission,
  type BracketViewConfig,
  type Theme,
  type ThemeTokens,
} from '@bracket/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '../api.js';
import { BracketCanvas } from '../components/BracketCanvas.js';
import { ThemeStyle } from '../components/ThemeStyle.js';
import { useAppStore } from '../store.js';
import { previewSets } from '../previewData.js';

type TokenKey = keyof ThemeTokens;

const COLOR_TOKENS: [TokenKey, string][] = [
  ['bgSurface', 'Match background'],
  ['bgSurfaceAlt', 'Second slot background'],
  ['textPrimary', 'Primary text'],
  ['textSecondary', 'Secondary text'],
  ['textMuted', 'Muted text'],
  ['accent', 'Accent'],
  ['winner', 'Winner'],
  ['loser', 'Loser'],
  ['live', 'Live indicator'],
  ['border', 'Border'],
  ['pending', 'Badge background'],
  ['connectorColor', 'Connector'],
  ['connectorLoserColor', 'Losers connector'],
];

const TEXT_TOKENS: [TokenKey, string, string][] = [
  ['fontFamily', 'Font family', "'Inter', system-ui, sans-serif"],
  ['fontSizeBase', 'Base text size', '15px'],
  ['fontSizeScore', 'Score size', '17px'],
  ['fontSizeRoundLabel', 'Round label size', '12px'],
  ['fontWeightName', 'Name weight', '600'],
  ['radius', 'Corner radius', '6px'],
  ['borderWidth', 'Border width', '1px'],
  ['matchPadding', 'Match padding', '8px'],
  ['slotGap', 'Gap between slots', '2px'],
  ['shadow', 'Shadow', '0 2px 10px rgba(0,0,0,0.35)'],
  ['connectorWidth', 'Connector width', '2px'],
  ['overlayBackground', 'Overlay background', 'transparent'],
  ['cameraDurationMs', 'Camera animation (ms)', '650'],
];

export function ThemesPage() {
  const themes = useAppStore((s) => s.themes);
  const setThemes = useAppStore((s) => s.setThemes);
  const user = useAppStore((s) => s.user);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Theme | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await api.themes();
      setThemes(result.themes);
      setSelectedId((current) => current ?? result.themes[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load themes');
    }
  }, [setThemes]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = themes.find((t) => t.id === selectedId) ?? null;

  useEffect(() => {
    setDraft(selected ? structuredClone(selected) : null);
    setSaved(false);
  }, [selected]);

  const canManage = hasPermission(user, 'theme:manage');
  const config = useMemo(() => defaultConfigFor('bracket') as BracketViewConfig, []);

  const setToken = (key: TokenKey, value: string) => {
    setDraft((current) =>
      current ? { ...current, tokens: { ...current.tokens, [key]: value } } : current,
    );
    setSaved(false);
  };

  const save = async () => {
    if (!draft) return;
    setError(null);
    try {
      await api.updateTheme(draft.id, {
        name: draft.name,
        tokens: draft.tokens,
        customCss: draft.customCss,
      });
      setSaved(true);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save theme');
    }
  };

  const exportTheme = () => {
    if (!draft) return;
    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${draft.name.replace(/\s+/g, '-').toLowerCase()}.theme.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importTheme = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as Partial<Theme>;
      await api.createTheme({
        name: parsed.name ?? 'Imported theme',
        tokens: { ...DEFAULT_THEME_TOKENS, ...(parsed.tokens ?? {}) },
        customCss: parsed.customCss ?? '',
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? `Import failed: ${err.message}` : 'Import failed');
    }
  };

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Themes</h1>
          <p className="page__subtitle">
            Style your overlays. Built-in themes are read-only — duplicate one to make it
            yours.
          </p>
        </div>
        <div className="row row--tight">
          <label className="btn btn--sm">
            Import
            <input
              type="file"
              accept="application/json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importTheme(file);
              }}
            />
          </label>
          <button className="btn btn--sm" onClick={exportTheme} disabled={!draft}>
            Export
          </button>
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {saved && <div className="alert alert--success">Theme saved. Live overlays updated.</div>}

      <div className="row" style={{ marginBottom: 16 }}>
        <select
          className="select"
          style={{ width: 'auto', minWidth: 220 }}
          value={selectedId ?? ''}
          onChange={(e) => setSelectedId(e.target.value)}
        >
          {themes.map((theme) => (
            <option key={theme.id} value={theme.id}>
              {theme.name}
              {theme.builtIn ? ' (built in)' : ''}
            </option>
          ))}
        </select>

        {canManage && selected && (
          <>
            <button
              className="btn btn--sm"
              onClick={() =>
                void api.duplicateTheme(selected.id).then(async (result) => {
                  await refresh();
                  setSelectedId(result.theme.id);
                })
              }
            >
              Duplicate
            </button>
            {!selected.builtIn && (
              <button
                className="btn btn--sm btn--danger btn--ghost"
                onClick={() => {
                  if (window.confirm(`Delete "${selected.name}"?`)) {
                    void api.deleteTheme(selected.id).then(async () => {
                      setSelectedId(null);
                      await refresh();
                    });
                  }
                }}
              >
                Delete
              </button>
            )}
          </>
        )}
      </div>

      {draft && (
        <>
          <div className="panel">
            <h2 className="panel__title">Preview</h2>
            <div className="preview-frame">
              <ThemeStyle theme={draft} transparent style={{ width: '100%', height: '100%' }}>
                <BracketCanvas
                  sets={previewSets}
                  bracketType="DOUBLE_ELIMINATION"
                  config={config}
                  interactive
                />
              </ThemeStyle>
            </div>
          </div>

          {draft.builtIn && (
            <div className="alert alert--info" style={{ marginTop: 16 }}>
              This is a built-in theme. Changes here are preview-only — duplicate it to save
              edits.
            </div>
          )}

          <div className="panel">
            <h2 className="panel__title">Name</h2>
            <input
              className="input"
              value={draft.name}
              disabled={draft.builtIn}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>

          <div className="panel">
            <h2 className="panel__title">Colours</h2>
            <div className="swatch-grid">
              {COLOR_TOKENS.map(([key, label]) => (
                <label key={key} className="swatch">
                  <input
                    type="color"
                    value={toHexColor(draft.tokens[key])}
                    disabled={draft.builtIn}
                    onChange={(e) => setToken(key, e.target.value)}
                  />
                  <span className="swatch__label">{label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="panel">
            <h2 className="panel__title">Type and shape</h2>
            <div className="grid">
              {TEXT_TOKENS.map(([key, label, placeholder]) => (
                <div key={key} className="field">
                  <label className="field__label">{label}</label>
                  <input
                    className="input"
                    value={String(draft.tokens[key])}
                    placeholder={placeholder}
                    disabled={draft.builtIn}
                    onChange={(e) => setToken(key, e.target.value)}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <h2 className="panel__title">Custom CSS</h2>
            <p className="field__hint" style={{ marginBottom: 8 }}>
              Applied on top of the tokens and scoped to this overlay. Target{' '}
              <code className="mono">.bd-match</code>, <code className="mono">.bd-slot</code>,{' '}
              <code className="mono">.bd-connector</code>,{' '}
              <code className="mono">.bd-round-label</code> and the rest of the{' '}
              <code className="mono">.bd-*</code> classes.
            </p>
            <textarea
              className="textarea"
              value={draft.customCss}
              disabled={draft.builtIn}
              spellCheck={false}
              placeholder={'.bd-match {\n  border-left: 3px solid var(--bd-accent);\n}'}
              onChange={(e) => setDraft({ ...draft, customCss: e.target.value })}
            />
          </div>

          {canManage && !draft.builtIn && (
            <button className="btn btn--primary" onClick={() => void save()}>
              Save theme
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * <input type="color"> only accepts #rrggbb. Non-hex values (rgba, transparent,
 * color-mix) fall back to black in the picker but are preserved in the token
 * until the user actually changes them.
 */
function toHexColor(value: string | number): string {
  const text = String(value).trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) return text;
  if (/^#[0-9a-f]{3}$/i.test(text)) {
    const [r, g, b] = [text[1], text[2], text[3]];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return '#000000';
}
