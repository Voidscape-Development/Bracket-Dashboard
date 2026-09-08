import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_LAYOUT_OPTIONS,
  boundsOf,
  compareIdentifiers,
  layoutBracket,
  layoutElimination,
  layoutRoundRobin,
  progressionFrom,
  type EliminationLayout,
} from '../dist/index.js';
import { parseStartggUrl } from '../dist/index.js';
import { doubleElimination4, roundRobin3, singleElimination4 } from './fixtures.ts';

test('identifiers sort naturally, not lexically', () => {
  const input = ['A10', 'A2', 'A1', 'B1'];
  const sorted = input.slice().sort(compareIdentifiers);
  assert.deepEqual(sorted, ['A1', 'A2', 'A10', 'B1']);
});

test('single elimination places rounds in columns left to right', () => {
  const layout = layoutElimination({
    sets: singleElimination4(),
    bracketType: 'SINGLE_ELIMINATION',
  });

  assert.equal(layout.nodes.length, 3);
  assert.equal(layout.columns.length, 2);

  const [semis, final] = layout.columns;
  assert.ok(semis && final);
  assert.ok(final.x > semis.x, 'later rounds sit to the right');
  assert.equal(semis.setIds.length, 2);
  assert.equal(final.setIds.length, 1);

  // Every node is on the 'single' side when there is no losers bracket.
  assert.ok(layout.nodes.every((n) => n.side === 'single'));
});

test('a final is vertically centred on the matches that feed it', () => {
  const layout = layoutElimination({
    sets: singleElimination4(),
    bracketType: 'SINGLE_ELIMINATION',
  });

  const s1 = layout.nodes.find((n) => n.setId === 's1');
  const s2 = layout.nodes.find((n) => n.setId === 's2');
  const s3 = layout.nodes.find((n) => n.setId === 's3');
  assert.ok(s1 && s2 && s3);

  assert.equal(s3.y, (s1.y + s2.y) / 2);
});

test('double elimination separates winners, losers and grand finals', () => {
  const layout = layoutElimination({
    sets: doubleElimination4(),
    bracketType: 'DOUBLE_ELIMINATION',
  });

  const sides = new Set(layout.nodes.map((n) => n.side));
  assert.ok(sides.has('winners'));
  assert.ok(sides.has('losers'));
  assert.ok(sides.has('grands'));

  const winners = layout.nodes.filter((n) => n.side === 'winners');
  const losers = layout.nodes.filter((n) => n.side === 'losers');
  const lowestWinner = Math.max(...winners.map((n) => n.y + n.height));
  const highestLoser = Math.min(...losers.map((n) => n.y));
  assert.ok(
    highestLoser >= lowestWinner + DEFAULT_LAYOUT_OPTIONS.sectionGap - 1,
    'losers bracket sits below the winners bracket with a section gap',
  );

  // The reset sits to the right of the grand final.
  const gf = layout.nodes.find((n) => n.setId === 'gf');
  const gfr = layout.nodes.find((n) => n.setId === 'gfr');
  assert.ok(gf && gfr);
  assert.ok(gfr.x > gf.x);
});

test('edges follow prereq links and flag the winners-to-losers drop', () => {
  const layout = layoutElimination({
    sets: doubleElimination4(),
    bracketType: 'DOUBLE_ELIMINATION',
  });

  const intoLosersRound1 = layout.edges.filter((e) => e.toSetId === 'l1');
  assert.equal(intoLosersRound1.length, 2);
  assert.ok(
    intoLosersRound1.every((e) => e.isLoserFeed),
    'feeds from the winners bracket into losers carry the loser',
  );

  const intoWinnersFinal = layout.edges.filter((e) => e.toSetId === 'w3');
  assert.equal(intoWinnersFinal.length, 2);
  assert.ok(intoWinnersFinal.every((e) => !e.isLoserFeed));
});

test('sets in a column never overlap', () => {
  const layout = layoutElimination({
    sets: doubleElimination4(),
    bracketType: 'DOUBLE_ELIMINATION',
  });

  for (const column of layout.columns) {
    const ys = column.setIds
      .map((id) => layout.nodes.find((n) => n.setId === id))
      .filter((n): n is NonNullable<typeof n> => !!n)
      .map((n) => n.y)
      .sort((a, b) => a - b);

    for (let i = 1; i < ys.length; i++) {
      const gap = (ys[i] as number) - (ys[i - 1] as number);
      assert.ok(
        gap >= DEFAULT_LAYOUT_OPTIONS.nodeHeight,
        `column ${column.id} has overlapping matches (gap ${gap})`,
      );
    }
  }
});

test('progression walks forward from a match and stops at the requested depth', () => {
  const layout = layoutElimination({
    sets: doubleElimination4(),
    bracketType: 'DOUBLE_ELIMINATION',
  }) as EliminationLayout;

  const oneAhead = progressionFrom(layout, 's1', 1).map((n) => n.setId).sort();
  assert.deepEqual(oneAhead, ['l1', 's1', 'w3'].sort());

  const twoAhead = progressionFrom(layout, 's1', 2).map((n) => n.setId);
  assert.ok(twoAhead.includes('l2'), 'depth 2 reaches the losers final');
  assert.ok(twoAhead.includes('gf'), 'depth 2 reaches grand finals');
});

test('progression bounds are smaller than the full bracket', () => {
  const layout = layoutElimination({
    sets: doubleElimination4(),
    bracketType: 'DOUBLE_ELIMINATION',
  }) as EliminationLayout;

  const all = boundsOf(layout.nodes);
  const shot = boundsOf(progressionFrom(layout, 's1', 1));
  assert.ok(all && shot);
  assert.ok(shot.width < all.width, 'punching in narrows the frame');
});

test('round robin computes standings and a result matrix', () => {
  const layout = layoutRoundRobin({ sets: roundRobin3(), bracketType: 'ROUND_ROBIN' });

  assert.equal(layout.rows.length, 3);

  // Carol won her only completed match, Alice split, Bob lost his only one.
  const [first, second, third] = layout.rows;
  assert.ok(first && second && third);
  assert.equal(first.entrantName, 'Carol');
  assert.equal(first.wins, 1);
  assert.equal(second.entrantName, 'Alice');
  assert.equal(second.wins, 1);
  assert.equal(third.entrantName, 'Bob');
  assert.equal(third.wins, 0);

  // Head-to-head cells exist in both directions.
  const aliceVsBob = layout.cells.find(
    (c) => c.rowEntrantId === 'e1' && c.colEntrantId === 'e2',
  );
  assert.ok(aliceVsBob);
  assert.equal(aliceVsBob.score, '2-1');
  assert.equal(aliceVsBob.result, 'win');

  const unplayed = layout.cells.find(
    (c) => c.rowEntrantId === 'e2' && c.colEntrantId === 'e3',
  );
  assert.ok(unplayed);
  assert.equal(unplayed.result, 'pending');
});

test('layoutBracket dispatches on bracket type', () => {
  assert.equal(
    layoutBracket({ sets: singleElimination4(), bracketType: 'SINGLE_ELIMINATION' }).kind,
    'elimination',
  );
  assert.equal(
    layoutBracket({ sets: roundRobin3(), bracketType: 'ROUND_ROBIN' }).kind,
    'roundRobin',
  );
  assert.equal(
    layoutBracket({ sets: roundRobin3(), bracketType: 'SWISS' }).kind,
    'swiss',
  );
  assert.equal(
    layoutBracket({ sets: [], bracketType: 'MATCHMAKING' }).kind,
    'list',
  );
});

test('an empty bracket lays out without throwing', () => {
  const layout = layoutElimination({ sets: [], bracketType: 'DOUBLE_ELIMINATION' });
  assert.equal(layout.nodes.length, 0);
  assert.equal(layout.width, 0);
  assert.equal(boundsOf(layout.nodes), null);
});

test('start.gg URLs of every shape resolve to a tournament slug', () => {
  const cases: [string, string, string | null][] = [
    ['https://www.start.gg/tournament/genesis-9', 'genesis-9', null],
    [
      'https://www.start.gg/tournament/genesis-9/event/melee-singles',
      'genesis-9',
      'melee-singles',
    ],
    [
      'https://www.start.gg/tournament/genesis-9/event/melee-singles/brackets/1234567/2345678',
      'genesis-9',
      'melee-singles',
    ],
    ['start.gg/tournament/my-local-42/details', 'my-local-42', null],
    ['genesis-9', 'genesis-9', null],
  ];

  for (const [input, slug, eventSlug] of cases) {
    const parsed = parseStartggUrl(input);
    assert.ok(parsed, `expected ${input} to parse`);
    assert.equal(parsed.tournamentSlug, slug);
    assert.equal(parsed.eventSlug, eventSlug);
  }

  assert.equal(parseStartggUrl('https://example.com/tournament/nope'), null);
  assert.equal(parseStartggUrl(''), null);
});

test('bracket URL extracts the phase group id', () => {
  const parsed = parseStartggUrl(
    'https://www.start.gg/tournament/x/event/y/brackets/111/222',
  );
  assert.equal(parsed?.phaseGroupId, '222');
});
