/**
 * Hand-built bracket fixtures.
 *
 * These mirror the shapes start.gg returns (prereq linkage, negative losers
 * rounds, grand final + reset) so the layout tests exercise the real code paths
 * without needing network access.
 */

import { ActivityState, type TournamentSet } from '../dist/index.js';

interface SetSpec {
  id: string;
  identifier: string;
  round: number;
  roundText: string;
  a?: { id: string; name: string; score?: number } | { from: string };
  b?: { id: string; name: string; score?: number } | { from: string };
  winnerId?: string;
  state?: ActivityState;
}

export function makeSet(spec: SetSpec, eventId = 'E1'): TournamentSet {
  const slot = (index: number, s: SetSpec['a']) => {
    if (!s) {
      return {
        slotIndex: index,
        entrantId: null,
        entrantName: null,
        seed: null,
        score: null,
        prereqType: null,
        prereqId: null,
        placeholderText: 'TBD',
      };
    }
    if ('from' in s) {
      return {
        slotIndex: index,
        entrantId: null,
        entrantName: null,
        seed: null,
        score: null,
        prereqType: 'set' as const,
        prereqId: s.from,
        placeholderText: `Winner of ${s.from}`,
      };
    }
    return {
      slotIndex: index,
      entrantId: s.id,
      entrantName: s.name,
      seed: null,
      score: s.score ?? null,
      prereqType: 'seed' as const,
      prereqId: null,
      placeholderText: null,
    };
  };

  return {
    id: spec.id,
    eventId,
    phaseId: 'P1',
    phaseGroupId: 'G1',
    identifier: spec.identifier,
    round: spec.round,
    fullRoundText: spec.roundText,
    state: spec.state ?? (spec.winnerId ? ActivityState.Completed : ActivityState.Created),
    winnerId: spec.winnerId ?? null,
    loserId: null,
    displayScore: null,
    totalGames: null,
    bestOf: 3,
    startedAt: null,
    completedAt: null,
    updatedAt: 1000,
    stationNumber: null,
    stationId: null,
    streamName: null,
    streamId: null,
    slots: [slot(0, spec.a), slot(1, spec.b)],
    games: [],
  };
}

/** 4-entrant single elimination: two semis feeding a final. */
export function singleElimination4(): TournamentSet[] {
  return [
    makeSet({
      id: 's1',
      identifier: '1',
      round: 1,
      roundText: 'Winners Semi-Final',
      a: { id: 'e1', name: 'Alice', score: 2 },
      b: { id: 'e4', name: 'Dave', score: 0 },
      winnerId: 'e1',
    }),
    makeSet({
      id: 's2',
      identifier: '2',
      round: 1,
      roundText: 'Winners Semi-Final',
      a: { id: 'e2', name: 'Bob', score: 1 },
      b: { id: 'e3', name: 'Carol', score: 2 },
      winnerId: 'e3',
    }),
    makeSet({
      id: 's3',
      identifier: '3',
      round: 2,
      roundText: 'Winners Final',
      a: { from: 's1' },
      b: { from: 's2' },
    }),
  ];
}

/**
 * 4-entrant double elimination with the full losers path and a grand final
 * plus reset — the layout shape most likely to break.
 */
export function doubleElimination4(): TournamentSet[] {
  return [
    ...singleElimination4().slice(0, 2),
    makeSet({
      id: 'w3',
      identifier: '3',
      round: 2,
      roundText: 'Winners Final',
      a: { from: 's1' },
      b: { from: 's2' },
    }),
    makeSet({
      id: 'l1',
      identifier: 'L1',
      round: -1,
      roundText: 'Losers Round 1',
      a: { from: 's1' },
      b: { from: 's2' },
    }),
    makeSet({
      id: 'l2',
      identifier: 'L2',
      round: -2,
      roundText: 'Losers Final',
      a: { from: 'l1' },
      b: { from: 'w3' },
    }),
    makeSet({
      id: 'gf',
      identifier: 'GF',
      round: 3,
      roundText: 'Grand Final',
      a: { from: 'w3' },
      b: { from: 'l2' },
    }),
    makeSet({
      id: 'gfr',
      identifier: 'GFR',
      round: 4,
      roundText: 'Grand Final Reset',
      a: { from: 'gf' },
      b: { from: 'gf' },
    }),
  ];
}

/** 3-entrant round robin pool with one match still unplayed. */
export function roundRobin3(): TournamentSet[] {
  return [
    makeSet({
      id: 'r1',
      identifier: '1',
      round: 1,
      roundText: 'Round 1',
      a: { id: 'e1', name: 'Alice', score: 2 },
      b: { id: 'e2', name: 'Bob', score: 1 },
      winnerId: 'e1',
    }),
    makeSet({
      id: 'r2',
      identifier: '2',
      round: 2,
      roundText: 'Round 2',
      a: { id: 'e1', name: 'Alice', score: 0 },
      b: { id: 'e3', name: 'Carol', score: 2 },
      winnerId: 'e3',
    }),
    makeSet({
      id: 'r3',
      identifier: '3',
      round: 3,
      roundText: 'Round 3',
      a: { id: 'e2', name: 'Bob' },
      b: { id: 'e3', name: 'Carol' },
      state: ActivityState.Active,
    }),
  ];
}
