/**
 * Sync and store behaviour.
 *
 * These run against the mock transport and a temporary database, so they
 * exercise the real client, store and engine without a network.
 */

import { ActivityState } from '@bracket/shared';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Store } from '../dist/db/store.js';
import { StartggClient } from '../dist/startgg/client.js';
import { MockTransport, MockWorld } from '../dist/startgg/mock.js';
import { SyncEngine } from '../dist/sync/engine.js';

const tempDirs: string[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'bracket-test-'));
  tempDirs.push(dir);
  return new Store(join(dir, 'test.sqlite'));
}

interface HarnessOptions {
  /** Play every bracket out first, giving a tournament that is already over. */
  finished?: boolean;
  clientOptions?: Record<string, unknown>;
  engineOptions?: Record<string, unknown>;
  /** Extra mock-transport behaviour, e.g. hiding played sets from event reads. */
  mockOptions?: Record<string, unknown>;
  /** Wraps the mock transport, e.g. to make one operation answer with nothing. */
  wrapTransport?: (inner: any) => any;
}

function harness(options: HarnessOptions = {}) {
  const world = new MockWorld();
  if (options.finished) world.completeAll();
  // autoAdvanceMs 0 keeps the simulation still so assertions are deterministic.
  const mock = new MockTransport(world, { autoAdvanceMs: 0, ...(options.mockOptions ?? {}) });
  const transport = options.wrapTransport ? options.wrapTransport(mock) : mock;
  const client = new StartggClient(transport, {
    requestsPerMinute: 10000,
    ...(options.clientOptions ?? {}),
  });
  const store = freshStore();
  const sync = new SyncEngine(store, client, options.engineOptions ?? {});
  return { world, transport, client, store, sync };
}

/** The 8-entrant double elimination event, which has a known 15 sets. */
function mainEvent(store: Store) {
  const event = store
    .listEvents()
    .find((e) => e.phases[0]?.bracketType === 'DOUBLE_ELIMINATION');
  assert.ok(event, 'the double elimination event was imported');
  return event;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`condition not met within ${timeoutMs}ms`);
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test('importing a tournament stores every event, bracket and set', async () => {
  const { store, sync, world } = harness();

  const result = await sync.importTournament(world.slug);
  assert.ok(result);
  assert.equal(result.events, 4);

  const tournaments = store.listTournaments();
  assert.equal(tournaments.length, 1);

  const events = store.listEvents();
  assert.equal(events.length, 4);

  const bracketTypes = events.map((e) => e.phases[0]?.bracketType).sort();
  assert.deepEqual(bracketTypes, [
    'DOUBLE_ELIMINATION',
    'ROUND_ROBIN',
    'ROUND_ROBIN',
    'SINGLE_ELIMINATION',
  ]);

  // The multi-phase event keeps both of its phases.
  const multi = events.find((e) => e.phases.length > 1);
  assert.ok(multi, 'the pools-into-top-cut event survived the import');
  assert.deepEqual(
    multi.phases.map((p) => p.bracketType),
    ['ROUND_ROBIN', 'SINGLE_ELIMINATION'],
  );

  // The double elim event carries the full 8-entrant bracket.
  const main = events.find((e) => e.phases[0]?.bracketType === 'DOUBLE_ELIMINATION');
  assert.ok(main);
  assert.equal(store.listSets(main.id).length, 15);
  assert.equal(store.listEntrants(main.id).length, 8);
});

test('a finished tournament imports its whole set history', async () => {
  const { store, sync, world } = harness({ finished: true });

  const result = await sync.importTournament(world.slug);
  assert.ok(result);

  const main = mainEvent(store);
  const sets = store.listSets(main.id);

  // The point of importing a tournament that is over is the results: every set
  // has to arrive, with its winner and score, not just the ones still callable.
  assert.equal(sets.length, 15);
  assert.ok(
    sets.every((s) => s.state === ActivityState.Completed),
    'every set came back completed',
  );
  assert.ok(sets.every((s) => s.winnerId !== null), 'every set kept its winner');
  assert.ok(sets.every((s) => s.slots.some((slot) => slot.score !== null)), 'scores survived');

  const status = store.eventStatuses().find((s) => s.eventId === main.id)!;
  assert.equal(status.totalSets, 15);
  assert.equal(status.completedSets, 15);
});

test('call order is never used to read sets: it hides the ones already played', async () => {
  // The regression itself. start.gg builds CALL_ORDER from the queue of sets
  // waiting for a station, so a finished bracket has nothing in it — which is
  // what left completed tournaments importing with an empty bracket.
  const callOrder = harness({ finished: true, clientOptions: { setsSortType: 'CALL_ORDER' } });
  const eventId = callOrder.world.events[0]!.id;
  assert.equal((await callOrder.client.fetchEventSets(eventId, null)).sets.length, 0);

  const standard = harness({ finished: true });
  assert.equal(standard.client.health.setsSortType, 'STANDARD');
  assert.equal((await standard.client.fetchEventSets(eventId, null)).sets.length, 15);
});

test('an event the event-level read will not answer for is backfilled from its pools', async () => {
  // Belt and braces for the same failure arriving some other way: whatever the
  // sort, an unfiltered read that comes back empty for an event that has
  // brackets is wrong, so each phase group is asked directly instead.
  const { store, sync, world } = harness({
    finished: true,
    wrapTransport: (inner) => ({
      name: inner.name,
      endpoint: inner.endpoint,
      canMutate: inner.canMutate,
      async execute(request: any) {
        if ((request.operationName ?? '') === 'EventSets') {
          return {
            event: {
              id: String(request.variables?.eventId),
              sets: { nodes: [], pageInfo: { total: 0, totalPages: 1, page: 1 } },
            },
          };
        }
        return inner.execute(request);
      },
    }),
  });

  await sync.importTournament(world.slug);

  const main = mainEvent(store);
  assert.equal(store.listSets(main.id).length, 15);

  // Sets read off a phase group still land under the right event and bracket.
  assert.ok(store.listSets(main.id).every((s) => s.eventId === main.id));
  const groupId = main.phases[0]!.groups[0]!.id;
  assert.equal(store.listSetsByPhaseGroup(groupId).length, 15);

  // And the multi-phase event keeps its pools and its top cut apart.
  const multi = store.listEvents().find((e) => e.phases.length > 1)!;
  const byPhase = new Set(store.listSets(multi.id).map((s) => s.phaseId));
  assert.equal(byPhase.size, 2);
});

test('an event that stored no sets is repaired without waiting for a full reconcile', async () => {
  // A database written by the broken build: the watermark is up to date but no
  // set ever landed, so a delta read can only ever return nothing.
  const { store, sync, world } = harness({
    finished: true,
    engineOptions: {
      tickMs: 10,
      cadence: {
        liveMs: 20,
        warmMs: 20,
        idleMs: 20,
        doneMs: 20,
        // An hour: only the empty-store check can force an unfiltered read here.
        fullReconcileMs: 3_600_000,
      },
    },
  });

  await sync.importTournament(world.slug);
  const main = mainEvent(store);
  assert.equal(store.countSets(main.id), 15);

  sync.refreshTrackedEvents();
  sync.start();
  try {
    // Let the engine bank its one full reconcile first.
    await waitFor(() =>
      sync.listStates().some((s) => s.eventId === main.id && s.lastFullReconcileAt !== null),
    );

    store.db.prepare('DELETE FROM sets WHERE event_id = ?').run(main.id);
    assert.equal(store.countSets(main.id), 0);
    assert.ok(store.getWatermark(main.id)! > 0, 'the watermark is still current');

    await waitFor(() => store.countSets(main.id) === 15);
  } finally {
    sync.stop();
  }
});

test('a finished event is read bracket by bracket even when the event read answers', async () => {
  // The failure that survived switching the sort: the event-level resolver
  // answers, so nothing looks wrong, but every set it lists is unplayed. For an
  // event start.gg itself calls finished that answer cannot be right, so the
  // read goes to the per-bracket resolver, which does list played sets.
  const { store, sync, world } = harness({
    finished: true,
    wrapTransport: (inner) => ({
      name: inner.name,
      endpoint: inner.endpoint,
      canMutate: inner.canMutate,
      async execute(request: any) {
        const data: any = await inner.execute(request);
        if ((request.operationName ?? '') !== 'EventSets') return data;
        // Same sets, stripped of every sign that they were ever played.
        for (const node of data?.event?.sets?.nodes ?? []) {
          node.state = 1;
          node.winnerId = null;
          node.completedAt = null;
          node.games = [];
          for (const slot of node.slots ?? []) slot.standing = null;
        }
        return data;
      },
    }),
  });

  await sync.importTournament(world.slug);

  const sets = store.listSets(mainEvent(store).id);
  assert.equal(sets.length, 15);
  assert.ok(
    sets.every((s) => s.state === ActivityState.Completed),
    'the per-bracket read supplied the results the event read withheld',
  );
  assert.ok(sets.every((s) => s.winnerId !== null), 'winners came through');
});

test('an event read that hands over fewer sets than it claims is completed from its pools', async () => {
  // start.gg reporting `total: 15` and then handing over three of them is not a
  // quiet event, it is a short read — and believing it leaves twelve matches
  // missing with nothing to say so.
  const { store, sync, world } = harness({
    finished: true,
    wrapTransport: (inner) => ({
      name: inner.name,
      endpoint: inner.endpoint,
      canMutate: inner.canMutate,
      async execute(request: any) {
        const data: any = await inner.execute(request);
        if ((request.operationName ?? '') !== 'EventSets') return data;
        const connection = data?.event?.sets;
        if (!connection) return data;
        const total = connection.pageInfo?.total ?? connection.nodes.length;
        connection.nodes = connection.nodes.slice(0, 3);
        connection.pageInfo = { total, totalPages: 1, page: 1 };
        return data;
      },
    }),
  });

  await sync.importTournament(world.slug);
  assert.equal(store.listSets(mainEvent(store).id).length, 15);
});

test('brackets missing from the database are re-read rather than leaving an empty event', async () => {
  // A structure read that came back without phase groups used to be terminal:
  // the per-bracket fallback had nothing to iterate, returned an empty array,
  // and the event sat at zero sets with no error anywhere. The structure is now
  // re-read to recover them.
  const { store, sync, world } = harness({
    finished: true,
    mockOptions: { hideCompletedFromEventSets: true },
    engineOptions: { tickMs: 10, cadence: { doneMs: 20, fullReconcileMs: 3_600_000 } },
  });

  await sync.importTournament(world.slug);
  const main = mainEvent(store);
  assert.equal(store.countSets(main.id), 15);

  // Wipe the sets and the brackets they were read from.
  store.db.prepare('DELETE FROM sets WHERE event_id = ?').run(main.id);
  store.db.prepare('DELETE FROM phase_groups WHERE event_id = ?').run(main.id);
  assert.equal(store.getEvent(main.id)!.phases[0]!.groups.length, 0);

  sync.refreshTrackedEvents();
  sync.requestSync(main.id, true, true);
  sync.start();
  try {
    await waitFor(() => store.countSets(main.id) === 15);
  } finally {
    sync.stop();
  }
  assert.ok(
    store.getEvent(main.id)!.phases[0]!.groups.length > 0,
    'the brackets came back with the sets',
  );
});

test('a requested deep read ignores the rate limit that paces the automatic one', async () => {
  // The pool-by-pool read is throttled so an unseeded 64-pool event is not
  // polled to death. A person pressing "Load every set" is not that, and used
  // to be silently ignored for up to a full reconcile interval.
  const { store, sync, world } = harness({
    finished: true,
    mockOptions: { hideCompletedFromEventSets: true },
    engineOptions: { tickMs: 10, cadence: { doneMs: 20, fullReconcileMs: 3_600_000 } },
  });

  await sync.importTournament(world.slug);
  const main = mainEvent(store);
  assert.equal(store.countSets(main.id), 15);

  store.db.prepare('DELETE FROM sets WHERE event_id = ?').run(main.id);
  sync.refreshTrackedEvents();
  sync.requestSync(main.id, true, true);
  sync.start();
  try {
    await waitFor(() => store.countSets(main.id) === 15, 3000);
  } finally {
    sync.stop();
  }
});

test('an event left with no sets says why on its own card', async () => {
  // Silence is the thing being fixed. An unfiltered read that leaves an event
  // empty records that fact where the operator is already looking.
  const { store, sync, world } = harness({
    wrapTransport: (inner) => ({
      name: inner.name,
      endpoint: inner.endpoint,
      canMutate: inner.canMutate,
      async execute(request: any) {
        const op = request.operationName ?? '';
        if (op === 'EventSets') {
          return {
            event: {
              id: String(request.variables?.eventId),
              sets: { nodes: [], pageInfo: { total: 0, totalPages: 1, page: 1 } },
            },
          };
        }
        if (op === 'PhaseGroupSets') {
          return {
            phaseGroup: {
              id: String(request.variables?.phaseGroupId),
              displayIdentifier: 'A',
              bracketType: 'DOUBLE_ELIMINATION',
              state: 2,
              rounds: [],
              sets: { nodes: [], pageInfo: { total: 0, totalPages: 1, page: 1 } },
            },
          };
        }
        return inner.execute(request);
      },
    }),
  });

  await sync.importTournament(world.slug);
  const main = mainEvent(store);
  assert.equal(store.countSets(main.id), 0);

  const status = store.eventStatuses().find((s) => s.eventId === main.id)!;
  assert.match(status.syncError ?? '', /no sets/i);
});

test('an unknown slug reports not-found rather than throwing', async () => {
  const { sync } = harness();
  const result = await sync.importTournament('no-such-tournament');
  assert.equal(result, null);
});

test('a delta pass returns nothing when the bracket has not moved', async () => {
  const { store, sync, client, world } = harness();
  await sync.importTournament(world.slug);

  const eventId = store.listEvents()[0]!.id;
  const watermark = store.getWatermark(eventId);
  assert.ok(watermark && watermark > 0, 'import records a watermark');

  // Nothing changed upstream, so the filtered query comes back empty.
  const { sets } = await client.fetchEventSets(eventId, watermark);
  assert.equal(sets.length, 0);
});

test('a delta pass returns only the sets that actually changed', async () => {
  const { store, sync, client, world } = harness();
  await sync.importTournament(world.slug);

  const events = store.listEvents();
  const main = events.find((e) => e.phases[0]?.bracketType === 'DOUBLE_ELIMINATION')!;
  const before = store.getWatermark(main.id)!;

  // Advance one match in the simulation.
  await new Promise((r) => setTimeout(r, 1100));
  world.tick();
  const changedUpstream = world.events
    .find((e) => e.id === main.id)!
    .sets.filter((s) => s.updatedAt > before);
  assert.ok(changedUpstream.length > 0, 'the simulation moved something');

  // Queried at the exact watermark, only the moved sets come back.
  const { sets } = await client.fetchEventSets(main.id, before);
  assert.equal(sets.length, changedUpstream.length);
  assert.ok(sets.length < 15, 'not the whole bracket');

  // The engine deliberately rewinds the watermark by an overlap before asking,
  // to absorb clock skew. That re-fetches a few sets, and the content hash is
  // what stops them counting as changes.
  const { sets: overlapped } = await client.fetchEventSets(main.id, before - 90);
  assert.ok(overlapped.length >= sets.length, 'the overlap widens the window');
  const { upserted } = store.upsertSets(overlapped);
  assert.ok(
    upserted.length <= changedUpstream.length,
    'only genuinely changed sets are written',
  );
});

test('the store skips sets whose visible content is unchanged', async () => {
  const { store, sync, client, world } = harness();
  await sync.importTournament(world.slug);

  const eventId = store.listEvents()[0]!.id;
  const { sets } = await client.fetchEventSets(eventId, null);

  // Re-applying the identical payload must report zero changes, which is what
  // stops overlays re-rendering on every poll.
  const again = store.upsertSets(sets);
  assert.equal(again.upserted.length, 0);
  assert.equal(again.unchanged, sets.length);

  // A genuine change is detected.
  const first = sets[0]!;
  const mutated = { ...first, state: 2, identifier: first.identifier };
  const changed = store.upsertSets([mutated]);
  assert.equal(changed.upserted.length, 1);
});

test('sync tiers adapt to what the event is doing', async () => {
  const { store, sync, world } = harness();
  await sync.importTournament(world.slug);
  sync.refreshTrackedEvents();

  const states = sync.listStates();
  assert.equal(states.length, 4, 'every imported event is tracked');
  assert.ok(states.every((s) => s.nextRunAt > 0));

  // Untracking an event removes it from the loop.
  const eventId = store.listEvents()[0]!.id;
  store.setEventTracked(eventId, false);
  sync.refreshTrackedEvents();
  assert.equal(sync.listStates().length, 3);
});

test('event status counts reflect the bracket', async () => {
  const { store, sync, world } = harness();
  await sync.importTournament(world.slug);

  const statuses = store.eventStatuses();
  assert.equal(statuses.length, 4);
  for (const status of statuses) {
    assert.equal(
      status.totalSets,
      status.completedSets + status.activeSets + status.pendingSets,
      'set counts partition the bracket',
    );
    assert.ok(status.lastSyncedAt !== null);
  }
});

test('standings are recorded on import', async () => {
  const { store, sync, world } = harness();
  await sync.importTournament(world.slug);

  const eventId = store.listEvents()[0]!.id;
  const standings = store.listStandings(eventId);
  assert.ok(standings.length > 0);
  assert.equal(standings[0]!.placement, 1);
});

test('views get unguessable secrets and independent cameras', async () => {
  const store = freshStore();

  const a = store.createView({ name: 'Stream', kind: 'bracket', eventId: '1', phaseGroupId: null });
  const b = store.createView({ name: 'Lobby TV', kind: 'bracket', eventId: '1', phaseGroupId: null });

  assert.notEqual(a.secret, b.secret);
  assert.ok(a.secret.length >= 32);

  // Aiming one camera must not move the other — the whole point of separate views.
  store.updateView(a.id, {
    camera: { ...a.camera, mode: 'match', targetSetId: 'set-1' },
  });
  assert.equal(store.getView(a.id)!.camera.mode, 'match');
  assert.equal(store.getView(b.id)!.camera.mode, 'fit');

  // Rotating a secret invalidates the old URL but keeps the view id.
  const rotated = store.rotateViewSecret(a.id)!;
  assert.equal(rotated.id, a.id);
  assert.notEqual(rotated.secret, a.secret);
});

test('built-in themes are seeded and protected from deletion', () => {
  const store = freshStore();
  const themes = store.listThemes();
  assert.ok(themes.length >= 3);
  assert.ok(themes.every((t) => t.builtIn));
  assert.equal(store.deleteTheme(themes[0]!.id), false);
});
