/**
 * Bracket layout.
 *
 * Turns a flat list of sets into positioned nodes, columns and connector edges.
 * Pure and deterministic: the same sets always produce the same geometry, which
 * is what lets an overlay and the dashboard agree on where a match sits when the
 * director punches the camera at it.
 *
 * Positions are in abstract layout units. The renderer applies a single
 * transform to pan/zoom, so nothing here needs to know about screen pixels.
 */

import {
  ActivityState,
  type BracketType,
  type Entrant,
  type Id,
  type RoundInfo,
  type TournamentSet,
} from './domain.js';

export interface LayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  /** Horizontal gap between round columns. */
  columnGap: number;
  /** Minimum vertical gap between two matches in the same column. */
  rowGap: number;
  /** Vertical gap between the winners and losers bands. */
  sectionGap: number;
  /** Extra width reserved for the round header row. */
  headerHeight: number;
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  nodeWidth: 240,
  nodeHeight: 64,
  columnGap: 56,
  rowGap: 16,
  sectionGap: 96,
  headerHeight: 36,
};

export type BracketSide = 'winners' | 'losers' | 'grands' | 'single';

export interface LayoutNode {
  setId: Id;
  x: number;
  y: number;
  width: number;
  height: number;
  columnId: string;
  side: BracketSide;
  round: number;
}

export interface LayoutColumn {
  id: string;
  label: string;
  round: number;
  side: BracketSide;
  x: number;
  width: number;
  /** Vertical extent of the matches in this column, for column-level zoom. */
  top: number;
  bottom: number;
  setIds: Id[];
}

export interface LayoutEdge {
  id: string;
  fromSetId: Id;
  toSetId: Id;
  /** Which slot of the destination set this feeds. */
  toSlotIndex: number;
  /** True when the edge carries the loser (winners bracket -> losers bracket). */
  isLoserFeed: boolean;
}

export interface LayoutSection {
  side: BracketSide;
  label: string;
  top: number;
  bottom: number;
}

export interface EliminationLayout {
  kind: 'elimination';
  bracketType: BracketType;
  width: number;
  height: number;
  nodes: LayoutNode[];
  columns: LayoutColumn[];
  edges: LayoutEdge[];
  sections: LayoutSection[];
  options: LayoutOptions;
}

export interface RoundRobinCell {
  rowEntrantId: Id;
  colEntrantId: Id;
  setId: Id | null;
  /** Score from the row entrant's perspective, e.g. "2-1". */
  score: string | null;
  result: 'win' | 'loss' | 'pending' | 'none';
}

export interface RoundRobinRow {
  entrantId: Id;
  entrantName: string;
  seed: number | null;
  wins: number;
  losses: number;
  gamesWon: number;
  gamesLost: number;
  /** Sorted position within the group, 1-based. */
  rank: number;
}

export interface RoundRobinLayout {
  kind: 'roundRobin';
  bracketType: BracketType;
  rows: RoundRobinRow[];
  cells: RoundRobinCell[];
  /** Matches in play order, for the on-deck style listings. */
  setIds: Id[];
}

export interface SwissRound {
  round: number;
  label: string;
  setIds: Id[];
}

export interface SwissLayout {
  kind: 'swiss';
  bracketType: BracketType;
  rounds: SwissRound[];
  /** Swiss standings share the round-robin row shape. */
  standings: RoundRobinRow[];
}

export interface ListLayout {
  kind: 'list';
  bracketType: BracketType;
  setIds: Id[];
}

export type BracketLayout =
  | EliminationLayout
  | RoundRobinLayout
  | SwissLayout
  | ListLayout;

/** Natural sort so "A2" precedes "A10". */
export function compareIdentifiers(a: string, b: string): number {
  const re = /(\d+|\D+)/g;
  const pa = a.match(re) ?? [a];
  const pb = b.match(re) ?? [b];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const xa = pa[i];
    const xb = pb[i];
    if (xa === undefined) return -1;
    if (xb === undefined) return 1;
    const na = Number(xa);
    const nb = Number(xb);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na - nb;
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1;
    }
  }
  return 0;
}

function isGrandFinal(set: TournamentSet): boolean {
  return /grand\s*final/i.test(set.fullRoundText ?? '');
}

function isGrandFinalReset(set: TournamentSet): boolean {
  return /grand\s*final.*reset|reset/i.test(set.fullRoundText ?? '');
}

/**
 * start.gg labels rounds in `fullRoundText`; fall back to a derived label when
 * an event omits it (which happens on some custom phases).
 */
function roundLabel(sets: TournamentSet[], round: number, side: BracketSide): string {
  const withText = sets.find((s) => (s.fullRoundText ?? '').trim().length > 0);
  if (withText) return withText.fullRoundText;
  const n = Math.abs(round);
  if (side === 'losers') return `Losers Round ${n}`;
  if (side === 'grands') return 'Grand Final';
  return `Round ${n}`;
}

interface FeedIndex {
  /** setId -> ids of sets that feed into it. */
  feeders: Map<Id, Id[]>;
  /** setId -> edges out of it. */
  edges: LayoutEdge[];
}

function buildFeedIndex(sets: TournamentSet[]): FeedIndex {
  const known = new Set(sets.map((s) => s.id));
  const feeders = new Map<Id, Id[]>();
  const edges: LayoutEdge[] = [];

  for (const set of sets) {
    for (const slot of set.slots) {
      if (slot.prereqType !== 'set' || !slot.prereqId) continue;
      const from = String(slot.prereqId);
      if (!known.has(from)) continue;
      const list = feeders.get(set.id);
      if (list) list.push(from);
      else feeders.set(set.id, [from]);

      // A set fed from a winners-side match into a losers-side match carries the
      // loser. Rendered differently so the progression reads correctly.
      const source = sets.find((s) => s.id === from);
      const isLoserFeed = !!source && source.round > 0 && set.round < 0;
      edges.push({
        id: `${from}->${set.id}:${slot.slotIndex}`,
        fromSetId: from,
        toSetId: set.id,
        toSlotIndex: slot.slotIndex,
        isLoserFeed,
      });
    }
  }
  return { feeders, edges };
}

/**
 * Assigns y positions column by column. A match sits centred on the matches
 * that feed it; matches with no positioned feeders fall back to a running
 * cursor. A final pass enforces the minimum gap without reordering, which
 * reproduces start.gg's staircase look in losers brackets.
 */
function assignVerticalPositions(
  columns: { round: number; sets: TournamentSet[] }[],
  feeders: Map<Id, Id[]>,
  opts: LayoutOptions,
  startY: number,
): Map<Id, number> {
  const y = new Map<Id, number>();
  const step = opts.nodeHeight + opts.rowGap;

  for (const column of columns) {
    let cursor = startY;
    const placed: { id: Id; y: number }[] = [];

    for (const set of column.sets) {
      const parents = (feeders.get(set.id) ?? [])
        .map((id) => y.get(id))
        .filter((v): v is number => v !== undefined);

      let value: number;
      if (parents.length > 0) {
        value = parents.reduce((a, b) => a + b, 0) / parents.length;
      } else {
        value = cursor;
      }
      placed.push({ id: set.id, y: value });
      cursor = Math.max(cursor, value) + step;
    }

    // Enforce minimum spacing in order, so averaged positions never collide.
    let last = -Infinity;
    for (const item of placed) {
      const resolved = Math.max(item.y, last === -Infinity ? startY : last + step);
      y.set(item.id, resolved);
      last = resolved;
    }
  }
  return y;
}

function buildSide(
  sets: TournamentSet[],
  side: BracketSide,
  feeders: Map<Id, Id[]>,
  opts: LayoutOptions,
  startY: number,
  columnXOffset: number,
): { nodes: LayoutNode[]; columns: LayoutColumn[]; bottom: number; nextX: number } {
  if (sets.length === 0) {
    return { nodes: [], columns: [], bottom: startY, nextX: columnXOffset };
  }

  const byRound = new Map<number, TournamentSet[]>();
  for (const set of sets) {
    const list = byRound.get(set.round);
    if (list) list.push(set);
    else byRound.set(set.round, [set]);
  }

  const rounds = [...byRound.keys()].sort((a, b) => Math.abs(a) - Math.abs(b));
  const columnSets = rounds.map((round) => ({
    round,
    sets: (byRound.get(round) ?? []).slice().sort((a, b) => compareIdentifiers(a.identifier, b.identifier)),
  }));

  const yByset = assignVerticalPositions(columnSets, feeders, opts, startY);

  const nodes: LayoutNode[] = [];
  const columns: LayoutColumn[] = [];
  let x = columnXOffset;
  let bottom = startY;

  for (const column of columnSets) {
    const columnId = `${side}:${column.round}`;
    let top = Infinity;
    let colBottom = -Infinity;
    const setIds: Id[] = [];

    for (const set of column.sets) {
      const yPos = yByset.get(set.id) ?? startY;
      nodes.push({
        setId: set.id,
        x,
        y: yPos,
        width: opts.nodeWidth,
        height: opts.nodeHeight,
        columnId,
        side,
        round: column.round,
      });
      setIds.push(set.id);
      top = Math.min(top, yPos);
      colBottom = Math.max(colBottom, yPos + opts.nodeHeight);
    }

    columns.push({
      id: columnId,
      label: roundLabel(column.sets, column.round, side),
      round: column.round,
      side,
      x,
      width: opts.nodeWidth,
      top: Number.isFinite(top) ? top : startY,
      bottom: Number.isFinite(colBottom) ? colBottom : startY,
      setIds,
    });

    bottom = Math.max(bottom, colBottom);
    x += opts.nodeWidth + opts.columnGap;
  }

  return { nodes, columns, bottom, nextX: x };
}

export interface LayoutInput {
  sets: TournamentSet[];
  bracketType: BracketType;
  entrants?: Entrant[];
  rounds?: RoundInfo[];
  options?: Partial<LayoutOptions>;
}

export function layoutElimination(input: LayoutInput): EliminationLayout {
  const opts = { ...DEFAULT_LAYOUT_OPTIONS, ...(input.options ?? {}) };
  const sets = input.sets;
  const { feeders, edges } = buildFeedIndex(sets);

  const isDouble = input.bracketType === 'DOUBLE_ELIMINATION';
  const grands = isDouble ? sets.filter(isGrandFinal) : [];
  const grandIds = new Set(grands.map((s) => s.id));
  const winners = sets.filter((s) => s.round > 0 && !grandIds.has(s.id));
  const losers = sets.filter((s) => s.round < 0 && !grandIds.has(s.id));

  const sections: LayoutSection[] = [];

  const winnersSide: BracketSide = isDouble ? 'winners' : 'single';
  const w = buildSide(winners, winnersSide, feeders, opts, opts.headerHeight, 0);
  if (w.nodes.length > 0) {
    sections.push({
      side: winnersSide,
      label: isDouble ? 'Winners Bracket' : 'Bracket',
      top: opts.headerHeight,
      bottom: w.bottom,
    });
  }

  const losersTop = w.bottom + opts.sectionGap;
  const l = buildSide(losers, 'losers', feeders, opts, losersTop, 0);
  if (l.nodes.length > 0) {
    sections.push({ side: 'losers', label: 'Losers Bracket', top: losersTop, bottom: l.bottom });
  }

  const nodes = [...w.nodes, ...l.nodes];
  const columns = [...w.columns, ...l.columns];

  // Grand finals (and the reset) live in their own columns to the right of the
  // winners bracket, vertically centred across both bands.
  if (grands.length > 0) {
    const ordered = grands
      .slice()
      .sort((a, b) => {
        const ra = isGrandFinalReset(a) && !isGrandFinal(b) ? 1 : 0;
        if (a.round !== b.round) return a.round - b.round;
        return ra;
      });
    const centre =
      (opts.headerHeight + Math.max(w.bottom, l.bottom)) / 2 - opts.nodeHeight / 2;
    let x = Math.max(w.nextX, l.nextX);
    for (const set of ordered) {
      const columnId = `grands:${set.id}`;
      nodes.push({
        setId: set.id,
        x,
        y: centre,
        width: opts.nodeWidth,
        height: opts.nodeHeight,
        columnId,
        side: 'grands',
        round: set.round,
      });
      columns.push({
        id: columnId,
        label: set.fullRoundText || 'Grand Final',
        round: set.round,
        side: 'grands',
        x,
        width: opts.nodeWidth,
        top: centre,
        bottom: centre + opts.nodeHeight,
        setIds: [set.id],
      });
      x += opts.nodeWidth + opts.columnGap;
    }
    sections.push({
      side: 'grands',
      label: 'Grand Final',
      top: centre,
      bottom: centre + opts.nodeHeight,
    });
  }

  const width = nodes.reduce((max, n) => Math.max(max, n.x + n.width), 0);
  const height = nodes.reduce((max, n) => Math.max(max, n.y + n.height), 0);

  return {
    kind: 'elimination',
    bracketType: input.bracketType,
    width,
    height,
    nodes,
    columns,
    edges,
    sections,
    options: opts,
  };
}

function scoreForEntrant(set: TournamentSet, entrantId: Id): number | null {
  const slot = set.slots.find((s) => s.entrantId === entrantId);
  return slot?.score ?? null;
}

export function layoutRoundRobin(input: LayoutInput): RoundRobinLayout {
  const sets = input.sets;

  const names = new Map<Id, string>();
  const seeds = new Map<Id, number | null>();
  for (const entrant of input.entrants ?? []) {
    names.set(entrant.id, entrant.name);
    seeds.set(entrant.id, entrant.seed);
  }
  for (const set of sets) {
    for (const slot of set.slots) {
      if (slot.entrantId && !names.has(slot.entrantId)) {
        names.set(slot.entrantId, slot.entrantName ?? 'TBD');
        seeds.set(slot.entrantId, slot.seed);
      }
    }
  }

  const ids = [...names.keys()];
  const stats = new Map<Id, { w: number; l: number; gw: number; gl: number }>();
  for (const id of ids) stats.set(id, { w: 0, l: 0, gw: 0, gl: 0 });

  const cells: RoundRobinCell[] = [];
  const cellIndex = new Map<string, RoundRobinCell>();

  for (const set of sets) {
    const a = set.slots[0];
    const b = set.slots[1];
    if (!a?.entrantId || !b?.entrantId) continue;

    const done = set.state === ActivityState.Completed && set.winnerId !== null;
    for (const [self, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const selfId = self.entrantId as Id;
      const otherId = other.entrantId as Id;
      const selfScore = self.score;
      const otherScore = other.score;
      const cell: RoundRobinCell = {
        rowEntrantId: selfId,
        colEntrantId: otherId,
        setId: set.id,
        score:
          selfScore !== null && otherScore !== null ? `${selfScore}-${otherScore}` : null,
        result: done ? (set.winnerId === selfId ? 'win' : 'loss') : 'pending',
      };
      cells.push(cell);
      cellIndex.set(`${selfId}:${otherId}`, cell);

      if (done) {
        const s = stats.get(selfId);
        if (s) {
          if (set.winnerId === selfId) s.w += 1;
          else s.l += 1;
          s.gw += Math.max(0, selfScore ?? 0);
          s.gl += Math.max(0, otherScore ?? 0);
        }
      }
    }
  }

  const rows: RoundRobinRow[] = ids
    .map((id) => {
      const s = stats.get(id) ?? { w: 0, l: 0, gw: 0, gl: 0 };
      return {
        entrantId: id,
        entrantName: names.get(id) ?? 'TBD',
        seed: seeds.get(id) ?? null,
        wins: s.w,
        losses: s.l,
        gamesWon: s.gw,
        gamesLost: s.gl,
        rank: 0,
      };
    })
    .sort((x, y) => {
      if (y.wins !== x.wins) return y.wins - x.wins;
      const dx = x.gamesWon - x.gamesLost;
      const dy = y.gamesWon - y.gamesLost;
      if (dy !== dx) return dy - dx;
      if (y.gamesWon !== x.gamesWon) return y.gamesWon - x.gamesWon;
      return (x.seed ?? 9999) - (y.seed ?? 9999);
    });

  rows.forEach((row, i) => {
    row.rank = i + 1;
  });

  return {
    kind: 'roundRobin',
    bracketType: input.bracketType,
    rows,
    cells,
    setIds: sets
      .slice()
      .sort((a, b) => compareIdentifiers(a.identifier, b.identifier))
      .map((s) => s.id),
  };
}

export function layoutSwiss(input: LayoutInput): SwissLayout {
  const byRound = new Map<number, TournamentSet[]>();
  for (const set of input.sets) {
    const list = byRound.get(set.round);
    if (list) list.push(set);
    else byRound.set(set.round, [set]);
  }

  const rounds: SwissRound[] = [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, sets]) => ({
      round,
      label: sets[0]?.fullRoundText || `Round ${round}`,
      setIds: sets
        .slice()
        .sort((a, b) => compareIdentifiers(a.identifier, b.identifier))
        .map((s) => s.id),
    }));

  // Swiss standings use the same win/loss aggregation as round robin.
  const { rows } = layoutRoundRobin(input);
  return { kind: 'swiss', bracketType: input.bracketType, rounds, standings: rows };
}

/** Dispatches to the right layout for a bracket type. */
export function layoutBracket(input: LayoutInput): BracketLayout {
  switch (input.bracketType) {
    case 'SINGLE_ELIMINATION':
    case 'DOUBLE_ELIMINATION':
    case 'ELIMINATION_ROUNDS':
      return layoutElimination(input);
    case 'ROUND_ROBIN':
      return layoutRoundRobin(input);
    case 'SWISS':
      return layoutSwiss(input);
    default:
      return {
        kind: 'list',
        bracketType: input.bracketType,
        setIds: input.sets
          .slice()
          .sort((a, b) => compareIdentifiers(a.identifier, b.identifier))
          .map((s) => s.id),
      };
  }
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bounding box of a set of nodes, with padding, for camera framing. */
export function boundsOf(nodes: LayoutNode[], padding = 24): Rect | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}

/**
 * Nodes on the path forward from a set, up to `depth` rounds ahead. This backs
 * the "show potential progression" camera shot: punch in on a match and reveal
 * where its winner goes next.
 */
export function progressionFrom(
  layout: EliminationLayout,
  setId: Id,
  depth = 2,
): LayoutNode[] {
  const byId = new Map(layout.nodes.map((n) => [n.setId, n]));
  const out: LayoutNode[] = [];
  const seen = new Set<Id>();
  let frontier: Id[] = [setId];

  for (let level = 0; level <= depth; level++) {
    const next: Id[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const node = byId.get(id);
      if (node) out.push(node);
      for (const edge of layout.edges) {
        if (edge.fromSetId === id && !seen.has(edge.toSetId)) next.push(edge.toSetId);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return out;
}
