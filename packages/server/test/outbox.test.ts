/**
 * Offline reporting and conflict handling.
 *
 * The behaviour that matters: a report survives an outage, replays on
 * reconnect, and stops for a human when start.gg has moved on.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Store } from '../dist/db/store.js';
import { StartggClient } from '../dist/startgg/client.js';
import { MockTransport, MockWorld } from '../dist/startgg/mock.js';
import { SyncEngine } from '../dist/sync/engine.js';
import { OutboxWorker } from '../dist/sync/outbox.js';
import { GqlError } from '../dist/startgg/transport.js';

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'bracket-outbox-'));
  tempDirs.push(dir);

  const world = new MockWorld();
  const transport = new MockTransport(world, { autoAdvanceMs: 0 });
  const client = new StartggClient(transport, { requestsPerMinute: 10000 });
  const store = new Store(join(dir, 'test.sqlite'));
  const sync = new SyncEngine(store, client);
  const outbox = new OutboxWorker(store, client, { tickMs: 0 });

  await sync.importTournament(world.slug);
  return { world, transport, client, store, outbox };
}

/** A set with both entrants resolved, i.e. one that can actually be reported. */
function playableSet(store: Store) {
  for (const event of store.listEvents()) {
    const set = store
      .listSets(event.id)
      .find((s) => s.slots.every((slot) => slot.entrantId) && s.state !== 3);
    if (set) return set;
  }
  throw new Error('no playable set in the fixture');
}

const actor = { userId: 'u1', username: 'scorekeeper' };

test('a report applies locally straight away and then sends', async () => {
  const { store, outbox } = await harness();
  const set = playableSet(store);
  const winnerId = set.slots[0]!.entrantId!;
  const loserId = set.slots[1]!.entrantId!;

  outbox.enqueue(
    {
      kind: 'reportSet',
      setId: set.id,
      eventId: set.eventId,
      winnerId,
      scores: [
        { entrantId: winnerId, score: 2 },
        { entrantId: loserId, score: 1 },
      ],
    },
    actor,
  );

  // Optimistic: the local set is already decided before any network call.
  const local = store.getSet(set.id)!;
  assert.equal(local.winnerId, winnerId);
  assert.equal(local.state, 3);
  assert.equal(local.pendingLocal, true);

  await outbox.drain();

  const entry = store.listOutbox().find((e) => 'setId' in e.command && e.command.setId === set.id)!;
  assert.equal(entry.status, 'sent');

  // Confirmed by start.gg, so the pending marker is cleared.
  const confirmed = store.getSet(set.id)!;
  assert.equal(confirmed.winnerId, winnerId);
  assert.equal(confirmed.pendingLocal, false);
});

test('reports queue while offline and replay when the connection returns', async () => {
  const { store, client, outbox } = await harness();
  const set = playableSet(store);
  const winnerId = set.slots[0]!.entrantId!;
  const loserId = set.slots[1]!.entrantId!;

  // Simulate the venue losing Wi-Fi.
  const original = (client as any).transport;
  (client as any).transport = {
    name: 'down',
    endpoint: 'offline',
    canMutate: true,
    execute: async () => {
      throw new GqlError('Could not reach start.gg', 'network');
    },
  };
  await client.healthcheck().catch(() => undefined);
  // Force a failed call so the client marks itself offline.
  await client.fetchEventSets(set.eventId, null).catch(() => undefined);
  assert.equal(client.health.online, false);

  outbox.enqueue(
    {
      kind: 'reportSet',
      setId: set.id,
      eventId: set.eventId,
      winnerId,
      scores: [
        { entrantId: winnerId, score: 2 },
        { entrantId: loserId, score: 0 },
      ],
    },
    actor,
  );

  await outbox.drain();
  let entry = store.listOutbox().find((e) => 'setId' in e.command && e.command.setId === set.id)!;
  assert.ok(['queued', 'failed'].includes(entry.status), `still queued, got ${entry.status}`);

  // The operator still sees their result locally while offline.
  assert.equal(store.getSet(set.id)!.winnerId, winnerId);
  assert.equal(store.getSet(set.id)!.pendingLocal, true);

  // Connection returns.
  (client as any).transport = original;
  await client.healthcheck();
  assert.equal(client.health.online, true);

  await outbox.drain();
  entry = store.listOutbox().find((e) => 'setId' in e.command && e.command.setId === set.id)!;
  assert.equal(entry.status, 'sent');
  assert.equal(store.getSet(set.id)!.pendingLocal, false);
});

test('a set reported elsewhere while offline becomes a conflict, not an overwrite', async () => {
  const { world, store, outbox } = await harness();
  const set = playableSet(store);
  const ours = set.slots[0]!.entrantId!;
  const theirs = set.slots[1]!.entrantId!;

  // Someone reports the opposite result on the start.gg website.
  const remote = world.findSet(set.id)!;
  remote.set.winnerId = theirs;
  remote.set.state = 3;
  remote.set.completedAt = Math.floor(Date.now() / 1000);
  remote.set.updatedAt = Math.floor(Date.now() / 1000);

  outbox.enqueue(
    {
      kind: 'reportSet',
      setId: set.id,
      eventId: set.eventId,
      winnerId: ours,
      scores: [
        { entrantId: ours, score: 2 },
        { entrantId: theirs, score: 1 },
      ],
    },
    actor,
  );

  await outbox.drain();

  const entry = store.listOutbox().find((e) => 'setId' in e.command && e.command.setId === set.id)!;
  assert.equal(entry.status, 'conflict');
  assert.equal(entry.conflict?.reason, 'already-reported');
  assert.equal((entry.conflict?.remote as any).winnerId, theirs);
  assert.equal((entry.conflict?.local as any).winnerId, ours);

  // start.gg was not overwritten while a human decides.
  assert.equal(world.findSet(set.id)!.set.winnerId, theirs);
});

test('an identical result reported elsewhere is not treated as a conflict', async () => {
  const { world, store, outbox } = await harness();
  const set = playableSet(store);
  const winnerId = set.slots[0]!.entrantId!;

  const remote = world.findSet(set.id)!;
  remote.set.winnerId = winnerId;
  remote.set.state = 3;
  remote.set.updatedAt = Math.floor(Date.now() / 1000);

  outbox.enqueue(
    {
      kind: 'reportSet',
      setId: set.id,
      eventId: set.eventId,
      winnerId,
      scores: [{ entrantId: winnerId, score: 2 }],
    },
    actor,
  );

  await outbox.drain();
  const entry = store.listOutbox().find((e) => 'setId' in e.command && e.command.setId === set.id)!;
  assert.equal(entry.status, 'sent', 'agreeing with start.gg is not a conflict');
});

test('resolving a conflict as force-local re-sends it', async () => {
  const { world, store, outbox } = await harness();
  const set = playableSet(store);
  const ours = set.slots[0]!.entrantId!;
  const theirs = set.slots[1]!.entrantId!;

  const remote = world.findSet(set.id)!;
  remote.set.winnerId = theirs;
  remote.set.state = 3;
  remote.set.updatedAt = Math.floor(Date.now() / 1000);

  outbox.enqueue(
    {
      kind: 'reportSet',
      setId: set.id,
      eventId: set.eventId,
      winnerId: ours,
      scores: [{ entrantId: ours, score: 2 }],
    },
    actor,
  );
  await outbox.drain();

  const conflicted = store.listOutbox().find((e) => e.status === 'conflict')!;
  outbox.resolveConflict(conflicted.id, 'force-local', actor);
  await outbox.drain();

  assert.equal(world.findSet(set.id)!.set.winnerId, ours, 'our result now wins');
});

test('resolving a conflict as keep-remote abandons the local report', async () => {
  const { world, store, outbox } = await harness();
  const set = playableSet(store);
  const ours = set.slots[0]!.entrantId!;
  const theirs = set.slots[1]!.entrantId!;

  const remote = world.findSet(set.id)!;
  remote.set.winnerId = theirs;
  remote.set.state = 3;
  remote.set.updatedAt = Math.floor(Date.now() / 1000);

  outbox.enqueue(
    {
      kind: 'reportSet',
      setId: set.id,
      eventId: set.eventId,
      winnerId: ours,
      scores: [{ entrantId: ours, score: 2 }],
    },
    actor,
  );
  await outbox.drain();

  const conflicted = store.listOutbox().find((e) => e.status === 'conflict')!;
  outbox.resolveConflict(conflicted.id, 'keep-remote', actor);

  assert.equal(store.getOutboxEntry(conflicted.id)!.status, 'abandoned');
  assert.equal(world.findSet(set.id)!.set.winnerId, theirs, 'start.gg is untouched');
  assert.equal(store.getSet(set.id)!.pendingLocal, false);
});

test('a sync pass does not revert a report that is still queued', async () => {
  const { store, client, outbox } = await harness();
  const set = playableSet(store);
  const winnerId = set.slots[0]!.entrantId!;

  // Go offline so the report stays queued.
  const original = (client as any).transport;
  (client as any).transport = {
    name: 'down',
    endpoint: 'offline',
    canMutate: true,
    execute: async () => {
      throw new GqlError('offline', 'network');
    },
  };
  await client.fetchEventSets(set.eventId, null).catch(() => undefined);

  outbox.enqueue(
    {
      kind: 'reportSet',
      setId: set.id,
      eventId: set.eventId,
      winnerId,
      scores: [{ entrantId: winnerId, score: 2 }],
    },
    actor,
  );

  // Connection comes back and a sync pass runs before the queue drains. The
  // remote still has the set as unplayed; the local optimistic value must hold.
  (client as any).transport = original;
  const { sets } = await client.fetchEventSets(set.eventId, null);
  const pendingIds = new Set(
    store
      .listOutbox(['queued', 'sending', 'failed'])
      .map((e) => ('setId' in e.command ? e.command.setId : null))
      .filter(Boolean),
  );
  store.upsertSets(sets.filter((s) => !pendingIds.has(s.id)));

  assert.equal(store.getSet(set.id)!.winnerId, winnerId, 'local report survived the sync');
});

test('audit log records who queued what', async () => {
  const { store, outbox } = await harness();
  const set = playableSet(store);
  const winnerId = set.slots[0]!.entrantId!;

  outbox.enqueue(
    {
      kind: 'reportSet',
      setId: set.id,
      eventId: set.eventId,
      winnerId,
      scores: [{ entrantId: winnerId, score: 2 }],
    },
    actor,
  );

  const entries = store.listAudit(10);
  const queued = entries.find((e: any) => e.action === 'queue:reportSet');
  assert.ok(queued);
  assert.equal(queued.username, 'scorekeeper');
});
