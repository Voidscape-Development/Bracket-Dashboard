/**
 * Adaptive delta sync.
 *
 * The requirement is "only pull new updated info". Each tracked event keeps a
 * watermark and asks start.gg only for sets touched since then, at a cadence
 * derived from what the event is doing: a bracket with live matches is polled
 * hard, a finished one barely at all. A full reconcile runs occasionally to pick
 * up changes a delta cannot express (a reset, a deleted set, a reseed).
 *
 * Two details matter for correctness:
 *
 *  - The watermark is pushed back by an overlap before being sent. start.gg's
 *    clock is not ours, and a set updated during the request itself would
 *    otherwise fall in the gap. Re-fetching a few sets is free because the store
 *    hashes content and drops anything that did not actually change.
 *  - Sets with a pending local report are not treated as authoritative until the
 *    outbox confirms them, so a delta pass cannot silently revert an operator's
 *    entry while it is still queued.
 */

import { EventEmitter } from 'node:events';

import {
  ActivityState,
  type Id,
  type Standing,
  type TournamentSet,
} from '@bracket/shared';

import { noopActivity, type ActivityHandle, type ActivityLog } from '../activity.js';
import type { Store } from '../db/store.js';
import type { StartggClient } from '../startgg/client.js';

export interface SyncCadence {
  /** Event has sets in progress. */
  liveMs: number;
  /** Event is running but nothing is currently in progress. */
  warmMs: number;
  /** Event exists but has not started. */
  idleMs: number;
  /** Event is finished. */
  doneMs: number;
  /** Full reconcile interval, ignoring the watermark. */
  fullReconcileMs: number;
  /** Seconds subtracted from the watermark to absorb clock skew. */
  overlapSeconds: number;
}

export const DEFAULT_CADENCE: SyncCadence = {
  liveMs: 10_000,
  warmMs: 30_000,
  idleMs: 120_000,
  doneMs: 600_000,
  fullReconcileMs: 900_000,
  overlapSeconds: 90,
};

export type SyncTier = 'live' | 'warm' | 'idle' | 'done';

/**
 * Shown on the event's own card when a complete read still found nothing.
 *
 * It is usually a bracket that has not been published, and it is sometimes a
 * read start.gg will not answer — the app cannot tell which from here, so it
 * says both and names the button that settles it. An empty bracket with no
 * explanation is the thing this whole path exists to stop.
 */
export const NO_SETS_NOTE =
  'start.gg returned no sets for this event. Either its bracket has not been published ' +
  'yet, or the read needs to go bracket by bracket — use "Load every set" to force that.';

export interface EventSyncState {
  eventId: Id;
  tier: SyncTier;
  nextRunAt: number;
  lastRunAt: number | null;
  lastFullReconcileAt: number | null;
  lastError: string | null;
  consecutiveErrors: number;
  inFlight: boolean;
  /**
   * A human asked for everything, now. The next pass reads bracket by bracket
   * and ignores every rate limit meant to protect a steady-state poll.
   */
  deepRequested: boolean;
}

export interface SyncEngineOptions {
  cadence?: Partial<SyncCadence>;
  /** Poll loop granularity. */
  tickMs?: number;
  /** Refresh standings at most this often per event. */
  standingsIntervalMs?: number;
  /** Where to report progress. Omitted in tests and scripts. */
  activity?: ActivityLog;
}

export interface SetsSyncedEvent {
  eventId: Id;
  upserted: TournamentSet[];
  unchanged: number;
  mode: 'delta' | 'full';
}

export declare interface SyncEngine {
  on(event: 'sets', listener: (payload: SetsSyncedEvent) => void): this;
  on(event: 'standings', listener: (payload: { eventId: Id; standings: Standing[] }) => void): this;
  on(event: 'error', listener: (payload: { eventId: Id; error: string }) => void): this;
  on(event: 'tier', listener: (payload: { eventId: Id; tier: SyncTier }) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

export class SyncEngine extends EventEmitter {
  private readonly cadence: SyncCadence;
  private readonly tickMs: number;
  private readonly standingsIntervalMs: number;
  private readonly activity: ActivityLog | null;
  private readonly states = new Map<Id, EventSyncState>();
  private readonly lastStandingsAt = new Map<Id, number>();
  /** Last per-pool set read, which is rate-limited: see `readEventSets`. */
  private readonly lastGroupFallbackAt = new Map<Id, number>();
  /** Events whose structure has already been re-read to recover its brackets. */
  private readonly structureRepairedAt = new Map<Id, number>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly client: StartggClient,
    options: SyncEngineOptions = {},
  ) {
    super();
    this.cadence = { ...DEFAULT_CADENCE, ...(options.cadence ?? {}) };
    this.tickMs = options.tickMs ?? 2000;
    this.standingsIntervalMs = options.standingsIntervalMs ?? 60_000;
    this.activity = options.activity ?? null;
  }

  private track(init: Parameters<ActivityLog['begin']>[0]): ActivityHandle {
    return this.activity ? this.activity.begin(init) : noopActivity();
  }

  /** The event's own name, for progress text that reads like a sentence. */
  private eventName(eventId: Id): string {
    return this.store.getEvent(eventId)?.name ?? `Event ${eventId}`;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.refreshTrackedEvents();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Picks up events added or untracked since the last call. */
  refreshTrackedEvents(): void {
    const tracked = new Set(this.store.listTrackedEventIds());
    for (const eventId of tracked) {
      if (!this.states.has(eventId)) {
        this.states.set(eventId, {
          eventId,
          tier: 'idle',
          // Stagger first runs so importing a 12-event tournament does not fire
          // twelve simultaneous requests.
          nextRunAt: Date.now() + this.states.size * 400,
          lastRunAt: null,
          lastFullReconcileAt: null,
          lastError: null,
          consecutiveErrors: 0,
          inFlight: false,
          deepRequested: false,
        });
      }
    }
    for (const eventId of [...this.states.keys()]) {
      if (!tracked.has(eventId)) this.states.delete(eventId);
    }
  }

  listStates(): EventSyncState[] {
    return [...this.states.values()];
  }

  /**
   * Forces an event (or everything) to sync on the next tick.
   *
   * `full` drops the watermark, so the read is unfiltered rather than a delta.
   * `deep` goes further and reads every bracket directly, which is the only
   * request that is guaranteed to see sets the event-level endpoint will not
   * list. It is what the "Load every set" button asks for, so it deliberately
   * ignores the rate limit that stops steady-state polling doing the same.
   */
  requestSync(eventId?: Id, full = false, deep = false): void {
    const targets = eventId ? [this.states.get(eventId)] : [...this.states.values()];
    for (const state of targets) {
      if (!state) continue;
      state.nextRunAt = 0;
      if (full || deep) state.lastFullReconcileAt = null;
      if (deep) state.deepRequested = true;
    }
  }

  private computeTier(eventId: Id): SyncTier {
    const status = this.store
      .eventStatuses()
      .find((s) => s.eventId === eventId);
    if (!status) return 'idle';
    if (status.activeSets > 0) return 'live';
    if (status.totalSets > 0 && status.completedSets >= status.totalSets) return 'done';
    if (status.completedSets > 0) return 'warm';
    return 'idle';
  }

  private intervalFor(tier: SyncTier): number {
    switch (tier) {
      case 'live':
        return this.cadence.liveMs;
      case 'warm':
        return this.cadence.warmMs;
      case 'done':
        return this.cadence.doneMs;
      case 'idle':
      default:
        return this.cadence.idleMs;
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    const now = Date.now();

    for (const state of this.states.values()) {
      if (state.inFlight || state.nextRunAt > now) continue;
      state.inFlight = true;
      void this.syncEvent(state)
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          state.lastError = message;
          state.consecutiveErrors += 1;
          this.store.recordSyncError(state.eventId, message);
          this.emit('error', { eventId: state.eventId, error: message });
        })
        .finally(() => {
          state.inFlight = false;
          state.lastRunAt = Date.now();

          const tier = this.computeTier(state.eventId);
          if (tier !== state.tier) {
            state.tier = tier;
            this.emit('tier', { eventId: state.eventId, tier });
          }

          // Back off on repeated failure so an offline venue does not hammer a
          // dead connection, capped so recovery is still prompt.
          const base = this.intervalFor(tier);
          const penalty =
            state.consecutiveErrors > 0
              ? Math.min(60_000, 2 ** Math.min(state.consecutiveErrors, 5) * 1000)
              : 0;
          state.nextRunAt = Date.now() + base + penalty;
        });
    }
  }

  private async syncEvent(state: EventSyncState): Promise<void> {
    const deep = state.deepRequested;
    // Cleared before the work rather than after, so a pass that throws does not
    // leave the flag armed and turn every later tick into a pool-by-pool read.
    state.deepRequested = false;
    const handle = deep
      ? this.track({
          kind: 'sets',
          label: `Loading every set — ${this.eventName(state.eventId)}`,
          eventId: state.eventId,
        })
      : noopActivity();

    try {
      await this.runSyncPass(state, deep);
      handle.succeed(`${this.store.countSets(state.eventId)} sets stored`);
    } catch (error) {
      handle.fail(error);
      throw error;
    }
  }

  private async runSyncPass(state: EventSyncState, deep: boolean): Promise<void> {
    const eventId = state.eventId;
    // An event holding no sets is either one whose bracket has not been
    // published or one whose sets never arrived — a finished tournament
    // imported by a build that asked start.gg for them in call order, say. A
    // delta keyed off the watermark can never fill either in, because upstream
    // nothing has changed since, so the read has to go back to unfiltered.
    const storedSets = this.store.countSets(eventId);
    const needsFull =
      deep ||
      storedSets === 0 ||
      state.lastFullReconcileAt === null ||
      Date.now() - state.lastFullReconcileAt > this.cadence.fullReconcileMs;

    const watermark = needsFull ? null : this.store.getWatermark(eventId);
    const requestedAt = Math.floor(Date.now() / 1000);
    const updatedAfter =
      watermark === null ? null : Math.max(0, watermark - this.cadence.overlapSeconds);

    const sets = await this.readEventSets(eventId, updatedAfter, needsFull, deep);

    // Protect optimistic local reports: a set still queued in the outbox keeps
    // its local value until the send confirms or conflicts.
    const pendingIds = new Set(
      this.store
        .listOutbox(['queued', 'sending', 'failed'])
        .map((entry) => ('setId' in entry.command ? entry.command.setId : null))
        .filter((id): id is Id => id !== null),
    );
    const applicable = sets.filter((set) => !pendingIds.has(set.id));

    const { upserted, unchanged } = this.store.upsertSets(applicable);

    // Prefer start.gg's own timestamps for the next watermark; fall back to our
    // request time when the endpoint does not expose updatedAt.
    const remoteMax = sets.reduce<number>((max, set) => Math.max(max, set.updatedAt ?? 0), 0);
    const nextWatermark = remoteMax > 0 ? remoteMax : requestedAt;
    this.store.recordSyncSuccess(eventId, nextWatermark);

    state.lastError = null;
    state.consecutiveErrors = 0;
    if (needsFull) state.lastFullReconcileAt = Date.now();

    if (needsFull) this.noteIfEmpty(eventId);

    if (upserted.length > 0) {
      this.emit('sets', {
        eventId,
        upserted,
        unchanged,
        mode: needsFull ? 'full' : 'delta',
      });
    }

    await this.maybeSyncStandings(eventId, upserted);
  }

  /**
   * Sets for an event, with a second route for the cases the event-level read
   * cannot be trusted on.
   *
   * `event.sets` is one resolver's opinion of what an event contains, and for a
   * bracket that has already been played that opinion has repeatedly turned out
   * to be incomplete — sometimes empty, sometimes everything except the matches
   * that finished. Reading each phase group directly asks a different resolver,
   * scoped to a bracket rather than to the event, and that one answers for
   * played sets. So an unfiltered read is checked for three symptoms before it
   * is believed:
   *
   *  - nothing at all came back;
   *  - start.gg's own `total` says there are more sets than it handed over;
   *  - the event is finished, yet not one returned set is complete.
   *
   * Any of those sends the read down the per-bracket route, and what comes back
   * is merged rather than replacing: a partial event-level answer is still real
   * data, and the store deduplicates by set id.
   *
   * Only unfiltered reads are checked. A delta pass returning nothing is the
   * normal, cheap case and must stay one request.
   */
  private async readEventSets(
    eventId: Id,
    updatedAfter: number | null,
    allowFallback: boolean,
    force = false,
  ): Promise<TournamentSet[]> {
    const { sets, total } = await this.client.fetchEventSets(eventId, updatedAfter);
    if (!allowFallback) return sets;

    const reason = force
      ? 'every set was asked for'
      : this.incompleteReason(eventId, sets, total);
    if (reason === null) return sets;

    // Reading a bracket at a time costs a request per pool, so outside an
    // explicit request it runs on the first look at an event and then no more
    // often than a full reconcile — enough to repair a database that missed its
    // sets, not enough to poll a 64-pool event to death while it waits for
    // seeding.
    const lastAttempt = this.lastGroupFallbackAt.get(eventId);
    if (
      !force &&
      lastAttempt !== undefined &&
      Date.now() - lastAttempt < this.cadence.fullReconcileMs
    ) {
      return sets;
    }
    this.lastGroupFallbackAt.set(eventId, Date.now());

    const byGroup = await this.readSetsByPhaseGroup(eventId, force, reason);
    if (byGroup.length === 0) return sets;

    // The per-bracket read is the more authoritative of the two, so where both
    // answered for a set its version wins.
    const merged = new Map<Id, TournamentSet>();
    for (const set of sets) merged.set(set.id, set);
    for (const set of byGroup) merged.set(set.id, set);
    return [...merged.values()];
  }

  /**
   * Why an unfiltered event-level read should not be believed, or null when it
   * looks complete.
   */
  private incompleteReason(
    eventId: Id,
    sets: TournamentSet[],
    total: number,
  ): string | null {
    if (sets.length === 0) return 'the event returned no sets';
    if (total > sets.length) {
      return `the event returned ${sets.length} of ${total} sets`;
    }

    // The failure that started all of this: an endpoint happy to list an
    // event's upcoming matches while omitting every match already played. A
    // finished event whose answer contains no finished set is that, every time.
    const event = this.store.getEvent(eventId);
    const finishedUpstream = event?.state === ActivityState.Completed;
    if (finishedUpstream && !sets.some((set) => set.state === ActivityState.Completed)) {
      return 'the event is finished but none of its sets came back completed';
    }
    return null;
  }

  /**
   * Every set of an event, gathered one bracket at a time.
   *
   * A pool that fails is not allowed to lose the pools that answered — the
   * write is purely additive, so partial results are worth keeping. Only a
   * clean sweep of failures is reported as one, which is what should trip the
   * caller's error backoff.
   *
   * An event with no brackets on record cannot be read this way at all, and
   * used to answer with an empty array — which is how a completed tournament
   * could sit at zero sets indefinitely with nothing anywhere saying why. The
   * structure is re-read once to recover the brackets, and if there still are
   * none that is reported as the error it is.
   */
  private async readSetsByPhaseGroup(
    eventId: Id,
    force = false,
    reason?: string,
  ): Promise<TournamentSet[]> {
    let groupIds = this.groupIdsFor(eventId);
    if (groupIds.length === 0) {
      await this.repairEventStructure(eventId, force);
      groupIds = this.groupIdsFor(eventId);
    }
    if (groupIds.length === 0) {
      // Nothing published to read. Said out loud rather than returned as an
      // empty success, because an empty bracket with no explanation is the
      // exact thing this whole path exists to stop.
      throw new Error(
        `start.gg listed no brackets for "${this.eventName(eventId)}", so its sets ` +
          'cannot be read. If the bracket is published on start.gg, remove and re-import ' +
          'the tournament; otherwise it has not been generated yet.',
      );
    }

    const handle = this.track({
      kind: 'sets',
      label: `Pulling set info — ${this.eventName(eventId)}`,
      detail: reason ? `Reading each bracket: ${reason}` : null,
      eventId,
      total: groupIds.length,
    });

    const collected: TournamentSet[] = [];
    let firstError: unknown = null;
    let done = 0;

    try {
      for (const groupId of groupIds) {
        try {
          collected.push(...(await this.client.fetchPhaseGroupSets(groupId, eventId)));
        } catch (error) {
          firstError ??= error;
        }
        done += 1;
        handle.progress(done, groupIds.length, `Bracket ${done} of ${groupIds.length}`);
      }

      if (collected.length === 0 && firstError !== null) throw firstError;
      handle.succeed(
        `${collected.length} sets across ${groupIds.length} ` +
          (groupIds.length === 1 ? 'bracket' : 'brackets'),
      );
      return collected;
    } catch (error) {
      handle.fail(error);
      throw error;
    }
  }

  /**
   * Records, on the event itself, that a complete read left it with nothing.
   * Called only after an unfiltered read, so a quiet delta never raises it.
   */
  private noteIfEmpty(eventId: Id): void {
    if (this.store.countSets(eventId) > 0) return;
    this.store.recordSyncError(eventId, NO_SETS_NOTE);
  }

  private groupIdsFor(eventId: Id): Id[] {
    const event = this.store.getEvent(eventId);
    return (event?.phases ?? []).flatMap((phase) => phase.groups.map((group) => group.id));
  }

  /**
   * Re-reads the tournament that owns an event, to recover brackets a truncated
   * or failed structure read left out. Rate-limited the same way the per-bracket
   * read is, because it is a whole-tournament request.
   */
  private async repairEventStructure(eventId: Id, force: boolean): Promise<void> {
    const last = this.structureRepairedAt.get(eventId);
    if (!force && last !== undefined && Date.now() - last < this.cadence.fullReconcileMs) return;

    const event = this.store.getEvent(eventId);
    const slug = event ? this.store.getTournament(event.tournamentId)?.slug : null;
    if (!slug) return;

    this.structureRepairedAt.set(eventId, Date.now());
    const handle = this.track({
      kind: 'structure',
      label: `Re-reading brackets — ${this.eventName(eventId)}`,
      eventId,
    });
    try {
      const tournament = await this.client.fetchTournamentStructure(slug);
      if (tournament) this.store.saveTournament(tournament);
      handle.succeed();
    } catch (error) {
      // Best effort: the caller reports the real problem, which is the missing
      // sets rather than this attempt to go and find them.
      handle.fail(error);
    }
  }

  /**
   * Standings are refreshed when a set completes (placements just moved) or on a
   * slow timer. Fetching them every pass would double the call volume for data
   * that rarely changes.
   */
  private async maybeSyncStandings(eventId: Id, changed: TournamentSet[]): Promise<void> {
    const completedChanged = changed.some((s) => s.state === ActivityState.Completed);
    const last = this.lastStandingsAt.get(eventId) ?? 0;
    const stale = Date.now() - last > this.standingsIntervalMs;
    if (!completedChanged && !stale) return;

    try {
      const standings = await this.client.fetchStandings(eventId);
      this.lastStandingsAt.set(eventId, Date.now());
      if (standings.length > 0) {
        this.store.replaceStandings(eventId, standings);
        this.emit('standings', { eventId, standings });
      }
    } catch {
      // Standings are decorative next to the bracket itself; a failure here must
      // not fail the whole sync pass or trip the error backoff.
      this.lastStandingsAt.set(eventId, Date.now() - this.standingsIntervalMs / 2);
    }
  }

  /**
   * First-time import: pulls structure, entrants and every set, then hands over
   * to delta polling. "Every set" includes a tournament that finished months
   * ago — the results are the whole point of importing one.
   */
  async importTournament(slug: string): Promise<{ tournamentId: Id; events: number } | null> {
    const overall = this.track({
      kind: 'import',
      label: `Importing ${slug}`,
      detail: 'Reading tournament structure',
    });

    let tournament: Awaited<ReturnType<StartggClient['fetchTournamentStructure']>>;
    try {
      tournament = await this.client.fetchTournamentStructure(slug);
    } catch (error) {
      overall.fail(error);
      throw error;
    }
    if (!tournament) {
      overall.fail(new Error(`start.gg has no tournament at "${slug}"`));
      return null;
    }

    this.store.saveTournament(tournament);
    overall.step(`Importing ${tournament.name}`, null);

    const total = tournament.events.length;
    let done = 0;
    let failed = 0;

    for (const event of tournament.events) {
      const step = this.track({
        kind: 'sets',
        label: `Processing event data — ${event.name}`,
        detail: 'Reading entrants',
        eventId: event.id,
        tournamentId: tournament.id,
      });
      try {
        const entrants = await this.client.fetchEntrants(event.id);
        this.store.replaceEntrants(event.id, entrants);

        step.detail(`${entrants.length} entrants; pulling set info`);
        // The whole reason someone imports a tournament that is already over is
        // the results, so a completed event is read as thoroughly as an explicit
        // request would read it rather than trusting one event-level answer.
        const deep = event.state === ActivityState.Completed;
        const sets = await this.readEventSets(event.id, null, true, deep);
        const { upserted } = this.store.upsertSets(sets);
        this.store.recordSyncSuccess(
          event.id,
          sets.reduce<number>((max, s) => Math.max(max, s.updatedAt ?? 0), 0) ||
            Math.floor(Date.now() / 1000),
        );
        if (upserted.length > 0) {
          this.emit('sets', { eventId: event.id, upserted, unchanged: 0, mode: 'full' });
        }

        step.detail(`${sets.length} sets; reading standings`);
        const standings = await this.client.fetchStandings(event.id);
        if (standings.length > 0) {
          this.store.replaceStandings(event.id, standings);
          this.lastStandingsAt.set(event.id, Date.now());
          this.emit('standings', { eventId: event.id, standings });
        }
        this.noteIfEmpty(event.id);
        step.succeed(`${sets.length} sets, ${entrants.length} entrants`);
      } catch (error) {
        // One bad event must not abort the import; the rest still comes in and
        // the failure shows on the dashboard for that event alone.
        const message = error instanceof Error ? error.message : String(error);
        this.store.recordSyncError(event.id, message);
        this.emit('error', { eventId: event.id, error: message });
        step.fail(error);
        failed += 1;
      }
      done += 1;
      overall.progress(done, total, `Event ${done} of ${total}`);
    }

    this.store.markFullSync(tournament.id);
    this.refreshTrackedEvents();
    overall.succeed(
      failed > 0 ? `${total - failed} of ${total} events imported` : `${total} events imported`,
    );
    return { tournamentId: tournament.id, events: tournament.events.length };
  }
}
