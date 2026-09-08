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

export interface EventSyncState {
  eventId: Id;
  tier: SyncTier;
  nextRunAt: number;
  lastRunAt: number | null;
  lastFullReconcileAt: number | null;
  lastError: string | null;
  consecutiveErrors: number;
  inFlight: boolean;
}

export interface SyncEngineOptions {
  cadence?: Partial<SyncCadence>;
  /** Poll loop granularity. */
  tickMs?: number;
  /** Refresh standings at most this often per event. */
  standingsIntervalMs?: number;
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
  private readonly states = new Map<Id, EventSyncState>();
  private readonly lastStandingsAt = new Map<Id, number>();
  /** Last per-pool set read, which is rate-limited: see `readEventSets`. */
  private readonly lastGroupFallbackAt = new Map<Id, number>();
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

  /** Forces an event (or everything) to sync on the next tick. */
  requestSync(eventId?: Id, full = false): void {
    const targets = eventId ? [this.states.get(eventId)] : [...this.states.values()];
    for (const state of targets) {
      if (!state) continue;
      state.nextRunAt = 0;
      if (full) state.lastFullReconcileAt = null;
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
    const eventId = state.eventId;
    // An event holding no sets is either one whose bracket has not been
    // published or one whose sets never arrived — a finished tournament
    // imported by a build that asked start.gg for them in call order, say. A
    // delta keyed off the watermark can never fill either in, because upstream
    // nothing has changed since, so the read has to go back to unfiltered.
    const storedSets = this.store.countSets(eventId);
    const needsFull =
      storedSets === 0 ||
      state.lastFullReconcileAt === null ||
      Date.now() - state.lastFullReconcileAt > this.cadence.fullReconcileMs;

    const watermark = needsFull ? null : this.store.getWatermark(eventId);
    const requestedAt = Math.floor(Date.now() / 1000);
    const updatedAfter =
      watermark === null ? null : Math.max(0, watermark - this.cadence.overlapSeconds);

    const sets = await this.readEventSets(eventId, updatedAfter, needsFull);

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
   * Sets for an event, with a second route for the case that matters most after
   * the fact.
   *
   * A finished bracket is the one shape where "the event returned no sets" is
   * ambiguous: it reads the same as a quiet delta, but it can also mean the
   * event-level connection declined to list sets that are no longer in play.
   * On an unfiltered read the empty answer is never right for an event that has
   * brackets, so each phase group is asked directly — a different resolver,
   * scoped to a bracket rather than to what is currently callable.
   *
   * Only unfiltered reads take the fallback. A delta pass returning nothing is
   * the normal, cheap case and must stay one request.
   */
  private async readEventSets(
    eventId: Id,
    updatedAfter: number | null,
    allowFallback: boolean,
  ): Promise<TournamentSet[]> {
    const { sets } = await this.client.fetchEventSets(eventId, updatedAfter);
    if (sets.length > 0 || !allowFallback) return sets;

    // An event whose bracket has simply not been generated yet answers empty
    // too, and that is the far more common reason. Confirming it costs one
    // request per pool, so the fallback runs on the first look at an event and
    // then no more often than a full reconcile — enough to repair a database
    // that missed its sets, not enough to poll a 64-pool event to death while
    // it waits for seeding.
    const lastAttempt = this.lastGroupFallbackAt.get(eventId);
    if (lastAttempt !== undefined && Date.now() - lastAttempt < this.cadence.fullReconcileMs) {
      return sets;
    }
    this.lastGroupFallbackAt.set(eventId, Date.now());
    return this.readSetsByPhaseGroup(eventId);
  }

  /**
   * Every set of an event, gathered one bracket at a time.
   *
   * A pool that fails is not allowed to lose the pools that answered — the
   * write is purely additive, so partial results are worth keeping. Only a
   * clean sweep of failures is reported as one, which is what should trip the
   * caller's error backoff.
   */
  private async readSetsByPhaseGroup(eventId: Id): Promise<TournamentSet[]> {
    const event = this.store.getEvent(eventId);
    const groupIds = (event?.phases ?? []).flatMap((phase) =>
      phase.groups.map((group) => group.id),
    );
    if (groupIds.length === 0) return [];

    const collected: TournamentSet[] = [];
    let firstError: unknown = null;

    for (const groupId of groupIds) {
      try {
        collected.push(...(await this.client.fetchPhaseGroupSets(groupId, eventId)));
      } catch (error) {
        firstError ??= error;
      }
    }

    if (collected.length === 0 && firstError !== null) throw firstError;
    return collected;
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
    const tournament = await this.client.fetchTournamentStructure(slug);
    if (!tournament) return null;

    this.store.saveTournament(tournament);

    for (const event of tournament.events) {
      try {
        const entrants = await this.client.fetchEntrants(event.id);
        this.store.replaceEntrants(event.id, entrants);

        const sets = await this.readEventSets(event.id, null, true);
        const { upserted } = this.store.upsertSets(sets);
        this.store.recordSyncSuccess(
          event.id,
          sets.reduce<number>((max, s) => Math.max(max, s.updatedAt ?? 0), 0) ||
            Math.floor(Date.now() / 1000),
        );
        if (upserted.length > 0) {
          this.emit('sets', { eventId: event.id, upserted, unchanged: 0, mode: 'full' });
        }

        const standings = await this.client.fetchStandings(event.id);
        if (standings.length > 0) {
          this.store.replaceStandings(event.id, standings);
          this.lastStandingsAt.set(event.id, Date.now());
          this.emit('standings', { eventId: event.id, standings });
        }
      } catch (error) {
        // One bad event must not abort the import; the rest still comes in and
        // the failure shows on the dashboard for that event alone.
        const message = error instanceof Error ? error.message : String(error);
        this.store.recordSyncError(event.id, message);
        this.emit('error', { eventId: event.id, error: message });
      }
    }

    this.store.markFullSync(tournament.id);
    this.refreshTrackedEvents();
    return { tournamentId: tournament.id, events: tournament.events.length };
  }
}
