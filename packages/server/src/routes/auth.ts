/**
 * Session routes and the auth guard used by every other route file.
 *
 * Overlays never come through here: they authenticate with the per-view secret
 * in their URL, because an OBS browser source and a venue TV cannot log in.
 */

import {
  authorize,
  type Id,
  type Permission,
  type SessionUser,
} from '@bracket/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { verifyPassword } from '../auth/passwords.js';
import { toSessionUser, type Services } from '../services.js';

export const SESSION_COOKIE = 'bd_session';

declare module 'fastify' {
  interface FastifyRequest {
    sessionUser: SessionUser | null;
  }
}

function readToken(request: FastifyRequest): string | null {
  const cookie = (request.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
  if (cookie) return cookie;
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

/** Attaches the session user to every request; does not reject on its own. */
export function registerAuthContext(app: FastifyInstance, services: Services): void {
  app.decorateRequest('sessionUser', null);

  app.addHook('onRequest', async (request) => {
    const token = readToken(request);
    if (!token) {
      request.sessionUser = null;
      return;
    }
    const user = services.store.getSessionUser(token);
    request.sessionUser = user ? toSessionUser(user) : null;
  });
}

/**
 * Guard factory. `eventIdFrom` lets a route point at the event being acted on so
 * a scorekeeper scoped to one event cannot report in another.
 */
export function requirePermission(
  permission: Permission,
  eventIdFrom?: (request: FastifyRequest) => Id | null,
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = request.sessionUser;
    if (!user) {
      await reply.code(401).send({ error: 'Not signed in' });
      return;
    }
    const eventId = eventIdFrom ? eventIdFrom(request) : null;
    if (!authorize(user, permission, eventId)) {
      await reply.code(403).send({
        error: `Your role (${user.role}) cannot perform this action`,
        permission,
      });
    }
  };
}

export async function requireSignedIn(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.sessionUser) {
    await reply.code(401).send({ error: 'Not signed in' });
  }
}

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

export function registerAuthRoutes(app: FastifyInstance, services: Services): void {
  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Username and password are required' });
    }

    const record = services.store.getUserByUsername(parsed.data.username);
    // Verify against a dummy hash when the user is unknown so a missing account
    // and a wrong password take the same time to answer.
    const hash =
      record?.passwordHash ??
      'scrypt$00000000000000000000000000000000$' + '0'.repeat(128);
    const ok = await verifyPassword(parsed.data.password, hash);

    if (!record || !ok || record.disabled) {
      services.store.audit({
        userId: record?.id ?? null,
        username: parsed.data.username,
        action: 'login:failed',
      });
      return reply.code(401).send({ error: 'Incorrect username or password' });
    }

    const token = services.store.createSession(
      record.id,
      services.config.sessionTtlMs,
      request.headers['user-agent'] ?? null,
    );
    services.store.audit({
      userId: record.id,
      username: record.username,
      action: 'login',
    });

    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: Math.floor(services.config.sessionTtlMs / 1000),
    });
    return { user: toSessionUser(record), token };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = readToken(request);
    if (token) services.store.deleteSession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => {
    return { user: request.sessionUser };
  });
}
