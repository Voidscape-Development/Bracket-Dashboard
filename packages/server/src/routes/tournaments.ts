/**
 * Tournament, event and bracket reads, plus import/sync triggers.
 */

import { layoutBracket, parseStartggUrl, type Id } from '@bracket/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Services } from '../services.js';
import { requirePermission, requireSignedIn } from './auth.js';

const importSchema = z.object({
  url: z.string().min(1).max(500),
});

export function registerTournamentRoutes(app: FastifyInstance, services: Services): void {
  const { store, sync } = services;

  app.get('/api/tournaments', { onRequest: requireSignedIn }, async () => ({
    tournaments: store.listTournaments(),
    statuses: store.eventStatuses(),
  }));

  app.post(
    '/api/tournaments/import',
    { onRequest: requirePermission('tournament:import') },
    async (request, reply) => {
      const parsed = importSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'A start.gg tournament URL is required' });
      }

      const target = parseStartggUrl(parsed.data.url);
      if (!target) {
        return reply.code(400).send({
          error:
            'That does not look like a start.gg tournament link. Paste the URL from your browser, e.g. https://www.start.gg/tournament/your-event',
        });
      }

      try {
        const result = await sync.importTournament(target.tournamentSlug);
        if (!result) {
          return reply.code(404).send({
            error: `start.gg has no tournament at "${target.tournamentSlug}". Check the link, or that the tournament is public.`,
          });
        }

        store.audit({
          userId: request.sessionUser?.id ?? null,
          username: request.sessionUser?.username ?? null,
          action: 'tournament:import',
          target: result.tournamentId,
          detail: { slug: target.tournamentSlug, events: result.events },
        });

        const tournament = store.getTournament(result.tournamentId);
        services.hub.broadcast({ type: 'event:status', statuses: store.eventStatuses() });
        return { tournament, events: result.events };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(502).send({ error: `Import failed: ${message}` });
      }
    },
  );

  app.delete(
    '/api/tournaments/:id',
    { onRequest: requirePermission('tournament:import') },
    async (request) => {
      const { id } = request.params as { id: Id };
      store.deleteTournament(id);
      sync.refreshTrackedEvents();
      return { ok: true };
    },
  );

  app.post(
    '/api/sync',
    { onRequest: requirePermission('tournament:sync') },
    async (request) => {
      const body = (request.body ?? {}) as { eventId?: Id; full?: boolean };
      sync.requestSync(body.eventId, body.full ?? false);
      return { ok: true, states: sync.listStates() };
    },
  );

  app.get('/api/sync/status', { onRequest: requireSignedIn }, async () => ({
    running: sync.isRunning,
    states: sync.listStates(),
    health: services.client.health,
    statuses: store.eventStatuses(),
  }));

  app.get('/api/events/:eventId', { onRequest: requireSignedIn }, async (request, reply) => {
    const { eventId } = request.params as { eventId: Id };
    const event = store.getEvent(eventId);
    if (!event) return reply.code(404).send({ error: 'Event not found' });

    return {
      event,
      sets: store.listSets(eventId),
      entrants: store.listEntrants(eventId),
      standings: store.listStandings(eventId),
      status: store.eventStatuses().find((s) => s.eventId === eventId) ?? null,
    };
  });

  app.patch(
    '/api/events/:eventId',
    { onRequest: requirePermission('tournament:sync') },
    async (request, reply) => {
      const { eventId } = request.params as { eventId: Id };
      const body = (request.body ?? {}) as { tracked?: boolean };
      if (typeof body.tracked === 'boolean') {
        store.setEventTracked(eventId, body.tracked);
        sync.refreshTrackedEvents();
      }
      const event = store.getEvent(eventId);
      if (!event) return reply.code(404).send({ error: 'Event not found' });
      return { event };
    },
  );

  /**
   * Server-side layout. The dashboard and overlays can lay out locally too, but
   * exposing it keeps a thin client (a TV browser, a future control surface)
   * from needing the layout code at all.
   */
  app.get(
    '/api/phase-groups/:groupId/layout',
    { onRequest: requireSignedIn },
    async (request, reply) => {
      const { groupId } = request.params as { groupId: Id };
      const sets = store.listSetsByPhaseGroup(groupId);
      if (sets.length === 0) {
        return reply.code(404).send({ error: 'No sets found for that bracket' });
      }
      const eventId = sets[0]?.eventId as Id;
      const event = store.getEvent(eventId);
      const group = event?.phases
        .flatMap((p) => p.groups)
        .find((g) => g.id === groupId);

      return {
        layout: layoutBracket({
          sets,
          bracketType: group?.bracketType ?? 'DOUBLE_ELIMINATION',
          entrants: store.listEntrants(eventId),
          rounds: group?.rounds ?? [],
        }),
        sets,
      };
    },
  );
}
