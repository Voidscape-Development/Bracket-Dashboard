/**
 * User management, settings and the network panel.
 */

import { ROLES, type Id, type Role } from '@bracket/shared';
import type { FastifyInstance } from 'fastify';
import { networkInterfaces } from 'node:os';
import { z } from 'zod';

import { hashPassword } from '../auth/passwords.js';
import type { Services } from '../services.js';
import { requirePermission, requireSignedIn } from './auth.js';

const createUserSchema = z.object({
  username: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Letters, numbers, dots, dashes and underscores only'),
  password: z.string().min(8).max(200),
  role: z.enum(ROLES as unknown as [Role, ...Role[]]),
  eventScope: z.array(z.string()).max(100).optional(),
});

const updateUserSchema = z.object({
  role: z.enum(ROLES as unknown as [Role, ...Role[]]).optional(),
  eventScope: z.array(z.string()).max(100).optional(),
  disabled: z.boolean().optional(),
  password: z.string().min(8).max(200).optional(),
});

const settingsSchema = z.object({
  transport: z.enum(['web', 'official', 'mock']).optional(),
  token: z.string().nullable().optional(),
});

/** Every LAN address the app is reachable on, for the connect panel. */
export function localAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

export function registerAdminRoutes(app: FastifyInstance, services: Services): void {
  const { store } = services;

  app.get('/api/users', { onRequest: requirePermission('user:manage') }, async () => ({
    users: store.listUsers(),
  }));

  app.post('/api/users', { onRequest: requirePermission('user:manage') }, async (request, reply) => {
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid user', detail: parsed.error.issues });
    }
    if (store.getUserByUsername(parsed.data.username)) {
      return reply.code(409).send({ error: 'That username is already taken' });
    }

    const user = store.createUser({
      username: parsed.data.username,
      passwordHash: await hashPassword(parsed.data.password),
      role: parsed.data.role,
      eventScope: parsed.data.eventScope ?? [],
    });
    store.audit({
      userId: request.sessionUser?.id ?? null,
      username: request.sessionUser?.username ?? null,
      action: 'user:create',
      target: user.id,
      detail: { role: user.role },
    });
    return { user };
  });

  app.patch(
    '/api/users/:id',
    { onRequest: requirePermission('user:manage') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = updateUserSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid update', detail: parsed.error.issues });
      }

      const target = store.getUser(id);
      if (!target) return reply.code(404).send({ error: 'User not found' });

      // Never let the last admin lose admin, or an install becomes unmanageable.
      if (target.role === 'admin' && parsed.data.role && parsed.data.role !== 'admin') {
        const admins = store.listUsers().filter((u) => u.role === 'admin' && !u.disabled);
        if (admins.length <= 1) {
          return reply.code(400).send({ error: 'This is the only admin account' });
        }
      }

      const patch: Parameters<typeof store.updateUser>[1] = {
        role: parsed.data.role,
        eventScope: parsed.data.eventScope,
        disabled: parsed.data.disabled,
      };
      if (parsed.data.password) {
        patch.passwordHash = await hashPassword(parsed.data.password);
        // A password change ends existing sessions for that account.
        store.deleteSessionsForUser(id);
      }
      if (parsed.data.disabled) store.deleteSessionsForUser(id);

      const user = store.updateUser(id, patch);
      return { user };
    },
  );

  app.delete(
    '/api/users/:id',
    { onRequest: requirePermission('user:manage') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const target = store.getUser(id);
      if (!target) return reply.code(404).send({ error: 'User not found' });
      if (target.id === request.sessionUser?.id) {
        return reply.code(400).send({ error: 'You cannot delete your own account' });
      }
      if (target.role === 'admin') {
        const admins = store.listUsers().filter((u) => u.role === 'admin' && !u.disabled);
        if (admins.length <= 1) {
          return reply.code(400).send({ error: 'This is the only admin account' });
        }
      }
      store.deleteUser(id);
      return { ok: true };
    },
  );

  app.get('/api/settings', { onRequest: requireSignedIn }, async (request) => {
    const isAdmin = request.sessionUser?.role === 'admin';
    return {
      transport: services.config.transport,
      // The token itself is never returned; the UI only needs to know if one is set.
      hasToken: Boolean(services.config.startggToken),
      canMutate: services.client.canMutate,
      health: services.client.health,
      network: isAdmin
        ? {
            host: services.config.host,
            port: services.config.port,
            allowLan: services.config.allowLan,
            addresses: localAddresses(),
          }
        : null,
      dataDir: isAdmin ? services.config.dataDir : null,
    };
  });

  app.patch(
    '/api/settings',
    { onRequest: requirePermission('settings:manage') },
    async (request, reply) => {
      const parsed = settingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid settings', detail: parsed.error.issues });
      }
      services.applyTransportSettings(parsed.data);
      store.audit({
        userId: request.sessionUser?.id ?? null,
        username: request.sessionUser?.username ?? null,
        action: 'settings:update',
        detail: { transport: parsed.data.transport, tokenSet: Boolean(parsed.data.token) },
      });

      const reachable = await services.client.healthcheck();
      return {
        transport: services.config.transport,
        hasToken: Boolean(services.config.startggToken),
        canMutate: services.client.canMutate,
        reachable,
      };
    },
  );

  app.get('/api/audit', { onRequest: requirePermission('user:manage') }, async (request) => {
    const query = request.query as { limit?: string };
    return { entries: store.listAudit(Math.min(1000, Number(query.limit ?? 200) || 200)) };
  });

  app.get('/api/health', async () => ({
    ok: true,
    startgg: services.client.health,
    clients: services.hub.clientCount,
    queue: store.outboxCounts(),
  }));

  /** Stations and streams for the reporting UI's assignment controls. */
  app.get(
    '/api/events/:eventId/stations',
    { onRequest: requireSignedIn },
    async (request, reply) => {
      const { eventId } = request.params as { eventId: Id };
      try {
        return await services.client.fetchStationsAndStreams(eventId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(502).send({ error: message, stations: [], streams: [] });
      }
    },
  );
}
