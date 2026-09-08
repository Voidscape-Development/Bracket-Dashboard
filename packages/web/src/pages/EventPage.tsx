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
  const [config, setConfig] = useState<BracketViewConfig>(
    () => defaultConfigFor('bracket') as BracketViewConfig,
  );

  const load = useCallback(async () => {
    if (!eventId) return;
    try {
      const result = await api.event(eventId);
      setEvent(result.event);
      loadEvent(result);
      setGroupId((current) => current ?? result.event.phases[0]?.groups[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load event');
    }
  }, [eventId, loadEvent]);

  useEffect(() => {
    void load();
  }, [load]);

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
    // Some events report no phase group on sets; fall back rather than blank.
    return scoped.length > 0 ? scoped : all;
  }, [setsMap, groupId]);

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
        {hasPermission(user, 'set:report') && (
          <Link className="btn btn--sm btn--primary" to={`/events/${event.id}/report`}>
            Report scores
          </Link>
        )}
      </div>

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
