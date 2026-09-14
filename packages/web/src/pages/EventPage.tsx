/**
 * Bracket viewer for one event.
 *
 * Picks a renderer from the phase group's bracket type, so an event with pools
 * feeding a top cut shows a table for the pool phase and a tree for the cut.
 */

import {
  defaultConfigFor,
  hasPermission,
  type BracketViewConfig,
  type Id,
  type PhaseGroup,
  type TournamentSet,
} from '@bracket/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api } from '../api.js';
import { BracketCanvas } from '../components/BracketCanvas.js';
import { MatchListView, RoundRobinView, SwissView } from '../components/PoolViews.js';
import { useAppStore } from '../store.js';
import { formatBracketType } from './DashboardPage.js';

export function EventPage() {
  const { eventId } = useParams<{ eventId: Id }>();
  const loadEvent = useAppStore((s) => s.loadEvent);
  const setsMap = useAppStore((s) => (eventId ? s.setsByEvent[eventId] : undefined));
  const entrants = useAppStore((s) => (eventId ? s.entrantsByEvent[eventId] : undefined));
  const user = useAppStore((s) => s.user);

  const [event, setEvent] = useState<Awaited<ReturnType<typeof api.event>>['event'] | null>(null);
  const [groupId, setGroupId] = useState<Id | null>(null);
  const [selectedSet, setSelectedSet] = useState<TournamentSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.event>>['status']>(null);
  const [loadingAll, setLoadingAll] = useState(false);
  const [config, setConfig] = useState<BracketViewConfig>(
    () => defaultConfigFor('bracket') as BracketViewConfig,
  );

  const load = useCallback(async () => {
    if (!eventId) return;
    try {
      const result = await api.event(eventId);
      setEvent(result.event);
      setStatus(result.status);
      loadEvent(result);
      setGroupId((current) => current ?? result.event.phases[0]?.groups[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load event');
    }
  }, [eventId, loadEvent]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Reads every bracket of the event directly, rather than asking the event for
   * its sets. That is the read start.gg answers for matches already played, so
   * it is the one that fills in a finished bracket — and it is slow enough that
   * a person has to ask for it. Results arrive over the socket, so the page is
   * re-read a moment later rather than waiting on the request itself.
   */
  const loadEverySet = useCallback(async () => {
    if (!eventId) return;
    setLoadingAll(true);
    try {
      await api.deepSync(eventId);
      // The engine picks the request up on its next tick; give it that long
      // before re-reading, then let socket updates carry the rest.
      window.setTimeout(() => void load(), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the read');
    } finally {
      window.setTimeout(() => setLoadingAll(false), 2500);
    }
  }, [eventId, load]);

  const groups = useMemo(
    () =>
      (event?.phases ?? []).flatMap((phase) =>
        phase.groups.map((group) => ({ phase, group })),
      ),
    [event],
  );

  const activeGroup = groups.find((g) => g.group.id === groupId)?.group ?? null;

  const sets = useMemo(() => {
    const all = Object.values(setsMap ?? {});
    if (!groupId) return all;
    const scoped = all.filter((s) => s.phaseGroupId === groupId);
    if (scoped.length > 0) return scoped;

    // Some events report no phase group on their sets. Fall back to the phase,
    // never to the whole event: phases number rounds independently, so mixing
    // them would interleave pool round 1 with top-cut round 1.
    const phaseId = groups.find((g) => g.group.id === groupId)?.phase.id;
    return phaseId ? all.filter((s) => s.phaseId === phaseId) : [];
  }, [setsMap, groupId, groups]);

  if (error) {
    return (
      <div className="page">
        <div className="alert alert--error">{error}</div>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="page">
        <p className="muted">Loading event…</p>
      </div>
    );
  }

  return (
    <div className="page page--wide">
      <div className="event-toolbar">
        <Link to="/" className="btn btn--sm btn--ghost">
          ← Back
        </Link>
        <div>
          <strong>{event.name}</strong>{' '}
          <span className="muted" style={{ fontSize: 13 }}>
            {event.videogameName}
          </span>
        </div>

        {groups.length > 1 && (
          <select
            className="select"
            style={{ width: 'auto', minWidth: 200 }}
            value={groupId ?? ''}
            onChange={(e) => {
              setGroupId(e.target.value);
              setSelectedSet(null);
            }}
          >
            {groups.map(({ phase, group }) => (
              <option key={group.id} value={group.id}>
                {phase.name}
                {phase.groups.length > 1 ? ` — Pool ${group.displayIdentifier}` : ''}
              </option>
            ))}
          </select>
        )}

        {activeGroup && <span className="tag">{formatBracketType(activeGroup.bracketType)}</span>}

        <span className="spacer" />

        <ViewOptions config={config} onChange={setConfig} />

        <button className="btn btn--sm" onClick={() => void api.sync(event.id).then(load)}>
          Sync now
        </button>
        <button
          className="btn btn--sm"
          disabled={loadingAll}
          title="Read every bracket in this event directly. Slower, and the only read that returns matches that have already been played."
          onClick={() => void loadEverySet()}
        >
          {loadingAll ? 'Loading…' : 'Load every set'}
        </button>
        {hasPermission(user, 'set:report') && (
          <Link className="btn btn--sm btn--primary" to={`/events/${event.id}/report`}>
            Report scores
          </Link>
        )}
      </div>

      {sets.length === 0 && (
        <EmptyBracketNotice
          syncError={status?.syncError ?? null}
          busy={loadingAll}
          onLoadEverySet={() => void loadEverySet()}
        />
      )}

      <div className="event-stage">
        <BracketBody
          group={activeGroup}
          sets={sets}
          entrants={entrants ?? []}
          config={config}
          selectedSetId={selectedSet?.id ?? null}
          onSelectSet={setSelectedSet}
        />
      </div>

      {selectedSet && (
        <SetDetail set={selectedSet} onClose={() => setSelectedSet(null)} />
      )}
    </div>
  );
}

/**
 * An event with no sets used to render as a blank canvas, which says nothing
 * about whether the bracket is unpublished, still loading, or was never
 * successfully read. It says so now, and offers the read that fixes the last of
 * those without making anyone go and find it.
 */
function EmptyBracketNotice({
  syncError,
  busy,
  onLoadEverySet,
}: {
  syncError: string | null;
  busy: boolean;
  onLoadEverySet: () => void;
}) {
  return (
    <div className="alert alert--info" style={{ margin: 16, marginBottom: 0 }}>
      <div style={{ marginBottom: 8 }}>
        <strong>No matches stored for this bracket yet.</strong>{' '}
        {syncError ??
          'Either start.gg has not published it, or the sets have not been read ' +
            'successfully. A finished event in particular can need reading bracket by ' +
            'bracket, because start.gg will not always list matches that are already played.'}
      </div>
      <button className="btn btn--sm btn--primary" disabled={busy} onClick={onLoadEverySet}>
        {busy ? 'Reading every bracket…' : 'Load every set'}
      </button>
    </div>
  );
}

function BracketBody({
  group,
  sets,
  entrants,
  config,
  selectedSetId,
  onSelectSet,
}: {
  group: PhaseGroup | null;
  sets: TournamentSet[];
  entrants: NonNullable<ReturnType<typeof useAppStore.getState>['entrantsByEvent'][string]>;
  config: BracketViewConfig;
  selectedSetId: Id | null;
  onSelectSet: (set: TournamentSet) => void;
}) {
  const bracketType = group?.bracketType ?? 'DOUBLE_ELIMINATION';

  switch (bracketType) {
    case 'ROUND_ROBIN':
      return (
        <RoundRobinView
          sets={sets}
          bracketType={bracketType}
          entrants={entrants}
          onSelectSet={onSelectSet}
          selectedSetId={selectedSetId}
        />
      );
    case 'SWISS':
      return (
        <SwissView
          sets={sets}
          bracketType={bracketType}
          entrants={entrants}
          onSelectSet={onSelectSet}
          selectedSetId={selectedSetId}
        />
      );
    case 'SINGLE_ELIMINATION':
    case 'DOUBLE_ELIMINATION':
    case 'ELIMINATION_ROUNDS':
      return (
        <BracketCanvas
          sets={sets}
          bracketType={bracketType}
          entrants={entrants}
          config={config}
          interactive
          selectedSetId={selectedSetId}
          onSelectSet={onSelectSet}
        />
      );
    default:
      return (
        <MatchListView
          sets={sets}
          bracketType={bracketType}
          entrants={entrants}
          onSelectSet={onSelectSet}
          selectedSetId={selectedSetId}
        />
      );
  }
}

function ViewOptions({
  config,
  onChange,
}: {
  config: BracketViewConfig;
  onChange: (config: BracketViewConfig) => void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = (key: keyof BracketViewConfig) => () =>
    onChange({ ...config, [key]: !config[key] } as BracketViewConfig);

  return (
    <div style={{ position: 'relative' }}>
      <button className="btn btn--sm" onClick={() => setOpen((v) => !v)}>
        Display ▾
      </button>
      {open && (
        <div
          className="panel"
          style={{ position: 'absolute', right: 0, top: '110%', zIndex: 20, width: 220 }}
        >
          {(
            [
              ['showRoundLabels', 'Round labels'],
              ['showSeeds', 'Seeds'],
              ['showScores', 'Scores'],
              ['showStation', 'Setup numbers'],
              ['showStream', 'Stream names'],
              ['showConnectors', 'Connectors'],
              ['showLosers', 'Losers bracket'],
              ['dimCompleted', 'Dim finished sets'],
              ['highlightLive', 'Highlight live sets'],
              ['hideEmptyRounds', 'Hide unresolved rounds'],
            ] as [keyof BracketViewConfig, string][]
          ).map(([key, label]) => (
            <label key={key} className="checkbox">
              <input
                type="checkbox"
                checked={Boolean(config[key])}
                onChange={toggle(key)}
              />
              {label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function SetDetail({ set, onClose }: { set: TournamentSet; onClose: () => void }) {
  return (
    <div className="panel" style={{ margin: 16, marginTop: 0 }}>
      <div className="row">
        <strong>{set.fullRoundText || `Set ${set.identifier}`}</strong>
        {set.stationNumber !== null && <span className="tag">Setup {set.stationNumber}</span>}
        {set.streamName && <span className="tag">{set.streamName}</span>}
        {set.pendingLocal && <span className="tag tag--warn">Waiting to sync</span>}
        <span className="spacer" />
        <button className="btn btn--sm btn--ghost" onClick={onClose}>
          Close
        </button>
      </div>

      <table className="table-plain" style={{ marginTop: 10 }}>
        <tbody>
          {set.slots.map((slot) => (
            <tr key={slot.slotIndex}>
              <td>
                {slot.seed !== null && <span className="muted">#{slot.seed} </span>}
                {slot.entrantName ?? slot.placeholderText ?? 'TBD'}
              </td>
              <td style={{ width: 60, textAlign: 'right', fontWeight: 700 }}>
                {slot.score === null ? '–' : slot.score < 0 ? 'DQ' : slot.score}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {set.games.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="field__label">Games</div>
          <div className="row row--tight">
            {set.games.map((game) => (
              <span key={game.id} className="tag">
                G{game.orderNum}
                {game.selections.length > 0 &&
                  `: ${game.selections.map((s) => s.characterName ?? '?').join(' vs ')}`}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
