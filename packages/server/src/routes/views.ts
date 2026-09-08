/**
 * Output view management, theme CRUD, and the director endpoints.
 */

import {
  VIEW_KINDS,
  defaultConfigFor,
  normalizeTheme,
  overlayPath,
  themeToCssText,
  type Id,
  type ViewKind,
} from '@bracket/shared';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { Services } from '../services.js';
import { resolveView } from '../views/resolve.js';
import { requirePermission, requireSignedIn } from './auth.js';

const createViewSchema = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(VIEW_KINDS as unknown as [ViewKind, ...ViewKind[]]),
  eventId: z.string().nullable().optional(),
  phaseId: z.string().nullable().optional(),
  phaseGroupId: z.string().nullable().optional(),
  followActivePhase: z.boolean().optional(),
  themeId: z.string().optional(),
  width: z.number().int().min(100).max(7680).optional(),
  height: z.number().int().min(100).max(4320).optional(),
});

const cameraSchema = z.object({
  mode: z.enum(['fit', 'match', 'column', 'progression', 'manual']).optional(),
  targetSetId: z.string().nullable().optional(),
  targetColumnId: z.string().nullable().optional(),
  progressionDepth: z.number().int().min(0).max(6).optional(),
  zoom: z.number().min(0.01).max(10).optional(),
  centerX: z.number().optional(),
  centerY: z.number().optional(),
  animate: z.boolean().optional(),
});

const autoFollowSchema = z.object({
  enabled: z.boolean().optional(),
  rule: z.enum(['live', 'deepest', 'entrant', 'rotate', 'stream']).optional(),
  entrantId: z.string().nullable().optional(),
  streamName: z.string().nullable().optional(),
  rotateIntervalMs: z.number().int().min(2000).max(600000).optional(),
  shot: z.enum(['match', 'progression', 'column']).optional(),
  resumeAfterManualMs: z.number().int().min(0).max(600000).optional(),
});

const themeSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(80),
  tokens: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  customCss: z.string().max(200_000).optional(),
});

export function registerViewRoutes(app: FastifyInstance, services: Services): void {
  const { store, hub } = services;

  // ---- Views ---------------------------------------------------------------

  app.get('/api/views', { onRequest: requireSignedIn }, async () => ({
    views: store.listViews(),
    viewers: hub.viewerCounts(),
  }));

  app.post('/api/views', { onRequest: requirePermission('view:manage') }, async (request, reply) => {
    const parsed = createViewSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid view', detail: parsed.error.issues });
    }
    const view = store.createView({
      name: parsed.data.name,
      kind: parsed.data.kind,
      eventId: parsed.data.eventId ?? null,
      phaseId: parsed.data.phaseId ?? null,
      phaseGroupId: parsed.data.phaseGroupId ?? null,
      followActivePhase: parsed.data.followActivePhase ?? false,
      themeId: parsed.data.themeId,
      config: defaultConfigFor(parsed.data.kind),
      width: parsed.data.width,
      height: parsed.data.height,
    });
    return { view, url: overlayPath(view) };
  });

  app.patch(
    '/api/views/:id',
    { onRequest: requirePermission('view:manage') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as Record<string, unknown>;

      // Only fields a client is allowed to set; secret and id are never taken
      // from the request.
      const patch: Record<string, unknown> = {};
      for (const key of [
        'name',
        'eventId',
        'phaseId',
        'phaseGroupId',
        'followActivePhase',
        'themeId',
        'config',
        'width',
        'height',
      ]) {
        if (key in body) patch[key] = body[key];
      }

      const view = store.updateView(id, patch);
      if (!view) return reply.code(404).send({ error: 'View not found' });
      hub.publishViewUpdated(view);
      return { view, url: overlayPath(view) };
    },
  );

  app.delete('/api/views/:id', { onRequest: requirePermission('view:manage') }, async (request) => {
    const { id } = request.params as { id: string };
    store.deleteView(id);
    return { ok: true };
  });

  app.post(
    '/api/views/:id/rotate-secret',
    { onRequest: requirePermission('view:manage') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const view = store.rotateViewSecret(id);
      if (!view) return reply.code(404).send({ error: 'View not found' });
      return { view, url: overlayPath(view) };
    },
  );

  /**
   * Duplicating is the intended way to get "same bracket, different display":
   * a stream overlay and a venue TV that share an event but keep independent
   * cameras, themes and auto-follow.
   */
  app.post(
    '/api/views/:id/duplicate',
    { onRequest: requirePermission('view:manage') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const source = store.getView(id);
      if (!source) return reply.code(404).send({ error: 'View not found' });

      const copy = store.createView({
        name: `${source.name} (copy)`,
        kind: source.kind,
        eventId: source.eventId,
        phaseId: source.phaseId,
        phaseGroupId: source.phaseGroupId,
        followActivePhase: source.followActivePhase,
        themeId: source.themeId,
        config: source.config,
        width: source.width,
        height: source.height,
      });
      return { view: copy, url: overlayPath(copy) };
    },
  );

  // ---- Director ------------------------------------------------------------

  app.post(
    '/api/views/:id/camera',
    { onRequest: requirePermission('view:direct') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = cameraSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid camera', detail: parsed.error.issues });
      }
      const view = hub.setCamera(id, parsed.data, 'operator');
      if (!view) return reply.code(404).send({ error: 'View not found' });
      return { view };
    },
  );

  app.post(
    '/api/views/:id/autofollow',
    { onRequest: requirePermission('view:direct') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = autoFollowSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid auto-follow', detail: parsed.error.issues });
      }
      const view = hub.setAutoFollow(id, parsed.data);
      if (!view) return reply.code(404).send({ error: 'View not found' });
      return { view };
    },
  );

  // ---- Themes --------------------------------------------------------------

  app.get('/api/themes', { onRequest: requireSignedIn }, async () => ({
    themes: store.listThemes(),
  }));

  app.post('/api/themes', { onRequest: requirePermission('theme:manage') }, async (request, reply) => {
    const parsed = themeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid theme', detail: parsed.error.issues });
    }
    const theme = normalizeTheme({
      id: parsed.data.id ?? randomUUID().slice(0, 8),
      name: parsed.data.name,
      builtIn: false,
      tokens: parsed.data.tokens as never,
      customCss: parsed.data.customCss ?? '',
      updatedAt: Date.now(),
    });
    store.saveTheme(theme);
    hub.publishThemeUpdated(theme.id);
    return { theme };
  });

  app.patch(
    '/api/themes/:id',
    { onRequest: requirePermission('theme:manage') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const existing = store.getTheme(id);
      if (!existing) return reply.code(404).send({ error: 'Theme not found' });
      if (existing.builtIn) {
        return reply.code(400).send({
          error: 'Built-in themes cannot be edited. Duplicate it first.',
        });
      }

      const parsed = themeSchema.partial().safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid theme', detail: parsed.error.issues });
      }
      const theme = normalizeTheme({
        id,
        name: parsed.data.name ?? existing.name,
        builtIn: false,
        tokens: {
          ...existing.tokens,
          ...(parsed.data.tokens as Partial<typeof existing.tokens> | undefined),
        },
        customCss: parsed.data.customCss ?? existing.customCss,
        updatedAt: Date.now(),
      });
      store.saveTheme(theme);
      hub.publishThemeUpdated(id);
      return { theme };
    },
  );

  app.post(
    '/api/themes/:id/duplicate',
    { onRequest: requirePermission('theme:manage') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const source = store.getTheme(id);
      if (!source) return reply.code(404).send({ error: 'Theme not found' });
      const copy = normalizeTheme({
        ...source,
        id: randomUUID().slice(0, 8),
        name: `${source.name} (copy)`,
        builtIn: false,
        updatedAt: Date.now(),
      });
      store.saveTheme(copy);
      return { theme: copy };
    },
  );

  app.delete(
    '/api/themes/:id',
    { onRequest: requirePermission('theme:manage') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const ok = store.deleteTheme(id);
      if (!ok) {
        return reply.code(400).send({ error: 'That theme is built in and cannot be deleted' });
      }
      return { ok: true };
    },
  );

  /**
   * Themes as a stylesheet. Lets an overlay pull its look with a plain <link>,
   * which is also the simplest path for anyone styling a view by hand.
   */
  app.get('/api/themes/:id/css', async (request, reply) => {
    const { id } = request.params as { id: string };
    const theme = store.getTheme(id);
    if (!theme) return reply.code(404).send('/* theme not found */');
    return reply
      .type('text/css')
      .header('cache-control', 'no-store')
      .send(themeToCssText(theme));
  });

  // ---- Overlay bootstrap (secret-authenticated, no session) ----------------

  /**
   * Everything an overlay needs in one unauthenticated-but-secret-gated call, so
   * a browser source renders on first paint instead of waiting on a socket.
   */
  app.get('/api/overlay/:id/:secret', async (request, reply) => {
    const { id, secret } = request.params as { id: string; secret: string };
    const view = store.getView(id);
    if (!view || view.secret !== secret) {
      return reply.code(404).send({ error: 'Unknown overlay' });
    }

    const resolved = resolveView(store, view);
    const eventId = view.eventId as Id | null;

    return {
      view,
      theme: store.getTheme(view.themeId) ?? store.listThemes()[0] ?? null,
      event: resolved.event,
      phase: resolved.phase,
      phaseGroup: resolved.phaseGroup,
      bracketType: resolved.bracketType,
      sets: resolved.sets,
      entrants: eventId ? store.listEntrants(eventId) : [],
      standings: eventId ? store.listStandings(eventId) : [],
      status: hub.connectionStatus,
      serverTime: Date.now(),
    };
  });
}
