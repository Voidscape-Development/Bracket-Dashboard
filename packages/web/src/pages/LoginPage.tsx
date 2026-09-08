import { useState, type FormEvent } from 'react';

import { api } from '../api.js';
import { useAppStore } from '../store.js';

export function LoginPage() {
  const setUser = useAppStore((s) => s.setUser);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(username, password);
      setUser(result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login__box" onSubmit={submit}>
        <h1 style={{ fontSize: 18, margin: '0 0 4px' }}>Bracket Dashboard</h1>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Sign in to manage brackets and outputs.
        </p>

        {error && <div className="alert alert--error">{error}</div>}

        <div className="field">
          <label className="field__label" htmlFor="username">
            Username
          </label>
          <input
            id="username"
            className="input"
            value={username}
            autoComplete="username"
            autoFocus
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="input"
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <button className="btn btn--primary" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          On a fresh install, the admin password is printed in the terminal or shown
          by the desktop app on first launch.
        </p>
      </form>
    </div>
  );
}
