/**
 * The report queue and conflict review.
 *
 * When a queued report and start.gg disagree, both versions are shown side by
 * side and a person picks. Nothing is resolved automatically.
 */

import { hasPermission, type OutboxEntry } from '@bracket/shared';
import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';
import { useAppStore } from '../store.js';

export function QueuePage() {
  const queue = useAppStore((s) => s.queue);
  const counts = useAppStore((s) => s.queueCounts);
  const status = useAppStore((s) => s.status);
  const setQueue = useAppStore((s) => s.setQueue);
  const user = useAppStore((s) => s.user);

  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.queue();
      setQueue(result.entries, result.counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the queue');
    }
  }, [setQueue]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const conflicts = queue.filter((e) => e.status === 'conflict');
  const pending = queue.filter((e) => ['queued', 'sending', 'failed'].includes(e.status));
  const history = queue.filter((e) => ['sent', 'abandoned'].includes(e.status));

  const canResolve = hasPermission(user, 'queue:resolve');

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Report queue</h1>
          <p className="page__subtitle">
            Everything this app has sent, or is waiting to send, to start.gg.
          </p>
        </div>
        <button className="btn" onClick={() => void api.drainQueue().then(refresh)}>
          Try sending now
        </button>
      </div>

      {error && <div className="alert alert--error">{error}</div>}

      <div className={`alert ${status.online ? 'alert--success' : 'alert--warn'}`}>
        {status.online
          ? 'Connected to start.gg. Queued reports send automatically.'
          : 'start.gg is unreachable. Reports are held here and will send when the connection returns.'}
        {counts.queued > 0 && ` ${counts.queued} waiting.`}
      </div>

      {conflicts.length > 0 && (
        <>
          <h2 style={{ fontSize: 16 }}>Needs your decision ({conflicts.length})</h2>
          {conflicts.map((entry) => (
            <ConflictCard
              key={entry.id}
              entry={entry}
              canResolve={canResolve}
              onResolved={refresh}
            />
          ))}
        </>
      )}

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Waiting to send ({pending.length})</h2>
      {pending.length === 0 ? (
        <p className="muted">Nothing waiting.</p>
      ) : (
        <div className="panel">
          <table className="table-plain">
            <thead>
              <tr>
                <th>Action</th>
                <th>Target</th>
                <th>By</th>
                <th>Attempts</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((entry) => (
                <tr key={entry.id}>
                  <td>{describeCommand(entry)}</td>
                  <td className="mono">{targetOf(entry)}</td>
                  <td>{entry.username ?? '—'}</td>
                  <td>{entry.attempts}</td>
                  <td>
                    <span className="tag">{entry.status}</span>
                    {entry.lastError && (
                      <div className="muted" style={{ fontSize: 11 }}>
                        {entry.lastError}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Recent ({history.length})</h2>
      {history.length === 0 ? (
        <p className="muted">Nothing sent yet.</p>
      ) : (
        <div className="panel">
          <table className="table-plain">
            <thead>
              <tr>
                <th>Action</th>
                <th>Target</th>
                <th>By</th>
                <th>When</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {history.slice(0, 50).map((entry) => (
                <tr key={entry.id}>
                  <td>{describeCommand(entry)}</td>
                  <td className="mono">{targetOf(entry)}</td>
                  <td>{entry.username ?? '—'}</td>
                  <td className="muted">{new Date(entry.updatedAt).toLocaleTimeString()}</td>
                  <td>
                    <span className={`tag ${entry.status === 'sent' ? 'tag--done' : ''}`}>
                      {entry.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ConflictCard({
  entry,
  canResolve,
  onResolved,
}: {
  entry: OutboxEntry;
  canResolve: boolean;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const conflict = entry.conflict;

  const resolve = async (resolution: 'force-local' | 'keep-remote') => {
    setBusy(true);
    try {
      await api.resolveConflict(entry.id, resolution);
      onResolved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" style={{ borderColor: 'var(--ui-warn)' }}>
      <div className="row row--tight">
        <strong>{describeCommand(entry)}</strong>
        <span className="tag mono">{targetOf(entry)}</span>
        {entry.username && <span className="tag">by {entry.username}</span>}
      </div>

      <p style={{ marginBottom: 6 }}>{conflict?.message}</p>

      <div className="conflict">
        <div className="conflict__side">
          <h4>This app wanted to send</h4>
          <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(conflict?.local ?? {}, null, 2)}
          </pre>
        </div>
        <div className="conflict__side">
          <h4>start.gg currently has</h4>
          <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(conflict?.remote ?? {}, null, 2)}
          </pre>
        </div>
      </div>

      {canResolve ? (
        <div className="row row--tight">
          <button
            className="btn btn--sm btn--primary"
            disabled={busy}
            onClick={() => void resolve('force-local')}
          >
            Send ours anyway
          </button>
          <button
            className="btn btn--sm"
            disabled={busy}
            onClick={() => void resolve('keep-remote')}
          >
            Keep what start.gg has
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            Choosing start.gg's version discards this queued report.
          </span>
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          An organiser needs to resolve this.
        </p>
      )}
    </div>
  );
}

function describeCommand(entry: OutboxEntry): string {
  switch (entry.command.kind) {
    case 'reportSet':
      return entry.command.isDq ? 'Report DQ' : 'Report set result';
    case 'markInProgress':
      return 'Mark in progress';
    case 'resetSet':
      return 'Reset set';
    case 'assignStation':
      return 'Assign setup';
    case 'assignStream':
      return 'Assign stream';
    case 'updateSeeding':
      return 'Update seeding';
    default:
      return 'Unknown action';
  }
}

function targetOf(entry: OutboxEntry): string {
  const command = entry.command as { setId?: string; phaseId?: string };
  return command.setId ?? command.phaseId ?? '—';
}
