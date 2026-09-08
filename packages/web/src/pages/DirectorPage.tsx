/**
 * Director panel.
 *
 * Left: the shot list and auto-follow controls. Right: a live preview rendered
 * with the same component the overlay uses, so what the operator lines up here
 * is exactly what goes out. Camera changes go over the socket for immediacy and
 * are persisted server-side, so a browser source that reloads comes back framed
 * the same way.
 */

import {
  ActivityState,
  layoutElimination,
  type AutoFollowRule,
  type BracketViewConfig,
  type CameraMode,
  type Id,
  type OutputView,
  type TournamentSet,
} from '@bracket/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api } from '../api.js';
import { BracketCanvas } from '../components/BracketCanvas.js';
import { ThemeStyle } from '../components/ThemeStyle.js';
import { liveSocket, useAppStore } from '../store.js';

export function DirectorPage() {
  const { viewId } = useParams<{ viewId: string }>();
  const views = useAppStore((s) => s.views);
  const themes = useAppStore((s) => s.themes);
  const setViews = useAppStore((s) => s.setViews);
  const setThemes = useAppStore((s) => s.setThemes);
  const upsertView = useAppStore((s) => s.upsertView);
  const loadEvent = useAppStore((s) => s.loadEvent);

  const view = views.find((v) => v.id === viewId) ?? null;
  const setsMap = useAppStore((s) => (view?.eventId ? s.setsByEvent[view.eventId] : undefined));
  const entrants = useAppStore((s) => (view?.eventId ? s.entrantsByEvent[view.eventId] : undefined));

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [viewResult, themeResult] = await Promise.all([api.views(), api.themes()]);
        setViews(viewResult.views, viewResult.viewers);
        setThemes(themeResult.themes);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load output');
      }
    })();
  }, [setViews, setThemes]);

  useEffect(() => {
    if (!view?.eventId) return;
    void api
      .event(view.eventId)
      .then(loadEvent)
      .catch(() => setError('Could not load the event for this output'));
  }, [view?.eventId, loadEvent]);

  const sets = useMemo(() => {
    const all = Object.values(setsMap ?? {});
    if (!view?.phaseGroupId) return all;
    const scoped = all.filter((s) => s.phaseGroupId === view.phaseGroupId);
    return scoped.length > 0 ? scoped : all;
  }, [setsMap, view?.phaseGroupId]);

  const theme = themes.find((t) => t.id === view?.themeId) ?? themes[0] ?? null;

  const setCamera = useCallback(
    (patch: Parameters<typeof api.setCamera>[1]) => {
      if (!view) return;
      // Optimistic so the preview moves with the click; the server echoes back.
      upsertView({ ...view, camera: { ...view.camera, ...patch } });
      liveSocket.setCamera(view.id, patch, true);
      void api.setCamera(view.id, patch).catch(() => undefined);
    },
    [view, upsertView],
  );

  if (error) {
    return (
      <div className="page">
        <div className="alert alert--error">{error}</div>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="page">
        <p className="muted">Loading output…</p>
      </div>
    );
  }

  const config = view.config as BracketViewConfig;
  const isBracket = view.kind === 'bracket';

  return (
    <div className="page page--wide">
      <div className="event-toolbar">
        <Link to="/views" className="btn btn--sm btn--ghost">
          ← Outputs
        </Link>
        <strong>{view.name}</strong>
        <span className="tag">{view.kind}</span>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>
          {view.camera.mode === 'fit'
            ? 'Framed on the whole bracket'
            : `Shot: ${view.camera.mode}`}
        </span>
      </div>

      <div className="director">
        <div className="director__panel">
          {!isBracket && (
            <div className="alert alert--info">
              Camera controls apply to bracket outputs. This output type renders a fixed
              layout.
            </div>
          )}

          <h3 className="panel__title">Camera</h3>
          <div className="row row--tight" style={{ marginBottom: 12 }}>
            {(
              [
                ['fit', 'Whole bracket'],
                ['match', 'One match'],
                ['progression', 'Match + next'],
                ['column', 'One round'],
              ] as [CameraMode, string][]
            ).map(([mode, label]) => (
              <button
                key={mode}
                className={`btn btn--sm ${view.camera.mode === mode ? 'btn--primary' : ''}`}
                onClick={() => setCamera({ mode })}
                disabled={
                  (mode === 'match' || mode === 'progression') && !view.camera.targetSetId
                }
              >
                {label}
              </button>
            ))}
          </div>

          {view.camera.mode === 'progression' && (
            <div className="field">
              <label className="field__label">
                Rounds ahead: {view.camera.progressionDepth}
              </label>
              <input
                type="range"
                min={0}
                max={4}
                value={view.camera.progressionDepth}
                onChange={(e) => setCamera({ progressionDepth: Number(e.target.value) })}
              />
              <span className="field__hint">
                How far forward to reveal, so viewers can see where the winner goes.
              </span>
            </div>
          )}

          <label className="checkbox">
            <input
              type="checkbox"
              checked={view.camera.animate}
              onChange={(e) => setCamera({ animate: e.target.checked })}
            />
            Animate between shots
          </label>

          <AutoFollowControls view={view} sets={sets} onChanged={upsertView} />

          <h3 className="panel__title" style={{ marginTop: 18 }}>
            Shots
          </h3>
          <ShotList
            sets={sets}
            activeSetId={view.camera.targetSetId}
            onPick={(setId) =>
              setCamera({
                mode: view.camera.mode === 'column' ? 'match' : view.camera.mode === 'fit' ? 'progression' : view.camera.mode,
                targetSetId: setId,
              })
            }
          />

          <h3 className="panel__title" style={{ marginTop: 18 }}>
            Rounds
          </h3>
          <ColumnList
            sets={sets}
            activeColumnId={view.camera.targetColumnId}
            onPick={(columnId) => setCamera({ mode: 'column', targetColumnId: columnId })}
          />
        </div>

        <div className="director__stage">
          <ThemeStyle theme={theme} transparent style={{ width: '100%', height: '100%' }}>
            {isBracket ? (
              <BracketCanvas
                sets={sets}
                bracketType="DOUBLE_ELIMINATION"
                entrants={entrants ?? []}
                config={config}
                camera={view.camera}
                selectedSetId={view.camera.targetSetId}
                onSelectSet={(set) =>
                  setCamera({
                    mode: view.camera.mode === 'fit' ? 'progression' : view.camera.mode,
                    targetSetId: set.id,
                  })
                }
              />
            ) : (
              <div className="overlay-message">
                Preview this output by opening its URL from the Outputs page.
              </div>
            )}
          </ThemeStyle>
        </div>
      </div>
    </div>
  );
}

function AutoFollowControls({
  view,
  sets,
  onChanged,
}: {
  view: OutputView;
  sets: TournamentSet[];
  onChanged: (view: OutputView) => void;
}) {
  const update = (patch: Partial<OutputView['autoFollow']>) => {
    onChanged({ ...view, autoFollow: { ...view.autoFollow, ...patch } });
    void api.setAutoFollow(view.id, patch).catch(() => undefined);
  };

  const entrants = useMemo(() => {
    const map = new Map<Id, string>();
    for (const set of sets) {
      for (const slot of set.slots) {
        if (slot.entrantId && slot.entrantName) map.set(slot.entrantId, slot.entrantName);
      }
    }
    return [...map.entries()];
  }, [sets]);

  const streams = useMemo(
    () => [...new Set(sets.map((s) => s.streamName).filter((s): s is string => !!s))],
    [sets],
  );

  return (
    <>
      <h3 className="panel__title" style={{ marginTop: 18 }}>
        Auto-follow
      </h3>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={view.autoFollow.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
        />
        Move the camera automatically
      </label>
      <p className="field__hint" style={{ marginTop: 0 }}>
        Use this for an unattended display. Taking manual control pauses it for{' '}
        {Math.round(view.autoFollow.resumeAfterManualMs / 1000)}s.
      </p>

      {view.autoFollow.enabled && (
        <>
          <div className="field">
            <label className="field__label">Follow</label>
            <select
              className="select"
              value={view.autoFollow.rule}
              onChange={(e) => update({ rule: e.target.value as AutoFollowRule })}
            >
              <option value="live">The set that just started</option>
              <option value="deepest">The furthest-along live set</option>
              <option value="rotate">Rotate through live sets</option>
              <option value="entrant">A specific entrant</option>
              <option value="stream">Whatever is on a stream</option>
            </select>
          </div>

          {view.autoFollow.rule === 'entrant' && (
            <div className="field">
              <label className="field__label">Entrant</label>
              <select
                className="select"
                value={view.autoFollow.entrantId ?? ''}
                onChange={(e) => update({ entrantId: e.target.value || null })}
              >
                <option value="">Choose…</option>
                {entrants.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {view.autoFollow.rule === 'stream' && (
            <div className="field">
              <label className="field__label">Stream</label>
              <select
                className="select"
                value={view.autoFollow.streamName ?? ''}
                onChange={(e) => update({ streamName: e.target.value || null })}
              >
                <option value="">Choose…</option>
                {streams.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {view.autoFollow.rule === 'rotate' && (
            <div className="field">
              <label className="field__label">
                Seconds per shot: {Math.round(view.autoFollow.rotateIntervalMs / 1000)}
              </label>
              <input
                type="range"
                min={4}
                max={60}
                value={Math.round(view.autoFollow.rotateIntervalMs / 1000)}
                onChange={(e) => update({ rotateIntervalMs: Number(e.target.value) * 1000 })}
              />
            </div>
          )}

          <div className="field">
            <label className="field__label">Shot type</label>
            <select
              className="select"
              value={view.autoFollow.shot}
              onChange={(e) =>
                update({ shot: e.target.value as OutputView['autoFollow']['shot'] })
              }
            >
              <option value="match">Just the match</option>
              <option value="progression">Match and where it leads</option>
              <option value="column">The whole round</option>
            </select>
          </div>
        </>
      )}
    </>
  );
}

function ShotList({
  sets,
  activeSetId,
  onPick,
}: {
  sets: TournamentSet[];
  activeSetId: Id | null;
  onPick: (setId: Id) => void;
}) {
  const ordered = useMemo(
    () =>
      sets
        .slice()
        .sort(
          (a, b) =>
            Number(b.state === ActivityState.Active) - Number(a.state === ActivityState.Active) ||
            Math.abs(a.round) - Math.abs(b.round),
        )
        .slice(0, 60),
    [sets],
  );

  return (
    <div className="director__shot-list">
      {ordered.map((set) => {
        const names = set.slots
          .map((s) => s.entrantName ?? s.placeholderText ?? 'TBD')
          .join(' vs ');
        const live = set.state === ActivityState.Active || set.state === ActivityState.Called;
        return (
          <button
            key={set.id}
            className={`shot-btn ${activeSetId === set.id ? 'shot-btn--active' : ''}`}
            onClick={() => onPick(set.id)}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {names}
            </span>
            {live ? (
              <span className="tag tag--live">Live</span>
            ) : set.state === ActivityState.Completed ? (
              <span className="tag tag--done">Done</span>
            ) : (
              <span className="tag">{set.fullRoundText?.slice(0, 14)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function ColumnList({
  sets,
  activeColumnId,
  onPick,
}: {
  sets: TournamentSet[];
  activeColumnId: string | null;
  onPick: (columnId: string) => void;
}) {
  const layout = useMemo(
    () => layoutElimination({ sets, bracketType: 'DOUBLE_ELIMINATION' }),
    [sets],
  );

  return (
    <div className="director__shot-list">
      {layout.columns.map((column) => (
        <button
          key={column.id}
          className={`shot-btn ${activeColumnId === column.id ? 'shot-btn--active' : ''}`}
          onClick={() => onPick(column.id)}
        >
          <span>{column.label}</span>
          <span className="tag">{column.setIds.length}</span>
        </button>
      ))}
    </div>
  );
}
