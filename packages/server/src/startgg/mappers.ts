/**
 * start.gg -> domain mapping.
 *
 * Deliberately defensive: every field is treated as possibly missing. The site
 * endpoint returns nulls in places the documented schema implies are non-null
 * (unresolved slots, events without a videogame, sets before seeding), and a
 * venue display must not crash on a half-built bracket.
 */

import {
  ActivityState,
  BRACKET_TYPES,
  type BracketType,
  type Entrant,
  type GameResult,
  type GameSelection,
  type Id,
  type Participant,
  type Phase,
  type PhaseGroup,
  type SetSlot,
  type Standing,
  type Tournament,
  type TournamentEvent,
  type TournamentSet,
} from '@bracket/shared';

type Json = Record<string, any>;

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function id(value: unknown): Id | null {
  const s = str(value);
  return s && s.length > 0 ? s : null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bracketType(value: unknown): BracketType {
  const s = String(value ?? '').toUpperCase();
  return (BRACKET_TYPES as readonly string[]).includes(s)
    ? (s as BracketType)
    : 'CUSTOM_SCHEDULE';
}

function state(value: unknown): ActivityState | null {
  const n = num(value);
  return n === null ? null : (n as ActivityState);
}

function firstImageUrl(images: unknown): string | null {
  if (!Array.isArray(images)) return null;
  for (const image of images) {
    const url = str((image as Json)?.url);
    if (url) return url;
  }
  return null;
}

export function mapParticipant(raw: Json | null | undefined): Participant | null {
  const pid = id(raw?.id);
  if (!pid) return null;
  return {
    id: pid,
    gamerTag: str(raw?.gamerTag) ?? 'Unknown',
    prefix: str(raw?.prefix),
    country: str(raw?.user?.location?.country),
    imageUrl: firstImageUrl(raw?.user?.images),
  };
}

export function mapEntrant(raw: Json | null | undefined, eventId: Id): Entrant | null {
  const eid = id(raw?.id);
  if (!eid) return null;
  return {
    id: eid,
    eventId,
    name: str(raw?.name) ?? 'TBD',
    seed: num(raw?.initialSeedNum),
    isDisqualified: Boolean(raw?.isDisqualified),
    participants: (Array.isArray(raw?.participants) ? raw.participants : [])
      .map(mapParticipant)
      .filter((p): p is Participant => p !== null),
  };
}

function mapSlot(raw: Json, index: number): SetSlot {
  const entrant = raw?.entrant as Json | null | undefined;
  // start.gg reports set score under the slot's standing stats.
  const score = num(raw?.standing?.stats?.score?.value);
  const prereqTypeRaw = str(raw?.prereqType)?.toLowerCase() ?? null;
  const prereqType =
    prereqTypeRaw === 'set' || prereqTypeRaw === 'seed' ? prereqTypeRaw : null;

  return {
    slotIndex: num(raw?.slotIndex) ?? index,
    entrantId: id(entrant?.id),
    entrantName: str(entrant?.name),
    seed: num(entrant?.initialSeedNum) ?? num(raw?.seed?.seedNum),
    // A score of -1 is start.gg's DQ marker; keep it, the renderer shows "DQ".
    score,
    prereqType,
    prereqId: str(raw?.prereqId),
    placeholderText: entrant?.id ? null : buildPlaceholder(prereqType, str(raw?.prereqId)),
  };
}

function buildPlaceholder(
  prereqType: 'set' | 'seed' | null,
  prereqId: string | null,
): string {
  if (prereqType === 'set' && prereqId) return `Winner of ${prereqId}`;
  return 'TBD';
}

function mapGame(raw: Json): GameResult | null {
  const gid = id(raw?.id);
  if (!gid) return null;
  const selections: GameSelection[] = (Array.isArray(raw?.selections) ? raw.selections : [])
    .map((sel: Json): GameSelection | null => {
      const entrantId = id(sel?.entrant?.id);
      if (!entrantId) return null;
      return {
        entrantId,
        characterName: str(sel?.character?.name),
        characterImageUrl: firstImageUrl(sel?.character?.images),
      };
    })
    .filter((s: GameSelection | null): s is GameSelection => s !== null);

  return {
    id: gid,
    orderNum: num(raw?.orderNum) ?? 0,
    winnerId: id(raw?.winnerId),
    selections,
    stageName: str(raw?.stage?.name),
  };
}

export function mapSet(raw: Json, fallbackEventId?: Id): TournamentSet | null {
  const sid = id(raw?.id);
  if (!sid) return null;

  const eventId = id(raw?.event?.id) ?? fallbackEventId ?? null;
  if (!eventId) return null;

  const slots: SetSlot[] = (Array.isArray(raw?.slots) ? raw.slots : []).map(mapSlot);
  const winnerId = id(raw?.winnerId);
  const loserId =
    winnerId === null
      ? null
      : slots.find((s) => s.entrantId && s.entrantId !== winnerId)?.entrantId ?? null;

  return {
    id: sid,
    eventId,
    phaseId: id(raw?.phaseGroup?.phase?.id) ?? '',
    phaseGroupId: id(raw?.phaseGroup?.id) ?? '',
    identifier: str(raw?.identifier) ?? sid,
    round: num(raw?.round) ?? 0,
    fullRoundText: str(raw?.fullRoundText) ?? '',
    state: state(raw?.state) ?? ActivityState.Created,
    winnerId,
    loserId,
    displayScore: str(raw?.displayScore),
    totalGames: num(raw?.totalGames),
    bestOf: num(raw?.totalGames),
    startedAt: num(raw?.startedAt),
    completedAt: num(raw?.completedAt),
    updatedAt: num(raw?.updatedAt) ?? num(raw?.completedAt) ?? num(raw?.startedAt),
    stationNumber: num(raw?.station?.number),
    stationId: id(raw?.station?.id),
    streamName: str(raw?.stream?.streamName),
    streamId: id(raw?.stream?.id),
    slots,
    games: (Array.isArray(raw?.games) ? raw.games : [])
      .map(mapGame)
      .filter((g: GameResult | null): g is GameResult => g !== null)
      .sort((a: GameResult, b: GameResult) => a.orderNum - b.orderNum),
  };
}

export function mapPhaseGroup(raw: Json, phaseId: Id, eventId: Id): PhaseGroup | null {
  const gid = id(raw?.id);
  if (!gid) return null;
  return {
    id: gid,
    phaseId,
    eventId,
    displayIdentifier: str(raw?.displayIdentifier) ?? gid,
    bracketType: bracketType(raw?.bracketType),
    state: state(raw?.state),
    rounds: (Array.isArray(raw?.rounds) ? raw.rounds : [])
      .map((r: Json) => ({ number: num(r?.number) ?? 0, bestOf: num(r?.bestOf) }))
      .filter((r: { number: number }) => r.number !== 0),
  };
}

export function mapPhase(raw: Json, eventId: Id): Phase | null {
  const pid = id(raw?.id);
  if (!pid) return null;
  const type = bracketType(raw?.bracketType);
  const groupNodes: Json[] = Array.isArray(raw?.phaseGroups?.nodes)
    ? raw.phaseGroups.nodes
    : [];

  return {
    id: pid,
    eventId,
    name: str(raw?.name) ?? 'Phase',
    phaseOrder: num(raw?.phaseOrder) ?? 0,
    bracketType: type,
    groupCount: num(raw?.groupCount) ?? groupNodes.length,
    state: state(raw?.state),
    groups: groupNodes
      .map((g) => mapPhaseGroup(g, pid, eventId))
      .filter((g): g is PhaseGroup => g !== null)
      // A group can omit its own bracketType; inherit the phase's.
      .map((g) => (g.bracketType === 'CUSTOM_SCHEDULE' ? { ...g, bracketType: type } : g)),
  };
}

export function mapEvent(raw: Json, tournamentId: Id): TournamentEvent | null {
  const eid = id(raw?.id);
  if (!eid) return null;
  return {
    id: eid,
    tournamentId,
    name: str(raw?.name) ?? 'Event',
    slug: str(raw?.slug) ?? '',
    state: state(raw?.state),
    startAt: num(raw?.startAt),
    numEntrants: num(raw?.numEntrants),
    videogameId: id(raw?.videogame?.id),
    videogameName: str(raw?.videogame?.name),
    videogameImageUrl: firstImageUrl(raw?.videogame?.images),
    phases: (Array.isArray(raw?.phases) ? raw.phases : [])
      .map((p: Json) => mapPhase(p, eid))
      .filter((p: Phase | null): p is Phase => p !== null)
      .sort((a: Phase, b: Phase) => a.phaseOrder - b.phaseOrder),
  };
}

export function mapTournament(raw: Json): Tournament | null {
  const tid = id(raw?.id);
  if (!tid) return null;
  return {
    id: tid,
    slug: str(raw?.slug) ?? '',
    name: str(raw?.name) ?? 'Tournament',
    startAt: num(raw?.startAt),
    endAt: num(raw?.endAt),
    timezone: str(raw?.timezone),
    venueName: str(raw?.venueName),
    city: str(raw?.city),
    events: (Array.isArray(raw?.events) ? raw.events : [])
      .map((e: Json) => mapEvent(e, tid))
      .filter((e: TournamentEvent | null): e is TournamentEvent => e !== null),
  };
}

export function mapStanding(raw: Json, eventId: Id): Standing | null {
  const entrantId = id(raw?.entrant?.id);
  const placement = num(raw?.placement);
  if (!entrantId || placement === null) return null;
  return {
    eventId,
    entrantId,
    entrantName: str(raw?.entrant?.name) ?? 'TBD',
    placement,
    isFinal: Boolean(raw?.isFinal),
  };
}
