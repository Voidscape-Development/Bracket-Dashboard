/**
 * Activity reporting.
 *
 * The point of the log is that an operator can tell "working" from "stuck" and
 * "finished" from "failed", so the assertions here are about those transitions
 * being visible, not about wording.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { ActivityLog } from '../dist/activity.js';
import { Store } from '../dist/db/store.js';
import { StartggClient } from '../dist/startgg/client.js';
import { MockTransport, MockWorld } from '../dist/startgg/mock.js';
import { SyncEngine } from '../dist/sync/engine.js';

const tempDirs: string[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'bracket-activity-'));
  tempDirs.push(dir);
  return new Store(join(dir, 'test.sqlite'));
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test('a task is visible while it runs and keeps its result afterwards', () => {
  const log = new ActivityLog({ throttleMs: 0 });
  const handle = log.begin({ kind: 'sets', label: 'Pulling set info', total: 4 });

  let snapshot = log.snapshot();
  assert.equal(snapshot.running, 1);
  assert.equal(snapshot.tasks[0]!.label, 'Pulling set info');
  assert.equal(snapshot.tasks[0]!.current, 0);
  assert.equal(snapshot.tasks[0]!.total, 4);

  handle.progress(3, 4, 'Bracket 3 of 4');
  snapshot = log.snapshot();
  assert.equal(snapshot.tasks[0]!.current, 3);
  assert.equal(snapshot.tasks[0]!.detail, 'Bracket 3 of 4');

  handle.succeed('40 sets');
  snapshot = log.snapshot();
  assert.equal(snapshot.running, 0);
  assert.equal(snapshot.tasks[0]!.status, 'done');
  assert.equal(snapshot.tasks[0]!.current, 4, 'a finished task reads as complete');

  // Late calls on a closed task are ignored rather than resurrecting it.
  handle.progress(1, 4);
  assert.equal(log.snapshot().tasks[0]!.status, 'done');
  log.stop();
});

test('a failed task keeps the reason it failed', () => {
  const log = new ActivityLog({ throttleMs: 0 });
  log.begin({ kind: 'import', label: 'Importing' }).fail(new Error('start.gg said no'));

  const snapshot = log.snapshot();
  assert.equal(snapshot.failed, 1);
  assert.equal(snapshot.tasks[0]!.status, 'error');
  assert.equal(snapshot.tasks[0]!.error, 'start.gg said no');
  log.stop();
});

test('finished tasks are trimmed but running ones are never dropped', () => {
  const log = new ActivityLog({ throttleMs: 0, historyLimit: 3 });
  const open = log.begin({ kind: 'sets', label: 'Still going' });
  for (let i = 0; i < 10; i += 1) {
    log.begin({ kind: 'sets', label: `Done ${i}` }).succeed();
  }

  const snapshot = log.snapshot();
  assert.equal(snapshot.tasks.filter((t) => t.status === 'done').length, 3);
  assert.equal(snapshot.running, 1);
  assert.equal(snapshot.tasks[0]!.label, 'Still going', 'running work sorts first');
  open.succeed();
  log.stop();
});

test('an import narrates itself and reports a per-event failure', async () => {
  const world = new MockWorld();
  world.completeAll();
  const inner = new MockTransport(world, { autoAdvanceMs: 0 });
  // One event is made unreadable so both outcomes appear in the same feed.
  const brokenEventId = world.events[1]!.id;
  const transport = {
    name: inner.name,
    endpoint: inner.endpoint,
    canMutate: inner.canMutate,
    async execute(request: any) {
      const op = request.operationName ?? '';
      if (op === 'EventEntrants' && String(request.variables?.eventId) === brokenEventId) {
        throw new Error('entrants are unavailable');
      }
      return inner.execute(request);
    },
  };

  const log = new ActivityLog({ throttleMs: 0 });
  const seen: string[] = [];
  log.on('changed', (snapshot) => {
    for (const task of snapshot.tasks) {
      if (task.status === 'running') seen.push(task.label);
    }
  });

  const client = new StartggClient(transport as any, { requestsPerMinute: 10000, maxRetries: 0 });
  const sync = new SyncEngine(freshStore(), client, { activity: log });
  // Per-event failures are emitted; an EventEmitter with no 'error' listener
  // rethrows them, which is not what is under test here.
  sync.on('error', () => {});
  await sync.importTournament(world.slug);

  assert.ok(
    seen.some((label) => /^Importing /.test(label)),
    'the import itself was announced',
  );
  assert.ok(
    seen.some((label) => /Processing event data/.test(label)),
    'each event was announced as it was processed',
  );

  const snapshot = log.snapshot();
  assert.equal(snapshot.running, 0, 'nothing was left open');
  const failure = snapshot.tasks.find((t) => t.eventId === brokenEventId);
  assert.ok(failure, 'the broken event has a task of its own');
  assert.equal(failure.status, 'error');
  assert.match(failure.error ?? '', /entrants are unavailable/);

  // A single bad event does not fail the import as a whole.
  const overall = snapshot.tasks.find((t) => t.kind === 'import');
  assert.ok(overall);
  assert.equal(overall.status, 'done');
  assert.match(overall.detail ?? '', /of 4 events imported/);
  log.stop();
});
