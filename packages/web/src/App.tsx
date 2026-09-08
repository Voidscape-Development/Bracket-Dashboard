/**
 * App shell and routing.
 *
 * Overlay routes are deliberately outside the authenticated shell: they load
 * before any session check, render no chrome, and paint no background, because
 * they exist to be pointed at by an OBS browser source or a TV in a corner.
 */

import { hasPermission } from '@bracket/shared';
import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { api } from './api.js';
import { OverlayPage } from './overlay/OverlayPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { DirectorPage } from './pages/DirectorPage.js';
import { EventPage } from './pages/EventPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { QueuePage } from './pages/QueuePage.js';
import { ReportPage } from './pages/ReportPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { ThemesPage } from './pages/ThemesPage.js';
import { ViewsPage } from './pages/ViewsPage.js';
import { liveSocket, useAppStore } from './store.js';

export function App() {
  const location = useLocation();
  const isOverlay = location.pathname.startsWith('/overlay/');

  // Overlays must not inherit the dashboard's opaque background.
  useEffect(() => {
    document.body.classList.toggle('bd-overlay-mode', isOverlay);
    return () => document.body.classList.remove('bd-overlay-mode');
  }, [isOverlay]);

  if (isOverlay) {
    return (
      <Routes>
        <Route path="/overlay/:viewId/:secret" element={<OverlayPage />} />
      </Routes>
    );
  }

  return <Shell />;
}

function Shell() {
  const user = useAppStore((s) => s.user);
  const setUser = useAppStore((s) => s.setUser);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((result) => {
        if (!cancelled) setUser(result.user);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [setUser]);

  // One socket for the session, opened once signed in.
  useEffect(() => {
    if (!user) return;
    liveSocket.connect();
    liveSocket.subscribeDashboard();
  }, [user]);

  if (!checked) {
    return <div className="login">
      <p className="muted">Loading…</p>
    </div>;
  }

  if (!user) return <LoginPage />;

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/events/:eventId" element={<EventPage />} />
          <Route path="/events/:eventId/report" element={<ReportPage />} />
          <Route path="/views" element={<ViewsPage />} />
          <Route path="/views/:viewId/director" element={<DirectorPage />} />
          <Route path="/themes" element={<ThemesPage />} />
          <Route path="/queue" element={<QueuePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Sidebar() {
  const user = useAppStore((s) => s.user);
  const status = useAppStore((s) => s.status);
  const counts = useAppStore((s) => s.queueCounts);
  const connected = useAppStore((s) => s.socketConnected);
  const setUser = useAppStore((s) => s.setUser);

  const link = ({ isActive }: { isActive: boolean }) =>
    `sidebar__link ${isActive ? 'sidebar__link--active' : ''}`;

  return (
    <nav className="sidebar">
      <div className="sidebar__brand">Bracket Dashboard</div>

      <NavLink to="/" className={link} end>
        Tournaments
      </NavLink>
      <NavLink to="/views" className={link}>
        Outputs
      </NavLink>
      <NavLink to="/themes" className={link}>
        Themes
      </NavLink>
      <NavLink to="/queue" className={link}>
        <span>Report queue</span>
        {counts.conflicts > 0 ? (
          <span className="tag tag--warn">{counts.conflicts}</span>
        ) : counts.queued > 0 ? (
          <span className="tag">{counts.queued}</span>
        ) : null}
      </NavLink>
      {hasPermission(user, 'settings:manage') || hasPermission(user, 'user:manage') ? (
        <NavLink to="/settings" className={link}>
          Settings
        </NavLink>
      ) : null}

      <div className="sidebar__footer">
        <div className="row row--tight" style={{ marginBottom: 6 }}>
          <span
            className={`status-dot ${status.online ? '' : 'status-dot--off'}`}
            title={status.lastError ?? undefined}
          />
          <span>{status.online ? 'start.gg connected' : 'start.gg offline'}</span>
        </div>
        {!connected && <div className="tag tag--warn" style={{ marginBottom: 6 }}>Reconnecting…</div>}
        <div style={{ marginBottom: 8 }}>
          {status.requestsLastMinute} calls/min
        </div>
        <div className="row row--tight">
          <span className="dim">{user?.username}</span>
          <span className="tag">{user?.role}</span>
        </div>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          style={{ marginTop: 8, width: '100%' }}
          onClick={() => {
            void api.logout().then(() => setUser(null));
          }}
        >
          Sign out
        </button>
      </div>
    </nav>
  );
}
