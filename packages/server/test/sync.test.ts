/**
 * Sync and store behaviour.
 *
 * These run against the mock transport and a temporary database, so they
 * exercise the real client, store and engine without a network.
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

const tempDirs: string[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'bracket-test-'));
  tempDirs.push(dir);
  return new Store(join(dir, 'test.sqlite'));
}

function harness() {
  const world = new MockWorld();
  // autoAdvanceMs 0 keeps the simulation still so assertions are deterministic.
  const transport = new MockTransport(world, { autoAdvanceMs: 0 });
  const client = new StartggClient(transport, { requestsPerMinute: 10000 });
  const store = freshStore();
  const sync = new SyncEngine(store, client);
  return { world, transport, client, store, sync };
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test('importing a tournament stores every event, bracket and set', async () => {
  const { store, sync, world } = harness();

  const result = await sync.importTournament(world.slug);
  assert.ok(result);
  assert.equal(result.events, 3);

  const tournaments = store.listTournaments();
  assert.equal(tournaments.length, 1);

  const events = store.listEvents();
  assert.equal(events.length, 3);

  const bracketTypes = events.map((e) => e.phases[0]?.bracketType).sort();
  assert.deepEqual(bracketTypes, [
    'DOUBLE_ELIMINATION',
    'ROUND_ROBIN',
    'SINGLE_ELIMINATION',
  ]);

  // The double elim event carries the full 8-entrant bracket.
  const main = events.find((e) => e.phases[0]?.bracketType === 'DOUBLE_ELIMINATION');
  assert.ok(main);
  assert.equal(store.listSets(main.id).length, 15);
  assert.equal(store.listEntrants(main.id).length, 8);
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
  assert.equal(states.length, 3, 'every imported event is tracked');
  assert.ok(states.every((s) => s.nextRunAt > 0));

  // Untracking an event removes it from the loop.
  const eventId = store.listEvents()[0]!.id;
  store.setEventTracked(eventId, false);
  sync.refreshTrackedEvents();
  assert.equal(sync.listStates().length, 2);
});

test('event status counts reflect the bracket', async () => {
  const { store, sync, world } = harness();
  await sync.importTournament(world.slug);

  const statuses = store.eventStatuses();
  assert.equal(statuses.length, 3);
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
