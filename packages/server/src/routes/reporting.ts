/**
 * Reporting routes.
 *
 * Every write goes onto the outbox rather than straight to start.gg, so the
 * behaviour is identical online and offline and the operator always gets an
 * immediate answer.
 */

import {
  COMMAND_PERMISSION,
  type ConflictResolution,
  type Id,
  type ReportCommand,
} from '@bracket/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Services } from '../services.js';
import { requirePermission, requireSignedIn } from './auth.js';

const gameSchema = z.object({
  gameNum: z.number().int().positive(),
  winnerId: z.string().min(1),
  stageId: z.number().int().optional(),
  selections: z
    .array(
      z.object({
        entrantId: z.string().min(1),
        characterId: z.number().int().optional(),
        characterName: z.string().optional(),
      }),
    )
    .optional(),
});

const reportSchema = z.object({
  setId: z.string().min(1),
  eventId: z.string().min(1),
  winnerId: z.string().min(1),
  scores: z
    .array(z.object({ entrantId: z.string().min(1), score: z.number().int() }))
    .min(1)
    .max(8),
  games: z.array(gameSchema).max(21).optional(),
  isDq: z.boolean().optional(),
});

const setTargetSchema = z.object({
  setId: z.string().min(1),
  eventId: z.string().min(1),
});

const resetSchema = setTargetSchema.extend({
  resetDependents: z.boolean().default(false),
});

const stationSchema = setTargetSchema.extend({
  stationId: z.string().nullable(),
  stationNumber: z.number().int().nullable(),
});

const streamSchema = setTargetSchema.extend({
  streamId: z.string().nullable(),
  streamName: z.string().nullable(),
});

const seedingSchema = z.object({
  phaseId: z.string().min(1),
  eventId: z.string().min(1),
  seedMapping: z
    .array(z.object({ seedId: z.string().min(1), seedNum: z.number().int().positive() }))
    .min(1)
    .max(512),
});

/** Pulls the event id out of a body so the scope check can use it. */
const eventIdFromBody = (request: FastifyRequest): Id | null => {
  const body = request.body as { eventId?: string } | undefined;
  return body?.eventId ?? null;
};

export function registerReportingRoutes(app: FastifyInstance, services: Services): void {
  const { outbox, store } = services;

  const actorOf = (request: FastifyRequest) => ({
    userId: request.sessionUser?.id ?? null,
    username: request.sessionUser?.username ?? null,
  });

  /** Shared tail: validate, enqueue, hand back the queue entry and the set. */
  const enqueue = (request: FastifyRequest, command: ReportCommand) => {
    const entry = outbox.enqueue(command, actorOf(request));
    const set = 'setId' in command ? store.getSet(command.setId) : null;
    return {
      entry,
      set,
      online: services.client.health.online,
      queued: store.outboxCounts().queued,
    };
  };

  app.post(
    '/api/report/set',
    { onRequest: requirePermission(COMMAND_PERMISSION.reportSet, eventIdFromBody) },
    async (request, reply) => {
      const parsed = reportSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid report', detail: parsed.error.issues });
      }

      const set = store.getSet(parsed.data.setId);
      if (!set) return reply.code(404).send({ error: 'Set not found' });

      const entrantIds = set.slots.map((s) => s.entrantId).filter(Boolean);
      if (!entrantIds.includes(parsed.data.winnerId)) {
        return reply
          .code(400)
          .send({ error: 'The winner must be one of the entrants in this set' });
      }
      // A game log that disagrees with the set score is almost always a slip in
      // the reporting UI; reject it rather than sending start.gg something odd.
      if (parsed.data.games?.length) {
        const wins = new Map<string, number>();
        for (const game of parsed.data.games) {
          wins.set(game.winnerId, (wins.get(game.winnerId) ?? 0) + 1);
        }
        for (const score of parsed.data.scores) {
          const counted = wins.get(score.entrantId) ?? 0;
          if (score.score >= 0 && counted !== score.score) {
            return reply.code(400).send({
              error: `Game log does not match the reported score (${counted} game wins vs a score of ${score.score})`,
            });
          }
        }
      }

      return enqueue(request, { kind: 'reportSet', ...parsed.data });
    },
  );

  app.post(
    '/api/report/in-progress',
    { onRequest: requirePermission(COMMAND_PERMISSION.markInProgress, eventIdFromBody) },
    async (request, reply) => {
      const parsed = setTargetSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
      return enqueue(request, { kind: 'markInProgress', ...parsed.data });
    },
  );

  app.post(
    '/api/report/reset',
    { onRequest: requirePermission(COMMAND_PERMISSION.resetSet, eventIdFromBody) },
    async (request, reply) => {
      const parsed = resetSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
      return enqueue(request, { kind: 'resetSet', ...parsed.data });
    },
  );

  app.post(
    '/api/report/station',
    { onRequest: requirePermission(COMMAND_PERMISSION.assignStation, eventIdFromBody) },
    async (request, reply) => {
      const parsed = stationSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
      return enqueue(request, { kind: 'assignStation', ...parsed.data });
    },
  );

  app.post(
    '/api/report/stream',
    { onRequest: requirePermission(COMMAND_PERMISSION.assignStream, eventIdFromBody) },
    async (request, reply) => {
      const parsed = streamSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
      return enqueue(request, { kind: 'assignStream', ...parsed.data });
    },
  );

  app.post(
    '/api/report/seeding',
    { onRequest: requirePermission(COMMAND_PERMISSION.updateSeeding, eventIdFromBody) },
    async (request, reply) => {
      const parsed = seedingSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
      return enqueue(request, { kind: 'updateSeeding', ...parsed.data });
    },
  );

  // ---- Queue inspection and conflict resolution ----------------------------

  app.get('/api/queue', { onRequest: requireSignedIn }, async () => ({
    entries: store.listOutbox(),
    counts: store.outboxCounts(),
    online: services.client.health.online,
  }));

  app.post(
    '/api/queue/:id/resolve',
    { onRequest: requirePermission('queue:resolve') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { resolution?: ConflictResolution };
      const resolution = body.resolution ?? 'defer';
      if (!['force-local', 'keep-remote', 'defer'].includes(resolution)) {
        return reply.code(400).send({ error: 'Unknown resolution' });
      }

      const entry = outbox.resolveConflict(id, resolution, actorOf(request));
      if (!entry) return reply.code(404).send({ error: 'Queue entry not found' });
      return { entry };
    },
  );

  app.post('/api/queue/drain', { onRequest: requireSignedIn }, async () => {
    await outbox.drain();
    return { counts: store.outboxCounts() };
  });

  app.delete(
    '/api/queue/:id',
    { onRequest: requirePermission('queue:resolve') },
    async (request) => {
      const { id } = request.params as { id: string };
      store.deleteOutboxEntry(id);
      services.hub.publishOutbox();
      return { ok: true };
    },
  );
}
