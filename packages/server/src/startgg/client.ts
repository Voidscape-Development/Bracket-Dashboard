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
  EVENT_ENTRANTS,
  EVENT_STANDINGS,
  EVENT_STATIONS,
  HEALTHCHECK,
  SET_FRAGMENT_LEAN,
  SET_FRAGMENT_RICH,
  UPDATE_PHASE_SEEDING,
  assignStationMutation,
  assignStreamMutation,
  eventSetsQuery,
  markInProgressMutation,
  phaseGroupSetsQuery,
  reportSetMutation,
  resetSetMutation,
  TOURNAMENT_STRUCTURE,
} from './queries.js';
import { GqlError, type GqlTransport } from './transport.js';

export interface ClientOptions {
  /** Requests allowed per rolling minute. Kept below start.gg's published limit. */
  requestsPerMinute?: number;
  /** Simultaneous in-flight requests. */
  concurrency?: number;
  maxRetries?: number;
  perPage?: number;
}

export interface ClientHealth {
  online: boolean;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  requestsLastMinute: number;
  /** True once the rich set fragment has been downgraded. */
  degradedFields: boolean;
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
  private readonly perPage: number;
  private setFragment = SET_FRAGMENT_RICH;
  private degraded = false;

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
    this.perPage = options.perPage ?? 60;
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
    };
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
    try {
      return await this.request<T>(build(this.setFragment), variables, operationName);
    } catch (error) {
      if (this.degraded && error instanceof GqlError && error.kind === 'graphql') {
        return this.request<T>(build(this.setFragment), variables, operationName);
      }
      throw error;
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

  async fetchTournamentStructure(slug: string): Promise<Tournament | null> {
    const data = await this.request<{ tournament: unknown }>(
      TOURNAMENT_STRUCTURE,
      { slug },
      'TournamentStructure',
    );
    if (!data.tournament) return null;
    return mapTournament(data.tournament as Record<string, any>);
  }

  async fetchEntrants(eventId: Id): Promise<Entrant[]> {
    const out: Entrant[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const data = await this.request<any>(
        EVENT_ENTRANTS,
        { eventId, page, perPage: this.perPage },
        'EventEntrants',
      );
      const conn = data?.event?.entrants;
      totalPages = Number(conn?.pageInfo?.totalPages ?? 1) || 1;
      for (const node of conn?.nodes ?? []) {
        const entrant = mapEntrant(node, eventId);
        if (entrant) out.push(entrant);
      }
      page += 1;
    } while (page <= totalPages && page <= 200);

    return out;
  }

  /**
   * Sets for an event. With `updatedAfter` this returns only what changed, which
   * is the whole point of the delta sync — a quiet event costs one small call.
   */
  async fetchEventSets(eventId: Id, updatedAfter?: number | null): Promise<PagedSets> {
    const out: TournamentSet[] = [];
    let page = 1;
    let totalPages = 1;
    let total = 0;

    do {
      const data = await this.requestSets<any>(
        eventSetsQuery,
        {
          eventId,
          page,
          perPage: this.perPage,
          updatedAfter: updatedAfter ?? null,
        },
        'EventSets',
      );
      const conn = data?.event?.sets;
      totalPages = Number(conn?.pageInfo?.totalPages ?? 1) || 1;
      total = Number(conn?.pageInfo?.total ?? out.length) || out.length;
      for (const node of conn?.nodes ?? []) {
        const set = mapSet(node, eventId);
        if (set) out.push(set);
      }
      page += 1;
    } while (page <= totalPages && page <= 400);

    return { sets: out, total };
  }

  async fetchPhaseGroupSets(phaseGroupId: Id): Promise<TournamentSet[]> {
    const out: TournamentSet[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const data = await this.requestSets<any>(
        phaseGroupSetsQuery,
        { phaseGroupId, page, perPage: this.perPage },
        'PhaseGroupSets',
      );
      const conn = data?.phaseGroup?.sets;
      totalPages = Number(conn?.pageInfo?.totalPages ?? 1) || 1;
      for (const node of conn?.nodes ?? []) {
        const set = mapSet(node);
        if (set) out.push(set);
      }
      page += 1;
    } while (page <= totalPages && page <= 200);

    return out;
  }

  async fetchStandings(eventId: Id): Promise<Standing[]> {
    const out: Standing[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const data = await this.request<any>(
        EVENT_STANDINGS,
        { eventId, page, perPage: this.perPage },
        'EventStandings',
      );
      const conn = data?.event?.standings;
      totalPages = Number(conn?.pageInfo?.totalPages ?? 1) || 1;
      for (const node of conn?.nodes ?? []) {
        const standing = mapStanding(node, eventId);
        if (standing) out.push(standing);
      }
      page += 1;
    } while (page <= totalPages && page <= 50);

    return out.sort((a, b) => a.placement - b.placement);
  }

  async fetchStationsAndStreams(eventId: Id): Promise<{
    stations: { id: Id; number: number | null }[];
    streams: { id: Id; name: string }[];
  }> {
    const data = await this.request<any>(EVENT_STATIONS, { eventId }, 'EventStations');
    const tournament = data?.event?.tournament;
    return {
      stations: (tournament?.stations?.nodes ?? [])
        .filter((s: any) => s?.id)
        .map((s: any) => ({ id: String(s.id), number: s.number ?? null })),
      streams: (tournament?.streams ?? [])
        .filter((s: any) => s?.id)
        .map((s: any) => ({ id: String(s.id), name: s.streamName ?? 'Stream' })),
    };
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
