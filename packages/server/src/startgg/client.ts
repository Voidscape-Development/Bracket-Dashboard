/**
 * start.gg client.
 *
 * Owns everything about talking to start.gg: pacing, retries, paging, mapping
 * and the online/offline signal the rest of the app reacts to. Callers get
 * domain objects and never see a GraphQL document.
 */

import { EventEmitter } from 'node:events';

import {
  type Entrant,
  type Id,
  type Standing,
  type Tournament,
  type TournamentSet,
} from '@bracket/shared';

import { mapEntrant, mapSet, mapStanding, mapTournament } from './mappers.js';
import {
  DEFAULT_SET_SORT,
  EVENT_ENTRANTS,
  EVENT_STANDINGS,
  EVENT_STATIONS,
  HEALTHCHECK,
  PHASE_GROUPS,
  SET_FRAGMENT_LEAN,
  SET_FRAGMENT_RICH,
  TOURNAMENT_EVENTS,
  UPDATE_PHASE_SEEDING,
  assignStationMutation,
  assignStreamMutation,
  eventSetsQuery,
  markInProgressMutation,
  phaseGroupSetsQuery,
  reportSetMutation,
  resetSetMutation,
  TOURNAMENT_STRUCTURE,
  type SetSortType,
} from './queries.js';
import { GqlError, type GqlTransport } from './transport.js';

export interface ClientOptions {
  /** Requests allowed per rolling minute. Kept below start.gg's published limit. */
  requestsPerMinute?: number;
  /** Simultaneous in-flight requests. */
  concurrency?: number;
  maxRetries?: number;
  /** Page size for set reads; the ceiling-sensitive one. */
  perPage?: number;
  /** Page size for phase groups inside the structure read. */
  groupsPerPage?: number;
  /** Floor for the adaptive shrink. Below this, something else is wrong. */
  minPerPage?: number;
  /**
   * Sort passed to every set read. Leave it alone unless you specifically want
   * the station call queue — `CALL_ORDER` silently drops completed sets, which
   * empties a finished bracket. See `SetSortType` in queries.ts.
   */
  setsSortType?: SetSortType;
}

/**
 * Starting page sizes, per operation.
 *
 * start.gg allows 1000 objects per response and counts every nested object, so
 * the safe page size depends entirely on how fat the node is. A set carrying
 * slots, participants, games and character selections costs roughly 25-55
 * objects; an entrant costs about 5; a standing about 3. These are opening
 * bids — `shrinkPage` corrects them against what start.gg actually says.
 */
const DEFAULT_PAGE_SIZES: Readonly<Record<string, number>> = Object.freeze({
  EventSets: 25,
  PhaseGroupSets: 25,
  EventEntrants: 50,
  EventStandings: 50,
  TournamentStructure: 32,
  PhaseGroups: 32,
  EventStations: 100,
});

export interface ClientHealth {
  online: boolean;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  requestsLastMinute: number;
  /** True once the rich set fragment has been downgraded. */
  degradedFields: boolean;
  /** Current page size per operation, after any complexity-driven shrink. */
  pageSizes: Record<string, number>;
  /** Sort used for set reads; decides whether finished sets come back at all. */
  setsSortType: SetSortType;
}

interface QueueItem {
  run: () => Promise<void>;
}

/** Rolling-window limiter with a small concurrency cap. */
class RequestPacer {
  private readonly timestamps: number[] = [];
  private readonly queue: QueueItem[] = [];
  private active = 0;

  constructor(
    private readonly perMinute: number,
    private readonly concurrency: number,
  ) {}

  get requestsLastMinute(): number {
    this.prune();
    return this.timestamps.length;
  }

  private prune(now = Date.now()): void {
    const cutoff = now - 60_000;
    while (this.timestamps.length > 0 && (this.timestamps[0] as number) < cutoff) {
      this.timestamps.shift();
    }
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        run: async () => {
          try {
            this.timestamps.push(Date.now());
            resolve(await task());
          } catch (error) {
            reject(error);
          }
        },
      });
      this.pump();
    });
  }

  private pump(): void {
    if (this.active >= this.concurrency || this.queue.length === 0) return;

    this.prune();
    if (this.timestamps.length >= this.perMinute) {
      // Wait until the oldest request leaves the window.
      const oldest = this.timestamps[0] as number;
      const wait = Math.max(50, oldest + 60_000 - Date.now());
      setTimeout(() => this.pump(), wait);
      return;
    }

    const item = this.queue.shift();
    if (!item) return;
    this.active += 1;
    void item.run().finally(() => {
      this.active -= 1;
      this.pump();
    });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PagedSets {
  sets: TournamentSet[];
  total: number;
}

export class StartggClient extends EventEmitter {
  private readonly pacer: RequestPacer;
  private readonly maxRetries: number;
  private readonly minPerPage: number;
  private readonly setsSortType: SetSortType;
  private setFragment = SET_FRAGMENT_RICH;
  private degraded = false;
  /** Live page size per operation; only ever shrinks, and only on evidence. */
  private readonly pageSizes = new Map<string, number>();

  private lastSuccessAt: number | null = null;
  private lastErrorAt: number | null = null;
  private lastError: string | null = null;
  private online = true;

  constructor(
    private transport: GqlTransport,
    options: ClientOptions = {},
  ) {
    super();
    this.pacer = new RequestPacer(
      options.requestsPerMinute ?? 45,
      options.concurrency ?? 2,
    );
    this.maxRetries = options.maxRetries ?? 3;
    this.minPerPage = Math.max(1, options.minPerPage ?? 2);
    this.setsSortType = options.setsSortType ?? DEFAULT_SET_SORT;

    for (const [op, size] of Object.entries(DEFAULT_PAGE_SIZES)) {
      this.pageSizes.set(op, size);
    }
    if (options.perPage) {
      this.pageSizes.set('EventSets', options.perPage);
      this.pageSizes.set('PhaseGroupSets', options.perPage);
      this.pageSizes.set('EventEntrants', options.perPage);
      this.pageSizes.set('EventStandings', options.perPage);
    }
    if (options.groupsPerPage) {
      this.pageSizes.set('TournamentStructure', options.groupsPerPage);
      this.pageSizes.set('PhaseGroups', options.groupsPerPage);
    }
  }

  /** Swaps the transport at runtime, e.g. when the user adds an API token. */
  setTransport(transport: GqlTransport): void {
    this.transport = transport;
    this.emit('health', this.health);
  }

  get canMutate(): boolean {
    return this.transport.canMutate;
  }

  get health(): ClientHealth {
    return {
      online: this.online,
      lastSuccessAt: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
      requestsLastMinute: this.pacer.requestsLastMinute,
      degradedFields: this.degraded,
      pageSizes: Object.fromEntries(this.pageSizes),
      setsSortType: this.setsSortType,
    };
  }

  /** Current page size for an operation. */
  pageSize(operation: string): number {
    return this.pageSizes.get(operation) ?? DEFAULT_PAGE_SIZES[operation] ?? 25;
  }

  /**
   * Reacts to start.gg's object-count rejection by asking for fewer nodes.
   *
   * When start.gg reports both the ceiling and what the request would have
   * returned ("a maximum of 1000 objects ... (actual: 1219)"), the ratio says
   * exactly how far over we were, so one corrected retry lands instead of a
   * sequence of halvings. A 15% margin absorbs the fact that node cost varies
   * between pages — a page of completed best-of-five sets carries far more
   * objects than a page of unstarted ones.
   *
   * Returns false when already at the floor, which means the *shape* of the
   * query is too expensive at any page size and the caller needs a plan B.
   */
  private shrinkPage(operation: string, error: GqlError): boolean {
    const current = this.pageSize(operation);
    if (current <= this.minPerPage) return false;

    const { limit, actual } = error.complexity ?? {};
    const scaled =
      limit && actual && actual > 0
        ? Math.floor(current * (limit / actual) * 0.85)
        : Math.floor(current / 2);

    const next = Math.max(this.minPerPage, Math.min(current - 1, scaled));
    this.pageSizes.set(operation, next);
    this.emit('pageSize', { operation, from: current, to: next, reason: error.message });
    this.emit('health', this.health);
    return true;
  }

  /**
   * Permanently drops to the lean set fragment. Called when start.gg rejects a
   * field we asked for; retrying the rich fragment forever would just burn
   * requests on an endpoint that has clearly changed.
   */
  private degradeFragment(reason: string): void {
    if (this.degraded) return;
    this.degraded = true;
    this.setFragment = SET_FRAGMENT_LEAN;
    this.emit('degraded', reason);
    this.emit('health', this.health);
  }

  private markSuccess(): void {
    this.lastSuccessAt = Date.now();
    this.lastError = null;
    if (!this.online) {
      this.online = true;
      this.emit('online');
    }
    this.emit('health', this.health);
  }

  private markFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastErrorAt = Date.now();
    this.lastError = message;
    const isNetwork = error instanceof GqlError && error.kind === 'network';
    if (isNetwork && this.online) {
      this.online = false;
      this.emit('offline', message);
    }
    this.emit('health', this.health);
  }

  private async request<T>(
    query: string,
    variables: Record<string, unknown> = {},
    operationName?: string,
  ): Promise<T> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.maxRetries) {
      try {
        const data = await this.pacer.schedule(() =>
          this.transport.execute<T>({ query, variables, operationName }),
        );
        this.markSuccess();
        return data;
      } catch (error) {
        lastError = error;

        if (error instanceof GqlError) {
          // An unknown field means the endpoint's shape moved under us; drop to
          // the lean fragment and let the caller retry with the new document.
          if (
            error.kind === 'graphql' &&
            /cannot query field|unknown field|no field/i.test(error.message)
          ) {
            this.degradeFragment(error.message);
            this.markFailure(error);
            throw error;
          }
          if (!error.retryable) {
            this.markFailure(error);
            throw error;
          }
        }

        attempt += 1;
        if (attempt > this.maxRetries) break;
        // 500ms, 1s, 2s, 4s with jitter.
        const backoff = 500 * 2 ** (attempt - 1) + Math.random() * 250;
        await sleep(backoff);
      }
    }

    this.markFailure(lastError);
    throw lastError instanceof Error
      ? lastError
      : new GqlError(String(lastError), 'network');
  }

  /**
   * Runs a set query, transparently retrying once with the lean fragment if the
   * rich one was just rejected.
   */
  private async requestSets<T>(
    build: (fragment: string) => string,
    variables: Record<string, unknown>,
    operationName: string,
  ): Promise<T> {
    const wasDegraded = this.degraded;
    try {
      return await this.request<T>(build(this.setFragment), variables, operationName);
    } catch (error) {
      // Retry only when *this* call caused the downgrade. Testing `degraded`
      // alone re-sent an identical document for every later GraphQL error.
      if (!wasDegraded && this.degraded && error instanceof GqlError && error.kind === 'graphql') {
        return this.request<T>(build(this.setFragment), variables, operationName);
      }
      throw error;
    }
  }

  /**
   * Walks a paged connection, absorbing complexity rejections.
   *
   * A shrink changes what "page 3" means, so the walk restarts from page one at
   * the new size rather than stitching two page sizes together and silently
   * dropping or duplicating nodes.
   */
  private async collectPages<T>(params: {
    operation: string;
    maxPages: number;
    fetchPage: (
      page: number,
      perPage: number,
    ) => Promise<{ nodes: unknown[]; totalPages: number; total: number | null }>;
    map: (node: any) => T | null;
  }): Promise<{ items: T[]; total: number }> {
    const { operation, maxPages, fetchPage, map } = params;

    for (;;) {
      const perPage = this.pageSize(operation);
      const items: T[] = [];
      let total = 0;
      let page = 1;
      let totalPages = 1;

      try {
        do {
          const result = await fetchPage(page, perPage);
          totalPages = result.totalPages;
          total = result.total ?? total;
          for (const node of result.nodes) {
            const mapped = map(node);
            if (mapped !== null) items.push(mapped);
          }
          page += 1;
        } while (page <= totalPages && page <= maxPages);

        return { items, total: total || items.length };
      } catch (error) {
        if (error instanceof GqlError && error.kind === 'complexity') {
          if (this.shrinkPage(operation, error)) continue;
          throw new GqlError(
            `start.gg rejected ${operation} as too large even at ${perPage} per page (${error.message}). ` +
              'This usually means the query is asking for more nested detail than start.gg will return at once.',
            'complexity',
            error.status,
            error.detail,
            error.complexity,
          );
        }
        throw error;
      }
    }
  }

  async healthcheck(): Promise<boolean> {
    try {
      await this.request(HEALTHCHECK, {}, 'Healthcheck');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whole-tournament structure.
   *
   * Three escalating strategies, because the object ceiling applies to this
   * read on both endpoints and how close a given tournament sits to it is not
   * knowable in advance:
   *
   *  1. One combined call with a modest group page size (the common case).
   *  2. The same call with a smaller group page size, once start.gg has said
   *     how far over the request was.
   *  3. Events and phases in one call, then each phase's groups separately.
   *
   * Whatever the route, any phase whose groups were truncated by paging is
   * completed before mapping, so a 64-pool phase is never silently reduced to
   * its first page.
   */
  async fetchTournamentStructure(slug: string): Promise<Tournament | null> {
    let raw: any;

    // Only the combined call's own rejection should drive the escalation here;
    // completing the groups afterwards has its own handling, and folding the
    // two together would re-run the whole structure read to no purpose.
    for (;;) {
      const groupPerPage = this.pageSize('TournamentStructure');
      try {
        const data = await this.request<{ tournament: any }>(
          TOURNAMENT_STRUCTURE,
          { slug, groupPage: 1, groupPerPage },
          'TournamentStructure',
        );
        raw = data.tournament;
        break;
      } catch (error) {
        if (!(error instanceof GqlError) || error.kind !== 'complexity') throw error;
        if (this.shrinkPage('TournamentStructure', error)) continue;
        // Even one group per phase is too much for one call: split the read.
        return this.fetchTournamentStructureSplit(slug);
      }
    }

    if (!raw) return null;
    await this.completePhaseGroups(raw);
    return mapTournament(raw);
  }

  /** Strategy 3: structure without groups, then groups per phase. */
  private async fetchTournamentStructureSplit(slug: string): Promise<Tournament | null> {
    const data = await this.request<{ tournament: any }>(
      TOURNAMENT_EVENTS,
      { slug },
      'TournamentEvents',
    );
    const tournament = data?.tournament;
    if (!tournament) return null;

    for (const event of tournament.events ?? []) {
      for (const phase of event?.phases ?? []) {
        if (!phase?.id) continue;
        phase.phaseGroups = { nodes: await this.fetchPhaseGroupNodes(String(phase.id)) };
      }
    }
    return mapTournament(tournament);
  }

  /**
   * Refetches, in full, any phase whose groups the structure call truncated.
   *
   * The whole list is replaced rather than topped up: the follow-up query pages
   * at its own size, and a shrink mid-walk would otherwise leave page
   * boundaries that no longer line up with the ones already collected. One
   * repeated page on a rare path beats a bracket with a hole in it.
   */
  private async completePhaseGroups(tournament: any): Promise<void> {
    for (const event of tournament?.events ?? []) {
      for (const phase of event?.phases ?? []) {
        const connection = phase?.phaseGroups;
        const totalPages = Number(connection?.pageInfo?.totalPages ?? 1) || 1;
        if (!phase?.id || totalPages <= 1 || !Array.isArray(connection?.nodes)) continue;
        connection.nodes = await this.fetchPhaseGroupNodes(String(phase.id));
      }
    }
  }

  /** Every raw phase-group node for one phase. */
  private async fetchPhaseGroupNodes(phaseId: Id): Promise<any[]> {
    for (;;) {
      const perPage = this.pageSize('PhaseGroups');
      const nodes: any[] = [];
      let page = 1;
      let totalPages = 1;

      try {
        do {
          const data = await this.request<any>(
            PHASE_GROUPS,
            { phaseId, page, perPage },
            'PhaseGroups',
          );
          const connection = data?.phase?.phaseGroups;
          totalPages = Number(connection?.pageInfo?.totalPages ?? 1) || 1;
          nodes.push(...(connection?.nodes ?? []));
          page += 1;
        } while (page <= totalPages && page <= 100);

        return nodes;
      } catch (error) {
        if (error instanceof GqlError && error.kind === 'complexity') {
          // A smaller page changes what page numbers mean, so restart the walk.
          if (this.shrinkPage('PhaseGroups', error)) continue;
        }
        throw error;
      }
    }
  }

  async fetchEntrants(eventId: Id): Promise<Entrant[]> {
    const { items } = await this.collectPages<Entrant>({
      operation: 'EventEntrants',
      maxPages: 200,
      fetchPage: async (page, perPage) => {
        const data = await this.request<any>(
          EVENT_ENTRANTS,
          { eventId, page, perPage },
          'EventEntrants',
        );
        const connection = data?.event?.entrants;
        return {
          nodes: connection?.nodes ?? [],
          totalPages: Number(connection?.pageInfo?.totalPages ?? 1) || 1,
          total: null,
        };
      },
      map: (node) => mapEntrant(node, eventId),
    });
    return items;
  }

  /**
   * Sets for an event. With `updatedAfter` this returns only what changed, which
   * is the whole point of the delta sync — a quiet event costs one small call.
   * Without it, every set comes back including the ones already played.
   */
  async fetchEventSets(eventId: Id, updatedAfter?: number | null): Promise<PagedSets> {
    const { items, total } = await this.collectPages<TournamentSet>({
      operation: 'EventSets',
      maxPages: 400,
      fetchPage: async (page, perPage) => {
        const data = await this.requestSets<any>(
          (fragment) => eventSetsQuery(fragment, this.setsSortType),
          { eventId, page, perPage, updatedAfter: updatedAfter ?? null },
          'EventSets',
        );
        const connection = data?.event?.sets;
        return {
          nodes: connection?.nodes ?? [],
          totalPages: Number(connection?.pageInfo?.totalPages ?? 1) || 1,
          total: Number(connection?.pageInfo?.total ?? 0) || null,
        };
      },
      map: (node) => mapSet(node, eventId),
    });
    return { sets: items, total };
  }

  /**
   * Sets for one bracket, read straight off the phase group.
   *
   * This is the same data by a different resolver, which makes it the fallback
   * when the event-level read comes back empty for a bracket that plainly has
   * sets. `eventId` is only a backstop for nodes that arrive without their own
   * `event` — mapping drops a set that cannot be attributed to an event.
   */
  async fetchPhaseGroupSets(phaseGroupId: Id, eventId?: Id): Promise<TournamentSet[]> {
    const { items } = await this.collectPages<TournamentSet>({
      operation: 'PhaseGroupSets',
      maxPages: 200,
      fetchPage: async (page, perPage) => {
        const data = await this.requestSets<any>(
          (fragment) => phaseGroupSetsQuery(fragment, this.setsSortType),
          { phaseGroupId, page, perPage },
          'PhaseGroupSets',
        );
        const connection = data?.phaseGroup?.sets;
        return {
          nodes: connection?.nodes ?? [],
          totalPages: Number(connection?.pageInfo?.totalPages ?? 1) || 1,
          total: null,
        };
      },
      map: (node) => mapSet(node, eventId),
    });
    return items;
  }

  async fetchStandings(eventId: Id): Promise<Standing[]> {
    const { items } = await this.collectPages<Standing>({
      operation: 'EventStandings',
      maxPages: 50,
      fetchPage: async (page, perPage) => {
        const data = await this.request<any>(
          EVENT_STANDINGS,
          { eventId, page, perPage },
          'EventStandings',
        );
        const connection = data?.event?.standings;
        return {
          nodes: connection?.nodes ?? [],
          totalPages: Number(connection?.pageInfo?.totalPages ?? 1) || 1,
          total: null,
        };
      },
      map: (node) => mapStanding(node, eventId),
    });
    return items.sort((a, b) => a.placement - b.placement);
  }

  async fetchStationsAndStreams(eventId: Id): Promise<{
    stations: { id: Id; number: number | null }[];
    streams: { id: Id; name: string }[];
  }> {
    const streams: { id: Id; name: string }[] = [];

    const { items: stations } = await this.collectPages<{ id: Id; number: number | null }>({
      operation: 'EventStations',
      maxPages: 20,
      fetchPage: async (page, perPage) => {
        const data = await this.request<any>(
          EVENT_STATIONS,
          { eventId, page, perPage },
          'EventStations',
        );
        const tournament = data?.event?.tournament;
        // Streams ride along on the first page; they are a plain list, not a
        // connection, so collecting them again per page would duplicate them.
        if (page === 1) {
          // Cleared first: a shrink restarts the walk at page one.
          streams.length = 0;
          for (const stream of tournament?.streams ?? []) {
            if (stream?.id) {
              streams.push({ id: String(stream.id), name: stream.streamName ?? 'Stream' });
            }
          }
        }
        return {
          nodes: tournament?.stations?.nodes ?? [],
          totalPages: Number(tournament?.stations?.pageInfo?.totalPages ?? 1) || 1,
          total: null,
        };
      },
      map: (node) =>
        node?.id ? { id: String(node.id), number: node.number ?? null } : null,
    });

    return { stations, streams };
  }

  // -------------------------------------------------------------------------
  // Mutations. Each returns the updated set as start.gg now sees it, which the
  // outbox writes straight back into the local store so the UI reflects the
  // authoritative result rather than the optimistic guess.
  // -------------------------------------------------------------------------

  async reportSet(params: {
    setId: Id;
    winnerId: Id;
    isDq?: boolean;
    gameData?: unknown[];
  }): Promise<TournamentSet[]> {
    const data = await this.requestSets<any>(
      reportSetMutation,
      {
        setId: params.setId,
        winnerId: params.winnerId,
        isDQ: params.isDq ?? false,
        gameData: params.gameData ?? null,
      },
      'ReportSet',
    );
    const nodes = data?.reportBracketSet;
    const list = Array.isArray(nodes) ? nodes : nodes ? [nodes] : [];
    return list.map((n: any) => mapSet(n)).filter((s: TournamentSet | null): s is TournamentSet => s !== null);
  }

  async markInProgress(setId: Id): Promise<TournamentSet | null> {
    const data = await this.requestSets<any>(
      markInProgressMutation,
      { setId },
      'MarkSetInProgress',
    );
    return mapSet(data?.markSetInProgress ?? {});
  }

  async resetSet(setId: Id, resetDependentSets: boolean): Promise<TournamentSet | null> {
    const data = await this.requestSets<any>(
      resetSetMutation,
      { setId, resetDependentSets },
      'ResetSet',
    );
    return mapSet(data?.resetSet ?? {});
  }

  async assignStation(setId: Id, stationId: Id): Promise<TournamentSet | null> {
    const data = await this.requestSets<any>(
      assignStationMutation,
      { setId, stationId },
      'AssignStation',
    );
    return mapSet(data?.assignStation ?? {});
  }

  async assignStream(setId: Id, streamId: Id): Promise<TournamentSet | null> {
    const data = await this.requestSets<any>(
      assignStreamMutation,
      { setId, streamId },
      'AssignStream',
    );
    return mapSet(data?.assignStream ?? {});
  }

  async updateSeeding(
    phaseId: Id,
    seedMapping: { seedId: Id; seedNum: number }[],
  ): Promise<void> {
    await this.request(
      UPDATE_PHASE_SEEDING,
      { phaseId, seedMapping },
      'UpdatePhaseSeeding',
    );
  }
}
