/**
 * HTTP + WebSocket application.
 *
 * Binds the routes, the socket hub and (in production) the built web assets into
 * one Fastify instance. The desktop shell and the CLI both boot through here, so
 * there is exactly one definition of what the server is.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import type { ClientMessage, Id } from '@bracket/shared';

import { hashPassword, generatePassword } from './auth/passwords.js';
import type { AppConfig } from './config.js';
import { registerAdminRoutes, localAddresses } from './routes/admin.js';
import { registerAuthContext, registerAuthRoutes } from './routes/auth.js';
import { registerReportingRoutes } from './routes/reporting.js';
import { registerTournamentRoutes } from './routes/tournaments.js';
import { registerViewRoutes } from './routes/views.js';
import type { Services } from './services.js';

export interface BootstrapCredentials {
  username: string;
  password: string;
}

/**
 * Creates the first admin on an empty install and returns the generated
 * password once. It is never stored in plaintext, so it is shown at startup and
 * then only resettable, not recoverable.
 */
export async function ensureBootstrapUser(
  services: Services,
): Promise<BootstrapCredentials | null> {
  if (services.store.countUsers() > 0) return null;
  const password = generatePassword();
  services.store.createUser({
    username: 'admin',
    passwordHash: await hashPassword(password),
    role: 'admin',
    eventScope: [],
  });
  services.store.audit({
    userId: null,
    username: 'system',
    action: 'user:bootstrap',
    target: 'admin',
  });
  return { username: 'admin', password };
}

function handleClientMessage(services: Services, clientId: string, raw: string): void {
  let message: ClientMessage;
  try {
    message = JSON.parse(raw) as ClientMessage;
  } catch {
    services.hub.sendTo(clientId, {
      type: 'error',
      code: 'bad_json',
      message: 'Message was not valid JSON',
    });
    return;
  }

  const { hub, store } = services;

  switch (message.type) {
    case 'subscribe:dashboard': {
      hub.subscribeDashboard(clientId, message.eventIds);
      hub.sendTo(clientId, { type: 'status', status: hub.connectionStatus });
      hub.sendTo(clientId, { type: 'event:status', statuses: store.eventStatuses() });
      break;
    }

    case 'subscribe:view': {
      const view = hub.subscribeView(clientId, message.viewId, message.secret);
      if (!view) {
        hub.sendTo(clientId, {
          type: 'error',
          code: 'unauthorized_view',
          message: 'That overlay link is not valid. It may have been rotated or deleted.',
        });
        return;
      }
      const eventId = view.eventId as Id | null;
      const sets = view.phaseGroupId
        ? store.listSetsByPhaseGroup(view.phaseGroupId)
        : eventId
          ? store.listSets(eventId)
          : [];

      hub.sendTo(clientId, {
        type: 'view:snapshot',
        view,
        theme: store.getTheme(view.themeId) ?? store.listThemes()[0]!,
        event: eventId ? store.getEvent(eventId) : null,
        sets,
        entrants: eventId ? store.listEntrants(eventId) : [],
        standings: eventId ? store.listStandings(eventId) : [],
        status: hub.connectionStatus,
        serverTime: Date.now(),
      });
      break;
    }

    case 'camera:set': {
      // Camera commands over the socket are how the director panel gets its
      // instant feel; the REST equivalent exists for scripted/automated control.
      hub.setCamera(
        message.viewId,
        message.camera,
        message.manualInput ? 'operator' : 'operator',
      );
      break;
    }

    case 'autofollow:set': {
      hub.setAutoFollow(message.viewId, message.autoFollow);
      break;
    }

    case 'ping':
      hub.sendTo(clientId, { type: 'pong', t: message.t });
      break;

    default:
      hub.sendTo(clientId, {
        type: 'error',
        code: 'unknown_message',
        message: `Unrecognised message type`,
      });
  }
}

export async function buildApp(services: Services): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: undefined,
    },
    // OBS and phones sit on the LAN; trusting the proxy header is wrong here.
    trustProxy: false,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 1024 * 1024 },
  });

  registerAuthContext(app, services);
  registerAuthRoutes(app, services);
  registerTournamentRoutes(app, services);
  registerReportingRoutes(app, services);
  registerViewRoutes(app, services);
  registerAdminRoutes(app, services);

  app.get('/ws', { websocket: true }, (socket) => {
    const clientId = services.hub.addClient(socket as never);

    socket.on('message', (data: Buffer) => {
      handleClientMessage(services, clientId, data.toString());
    });
    socket.on('close', () => services.hub.removeClient(clientId));
    socket.on('error', () => services.hub.removeClient(clientId));
  });

  // ---- Static web assets ---------------------------------------------------

  const webRoot = services.config.webRoot;
  if (webRoot && existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });

    // SPA fallback: anything that is not an API route or a real file serves the
    // app shell, so deep links like /views/abc/director survive a refresh.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.code(404).send({
        error:
          'Web assets are not built. Run `npm run build -w @bracket/web`, or use the Vite dev server on port 5173.',
      });
    });
  }

  return app;
}

export interface StartedServer {
  app: FastifyInstance;
  services: Services;
  url: string;
  lanUrls: string[];
  credentials: BootstrapCredentials | null;
  stop(): Promise<void>;
}

export async function startServer(
  services: Services,
  config: AppConfig,
): Promise<StartedServer> {
  const credentials = await ensureBootstrapUser(services);
  const app = await buildApp(services);

  await app.listen({ host: config.host, port: config.port });

  services.hub.start();
  if (config.syncEnabled) {
    services.sync.start();
    services.outbox.start();
  }
  // Establish the initial online/offline signal rather than assuming reachable.
  void services.client.healthcheck();

  const url = `http://localhost:${config.port}`;
  const lanUrls = config.allowLan
    ? localAddresses().map((address) => `http://${address}:${config.port}`)
    : [];

  return {
    app,
    services,
    url,
    lanUrls,
    credentials,
    async stop() {
      services.shutdown();
      await app.close();
    },
  };
}
