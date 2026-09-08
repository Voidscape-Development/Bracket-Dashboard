/**
 * Multi-phase view resolution.
 *
 * The failure this guards against: an event whose phases each number rounds from
 * 1, rendered as one bracket, interleaves pool round 1 with top-cut round 1 and
 * produces a nonsense layout.
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
import { activePhaseOf, resolveView } from '../dist/views/resolve.js';

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** The mock's two-phase event: round robin pools into a single elim top cut. */
const MULTI_PHASE_EVENT = '100004';
const POOLS_PHASE = '200004';
const TOPCUT_PHASE = '200005';
const POOL_A = '300004';
const POOL_B = '300005';
const TOPCUT_GROUP = '300006';

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'bracket-resolve-'));
  tempDirs.push(dir);
  const world = new MockWorld();
  const client = new StartggClient(new MockTransport(world, { autoAdvanceMs: 0 }), {
    requestsPerMinute: 10000,
  });
  const store = new Store(join(dir, 'test.sqlite'));
  await new SyncEngine(store, client).importTournament(world.slug);
  return { store, world };
}

test('the fixture really does have colliding round numbers across phases', async () => {
  const { store } = await harness();
  const sets = store.listSets(MULTI_PHASE_EVENT);

  const poolRounds = new Set(
    sets.filter((s) => s.phaseId === POOLS_PHASE).map((s) => s.round),
  );
  const cutRounds = new Set(
    sets.filter((s) => s.phaseId === TOPCUT_PHASE).map((s) => s.round),
  );

  assert.ok(poolRounds.size > 0 && cutRounds.size > 0);
  const overlap = [...cutRounds].filter((r) => poolRounds.has(r));
  assert.ok(
    overlap.length > 0,
    'phases share round numbers, so mixing them would collide',
  );
});

test('a view pinned to a pool shows only that pool', async () => {
  const { store } = await harness();
  const view = store.createView({
    name: 'Pool A',
    kind: 'bracket',
    eventId: MULTI_PHASE_EVENT,
    phaseGroupId: POOL_A,
  });

  const resolved = resolveView(store, view);
  assert.equal(resolved.phaseGroup?.id, POOL_A);
  assert.equal(resolved.bracketType, 'ROUND_ROBIN');
  assert.ok(resolved.sets.length > 0);
  assert.ok(
    resolved.sets.every((s) => s.phaseGroupId === POOL_A),
    'no sets from pool B or the top cut leak in',
  );
});

test('a view pinned to a phase never mixes in another phase', async () => {
  const { store } = await harness();
  const view = store.createView({
    name: 'Top cut',
    kind: 'bracket',
    eventId: MULTI_PHASE_EVENT,
    phaseId: TOPCUT_PHASE,
    phaseGroupId: null,
  });

  const resolved = resolveView(store, view);
  assert.equal(resolved.phase?.id, TOPCUT_PHASE);
  assert.equal(resolved.bracketType, 'SINGLE_ELIMINATION');
  assert.ok(resolved.sets.length > 0);
  assert.ok(
    resolved.sets.every((s) => s.phaseId === TOPCUT_PHASE),
    'pool sets are excluded',
  );
});

test('a view with no phase target resolves to one phase, not the whole event', async () => {
  const { store } = await harness();
  const view = store.createView({
    name: 'Untargeted',
    kind: 'bracket',
    eventId: MULTI_PHASE_EVENT,
    phaseGroupId: null,
  });

  const resolved = resolveView(store, view);
  assert.ok(resolved.phase, 'a phase was chosen');

  const phaseIds = new Set(resolved.sets.map((s) => s.phaseId));
  assert.equal(phaseIds.size, 1, 'exactly one phase is rendered');

  const allSets = store.listSets(MULTI_PHASE_EVENT);
  assert.ok(
    resolved.sets.length < allSets.length,
    'the whole event is not dumped into one bracket',
  );
});

test('follow-active-phase tracks play from pools into the top cut', async () => {
  const { store, world } = await harness();
  const view = store.createView({
    name: 'Venue TV',
    kind: 'bracket',
    eventId: MULTI_PHASE_EVENT,
    phaseGroupId: null,
    followActivePhase: true,
  });

  // Nothing has started: the earliest unfinished phase is pools.
  assert.equal(resolveView(store, view).phase?.id, POOLS_PHASE);

  // Finish every pool set and start a top-cut match upstream.
  const event = world.events.find((e) => e.id === MULTI_PHASE_EVENT)!;
  for (const set of event.sets) {
    if (set.phaseId === POOLS_PHASE) {
      set.state = 3;
      set.winnerId = set.slots[0]?.entrantId ?? null;
    } else if (set.round === 1) {
      set.state = 2;
    }
  }
  const client = new StartggClient(new MockTransport(world, { autoAdvanceMs: 0 }), {
    requestsPerMinute: 10000,
  });
  const { sets } = await client.fetchEventSets(MULTI_PHASE_EVENT, null);
  store.upsertSets(sets);

  const resolved = resolveView(store, view);
  assert.equal(resolved.phase?.id, TOPCUT_PHASE, 'the display moved on by itself');
  assert.equal(resolved.bracketType, 'SINGLE_ELIMINATION');
});

test('a multi-pool phase defaults to the busiest pool', async () => {
  const { store, world } = await harness();
  const view = store.createView({
    name: 'Pools TV',
    kind: 'bracket',
    eventId: MULTI_PHASE_EVENT,
    phaseId: POOLS_PHASE,
    phaseGroupId: null,
  });

  // Put a live match in pool B only.
  const event = world.events.find((e) => e.id === MULTI_PHASE_EVENT)!;
  for (const set of event.sets) {
    if (set.phaseGroupId === POOL_B) set.state = 2;
  }
  const client = new StartggClient(new MockTransport(world, { autoAdvanceMs: 0 }), {
    requestsPerMinute: 10000,
  });
  const { sets } = await client.fetchEventSets(MULTI_PHASE_EVENT, null);
  store.upsertSets(sets);

  assert.equal(resolveView(store, view).phaseGroup?.id, POOL_B);
});

test('a deleted pool falls back instead of showing an empty overlay', async () => {
  const { store } = await harness();
  const view = store.createView({
    name: 'Stale pin',
    kind: 'bracket',
    eventId: MULTI_PHASE_EVENT,
    phaseGroupId: 'a-pool-that-no-longer-exists',
  });

  const resolved = resolveView(store, view);
  assert.ok(resolved.phaseGroup, 'resolved to some real bracket');
  assert.ok(resolved.sets.length > 0, 'and it has matches to show');
});

test('single-phase events are unaffected', async () => {
  const { store } = await harness();
  const view = store.createView({
    name: 'Melee singles',
    kind: 'bracket',
    eventId: '100001',
    phaseGroupId: null,
  });

  const resolved = resolveView(store, view);
  assert.equal(resolved.bracketType, 'DOUBLE_ELIMINATION');
  assert.equal(resolved.sets.length, 15, 'the whole bracket still renders');
});

test('activePhaseOf prefers a live phase over an unfinished later one', async () => {
  const { store } = await harness();
  const event = store.getEvent(MULTI_PHASE_EVENT)!;
  const sets = store.listSets(MULTI_PHASE_EVENT);

  const phase = activePhaseOf(event, sets);
  assert.ok(phase);
  assert.equal(phase.id, POOLS_PHASE, 'pools run before the cut');
});

test('view resolution survives an event with no phases', async () => {
  const { store } = await harness();
  const view = store.createView({
    name: 'Orphan',
    kind: 'bracket',
    eventId: 'nonexistent-event',
    phaseGroupId: null,
  });

  const resolved = resolveView(store, view);
  assert.equal(resolved.event, null);
  assert.deepEqual(resolved.sets, []);
});

test('the top cut bracket wires up rather than dangling', async () => {
  const { store } = await harness();
  const view = store.createView({
    name: 'Top cut',
    kind: 'bracket',
    eventId: MULTI_PHASE_EVENT,
    phaseGroupId: TOPCUT_GROUP,
  });

  const { sets } = resolveView(store, view);
  const ids = new Set(sets.map((s) => s.id));
  const feeders = sets
    .flatMap((s) => s.slots)
    .filter((slot) => slot.prereqType === 'set' && slot.prereqId);

  assert.ok(feeders.length > 0, 'the final is fed by earlier sets');
  assert.ok(
    feeders.every((slot) => ids.has(String(slot.prereqId))),
    'every prereq points at a set inside this bracket',
  );
});
