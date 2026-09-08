/**
 * Tournament overview — the "what is going on across every event" screen.
 */

import { ActivityState, hasPermission, type Id, type TournamentEvent } from '@bracket/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { api, ApiError } from '../api.js';
import { useAppStore } from '../store.js';

export function DashboardPage() {
  const tournaments = useAppStore((s) => s.tournaments);
  const statuses = useAppStore((s) => s.statuses);
  const setTournaments = useAppStore((s) => s.setTournaments);
  const user = useAppStore((s) => s.user);

  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.tournaments();
      setTournaments(result.tournaments, result.statuses);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load tournaments');
    }
  }, [setTournaments]);

  useEffect(() => {
    void refresh();
    // Statuses arrive over the socket, but a slow poll keeps counts honest if a
    // message is missed while the tab is backgrounded.
    const timer = window.setInterval(() => void refresh(), 30000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.importTournament(url);
      setNotice(`Imported ${result.tournament.name} — ${result.events} events.`);
      setUrl('');
      await refresh();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Import failed',
      );
    } finally {
      setBusy(false);
    }
  };

  const canImport = hasPermission(user, 'tournament:import');

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Tournaments</h1>
          <p className="page__subtitle">
            Every event you have imported, with live bracket progress.
          </p>
        </div>
        <button className="btn" onClick={() => void api.sync(undefined, true).then(refresh)}>
          Force full resync
        </button>
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--success">{notice}</div>}

      {canImport && (
        <form className="panel" onSubmit={submit}>
          <h2 className="panel__title">Import a tournament</h2>
          <div className="row">
            <input
              className="input"
              style={{ flex: 1, minWidth: 260 }}
              placeholder="https://www.start.gg/tournament/your-tournament"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button className="btn btn--primary" disabled={busy || !url.trim()}>
              {busy ? 'Importing…' : 'Import'}
            </button>
          </div>
          <p className="field__hint" style={{ marginTop: 8 }}>
            Paste any start.gg link for the tournament — the tournament page, an event
            page, or a bracket URL all work.
          </p>
        </form>
      )}

      {tournaments.length === 0 ? (
        <div className="panel" style={{ marginTop: 16 }}>
          <p className="muted" style={{ margin: 0 }}>
            Nothing imported yet. {canImport ? 'Paste a start.gg link above to begin.' : 'Ask an organiser to import a tournament.'}
          </p>
        </div>
      ) : (
        tournaments.map((tournament) => (
          <section key={tournament.id} style={{ marginTop: 24 }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>{tournament.name}</h2>
              {tournament.city && <span className="tag">{tournament.city}</span>}
              <span className="spacer" />
              {canImport && (
                <button
                  className="btn btn--sm btn--danger btn--ghost"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Remove "${tournament.name}" and all its local data? This does not change anything on start.gg.`,
                      )
                    ) {
                      void api.deleteTournament(tournament.id).then(refresh);
                    }
                  }}
                >
                  Remove
                </button>
              )}
            </div>

            <div className="grid">
              {tournament.events.map((event) => (
                <EventCard
                  key={event.id}
                  event={event}
                  status={statuses[event.id]}
                  onRefresh={refresh}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function EventCard({
  event,
  status,
  onRefresh,
}: {
  event: TournamentEvent;
  status: { totalSets: number; completedSets: number; activeSets: number; syncError: string | null } | undefined;
  onRefresh: () => void;
}) {
  const total = status?.totalSets ?? 0;
  const completed = status?.completedSets ?? 0;
  const active = status?.activeSets ?? 0;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const bracketTypes = [...new Set(event.phases.map((p) => p.bracketType))];

  return (
    <Link to={`/events/${event.id}`} className="card-link">
      <div className="row row--tight" style={{ marginBottom: 6 }}>
        <strong style={{ fontSize: 15 }}>{event.name}</strong>
        {event.state === ActivityState.Completed && <span className="tag tag--done">Done</span>}
        {active > 0 && <span className="tag tag--live">{active} live</span>}
      </div>

      <div className="row row--tight" style={{ marginBottom: 10 }}>
        {event.videogameName && <span className="tag">{event.videogameName}</span>}
        {bracketTypes.map((type) => (
          <span key={type} className="tag">
            {formatBracketType(type)}
          </span>
        ))}
        {event.numEntrants !== null && <span className="tag">{event.numEntrants} entrants</span>}
      </div>

      <div className="progress" style={{ marginBottom: 6 }}>
        <div className="progress__fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="row" style={{ fontSize: 12 }}>
        <span className="muted">
          {completed} / {total} sets
        </span>
        <span className="spacer" />
        <button
          className="btn btn--sm btn--ghost"
          onClick={(e) => {
            e.preventDefault();
            void api.sync(event.id).then(onRefresh);
          }}
        >
          Sync
        </button>
      </div>

      {status?.syncError && (
        <div className="alert alert--warn" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
          {status.syncError}
        </div>
      )}
    </Link>
  );
}

export function formatBracketType(type: string): string {
  return type
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export type { Id };
