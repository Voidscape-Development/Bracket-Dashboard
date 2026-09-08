/**
 * WebSocket hub and camera director.
 *
 * Holds every connected client — dashboards and overlays — and routes three
 * things: data changes out to whoever cares, director commands from an operator
 * to the specific view being driven, and auto-follow decisions computed here so
 * that an unattended display and a monitored one always agree on the shot.
 *
 * Camera state lives on the view record, so a browser source that reloads
 * mid-tournament comes back framed exactly where it was.
 */

import { randomUUID } from 'node:crypto';

import {
  pickAutoFollowTarget,
  type CameraState,
  type ConnectionStatus,
  type Id,
  type OutputView,
  type ServerMessage,
  type Standing,
  type TournamentSet,
} from '@bracket/shared';
import type { WebSocket } from 'ws';

import type { Store } from '../db/store.js';
import { resolveView } from '../views/resolve.js';

type ClientKind = 'dashboard' | 'view';

interface Client {
  id: string;
  socket: WebSocket;
  kind: ClientKind;
  /** For view clients, the view they are rendering. */
  viewId: string | null;
  /** For dashboard clients, an optional event filter. */
  eventIds: Id[] | null;
  isAlive: boolean;
}

export interface HubOptions {
  /** How often auto-follow re-evaluates. */
  autoFollowTickMs?: number;
  heartbeatMs?: number;
}

export class Hub {
  private readonly clients = new Map<string, Client>();
  private readonly revisions = new Map<Id, number>();
  /** viewId -> timestamp until which auto-follow stays paused after operator input. */
  private readonly manualHoldUntil = new Map<string, number>();
  /** viewId -> the set auto-follow last chose, so it does not re-issue the same shot. */
  private readonly lastAutoTarget = new Map<string, Id | null>();
  private autoFollowTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private status: ConnectionStatus = {
    online: true,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    queuedCommands: 0,
    conflictCount: 0,
    requestsLastMinute: 0,
  };

  constructor(
    private readonly store: Store,
    private readonly options: HubOptions = {},
  ) {}

  start(): void {
    const tick = this.options.autoFollowTickMs ?? 2000;
    this.autoFollowTimer = setInterval(() => this.evaluateAutoFollow(), tick);
    this.autoFollowTimer.unref?.();

    const beat = this.options.heartbeatMs ?? 30_000;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), beat);
    this.heartbeatTimer.unref?.();
  }

  stop(): void {
    if (this.autoFollowTimer) clearInterval(this.autoFollowTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.autoFollowTimer = null;
    this.heartbeatTimer = null;
    for (const client of this.clients.values()) {
      try {
        client.socket.close();
      } catch {
        // Already gone; nothing to do.
      }
    }
    this.clients.clear();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Connected overlays per view, shown in the director panel. */
  viewerCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const client of this.clients.values()) {
      if (client.kind === 'view' && client.viewId) {
        counts[client.viewId] = (counts[client.viewId] ?? 0) + 1;
      }
    }
    return counts;
  }

  addClient(socket: WebSocket): string {
    const id = randomUUID();
    this.clients.set(id, {
      id,
      socket,
      kind: 'dashboard',
      viewId: null,
      eventIds: null,
      isAlive: true,
    });
    socket.on('pong', () => {
      const client = this.clients.get(id);
      if (client) client.isAlive = true;
    });
    return id;
  }

  removeClient(id: string): void {
    this.clients.delete(id);
  }

  subscribeDashboard(clientId: string, eventIds?: Id[]): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    client.kind = 'dashboard';
    client.viewId = null;
    client.eventIds = eventIds && eventIds.length > 0 ? eventIds : null;
  }

  /** Overlays authenticate with the view's secret rather than a user session. */
  subscribeView(clientId: string, viewId: string, secret: string): OutputView | null {
    const client = this.clients.get(clientId);
    if (!client) return null;
    const view = this.store.getView(viewId);
    if (!view || view.secret !== secret) return null;

    client.kind = 'view';
    client.viewId = viewId;
    client.eventIds = view.eventId ? [view.eventId] : null;
    return view;
  }

  private send(client: Client, message: ServerMessage): void {
    if (client.socket.readyState !== 1) return;
    try {
      client.socket.send(JSON.stringify(message));
    } catch {
      this.clients.delete(client.id);
    }
  }

  sendTo(clientId: string, message: ServerMessage): void {
    const client = this.clients.get(clientId);
    if (client) this.send(client, message);
  }

  /** Fans a message out to dashboards and to overlays bound to the event. */
  broadcast(message: ServerMessage, eventId?: Id): void {
    for (const client of this.clients.values()) {
      if (eventId && client.eventIds && !client.eventIds.includes(eventId)) continue;
      this.send(client, message);
    }
  }

  broadcastToView(viewId: string, message: ServerMessage): void {
    for (const client of this.clients.values()) {
      if (client.kind === 'view' && client.viewId !== viewId) continue;
      if (client.kind === 'view' || client.kind === 'dashboard') {
        // Dashboards receive view traffic too, so a director panel stays in sync
        // with whatever an operator on another machine just did.
        this.send(client, message);
      }
    }
  }

  nextRevision(eventId: Id): number {
    const next = (this.revisions.get(eventId) ?? 0) + 1;
    this.revisions.set(eventId, next);
    return next;
  }

  publishSets(eventId: Id, upserted: TournamentSet[], removedIds: Id[] = []): void {
    if (upserted.length === 0 && removedIds.length === 0) return;
    this.broadcast(
      {
        type: 'sets:changed',
        eventId,
        upserted,
        removedIds,
        revision: this.nextRevision(eventId),
      },
      eventId,
    );
  }

  publishStandings(eventId: Id, standings: Standing[]): void {
    this.broadcast({ type: 'standings:changed', eventId, standings }, eventId);
  }

  publishStatus(patch: Partial<ConnectionStatus>): void {
    this.status = { ...this.status, ...patch };
    this.broadcast({ type: 'status', status: this.status });
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  publishViewUpdated(view: OutputView): void {
    const theme = this.store.getTheme(view.themeId) ?? this.store.listThemes()[0];
    if (!theme) return;
    this.broadcastToView(view.id, { type: 'view:updated', view, theme });
  }

  publishThemeUpdated(themeId: string): void {
    const theme = this.store.getTheme(themeId);
    if (!theme) return;
    this.broadcast({ type: 'theme:updated', theme });
  }

  publishOutbox(): void {
    const entries = this.store.listOutbox();
    const counts = this.store.outboxCounts();
    this.broadcast({
      type: 'outbox:changed',
      entries: entries.slice(0, 100),
      queued: counts.queued,
      conflicts: counts.conflicts,
    });
    this.publishStatus({
      queuedCommands: counts.queued,
      conflictCount: counts.conflicts,
    });
  }

  // -------------------------------------------------------------------------
  // Camera direction
  // -------------------------------------------------------------------------

  /**
   * Applies a camera change to a view and pushes it to everyone watching.
   * Operator input parks auto-follow for the view's configured grace period, so
   * a director can grab the shot without fighting the automation.
   */
  setCamera(
    viewId: string,
    patch: Partial<CameraState>,
    source: 'operator' | 'autofollow' | 'restore',
  ): OutputView | null {
    const view = this.store.getView(viewId);
    if (!view) return null;

    const camera: CameraState = { ...view.camera, ...patch };
    const updated = this.store.updateView(viewId, { camera });
    if (!updated) return null;

    if (source === 'operator' && view.autoFollow.enabled) {
      this.manualHoldUntil.set(viewId, Date.now() + view.autoFollow.resumeAfterManualMs);
    }

    this.broadcastToView(viewId, {
      type: 'camera:changed',
      viewId,
      camera,
      source,
    });
    return updated;
  }

  setAutoFollow(viewId: string, patch: Partial<OutputView['autoFollow']>): OutputView | null {
    const view = this.store.getView(viewId);
    if (!view) return null;
    const autoFollow = { ...view.autoFollow, ...patch };
    const updated = this.store.updateView(viewId, { autoFollow });
    if (updated) {
      // Re-enabling should take effect now, not after the hold expires.
      if (autoFollow.enabled) this.manualHoldUntil.delete(viewId);
      this.lastAutoTarget.delete(viewId);
      this.publishViewUpdated(updated);
    }
    return updated;
  }

  /**
   * Re-evaluates auto-follow for every view that has it on. Only issues a camera
   * change when the chosen target actually moved — an overlay that re-animates
   * every two seconds looks broken on stream.
   */
  private evaluateAutoFollow(): void {
    const now = Date.now();
    for (const view of this.store.listViews()) {
      if (!view.autoFollow.enabled) continue;
      if ((this.manualHoldUntil.get(view.id) ?? 0) > now) continue;
      if (!view.eventId) continue;

      // Same resolution the overlay uses, so auto-follow never picks a match
      // from a phase the display is not showing.
      const { sets } = resolveView(this.store, view);
      if (sets.length === 0) continue;

      const previous = this.lastAutoTarget.get(view.id) ?? view.camera.targetSetId;
      const pick = pickAutoFollowTarget(sets, view.autoFollow, previous, now);
      if (!pick) continue;
      if (pick.setId === previous && view.camera.mode === view.autoFollow.shot) continue;

      this.lastAutoTarget.set(view.id, pick.setId);
      this.setCamera(
        view.id,
        {
          mode: view.autoFollow.shot,
          targetSetId: pick.setId,
          targetColumnId: null,
          animate: true,
        },
        'autofollow',
      );
    }
  }

  private heartbeat(): void {
    for (const client of this.clients.values()) {
      if (!client.isAlive) {
        try {
          client.socket.terminate();
        } catch {
          // Socket already dead.
        }
        this.clients.delete(client.id);
        continue;
      }
      client.isAlive = false;
      try {
        client.socket.ping();
      } catch {
        this.clients.delete(client.id);
      }
    }
  }
}
