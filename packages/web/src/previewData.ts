/**
 * A small fake bracket used by the theme editor's preview, so styling works
 * before any tournament has been imported.
 */

import { ActivityState, type TournamentSet } from '@bracket/shared';

function slot(index: number, name: string | null, seed: number | null, score: number | null) {
  return {
    slotIndex: index,
    entrantId: name ? `preview-${name}` : null,
    entrantName: name,
    seed,
    score,
    prereqType: null,
    prereqId: null,
    placeholderText: name ? null : 'TBD',
  };
}

function set(
  id: string,
  identifier: string,
  round: number,
  roundText: string,
  a: ReturnType<typeof slot>,
  b: ReturnType<typeof slot>,
  state: ActivityState,
  winnerName?: string,
): TournamentSet {
  return {
    id,
    eventId: 'preview',
    phaseId: 'preview',
    phaseGroupId: 'preview',
    identifier,
    round,
    fullRoundText: roundText,
    state,
    winnerId: winnerName ? `preview-${winnerName}` : null,
    loserId: null,
    displayScore: null,
    totalGames: 3,
    bestOf: 3,
    startedAt: null,
    completedAt: null,
    updatedAt: null,
    stationNumber: state === ActivityState.Active ? 3 : null,
    stationId: null,
    streamName: round >= 2 ? 'Main Stage' : null,
    streamId: null,
    slots: [a, b],
    games: [],
  };
}

export const previewSets: TournamentSet[] = [
  set(
    'p1',
    '1',
    1,
    'Winners Semi-Final',
    slot(0, 'Ari', 1, 2),
    slot(1, 'Boone', 4, 0),
    ActivityState.Completed,
    'Ari',
  ),
  set(
    'p2',
    '2',
    1,
    'Winners Semi-Final',
    slot(0, 'Cass', 2, 1),
    slot(1, 'Dev', 3, 2),
    ActivityState.Active,
  ),
  set(
    'p3',
    '3',
    2,
    'Winners Final',
    slot(0, 'Ari', 1, null),
    slot(1, null, null, null),
    ActivityState.Created,
  ),
  set(
    'p4',
    'L1',
    -1,
    'Losers Round 1',
    slot(0, 'Boone', 4, null),
    slot(1, null, null, null),
    ActivityState.Created,
  ),
];
