/**
 * Settings: start.gg connection, network reachability, and local accounts.
 */

import { ROLES, hasPermission, type Role, type User } from '@bracket/shared';
import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';
import { useAppStore } from '../store.js';

export function SettingsPage() {
  const user = useAppStore((s) => s.user);
  const tournaments = useAppStore((s) => s.tournaments);
  const [settings, setSettings] = useState<any>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canManageUsers = hasPermission(user, 'user:manage');
  const canManageSettings = hasPermission(user, 'settings:manage');

  const refresh = useCallback(async () => {
    try {
      const result = await api.settings();
      setSettings(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load settings');
    }
    if (canManageUsers) {
      try {
        const result = await api.users();
        setUsers(result.users);
      } catch {
        // Non-fatal: the connection panel is still useful.
      }
    }
  }, [canManageUsers]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const events = tournaments.flatMap((t) =>
    t.events.map((e) => ({ id: e.id, label: `${t.name} — ${e.name}` })),
  );

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Settings</h1>
          <p className="page__subtitle">Connection, network access and local accounts.</p>
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--success">{notice}</div>}

      {settings && (
        <>
          <ConnectionPanel
            settings={settings}
            canEdit={canManageSettings}
            onSaved={async (message) => {
              setNotice(message);
              await refresh();
            }}
          />

          {settings.network && (
            <div className="panel">
              <h2 className="panel__title">Network access</h2>
              <p className="field__hint" style={{ marginTop: 0 }}>
                {settings.network.allowLan
                  ? 'Other devices on this network can reach this app. Anyone who can open these addresses can attempt to sign in — keep accounts limited and use strong passwords on shared networks.'
                  : 'Restricted to this machine only. Start with LAN access enabled if scorekeepers need to report from phones.'}
              </p>
              <table className="table-plain">
                <tbody>
                  <tr>
                    <th style={{ width: 160 }}>This machine</th>
                    <td className="mono">http://localhost:{settings.network.port}</td>
                  </tr>
                  {settings.network.addresses.map((address: string) => (
                    <tr key={address}>
                      <th>On the network</th>
                      <td className="mono">
                        http://{address}:{settings.network.port}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <th>Data folder</th>
                    <td className="mono">{settings.dataDir}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {canManageUsers && (
        <UsersPanel users={users} events={events} onChanged={refresh} currentUserId={user?.id ?? ''} />
      )}
    </div>
  );
}

function ConnectionPanel({
  settings,
  canEdit,
  onSaved,
}: {
  settings: any;
  canEdit: boolean;
  onSaved: (message: string) => Promise<void>;
}) {
  const [transport, setTransport] = useState<string>(settings.transport);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const result = await api.updateSettings({
        transport,
        ...(token ? { token } : {}),
      });
      setToken('');
      await onSaved(
        result.reachable
          ? 'Saved. start.gg responded successfully.'
          : 'Saved, but start.gg did not respond to a test call.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2 className="panel__title">start.gg connection</h2>

      <div className="row row--tight" style={{ marginBottom: 10 }}>
        <span className={`status-dot ${settings.health?.online ? '' : 'status-dot--off'}`} />
        <span>{settings.health?.online ? 'Connected' : 'Not reachable'}</span>
        {settings.health?.degradedFields && (
          <span className="tag tag--warn" title="start.gg rejected some optional fields; the app dropped to a reduced query.">
            Reduced fields
          </span>
        )}
        {settings.health?.pageSizes?.EventSets < 25 && (
          <span
            className="tag tag--warn"
            title={`start.gg refused a full page for this tournament (its 1000-object per-request cap), so sets are being read ${settings.health.pageSizes.EventSets} at a time. Reads still complete; they take more calls.`}
          >
            Smaller pages ({settings.health.pageSizes.EventSets}/call)
          </span>
        )}
        <span className="muted">{settings.health?.requestsLastMinute ?? 0} calls/min</span>
      </div>

      {settings.health?.lastError && (
        <div className="alert alert--warn">{settings.health.lastError}</div>
      )}

      <div className="field">
        <label className="field__label">Endpoint</label>
        <select
          className="select"
          value={transport}
          disabled={!canEdit}
          onChange={(e) => setTransport(e.target.value)}
        >
          <option value="web">Site endpoint (no token needed)</option>
          <option value="official">Documented API (requires a token)</option>
          <option value="mock">Demo mode (simulated tournament, no network)</option>
        </select>
        <span className="field__hint">
          {transport === 'web' &&
            'Uses the same endpoint the start.gg website uses, with the same browser headers. No token needed for reading. It is undocumented, so it can change without notice. Like the documented API, it caps a response at 1000 objects — the app pages around that automatically.'}
          {transport === 'official' &&
            'The documented start.gg API. Stable and supported, but requires a personal access token. Caps a response at 1000 objects, the same as the site endpoint.'}
          {transport === 'mock' &&
            'Runs against a simulated tournament so you can lay out overlays and rehearse without touching start.gg.'}
        </span>
      </div>

      <div className="field">
        <label className="field__label">
          API token {settings.hasToken && <span className="tag tag--done">set</span>}
        </label>
        <input
          className="input"
          type="password"
          value={token}
          disabled={!canEdit}
          placeholder={settings.hasToken ? 'Leave blank to keep the current token' : 'Paste a token'}
          onChange={(e) => setToken(e.target.value)}
        />
        <span className="field__hint">
          Required for the documented API, and for reporting results back to start.gg.
          Create one at start.gg under Developer Settings. The token is stored locally
          and never shown again.
        </span>
      </div>

      {!settings.canMutate && (
        <div className="alert alert--warn">
          Reporting to start.gg is disabled: no credential is configured that can perform
          writes. Reads and overlays work normally, and reports will queue locally.
        </div>
      )}

      {canEdit && (
        <button className="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save connection'}
        </button>
      )}
    </div>
  );
}

function UsersPanel({
  users,
  events,
  onChanged,
  currentUserId,
}: {
  users: User[];
  events: { id: string; label: string }[];
  onChanged: () => void;
  currentUserId: string;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('scorekeeper');
  const [scope, setScope] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    try {
      await api.createUser({ username, password, role, eventScope: scope });
      setUsername('');
      setPassword('');
      setScope([]);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create user');
    }
  };

  return (
    <div className="panel">
      <h2 className="panel__title">People</h2>
      <p className="field__hint" style={{ marginTop: 0 }}>
        Scorekeepers can report results and start matches. Organisers can also reset sets,
        change seeding, and manage outputs. Leaving the event list empty gives access to
        every event.
      </p>

      {error && <div className="alert alert--error">{error}</div>}

      <table className="table-plain" style={{ marginBottom: 16 }}>
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>Events</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((entry) => (
            <tr key={entry.id}>
              <td>
                {entry.username}
                {entry.disabled && <span className="tag tag--warn"> disabled</span>}
              </td>
              <td>
                <select
                  className="select"
                  style={{ width: 'auto' }}
                  value={entry.role}
                  onChange={(e) =>
                    void api.updateUser(entry.id, { role: e.target.value }).then(onChanged)
                  }
                >
                  {ROLES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </td>
              <td className="muted">
                {entry.eventScope.length === 0
                  ? 'All events'
                  : `${entry.eventScope.length} event(s)`}
              </td>
              <td style={{ textAlign: 'right' }}>
                {entry.id !== currentUserId && (
                  <button
                    className="btn btn--sm btn--danger btn--ghost"
                    onClick={() => {
                      if (window.confirm(`Delete ${entry.username}?`)) {
                        void api.deleteUser(entry.id).then(onChanged);
                      }
                    }}
                  >
                    Delete
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ fontSize: 14 }}>Add someone</h3>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="field" style={{ flex: 1, minWidth: 160 }}>
          <label className="field__label">Username</label>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 160 }}>
          <label className="field__label">Password</label>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className="field__hint">At least 8 characters.</span>
        </div>
        <div className="field" style={{ width: 160 }}>
          <label className="field__label">Role</label>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      </div>

      {events.length > 0 && (
        <div className="field">
          <label className="field__label">Limit to events (optional)</label>
          {events.map((event) => (
            <label key={event.id} className="checkbox">
              <input
                type="checkbox"
                checked={scope.includes(event.id)}
                onChange={(e) =>
                  setScope((current) =>
                    e.target.checked
                      ? [...current, event.id]
                      : current.filter((id) => id !== event.id),
                  )
                }
              />
              {event.label}
            </label>
          ))}
        </div>
      )}

      <button
        className="btn btn--primary"
        disabled={!username || password.length < 8}
        onClick={() => void create()}
      >
        Add person
      </button>
    </div>
  );
}
