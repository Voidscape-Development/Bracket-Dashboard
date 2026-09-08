/**
 * Object-count ceiling handling, and the browser headers the site endpoint
 * expects.
 *
 * start.gg caps every response at 1000 objects on *both* endpoints. These tests
 * pin the two halves of the response to that: recognising the rejection, and
 * recovering from it by asking for less rather than failing the import.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StartggClient } from '../dist/startgg/client.js';
import {
  GqlError,
  WebGqlTransport,
  OfficialGqlTransport,
  parseComplexityError,
} from '../dist/startgg/transport.js';

/** The message start.gg actually returns, verbatim. */
const COMPLEXITY_MESSAGE =
  'Your query complexity is too high. A maximum of 1000 objects may be returned by each request (actual: 1219)';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Recognising the rejection
// ---------------------------------------------------------------------------

test('the complexity message is parsed into its limit and actual', () => {
  const parsed = parseComplexityError(COMPLEXITY_MESSAGE);
  assert.ok(parsed);
  assert.equal(parsed.limit, 1000);
  assert.equal(parsed.actual, 1219);

  // Wording drift still classifies, just without numbers to steer by.
  assert.ok(parseComplexityError('query complexity exceeded'));
  assert.equal(parseComplexityError('Cannot query field "foo" on type "Set"'), null);
});

test('a complexity rejection is classified as such under 200 and under 400', async () => {
  for (const status of [200, 400]) {
    const transport = new WebGqlTransport({
      fetchImpl: async () => jsonResponse({ data: null, errors: [{ message: COMPLEXITY_MESSAGE }] }, status),
    });

    const error = await transport.execute({ query: '{ __typename }' }).catch((e: unknown) => e);
    assert.ok(error instanceof GqlError, `status ${status} produced a GqlError`);
    assert.equal(error.kind, 'complexity');
    assert.equal(error.complexity?.actual, 1219);
    // Retrying the identical request would be rejected identically.
    assert.equal(error.retryable, false);
  }
});

test('a GraphQL error carried by a 4xx keeps its message instead of becoming "HTTP 400"', async () => {
  const transport = new WebGqlTransport({
    fetchImpl: async () => jsonResponse({ errors: [{ message: 'Tournament not found' }] }, 400),
  });

  const error = await transport.execute({ query: '{ __typename }' }).catch((e: unknown) => e);
  assert.ok(error instanceof GqlError);
  assert.equal(error.message, 'Tournament not found');
});

// ---------------------------------------------------------------------------
// Looking like a browser
// ---------------------------------------------------------------------------

test('the site endpoint sends a browser header set', async () => {
  let sent: Record<string, string> = {};
  const transport = new WebGqlTransport({
    fetchImpl: async (_url: any, init: any) => {
      sent = init.headers;
      return jsonResponse({ data: { __typename: 'Query' } });
    },
  });

  await transport.execute({ query: '{ __typename }' });

  assert.match(sent['user-agent'] ?? '', /Chrome\/\d+/);
  assert.equal(sent['origin'], 'https://www.start.gg');
  assert.equal(sent['referer'], 'https://www.start.gg/');
  assert.equal(sent['sec-fetch-mode'], 'cors');
  assert.equal(sent['accept-language'], 'en-US,en;q=0.9');
  assert.equal(sent['client-version'], '20');
});

test('configured headers override the defaults regardless of case', async () => {
  let sent: Record<string, string> = {};
  const transport = new WebGqlTransport({
    headers: { 'User-Agent': 'custom-agent/1.0', cookie: 'session=abc' },
    fetchImpl: async (_url: any, init: any) => {
      sent = init.headers;
      return jsonResponse({ data: { __typename: 'Query' } });
    },
  });

  await transport.execute({ query: '{ __typename }' });

  // One user-agent, the caller's — not two headers differing only in case.
  assert.equal(sent['user-agent'], 'custom-agent/1.0');
  assert.equal(sent['User-Agent'], undefined);
  assert.equal(sent['cookie'], 'session=abc');
  // A cookie is what lets the site endpoint mutate.
  assert.equal(transport.canMutate, true);
});

test('the documented endpoint identifies itself as this app, not as a browser', async () => {
  let sent: Record<string, string> = {};
  const transport = new OfficialGqlTransport({
    token: 'tok',
    fetchImpl: async (_url: any, init: any) => {
      sent = init.headers;
      return jsonResponse({ data: { __typename: 'Query' } });
    },
  });

  await transport.execute({ query: '{ __typename }' });
  assert.match(sent['user-agent'] ?? '', /bracket-dashboard/);
  assert.equal(sent['authorization'], 'Bearer tok');
});

// ---------------------------------------------------------------------------
// Recovering from the rejection
// ---------------------------------------------------------------------------

interface StubCall {
  operation: string;
  variables: Record<string, any>;
}

/**
 * A transport that enforces an object budget the way start.gg does: it costs
 * each returned set with `costOf` and rejects a page totalling over 1000. Cost
 * per set varies in reality — a completed best-of-five with character data is
 * worth several unstarted sets — so the cost is a function of the set.
 */
function budgetedSetTransport(options: { setCount: number; costOf: (index: number) => number }) {
  const calls: StubCall[] = [];
  const sets = Array.from({ length: options.setCount }, (_, i) => ({
    index: i,
    id: `set-${i + 1}`,
    identifier: `A${i + 1}`,
    state: 1,
    event: { id: 'evt-1' },
    phaseGroup: { id: 'pg-1', phase: { id: 'ph-1' } },
    slots: [],
    games: [],
  }));

  return {
    calls,
    transport: {
      name: 'stub',
      endpoint: 'stub://start.gg',
      canMutate: false,
      async execute(request: any) {
        const operation = request.operationName ?? 'Unknown';
        const variables = request.variables ?? {};
        calls.push({ operation, variables });

        const perPage = Number(variables.perPage ?? 0);
        const page = Number(variables.page ?? 1);
        const nodes = sets.slice((page - 1) * perPage, page * perPage);
        const returned = nodes.reduce((sum, set) => sum + options.costOf(set.index), 0);
        if (returned > 1000) {
          throw new GqlError(
            `Your query complexity is too high. A maximum of 1000 objects may be returned by each request (actual: ${returned})`,
            'complexity',
            200,
            null,
            { limit: 1000, actual: returned },
          );
        }

        return {
          event: {
            id: 'evt-1',
            sets: {
              pageInfo: {
                total: sets.length,
                totalPages: Math.max(1, Math.ceil(sets.length / perPage)),
                page,
              },
              nodes,
            },
          },
        };
      },
    },
  };
}

test('a rejected page size is reduced and the read completes in full', async () => {
  // 55 objects per set is a completed best-of-five with character selections:
  // the default page of 25 costs 1375 and is refused.
  const { transport, calls } = budgetedSetTransport({ setCount: 90, costOf: () => 55 });
  const client = new StartggClient(transport as any, { requestsPerMinute: 10000 });

  assert.equal(client.pageSize('EventSets'), 25);

  const { sets, total } = await client.fetchEventSets('evt-1', null);

  // Every set arrives exactly once, despite the page size changing underneath.
  assert.equal(sets.length, 90);
  assert.equal(total, 90);
  assert.equal(new Set(sets.map((s) => s.id)).size, 90);

  // The reduced size is remembered, so the next poll does not re-learn it.
  const learned = client.pageSize('EventSets');
  assert.ok(learned < 25 && learned * 55 <= 1000, `page size settled at ${learned}`);
  assert.equal(client.health.pageSizes.EventSets, learned);

  const rejected = calls.filter((c) => Number(c.variables.perPage) * 55 > 1000);
  assert.ok(rejected.length <= 2, 'the ratio in the error converges in one or two tries');
});

test('a rejection partway through a walk restarts it rather than stitching page sizes', async () => {
  // Early rounds are cheap and the later, completed ones are not, so the first
  // pages succeed and page three is refused — the case where naively carrying
  // on with a new page size would skip or double-count sets.
  const { transport, calls } = budgetedSetTransport({
    setCount: 200,
    costOf: (index) => (index >= 50 ? 60 : 20),
  });
  const client = new StartggClient(transport as any, { requestsPerMinute: 10000 });

  const { sets } = await client.fetchEventSets('evt-1', null);

  assert.equal(sets.length, 200);
  assert.equal(new Set(sets.map((s) => s.id)).size, 200, 'no set is collected twice');

  // Page 1 is fetched again at the new size — that restart is the point.
  const firstPages = calls.filter((c) => Number(c.variables.page) === 1);
  assert.ok(firstPages.length >= 2);
});

test('a query too expensive at any page size reports what it was asked to do', async () => {
  const transport = {
    name: 'stub',
    endpoint: 'stub://start.gg',
    canMutate: false,
    async execute() {
      throw new GqlError(COMPLEXITY_MESSAGE, 'complexity', 200, null, {
        limit: 1000,
        actual: 1219,
      });
    },
  };
  const client = new StartggClient(transport as any, { requestsPerMinute: 10000 });

  const error = await client.fetchEventSets('evt-1', null).catch((e: unknown) => e);
  assert.ok(error instanceof GqlError);
  assert.equal(error.kind, 'complexity');
  assert.match(error.message, /EventSets/);
  assert.match(error.message, /per page/);
});

// ---------------------------------------------------------------------------
// The structure read, which is what the reported failure was
// ---------------------------------------------------------------------------

function structureTransport(options: { maxGroupsPerPage: number }) {
  const calls: string[] = [];
  const groups = Array.from({ length: 24 }, (_, i) => ({
    id: `pg-${i + 1}`,
    displayIdentifier: String.fromCharCode(65 + i),
    bracketType: 'ROUND_ROBIN',
    state: 2,
    rounds: [{ number: 1, bestOf: 3 }],
  }));

  const page = (nodes: any[], p: number, perPage: number) => ({
    pageInfo: {
      total: nodes.length,
      totalPages: Math.max(1, Math.ceil(nodes.length / perPage)),
      page: p,
    },
    nodes: nodes.slice((p - 1) * perPage, p * perPage),
  });

  return {
    calls,
    transport: {
      name: 'stub',
      endpoint: 'stub://start.gg',
      canMutate: false,
      async execute(request: any) {
        const op = request.operationName;
        const vars = request.variables ?? {};
        calls.push(op);

        if (op === 'TournamentStructure') {
          const perPage = Number(vars.groupPerPage);
          if (perPage > options.maxGroupsPerPage) {
            throw new GqlError(COMPLEXITY_MESSAGE, 'complexity', 200, null, {
              limit: 1000,
              actual: 1219,
            });
          }
          return {
            tournament: {
              id: 't-1',
              name: 'Big Regional',
              slug: 'big-regional',
              events: [
                {
                  id: 'evt-1',
                  name: 'Singles',
                  phases: [
                    {
                      id: 'ph-1',
                      name: 'Pools',
                      phaseOrder: 1,
                      bracketType: 'ROUND_ROBIN',
                      groupCount: groups.length,
                      state: 2,
                      phaseGroups: page(groups, Number(vars.groupPage), perPage),
                    },
                  ],
                },
              ],
            },
          };
        }

        if (op === 'TournamentEvents') {
          return {
            tournament: {
              id: 't-1',
              name: 'Big Regional',
              slug: 'big-regional',
              events: [
                {
                  id: 'evt-1',
                  name: 'Singles',
                  phases: [
                    {
                      id: 'ph-1',
                      name: 'Pools',
                      phaseOrder: 1,
                      bracketType: 'ROUND_ROBIN',
                      groupCount: groups.length,
                      state: 2,
                    },
                  ],
                },
              ],
            },
          };
        }

        if (op === 'PhaseGroups') {
          return {
            phase: {
              id: 'ph-1',
              phaseGroups: page(groups, Number(vars.page), Number(vars.perPage)),
            },
          };
        }

        throw new GqlError(`unexpected ${op}`, 'graphql');
      },
    },
  };
}

test('pools cut off by paging are fetched rather than silently dropped', async () => {
  // 24 pools, 8 per page: the combined call returns only the first third.
  const { transport, calls } = structureTransport({ maxGroupsPerPage: 8 });
  const client = new StartggClient(transport as any, {
    requestsPerMinute: 10000,
    groupsPerPage: 8,
  });

  const tournament = await client.fetchTournamentStructure('big-regional');

  assert.ok(tournament);
  assert.equal(tournament.events[0].phases[0].groups.length, 24);
  assert.ok(calls.includes('PhaseGroups'), 'the remaining pools were paged in');
});

test('a structure read that cannot fit at all falls back to a split read', async () => {
  // Nothing fits: even one group per phase is refused.
  const { transport, calls } = structureTransport({ maxGroupsPerPage: 0 });
  const client = new StartggClient(transport as any, { requestsPerMinute: 10000 });

  const tournament = await client.fetchTournamentStructure('big-regional');

  assert.ok(tournament, 'the import still produces a tournament');
  assert.equal(tournament.events.length, 1);
  assert.equal(tournament.events[0].phases[0].groups.length, 24);
  assert.ok(calls.includes('TournamentEvents'), 'it dropped to the split read');
});
