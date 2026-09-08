/**
 * Mock start.gg.
 *
 * A self-contained tournament that behaves like the real endpoint: paged
 * connections, `updatedAfter` filtering, working mutations, and matches that
 * progress on a timer so overlays and the delta sync can be exercised without
 * a network or a live bracket.
 *
 * Enabled with `STARTGG_TRANSPORT=mock`. It is a development and demo aid, not
 * a fallback — the real transports never silently defer to it.
 */

import { GqlError, type GqlRequest, type GqlTransport } from './transport.js';

interface MockSlot {
  slotIndex: number;
  entrantId: string | null;
  prereqType: 'set' | 'seed' | null;
  prereqId: string | null;
  score: number | null;
}

interface MockSet {
  id: string;
  eventId: string;
  phaseId: string;
  phaseGroupId: string;
  identifier: string;
  round: number;
  fullRoundText: string;
  state: number;
  winnerId: string | null;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
  stationNumber: number | null;
  streamName: string | null;
  slots: MockSlot[];
  games: { id: string; orderNum: number; winnerId: string }[];
}

interface MockEvent {
  id: string;
  name: string;
  slug: string;
  bracketType: string;
  phaseId: string;
  phaseGroupId: string;
  entrants: { id: string; name: string; seed: number }[];
  sets: MockSet[];
}

const TAGS = [
  'Mango', 'Zain', 'iBDW', 'Cody', 'Plup', 'Jmook', 'aMSa', 'Hbox',
  'Leffen', 'Axe', 'Wizzrobe', 'SFAT', 'Moky', 'Soonsay', 'Fiction', 'Krudo',
];

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** Builds a standard power-of-two double elimination bracket with full wiring. */
function buildDoubleElimination(eventId: string, phaseId: string, groupId: string, size: 8): MockSet[] {
  const sets: MockSet[] = [];
  const mk = (
    id: string,
    identifier: string,
    round: number,
    text: string,
    a: MockSlot,
    b: MockSlot,
  ): MockSet => ({
    id,
    eventId,
    phaseId,
    phaseGroupId: groupId,
    identifier,
    round,
    fullRoundText: text,
    state: 1,
    winnerId: null,
    startedAt: null,
    completedAt: null,
    updatedAt: now(),
    stationNumber: null,
    streamName: null,
    slots: [a, b],
    games: [],
  });

  const seedSlot = (index: number, entrantId: string): MockSlot => ({
    slotIndex: index,
    entrantId,
    prereqType: 'seed',
    prereqId: null,
    score: null,
  });
  const fromSet = (index: number, setId: string): MockSlot => ({
    slotIndex: index,
    entrantId: null,
    prereqType: 'set',
    prereqId: setId,
    score: null,
  });

  // Winners round 1: standard 1v8, 4v5, 3v6, 2v7 seeding.
  const pairs: [number, number][] = [
    [1, 8],
    [4, 5],
    [3, 6],
    [2, 7],
  ];
  pairs.forEach(([hi, lo], i) => {
    sets.push(
      mk(
        `w1-${i + 1}`,
        `${i + 1}`,
        1,
        'Winners Quarter-Final',
        seedSlot(0, `e${hi}`),
        seedSlot(1, `e${lo}`),
      ),
    );
  });

  sets.push(
    mk('w2-1', '5', 2, 'Winners Semi-Final', fromSet(0, 'w1-1'), fromSet(1, 'w1-2')),
    mk('w2-2', '6', 2, 'Winners Semi-Final', fromSet(0, 'w1-3'), fromSet(1, 'w1-4')),
    mk('w3-1', '7', 3, 'Winners Final', fromSet(0, 'w2-1'), fromSet(1, 'w2-2')),
  );

  // Losers: R1 takes WR1 losers, R2 mixes in WR2 losers, R3 consolidates,
  // LF takes the winners-final loser.
  sets.push(
    mk('l1-1', 'L1', -1, 'Losers Round 1', fromSet(0, 'w1-1'), fromSet(1, 'w1-2')),
    mk('l1-2', 'L2', -1, 'Losers Round 1', fromSet(0, 'w1-3'), fromSet(1, 'w1-4')),
    mk('l2-1', 'L3', -2, 'Losers Round 2', fromSet(0, 'l1-1'), fromSet(1, 'w2-2')),
    mk('l2-2', 'L4', -2, 'Losers Round 2', fromSet(0, 'l1-2'), fromSet(1, 'w2-1')),
    mk('l3-1', 'L5', -3, 'Losers Semi-Final', fromSet(0, 'l2-1'), fromSet(1, 'l2-2')),
    mk('l4-1', 'L6', -4, 'Losers Final', fromSet(0, 'l3-1'), fromSet(1, 'w3-1')),
    mk('gf', 'GF', 4, 'Grand Final', fromSet(0, 'w3-1'), fromSet(1, 'l4-1')),
    mk('gfr', 'GFR', 5, 'Grand Final Reset', fromSet(0, 'gf'), fromSet(1, 'gf')),
  );

  void size;
  return sets;
}

function buildRoundRobin(
  eventId: string,
  phaseId: string,
  groupId: string,
  entrantIds: string[],
): MockSet[] {
  const sets: MockSet[] = [];
  let n = 1;
  for (let i = 0; i < entrantIds.length; i++) {
    for (let j = i + 1; j < entrantIds.length; j++) {
      sets.push({
        id: `rr-${n}`,
        eventId,
        phaseId,
        phaseGroupId: groupId,
        identifier: `${n}`,
        round: n,
        fullRoundText: `Round ${n}`,
        state: 1,
        winnerId: null,
        startedAt: null,
        completedAt: null,
        updatedAt: now(),
        stationNumber: null,
        streamName: null,
        slots: [
          { slotIndex: 0, entrantId: entrantIds[i] as string, prereqType: 'seed', prereqId: null, score: null },
          { slotIndex: 1, entrantId: entrantIds[j] as string, prereqType: 'seed', prereqId: null, score: null },
        ],
        games: [],
      });
      n += 1;
    }
  }
  return sets;
}

function buildSingleElimination(
  eventId: string,
  phaseId: string,
  groupId: string,
  entrantIds: string[],
): MockSet[] {
  const sets: MockSet[] = [];
  const half = entrantIds.length / 2;
  for (let i = 0; i < half; i++) {
    sets.push({
      id: `se1-${i + 1}`,
      eventId,
      phaseId,
      phaseGroupId: groupId,
      identifier: `${i + 1}`,
      round: 1,
      fullRoundText: 'Semi-Final',
      state: 1,
      winnerId: null,
      startedAt: null,
      completedAt: null,
      updatedAt: now(),
      stationNumber: null,
      streamName: null,
      slots: [
        { slotIndex: 0, entrantId: entrantIds[i * 2] as string, prereqType: 'seed', prereqId: null, score: null },
        { slotIndex: 1, entrantId: entrantIds[i * 2 + 1] as string, prereqType: 'seed', prereqId: null, score: null },
      ],
      games: [],
    });
  }
  sets.push({
    id: 'se2-1',
    eventId,
    phaseId,
    phaseGroupId: groupId,
    identifier: `${half + 1}`,
    round: 2,
    fullRoundText: 'Final',
    state: 1,
    winnerId: null,
    startedAt: null,
    completedAt: null,
    updatedAt: now(),
    stationNumber: null,
    streamName: null,
    slots: [
      { slotIndex: 0, entrantId: null, prereqType: 'set', prereqId: 'se1-1', score: null },
      { slotIndex: 1, entrantId: null, prereqType: 'set', prereqId: 'se1-2', score: null },
    ],
    games: [],
  });
  return sets;
}

/**
 * The simulated tournament. `tick()` advances play: it starts sets whose
 * entrants are known and completes sets that have been running, propagating
 * winners forward exactly as start.gg would.
 */
export class MockWorld {
  readonly slug = 'bracket-dashboard-demo';
  readonly tournamentId = '900001';
  readonly events: MockEvent[] = [];

  constructor() {
    const mainEntrants = Array.from({ length: 8 }, (_, i) => ({
      id: `e${i + 1}`,
      name: TAGS[i] as string,
      seed: i + 1,
    }));
    this.events.push({
      id: '100001',
      name: 'Melee Singles',
      slug: `tournament/${this.slug}/event/melee-singles`,
      bracketType: 'DOUBLE_ELIMINATION',
      phaseId: '200001',
      phaseGroupId: '300001',
      entrants: mainEntrants,
      sets: buildDoubleElimination('100001', '200001', '300001', 8),
    });

    const poolEntrants = Array.from({ length: 4 }, (_, i) => ({
      id: `p${i + 1}`,
      name: TAGS[i + 8] as string,
      seed: i + 1,
    }));
    this.events.push({
      id: '100002',
      name: 'Ultimate Singles — Pool A',
      slug: `tournament/${this.slug}/event/ultimate-singles`,
      bracketType: 'ROUND_ROBIN',
      phaseId: '200002',
      phaseGroupId: '300002',
      entrants: poolEntrants,
      sets: buildRoundRobin(
        '100002',
        '200002',
        '300002',
        poolEntrants.map((e) => e.id),
      ),
    });

    const doublesEntrants = Array.from({ length: 4 }, (_, i) => ({
      id: `d${i + 1}`,
      name: `${TAGS[i]} + ${TAGS[i + 4]}`,
      seed: i + 1,
    }));
    this.events.push({
      id: '100003',
      name: 'Melee Doubles',
      slug: `tournament/${this.slug}/event/melee-doubles`,
      bracketType: 'SINGLE_ELIMINATION',
      phaseId: '200003',
      phaseGroupId: '300003',
      entrants: doublesEntrants,
      sets: buildSingleElimination(
        '100003',
        '200003',
        '300003',
        doublesEntrants.map((e) => e.id),
      ),
    });
  }

  findSet(setId: string): { event: MockEvent; set: MockSet } | null {
    for (const event of this.events) {
      const set = event.sets.find((s) => s.id === setId);
      if (set) return { event, set };
    }
    return null;
  }

  private resolveSlots(event: MockEvent): void {
    for (const set of event.sets) {
      for (const slot of set.slots) {
        if (slot.entrantId || slot.prereqType !== 'set' || !slot.prereqId) continue;
        const source = event.sets.find((s) => s.id === slot.prereqId);
        if (!source || source.state !== 3 || !source.winnerId) continue;

        // A losers-side slot fed from the winners bracket receives the loser.
        if (set.round < 0 && source.round > 0) {
          const loser = source.slots.find((s) => s.entrantId && s.entrantId !== source.winnerId);
          slot.entrantId = loser?.entrantId ?? null;
        } else {
          slot.entrantId = source.winnerId;
        }
        if (slot.entrantId) set.updatedAt = now();
      }
    }
  }

  /** Advances the simulation one step. */
  tick(): void {
    for (const event of this.events) {
      this.resolveSlots(event);

      const ready = event.sets.filter(
        (s) => s.state === 1 && s.slots.every((slot) => slot.entrantId),
      );
      const active = event.sets.filter((s) => s.state === 2);

      // Keep two matches running per event.
      for (const set of ready.slice(0, Math.max(0, 2 - active.length))) {
        set.state = 2;
        set.startedAt = now();
        set.updatedAt = now();
        set.stationNumber = 1 + (Number(set.id.replace(/\D/g, '')) % 6);
        if (/final/i.test(set.fullRoundText)) set.streamName = 'MainStage';
      }

      // Complete the oldest running match.
      const oldest = active.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))[0];
      if (oldest && (oldest.startedAt ?? 0) < now() - 8) {
        const a = oldest.slots[0];
        const b = oldest.slots[1];
        if (a?.entrantId && b?.entrantId) {
          // Lower seed number wins more often, with an upset chance.
          const upset = Math.random() < 0.3;
          const winner = upset ? b.entrantId : a.entrantId;
          const loserScore = Math.floor(Math.random() * 2);
          a.score = winner === a.entrantId ? 2 : loserScore;
          b.score = winner === b.entrantId ? 2 : loserScore;
          oldest.winnerId = winner;
          oldest.state = 3;
          oldest.completedAt = now();
          oldest.updatedAt = now();
          oldest.games = Array.from({ length: 2 + loserScore }, (_, i) => ({
            id: `${oldest.id}-g${i + 1}`,
            orderNum: i + 1,
            winnerId: i === 0 && loserScore > 0 ? (b.entrantId as string) : winner,
          }));
        }
      }
      this.resolveSlots(event);
    }
  }

  standings(eventId: string): { entrantId: string; name: string; placement: number }[] {
    const event = this.events.find((e) => e.id === eventId);
    if (!event) return [];
    const losses = new Map<string, number>();
    for (const entrant of event.entrants) losses.set(entrant.id, 0);
    for (const set of event.sets) {
      if (set.state !== 3 || !set.winnerId) continue;
      const loser = set.slots.find((s) => s.entrantId && s.entrantId !== set.winnerId);
      if (loser?.entrantId) {
        losses.set(loser.entrantId, (losses.get(loser.entrantId) ?? 0) + 1);
      }
    }
    return event.entrants
      .slice()
      .sort((a, b) => (losses.get(a.id) ?? 0) - (losses.get(b.id) ?? 0) || a.seed - b.seed)
      .map((entrant, i) => ({ entrantId: entrant.id, name: entrant.name, placement: i + 1 }));
  }
}

function entrantPayload(event: MockEvent, entrantId: string | null) {
  if (!entrantId) return null;
  const entrant = event.entrants.find((e) => e.id === entrantId);
  if (!entrant) return null;
  return {
    id: entrant.id,
    name: entrant.name,
    initialSeedNum: entrant.seed,
    isDisqualified: false,
    participants: [
      { id: `${entrant.id}-p`, gamerTag: entrant.name, prefix: null, user: null },
    ],
  };
}

function setPayload(event: MockEvent, set: MockSet) {
  return {
    id: set.id,
    identifier: set.identifier,
    round: set.round,
    fullRoundText: set.fullRoundText,
    state: set.state,
    winnerId: set.winnerId,
    displayScore:
      set.state === 3
        ? set.slots
            .map((s) => `${entrantPayload(event, s.entrantId)?.name ?? 'TBD'} ${s.score ?? 0}`)
            .join(' - ')
        : null,
    totalGames: 3,
    startedAt: set.startedAt,
    completedAt: set.completedAt,
    updatedAt: set.updatedAt,
    station: set.stationNumber ? { id: `st${set.stationNumber}`, number: set.stationNumber } : null,
    stream: set.streamName ? { id: 'stream1', streamName: set.streamName } : null,
    phaseGroup: { id: set.phaseGroupId, phase: { id: set.phaseId } },
    event: { id: set.eventId },
    slots: set.slots.map((slot) => ({
      id: `${set.id}-${slot.slotIndex}`,
      slotIndex: slot.slotIndex,
      prereqType: slot.prereqType,
      prereqId: slot.prereqId,
      seed: null,
      entrant: entrantPayload(event, slot.entrantId),
      standing: slot.score === null ? null : { stats: { score: { value: slot.score } } },
    })),
    games: set.games.map((g) => ({
      id: g.id,
      orderNum: g.orderNum,
      winnerId: g.winnerId,
      stage: null,
      selections: [],
    })),
  };
}

function paginate<T>(items: T[], page: number, perPage: number) {
  const start = (page - 1) * perPage;
  return {
    nodes: items.slice(start, start + perPage),
    pageInfo: {
      total: items.length,
      totalPages: Math.max(1, Math.ceil(items.length / perPage)),
      page,
    },
  };
}

/**
 * Transport that answers against a `MockWorld`. Dispatches on operation name,
 * which is why every document in queries.ts carries one.
 */
export class MockTransport implements GqlTransport {
  readonly name = 'mock';
  readonly endpoint = 'mock://start.gg';
  readonly canMutate = true;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly world = new MockWorld(),
    options: { autoAdvanceMs?: number } = {},
  ) {
    const interval = options.autoAdvanceMs ?? 6000;
    if (interval > 0) {
      this.timer = setInterval(() => this.world.tick(), interval);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async execute<T>(request: GqlRequest): Promise<T> {
    const op = request.operationName ?? inferOperation(request.query);
    const vars = request.variables ?? {};
    const world = this.world;

    const eventById = (eventId: unknown) =>
      world.events.find((e) => e.id === String(eventId));

    switch (op) {
      case 'Healthcheck':
        return { __typename: 'Query' } as T;

      case 'TournamentStructure': {
        if (String(vars.slug) !== world.slug) return { tournament: null } as T;
        return {
          tournament: {
            id: world.tournamentId,
            name: 'Bracket Dashboard Demo',
            slug: world.slug,
            startAt: now() - 3600,
            endAt: now() + 3600 * 6,
            timezone: 'America/New_York',
            venueName: 'Demo Venue',
            city: 'Testville',
            events: world.events.map((event) => ({
              id: event.id,
              name: event.name,
              slug: event.slug,
              state: 2,
              startAt: now() - 1800,
              numEntrants: event.entrants.length,
              videogame: { id: '1', name: 'Demo Game', images: [] },
              phases: [
                {
                  id: event.phaseId,
                  name: 'Bracket',
                  phaseOrder: 1,
                  bracketType: event.bracketType,
                  groupCount: 1,
                  state: 2,
                  phaseGroups: {
                    nodes: [
                      {
                        id: event.phaseGroupId,
                        displayIdentifier: 'A',
                        bracketType: event.bracketType,
                        state: 2,
                        rounds: [],
                      },
                    ],
                  },
                },
              ],
            })),
          },
        } as T;
      }

      case 'EventEntrants': {
        const event = eventById(vars.eventId);
        if (!event) throw new GqlError('Event not found', 'graphql');
        const nodes = event.entrants.map((e) => entrantPayload(event, e.id));
        return {
          event: {
            id: event.id,
            entrants: paginate(nodes, Number(vars.page ?? 1), Number(vars.perPage ?? 50)),
          },
        } as T;
      }

      case 'EventSets': {
        const event = eventById(vars.eventId);
        if (!event) throw new GqlError('Event not found', 'graphql');
        const updatedAfter = vars.updatedAfter == null ? null : Number(vars.updatedAfter);
        const filtered = event.sets.filter(
          (s) => updatedAfter === null || s.updatedAt > updatedAfter,
        );
        const nodes = filtered.map((s) => setPayload(event, s));
        return {
          event: {
            id: event.id,
            sets: paginate(nodes, Number(vars.page ?? 1), Number(vars.perPage ?? 50)),
          },
        } as T;
      }

      case 'PhaseGroupSets': {
        const event = world.events.find((e) => e.phaseGroupId === String(vars.phaseGroupId));
        if (!event) throw new GqlError('Phase group not found', 'graphql');
        const nodes = event.sets.map((s) => setPayload(event, s));
        return {
          phaseGroup: {
            id: event.phaseGroupId,
            displayIdentifier: 'A',
            bracketType: event.bracketType,
            state: 2,
            rounds: [],
            sets: paginate(nodes, Number(vars.page ?? 1), Number(vars.perPage ?? 50)),
          },
        } as T;
      }

      case 'EventStandings': {
        const event = eventById(vars.eventId);
        if (!event) throw new GqlError('Event not found', 'graphql');
        const nodes = world.standings(event.id).map((s) => ({
          id: `${event.id}-${s.entrantId}`,
          placement: s.placement,
          isFinal: false,
          entrant: { id: s.entrantId, name: s.name },
        }));
        return {
          event: {
            id: event.id,
            standings: paginate(nodes, Number(vars.page ?? 1), Number(vars.perPage ?? 50)),
          },
        } as T;
      }

      case 'EventStations': {
        const event = eventById(vars.eventId);
        if (!event) throw new GqlError('Event not found', 'graphql');
        return {
          event: {
            id: event.id,
            tournament: {
              id: world.tournamentId,
              stations: {
                nodes: Array.from({ length: 6 }, (_, i) => ({
                  id: `st${i + 1}`,
                  number: i + 1,
                  state: 1,
                })),
              },
              streams: [
                { id: 'stream1', streamName: 'MainStage', streamSource: 'TWITCH' },
              ],
            },
          },
        } as T;
      }

      case 'ReportSet': {
        const found = world.findSet(String(vars.setId));
        if (!found) throw new GqlError('Set not found', 'graphql');
        const { event, set } = found;
        const winnerId = String(vars.winnerId);
        set.winnerId = winnerId;
        set.state = 3;
        set.completedAt = now();
        set.updatedAt = now();
        for (const slot of set.slots) {
          slot.score = slot.entrantId === winnerId ? 2 : 0;
        }
        world.tick();
        return { reportBracketSet: [setPayload(event, set)] } as T;
      }

      case 'MarkSetInProgress': {
        const found = world.findSet(String(vars.setId));
        if (!found) throw new GqlError('Set not found', 'graphql');
        found.set.state = 2;
        found.set.startedAt = now();
        found.set.updatedAt = now();
        return { markSetInProgress: setPayload(found.event, found.set) } as T;
      }

      case 'ResetSet': {
        const found = world.findSet(String(vars.setId));
        if (!found) throw new GqlError('Set not found', 'graphql');
        const { set } = found;
        set.state = 1;
        set.winnerId = null;
        set.completedAt = null;
        set.startedAt = null;
        set.games = [];
        for (const slot of set.slots) slot.score = null;
        set.updatedAt = now();
        return { resetSet: setPayload(found.event, set) } as T;
      }

      case 'AssignStation': {
        const found = world.findSet(String(vars.setId));
        if (!found) throw new GqlError('Set not found', 'graphql');
        found.set.stationNumber = Number(String(vars.stationId).replace(/\D/g, '')) || 1;
        found.set.updatedAt = now();
        return { assignStation: setPayload(found.event, found.set) } as T;
      }

      case 'AssignStream': {
        const found = world.findSet(String(vars.setId));
        if (!found) throw new GqlError('Set not found', 'graphql');
        found.set.streamName = 'MainStage';
        found.set.updatedAt = now();
        return { assignStream: setPayload(found.event, found.set) } as T;
      }

      case 'UpdatePhaseSeeding':
        return { updatePhaseSeeding: { id: String(vars.phaseId), name: 'Bracket' } } as T;

      default:
        throw new GqlError(`Mock transport has no handler for ${op}`, 'graphql');
    }
  }
}

function inferOperation(query: string): string {
  const match = /(?:query|mutation)\s+(\w+)/.exec(query);
  return match?.[1] ?? 'Unknown';
}
