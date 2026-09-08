/**
 * GraphQL documents.
 *
 * Two variants of the set fragment exist. The rich one asks for everything the
 * UI can use; the lean one asks only for fields that have been stable for years.
 * The client starts rich and permanently downgrades if start.gg replies "Cannot
 * query field" — the site endpoint is undocumented, so a field can disappear and
 * an unattended venue display should degrade rather than go dark.
 */

export const SET_FRAGMENT_RICH = /* GraphQL */ `
  fragment SetParts on Set {
    id
    identifier
    round
    fullRoundText
    state
    winnerId
    displayScore
    totalGames
    startedAt
    completedAt
    updatedAt
    station {
      id
      number
    }
    stream {
      id
      streamName
    }
    phaseGroup {
      id
      phase {
        id
      }
    }
    event {
      id
    }
    slots {
      id
      slotIndex
      prereqType
      prereqId
      seed {
        seedNum
      }
      entrant {
        id
        name
        initialSeedNum
        isDisqualified
        participants {
          id
          gamerTag
          prefix
          user {
            images(type: "profile") {
              url
            }
            location {
              country
            }
          }
        }
      }
      standing {
        stats {
          score {
            value
          }
        }
      }
    }
    games {
      id
      orderNum
      winnerId
      stage {
        id
        name
      }
      selections {
        entrant {
          id
        }
        selectionValue
        character {
          id
          name
          images(type: "stockIcon") {
            url
          }
        }
      }
    }
  }
`;

/**
 * Deliberately does not ask for `updatedAt`: this fragment is the safety net
 * the rich one falls back to, so it stays limited to fields that have never
 * moved. The sync watermark falls back to completedAt/startedAt without it.
 */
export const SET_FRAGMENT_LEAN = /* GraphQL */ `
  fragment SetParts on Set {
    id
    identifier
    round
    fullRoundText
    state
    winnerId
    displayScore
    totalGames
    startedAt
    completedAt
    phaseGroup {
      id
      phase {
        id
      }
    }
    event {
      id
    }
    slots {
      id
      slotIndex
      prereqType
      prereqId
      entrant {
        id
        name
        initialSeedNum
      }
      standing {
        stats {
          score {
            value
          }
        }
      }
    }
  }
`;

/**
 * Whole-tournament structure in one call: events, phases and phase groups.
 *
 * This is the most complexity-hungry read in the app, and both endpoints cap a
 * response at 1000 objects. The cost is roughly
 *
 *     events x phases x groupPerPage x (1 + rounds per group)
 *
 * so the group page size is a variable, not a constant: the client shrinks it
 * when start.gg rejects the request and pages in whatever was cut off. The old
 * hard-coded `perPage: 250` is what pushed a multi-event tournament with pools
 * past the ceiling in a single call.
 */
export const TOURNAMENT_STRUCTURE = /* GraphQL */ `
  query TournamentStructure($slug: String!, $groupPage: Int!, $groupPerPage: Int!) {
    tournament(slug: $slug) {
      id
      name
      slug
      startAt
      endAt
      timezone
      venueName
      city
      events {
        id
        name
        slug
        state
        startAt
        numEntrants
        videogame {
          id
          name
          images(type: "primary") {
            url
          }
        }
        phases {
          id
          name
          phaseOrder
          bracketType
          groupCount
          state
          phaseGroups(query: { page: $groupPage, perPage: $groupPerPage }) {
            pageInfo {
              total
              totalPages
              page
            }
            nodes {
              id
              displayIdentifier
              bracketType
              state
              rounds {
                number
                bestOf
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Structure without any phase groups: the fallback for a tournament so large
 * that even one group per phase breaches the ceiling. Groups are then fetched
 * per phase with PHASE_GROUPS and stitched back on.
 */
export const TOURNAMENT_EVENTS = /* GraphQL */ `
  query TournamentEvents($slug: String!) {
    tournament(slug: $slug) {
      id
      name
      slug
      startAt
      endAt
      timezone
      venueName
      city
      events {
        id
        name
        slug
        state
        startAt
        numEntrants
        videogame {
          id
          name
          images(type: "primary") {
            url
          }
        }
        phases {
          id
          name
          phaseOrder
          bracketType
          groupCount
          state
        }
      }
    }
  }
`;

/** One phase's groups, paged. Used to complete or replace the structure read. */
export const PHASE_GROUPS = /* GraphQL */ `
  query PhaseGroups($phaseId: ID!, $page: Int!, $perPage: Int!) {
    phase(id: $phaseId) {
      id
      phaseGroups(query: { page: $page, perPage: $perPage }) {
        pageInfo {
          total
          totalPages
          page
        }
        nodes {
          id
          displayIdentifier
          bracketType
          state
          rounds {
            number
            bestOf
          }
        }
      }
    }
  }
`;

export const EVENT_ENTRANTS = /* GraphQL */ `
  query EventEntrants($eventId: ID!, $page: Int!, $perPage: Int!) {
    event(id: $eventId) {
      id
      entrants(query: { page: $page, perPage: $perPage }) {
        pageInfo {
          totalPages
          page
        }
        nodes {
          id
          name
          initialSeedNum
          isDisqualified
          participants {
            id
            gamerTag
            prefix
            user {
              images(type: "profile") {
                url
              }
              location {
                country
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Sets for an event, optionally only those touched since `updatedAfter`. The
 * filter is what keeps steady-state polling cheap: a quiet event returns an
 * empty page instead of the whole bracket.
 */
export function eventSetsQuery(setFragment: string): string {
  return /* GraphQL */ `
    ${setFragment}
    query EventSets(
      $eventId: ID!
      $page: Int!
      $perPage: Int!
      $updatedAfter: Timestamp
    ) {
      event(id: $eventId) {
        id
        sets(
          page: $page
          perPage: $perPage
          sortType: CALL_ORDER
          filters: { updatedAfter: $updatedAfter, hideEmpty: false }
        ) {
          pageInfo {
            total
            totalPages
            page
          }
          nodes {
            ...SetParts
          }
        }
      }
    }
  `;
}

export function phaseGroupSetsQuery(setFragment: string): string {
  return /* GraphQL */ `
    ${setFragment}
    query PhaseGroupSets($phaseGroupId: ID!, $page: Int!, $perPage: Int!) {
      phaseGroup(id: $phaseGroupId) {
        id
        displayIdentifier
        bracketType
        state
        rounds {
          number
          bestOf
        }
        sets(page: $page, perPage: $perPage, sortType: CALL_ORDER) {
          pageInfo {
            total
            totalPages
            page
          }
          nodes {
            ...SetParts
          }
        }
      }
    }
  `;
}

export const EVENT_STANDINGS = /* GraphQL */ `
  query EventStandings($eventId: ID!, $page: Int!, $perPage: Int!) {
    event(id: $eventId) {
      id
      standings(query: { page: $page, perPage: $perPage }) {
        pageInfo {
          totalPages
          page
        }
        nodes {
          id
          placement
          isFinal
          entrant {
            id
            name
          }
        }
      }
    }
  }
`;

export const EVENT_STATIONS = /* GraphQL */ `
  query EventStations($eventId: ID!, $page: Int!, $perPage: Int!) {
    event(id: $eventId) {
      id
      tournament {
        id
        stations(query: { page: $page, perPage: $perPage }) {
          pageInfo {
            totalPages
            page
          }
          nodes {
            id
            number
            state
          }
        }
        streams {
          id
          streamName
          streamSource
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Mutations
//
// These follow start.gg's documented bracket-reporting mutations. They are the
// part of this integration most likely to need adjustment against a live
// account, so they are isolated here and every call goes through the outbox —
// a rejected mutation surfaces as a conflict for a human, never as lost data.
// ---------------------------------------------------------------------------

export function reportSetMutation(setFragment: string): string {
  return /* GraphQL */ `
    ${setFragment}
    mutation ReportSet(
      $setId: ID!
      $winnerId: ID
      $isDQ: Boolean
      $gameData: [BracketSetGameDataInput]
    ) {
      reportBracketSet(
        setId: $setId
        winnerId: $winnerId
        isDQ: $isDQ
        gameData: $gameData
      ) {
        ...SetParts
      }
    }
  `;
}

export function markInProgressMutation(setFragment: string): string {
  return /* GraphQL */ `
    ${setFragment}
    mutation MarkSetInProgress($setId: ID!) {
      markSetInProgress(setId: $setId) {
        ...SetParts
      }
    }
  `;
}

export function resetSetMutation(setFragment: string): string {
  return /* GraphQL */ `
    ${setFragment}
    mutation ResetSet($setId: ID!, $resetDependentSets: Boolean) {
      resetSet(setId: $setId, resetDependentSets: $resetDependentSets) {
        ...SetParts
      }
    }
  `;
}

export function assignStationMutation(setFragment: string): string {
  return /* GraphQL */ `
    ${setFragment}
    mutation AssignStation($setId: ID!, $stationId: ID!) {
      assignStation(setId: $setId, stationId: $stationId) {
        ...SetParts
      }
    }
  `;
}

export function assignStreamMutation(setFragment: string): string {
  return /* GraphQL */ `
    ${setFragment}
    mutation AssignStream($setId: ID!, $streamId: ID!) {
      assignStream(setId: $setId, streamId: $streamId) {
        ...SetParts
      }
    }
  `;
}

export const UPDATE_PHASE_SEEDING = /* GraphQL */ `
  mutation UpdatePhaseSeeding($phaseId: ID!, $seedMapping: [UpdatePhaseSeedInfo]!) {
    updatePhaseSeeding(phaseId: $phaseId, seedMapping: $seedMapping) {
      id
      name
    }
  }
`;

/** Cheap call used purely to decide whether start.gg is reachable. */
export const HEALTHCHECK = /* GraphQL */ `
  query Healthcheck {
    __typename
  }
`;
