/**
 * Output views — creating the URLs that go into OBS or onto a venue TV.
 */

import {
  VIEW_KINDS,
  hasPermission,
  overlayPath,
  type Id,
  type OutputView,
  type ViewKind,
} from '@bracket/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api.js';
import { useAppStore } from '../store.js';

const KIND_LABELS: Record<ViewKind, string> = {
  bracket: 'Bracket',
  ondeck: 'Upcoming matches',
  standings: 'Standings / Top 8',
  scorecard: 'Match scorecard',
};

const KIND_HINTS: Record<ViewKind, string> = {
  bracket: 'Full bracket with zoom and punch-in. The main stream and TV display.',
  ondeck: 'A queue of what is playing next, optionally filtered to one setup or stream.',
  standings: 'Live placements that fill in as the bracket resolves.',
  scorecard: 'Single-match lower third with names, seeds and score.',
};

export function ViewsPage() {
  const views = useAppStore((s) => s.views);
  const viewers = useAppStore((s) => s.viewers);
  const themes = useAppStore((s) => s.themes);
  const tournaments = useAppStore((s) => s.tournaments);
  const setViews = useAppStore((s) => s.setViews);
  const setThemes = useAppStore((s) => s.setThemes);
  const setTournaments = useAppStore((s) => s.setTournaments);
  const user = useAppStore((s) => s.user);

  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [viewResult, themeResult, tournamentResult] = await Promise.all([
        api.views(),
        api.themes(),
        api.tournaments(),
      ]);
      setViews(viewResult.views, viewResult.viewers);
      setThemes(themeResult.themes);
      setTournaments(tournamentResult.tournaments, tournamentResult.statuses);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load outputs');
    }
  }, [setViews, setThemes, setTournaments]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const canManage = hasPermission(user, 'view:manage');

  const events = tournaments.flatMap((t) =>
    t.events.map((e) => ({ id: e.id, label: `${t.name} — ${e.name}`, event: e })),
  );

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Outputs</h1>
          <p className="page__subtitle">
            Each output has its own URL, theme and camera. Add the URL as a Browser
            Source in OBS, or just open it on a TV.
          </p>
        </div>
        {canManage && (
          <button className="btn btn--primary" onClick={() => setCreating((v) => !v)}>
            {creating ? 'Cancel' : 'New output'}
          </button>
        )}
      </div>

      {error && <div className="alert alert--error">{error}</div>}

      {creating && (
        <CreateViewForm
          events={events}
          themes={themes}
          onCreated={() => {
            setCreating(false);
            void refresh();
          }}
        />
      )}

      {views.length === 0 ? (
        <div className="panel">
          <p className="muted" style={{ margin: 0 }}>
            No outputs yet. Create one to get a URL you can drop into OBS.
          </p>
        </div>
      ) : (
        <div className="grid">
          {views.map((view) => (
            <ViewCard
              key={view.id}
              view={view}
              viewerCount={viewers[view.id] ?? 0}
              events={events}
              canManage={canManage}
              onChanged={refresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CreateViewForm({
  events,
  themes,
  onCreated,
}: {
  events: { id: Id; label: string; event: { phases: { name: string; groups: { id: Id; displayIdentifier: string }[] }[] } }[];
  themes: { id: string; name: string }[];
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ViewKind>('bracket');
  const [eventId, setEventId] = useState<Id | ''>(events[0]?.id ?? '');
  const [groupId, setGroupId] = useState<Id | ''>('');
  const [themeId, setThemeId] = useState(themes[0]?.id ?? 'startgg-dark');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = events.find((e) => e.id === eventId);
  const groups = selected?.event.phases.flatMap((p) =>
    p.groups.map((g) => ({ id: g.id, label: `${p.name} — ${g.displayIdentifier}` })),
  ) ?? [];

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createView({
        name: name.trim() || KIND_LABELS[kind],
        kind,
        eventId: eventId || null,
        phaseGroupId: groupId || null,
        themeId,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create output');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2 className="panel__title">New output</h2>
      {error && <div className="alert alert--error">{error}</div>}

      <div className="field">
        <label className="field__label">Name</label>
        <input
          className="input"
          value={name}
          placeholder="Main stream bracket"
          onChange={(e) => setName(e.target.value)}
        />
        <span className="field__hint">
          Give the stream overlay and the lobby TV different names — they are separate
          outputs and can be aimed independently.
        </span>
      </div>

      <div className="field">
        <label className="field__label">Type</label>
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value as ViewKind)}>
          {VIEW_KINDS.map((value) => (
            <option key={value} value={value}>
              {KIND_LABELS[value]}
            </option>
          ))}
        </select>
        <span className="field__hint">{KIND_HINTS[kind]}</span>
      </div>

      <div className="field">
        <label className="field__label">Event</label>
        <select
          className="select"
          value={eventId}
          onChange={(e) => {
            setEventId(e.target.value);
            setGroupId('');
          }}
        >
          <option value="">Choose an event…</option>
          {events.map((event) => (
            <option key={event.id} value={event.id}>
              {event.label}
            </option>
          ))}
        </select>
      </div>

      {groups.length > 1 && (
        <div className="field">
          <label className="field__label">Bracket (optional)</label>
          <select className="select" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">All brackets in the event</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="field">
        <label className="field__label">Theme</label>
        <select className="select" value={themeId} onChange={(e) => setThemeId(e.target.value)}>
          {themes.map((theme) => (
            <option key={theme.id} value={theme.id}>
              {theme.name}
            </option>
          ))}
        </select>
      </div>

      <button className="btn btn--primary" disabled={busy} onClick={() => void submit()}>
        {busy ? 'Creating…' : 'Create output'}
      </button>
    </div>
  );
}

function ViewCard({
  view,
  viewerCount,
  events,
  canManage,
  onChanged,
}: {
  view: OutputView;
  viewerCount: number;
  events: { id: Id; label: string }[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}${overlayPath(view)}`;
  const eventLabel = events.find((e) => e.id === view.eventId)?.label ?? 'No event selected';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard can be blocked; the URL is visible and selectable anyway.
      window.prompt('Copy this URL', url);
    }
  };

  return (
    <div className="panel">
      <div className="row row--tight" style={{ marginBottom: 6 }}>
        <strong>{view.name}</strong>
        <span className="tag">{KIND_LABELS[view.kind]}</span>
        {viewerCount > 0 && <span className="tag tag--live">{viewerCount} connected</span>}
        {view.autoFollow.enabled && <span className="tag">Auto-follow</span>}
      </div>

      <p className="muted" style={{ fontSize: 12, margin: '0 0 10px' }}>
        {eventLabel}
      </p>

      <div className="url-box" style={{ marginBottom: 10 }}>
        <span className="url-box__text">{url}</span>
        <button className="btn btn--sm btn--ghost" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className="row row--tight">
        <Link className="btn btn--sm btn--primary" to={`/views/${view.id}/director`}>
          Direct
        </Link>
        <a className="btn btn--sm" href={url} target="_blank" rel="noreferrer">
          Open
        </a>
        {canManage && (
          <>
            <button
              className="btn btn--sm"
              onClick={() => void api.duplicateView(view.id).then(onChanged)}
              title="Create a second output with the same source but its own camera and theme"
            >
              Duplicate
            </button>
            <button
              className="btn btn--sm btn--ghost"
              onClick={() => {
                if (
                  window.confirm(
                    'Generate a new URL for this output? Anywhere the old URL is in use — OBS, a TV — will stop working until updated.',
                  )
                ) {
                  void api.rotateViewSecret(view.id).then(onChanged);
                }
              }}
            >
              New URL
            </button>
            <button
              className="btn btn--sm btn--danger btn--ghost"
              onClick={() => {
                if (window.confirm(`Delete "${view.name}"?`)) {
                  void api.deleteView(view.id).then(onChanged);
                }
              }}
            >
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}
