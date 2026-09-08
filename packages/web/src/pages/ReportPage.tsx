/**
 * Score reporting.
 *
 * Built for the venue: large touch targets, one card per playable set, and no
 * dependence on connectivity — every action queues locally and the banner says
 * plainly whether start.gg has it yet.
 */

import {
  ActivityState,
  hasPermission,
  type GameReport,
  type Id,
  type TournamentSet,
} from '@bracket/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api } from '../api.js';
import { useAppStore } from '../store.js';

type Filter = 'playable' | 'live' | 'all';

export function ReportPage() {
  const { eventId } = useParams<{ eventId: Id }>();
  const loadEvent = useAppStore((s) => s.loadEvent);
  const setsMap = useAppStore((s) => (eventId ? s.setsByEvent[eventId] : undefined));
  const status = useAppStore((s) => s.status);
  const user = useAppStore((s) => s.user);

  const [eventName, setEventName] = useState('');
  const [filter, setFilter] = useState<Filter>('playable');
  const [error, setError] = useState<string | null>(null);
  const [stations, setStations] = useState<{ id: Id; number: number | null }[]>([]);
  const [streams, setStreams] = useState<{ id: Id; name: string }[]>([]);

  const load = useCallback(async () => {
    if (!eventId) return;
    try {
      const result = await api.event(eventId);
      setEventName(result.event.name);
      loadEvent(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load event');
    }
    try {
      const meta = await api.stations(eventId);
      setStations(meta.stations);
      setStreams(meta.streams);
    } catch {
      // Station/stream assignment is optional; the rest of the page still works.
    }
  }, [eventId, loadEvent]);

  useEffect(() => {
    void load();
  }, [load]);

  const sets = useMemo(() => {
    const all = Object.values(setsMap ?? {});
    const playable = (s: TournamentSet) =>
      s.slots.every((slot) => slot.entrantId) && s.state !== ActivityState.Completed;

    const filtered =
      filter === 'all'
        ? all
        : filter === 'live'
          ? all.filter((s) => s.state === ActivityState.Active || s.state === ActivityState.Called)
          : all.filter(playable);

    return filtered.sort(
      (a, b) =>
        Number(b.state === ActivityState.Active) - Number(a.state === ActivityState.Active) ||
        Math.abs(a.round) - Math.abs(b.round) ||
        a.identifier.localeCompare(b.identifier, undefined, { numeric: true }),
    );
  }, [setsMap, filter]);

  if (!hasPermission(user, 'set:report')) {
    return (
      <div className="page">
        <div className="alert alert--warn">
          Your role ({user?.role}) cannot report scores.
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Report — {eventName}</h1>
          <p className="page__subtitle">
            Results are saved here immediately and sent to start.gg as soon as it is
            reachable.
          </p>
        </div>
        <Link className="btn" to={`/events/${eventId}`}>
          View bracket
        </Link>
      </div>

      {!status.online && (
        <div className="alert alert--warn">
          <strong>Offline.</strong> start.gg is not reachable right now. Reports are being
          queued locally and will send automatically when the connection returns.
          {status.queuedCommands > 0 && ` ${status.queuedCommands} waiting.`}
        </div>
      )}
      {status.conflictCount > 0 && (
        <div className="alert alert--error">
          {status.conflictCount} queued report{status.conflictCount === 1 ? '' : 's'} need
          {status.conflictCount === 1 ? 's' : ''} review. <Link to="/queue">Open the queue</Link>.
        </div>
      )}
      {error && <div className="alert alert--error">{error}</div>}

      <div className="row" style={{ marginBottom: 14 }}>
        {(
          [
            ['playable', 'Ready to play'],
            ['live', 'In progress'],
            ['all', 'All sets'],
          ] as [Filter, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            className={`btn btn--sm ${filter === value ? 'btn--primary' : ''}`}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
        <span className="spacer" />
        <span className="muted">{sets.length} sets</span>
      </div>

      <div className="report-list">
        {sets.length === 0 && (
          <div className="panel">
            <p className="muted" style={{ margin: 0 }}>
              Nothing to report in this filter.
            </p>
          </div>
        )}
        {sets.map((set) => (
          <ReportCard
            key={set.id}
            set={set}
            eventId={eventId as Id}
            stations={stations}
            streams={streams}
            canReset={hasPermission(user, 'set:reset')}
            canAssignStream={hasPermission(user, 'set:assignStream')}
          />
        ))}
      </div>
    </div>
  );
}

function ReportCard({
  set,
  eventId,
  stations,
  streams,
  canReset,
  canAssignStream,
}: {
  set: TournamentSet;
  eventId: Id;
  stations: { id: Id; number: number | null }[];
  streams: { id: Id; name: string }[];
  canReset: boolean;
  canAssignStream: boolean;
}) {
  const a = set.slots[0];
  const b = set.slots[1];
  const [scores, setScores] = useState<Record<string, number>>({});
  const [games, setGames] = useState<GameReport[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailed, setDetailed] = useState(false);

  const scoreFor = (entrantId: string | null) =>
    entrantId ? (scores[entrantId] ?? 0) : 0;

  const adjust = (entrantId: string, delta: number) => {
    setScores((current) => ({
      ...current,
      [entrantId]: Math.max(0, Math.min(99, (current[entrantId] ?? 0) + delta)),
    }));
    // Editing the totals directly invalidates a game-by-game log.
    setGames([]);
  };

  /** Game log drives the score, so the two can never disagree. */
  const addGame = (winnerId: string) => {
    const next: GameReport[] = [...games, { gameNum: games.length + 1, winnerId }];
    setGames(next);
    const tally: Record<string, number> = {};
    for (const game of next) tally[game.winnerId] = (tally[game.winnerId] ?? 0) + 1;
    setScores(tally);
  };

  const undoGame = () => {
    const next = games.slice(0, -1);
    setGames(next);
    const tally: Record<string, number> = {};
    for (const game of next) tally[game.winnerId] = (tally[game.winnerId] ?? 0) + 1;
    setScores(tally);
  };

  const submit = async (winnerId: string, isDq = false) => {
    if (!a?.entrantId || !b?.entrantId) return;
    setBusy(true);
    setError(null);
    setMessage(null);

    const loserId = winnerId === a.entrantId ? b.entrantId : a.entrantId;
    const payload = isDq
      ? [
          { entrantId: winnerId, score: 0 },
          // start.gg represents the DQ'd side with -1.
          { entrantId: loserId, score: -1 },
        ]
      : [
          { entrantId: a.entrantId, score: scoreFor(a.entrantId) },
          { entrantId: b.entrantId, score: scoreFor(b.entrantId) },
        ];

    try {
      const result = await api.report({
        kind: 'reportSet',
        setId: set.id,
        eventId,
        winnerId,
        scores: payload,
        ...(games.length > 0 && !isDq ? { games } : {}),
        ...(isDq ? { isDq: true } : {}),
      });
      setMessage(result.online ? 'Reported.' : 'Saved locally — will send when online.');
      setGames([]);
      setScores({});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Report failed');
    } finally {
      setBusy(false);
    }
  };

  const isLive = set.state === ActivityState.Active || set.state === ActivityState.Called;

  return (
    <div className="report-card">
      <div className="report-card__head">
        <strong>{set.fullRoundText || `Set ${set.identifier}`}</strong>
        {isLive && <span className="tag tag--live">Live</span>}
        {set.state === ActivityState.Completed && <span className="tag tag--done">Reported</span>}
        {set.pendingLocal && <span className="tag tag--warn">Queued</span>}
        {set.stationNumber !== null && <span className="tag">Setup {set.stationNumber}</span>}
        <span className="spacer" />
        {!isLive && set.state !== ActivityState.Completed && (
          <button
            className="btn btn--sm"
            disabled={busy}
            onClick={() => void api.markInProgress(set.id, eventId)}
          >
            Start
          </button>
        )}
        {canReset && set.state === ActivityState.Completed && (
          <button
            className="btn btn--sm btn--danger btn--ghost"
            disabled={busy}
            onClick={() => {
              if (window.confirm('Reset this set on start.gg? Any sets it fed will also be affected.')) {
                void api.resetSet(set.id, eventId, true);
              }
            }}
          >
            Reset
          </button>
        )}
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {message && <div className="alert alert--success">{message}</div>}

      {[a, b].map((slot) =>
        slot?.entrantId ? (
          <div key={slot.slotIndex} className="score-row">
            <span className="score-row__name">
              {slot.seed !== null && <span className="muted">#{slot.seed} </span>}
              {slot.entrantName}
            </span>

            {!detailed && (
              <div className="stepper">
                <button
                  className="btn btn--sm"
                  onClick={() => adjust(slot.entrantId as string, -1)}
                  disabled={busy}
                  aria-label={`Decrease score for ${slot.entrantName}`}
                >
                  −
                </button>
                <span className="stepper__value">{scoreFor(slot.entrantId)}</span>
                <button
                  className="btn btn--sm"
                  onClick={() => adjust(slot.entrantId as string, 1)}
                  disabled={busy}
                  aria-label={`Increase score for ${slot.entrantName}`}
                >
                  +
                </button>
              </div>
            )}

            {detailed && (
              <button
                className="btn btn--sm"
                disabled={busy}
                onClick={() => addGame(slot.entrantId as string)}
              >
                Won game {games.length + 1}
              </button>
            )}

            <button
              className="btn btn--sm btn--primary"
              disabled={busy}
              onClick={() => void submit(slot.entrantId as string)}
            >
              Wins set
            </button>
          </div>
        ) : (
          <div key={slot?.slotIndex ?? Math.random()} className="score-row">
            <span className="score-row__name muted">
              {slot?.placeholderText ?? 'Waiting on a previous match'}
            </span>
          </div>
        ),
      )}

      <div className="row row--tight" style={{ marginTop: 8 }}>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={detailed}
            onChange={(e) => {
              setDetailed(e.target.checked);
              setGames([]);
              setScores({});
            }}
          />
          Log games individually
        </label>
        {detailed && games.length > 0 && (
          <>
            <span className="muted" style={{ fontSize: 12 }}>
              {games.length} game{games.length === 1 ? '' : 's'} logged
            </span>
            <button className="btn btn--sm btn--ghost" onClick={undoGame}>
              Undo game
            </button>
          </>
        )}

        <span className="spacer" />

        {stations.length > 0 && (
          <select
            className="select"
            style={{ width: 'auto' }}
            value={set.stationId ?? ''}
            onChange={(e) => {
              const station = stations.find((s) => s.id === e.target.value);
              void api.assignStation(
                set.id,
                eventId,
                station?.id ?? null,
                station?.number ?? null,
              );
            }}
          >
            <option value="">Setup…</option>
            {stations.map((station) => (
              <option key={station.id} value={station.id}>
                Setup {station.number ?? station.id}
              </option>
            ))}
          </select>
        )}

        {canAssignStream && streams.length > 0 && (
          <select
            className="select"
            style={{ width: 'auto' }}
            value={set.streamId ?? ''}
            onChange={(e) => {
              const stream = streams.find((s) => s.id === e.target.value);
              void api.assignStream(set.id, eventId, stream?.id ?? null, stream?.name ?? null);
            }}
          >
            <option value="">Stream…</option>
            {streams.map((stream) => (
              <option key={stream.id} value={stream.id}>
                {stream.name}
              </option>
            ))}
          </select>
        )}

        {a?.entrantId && b?.entrantId && (
          <div className="row row--tight">
            <span className="muted" style={{ fontSize: 12 }}>
              DQ:
            </span>
            <button
              className="btn btn--sm btn--ghost"
              disabled={busy}
              onClick={() => void submit(b.entrantId as string, true)}
              title={`${a.entrantName} is disqualified`}
            >
              {a.entrantName}
            </button>
            <button
              className="btn btn--sm btn--ghost"
              disabled={busy}
              onClick={() => void submit(a.entrantId as string, true)}
              title={`${b.entrantName} is disqualified`}
            >
              {b.entrantName}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
