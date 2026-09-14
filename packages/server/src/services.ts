/**
 * Service container.
 *
 * Builds the object graph once and wires the cross-component signals: sync
 * results and outbox activity both fan out through the hub, and the start.gg
 * client's health drives the connection status every client sees.
 */

import {
  permissionsFor,
  type SessionUser,
  type User,
} from '@bracket/shared';

import { ActivityLog } from './activity.js';
import type { AppConfig } from './config.js';
import { Store } from './db/store.js';
import { StartggClient } from './startgg/client.js';
import { MockTransport } from './startgg/mock.js';
import { createTransport, type GqlTransport } from './startgg/transport.js';
import { SyncEngine } from './sync/engine.js';
import { OutboxWorker } from './sync/outbox.js';
import { Hub } from './ws/hub.js';

export interface Services {
  config: AppConfig;
  store: Store;
  client: StartggClient;
  sync: SyncEngine;
  outbox: OutboxWorker;
  hub: Hub;
  activity: ActivityLog;
  /** Rebuilds the transport after a settings change. */
  applyTransportSettings(settings: {
    transport?: AppConfig['transport'];
    token?: string | null;
    headers?: Record<string, string>;
  }): void;
  shutdown(): void;
}

export function toSessionUser(user: User): SessionUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    eventScope: user.eventScope,
    permissions: permissionsFor(user.role),
  };
}

function buildTransport(config: AppConfig): GqlTransport {
  if (config.transport === 'mock') return new MockTransport();
  return createTransport(config.transport, {
    token: config.startggToken,
    headers: config.startggHeaders,
  });
}

export function createServices(config: AppConfig): Services {
  const store = new Store(config.databaseFile);

  // Persisted settings win over env defaults once an admin has set them, so a
  // token entered in the UI survives a restart.
  const savedTransport = store.getSetting('startgg.transport') as AppConfig['transport'] | null;
  const savedToken = store.getSetting('startgg.token');
  const effective: AppConfig = {
    ...config,
    transport: savedTransport ?? config.transport,
    startggToken: savedToken ?? config.startggToken,
  };

  const client = new StartggClient(buildTransport(effective), {
    requestsPerMinute: effective.requestsPerMinute,
    perPage: effective.perPage,
    groupsPerPage: effective.groupsPerPage,
  });
  const activity = new ActivityLog();
  const hub = new Hub(store);
  const sync = new SyncEngine(store, client, { activity });
  const outbox = new OutboxWorker(store, client, { activity });

  // ---- Signal wiring -------------------------------------------------------

  sync.on('sets', ({ eventId, upserted }) => {
    hub.publishSets(eventId, upserted);
  });
  sync.on('standings', ({ eventId, standings }) => {
    hub.publishStandings(eventId, standings);
  });
  sync.on('error', () => {
    hub.publishStatus({ ...client.health });
  });

  // Health fires several times per request — queued, answered, settled — so an
  // import would otherwise put a socket message on the wire for every one of a
  // few hundred calls. The counters are a gauge, not a log: a coalesced update
  // a few times a second says the same thing. A connection dropping or coming
  // back is not a counter and goes out at once.
  let healthTimer: NodeJS.Timeout | null = null;
  const publishHealth = (health: typeof client.health): void => {
    hub.publishStatus({
      online: health.online,
      lastSuccessAt: health.lastSuccessAt,
      lastErrorAt: health.lastErrorAt,
      lastError: health.lastError,
      requestsLastMinute: health.requestsLastMinute,
      requestsInFlight: health.requestsInFlight,
    });
  };
  client.on('health', (health) => {
    if (health.online !== hub.connectionStatus.online) {
      if (healthTimer) clearTimeout(healthTimer);
      healthTimer = null;
      publishHealth(health);
      return;
    }
    if (healthTimer) return;
    healthTimer = setTimeout(() => {
      healthTimer = null;
      publishHealth(client.health);
    }, 400);
    healthTimer.unref?.();
  });

  activity.on('changed', (snapshot) => hub.publishActivity(snapshot));
  client.on('online', () => {
    // Connection is back: flush anything the venue queued while it was down.
    void outbox.drain();
    sync.requestSync();
  });

  outbox.on('changed', () => hub.publishOutbox());
  outbox.on('queued', ({ sets }: { sets: { eventId: string }[] }) => {
    for (const set of sets) {
      const stored = store.getSet((set as any).id);
      if (stored) hub.publishSets(stored.eventId, [stored]);
    }
  });
  outbox.on('sets', ({ sets }: { sets: { eventId: string }[] }) => {
    const byEvent = new Map<string, any[]>();
    for (const set of sets) {
      const list = byEvent.get(set.eventId);
      if (list) list.push(set);
      else byEvent.set(set.eventId, [set]);
    }
    for (const [eventId, list] of byEvent) hub.publishSets(eventId, list);
  });

  const services: Services = {
    config: effective,
    store,
    client,
    sync,
    outbox,
    hub,
    activity,

    applyTransportSettings(settings) {
      if (settings.transport) {
        store.setSetting('startgg.transport', settings.transport);
        effective.transport = settings.transport;
      }
      if (settings.token !== undefined) {
        if (settings.token) store.setSetting('startgg.token', settings.token);
        else store.setSetting('startgg.token', '');
        effective.startggToken = settings.token || null;
      }
      if (settings.headers) effective.startggHeaders = settings.headers;
      client.setTransport(buildTransport(effective));
    },

    shutdown() {
      if (healthTimer) clearTimeout(healthTimer);
      sync.stop();
      outbox.stop();
      hub.stop();
      activity.stop();
      store.close();
    },
  };

  return services;
}
