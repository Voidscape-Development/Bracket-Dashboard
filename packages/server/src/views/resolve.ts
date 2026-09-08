/**
 * Resolving what an output view actually displays.
 *
 * An event is a sequence of phases — pools, then a top cut — and each phase
 * numbers its rounds from scratch. Pooling every set in an event into one
 * bracket layout produces nonsense: pool round 1 and top-cut round 1 would land
 * in the same column. So a bracket view renders exactly one phase group, and
 * this is the single place that decides which one.
 *
 * REST snapshots, socket snapshots and the auto-follow evaluator all call it, so
 * they cannot drift apart about what a given overlay is showing.
 */

import {
  ActivityState,
  type BracketType,
  type Id,
  type OutputView,
  type Phase,
  type PhaseGroup,
  type TournamentEvent,
  type TournamentSet,
} from '@bracket/shared';

import type { Store } from '../db/store.js';

export interface ResolvedView {
  event: TournamentEvent | null;
  phase: Phase | null;
  phaseGroup: PhaseGroup | null;
  /** The bracket type to render with — never inferred from the sets. */
  bracketType: BracketType;
  sets: TournamentSet[];
  /** Every phase group in the event, so the UI can offer a picker. */
  available: { phase: Phase; group: PhaseGroup }[];
}

/** A phase is "live" when it has sets in progress or partially completed. */
function phaseActivity(sets: TournamentSet[], phaseId: Id): {
  live: number;
  completed: number;
  total: number;
} {
  let live = 0;
  let completed = 0;
  let total = 0;
  for (const set of sets) {
    if (set.phaseId !== phaseId) continue;
    total += 1;
    if (set.state === ActivityState.Active || set.state === ActivityState.Called) live += 1;
    else if (set.state === ActivityState.Completed) completed += 1;
  }
  return { live, completed, total };
}

/**
 * Picks the phase an event is currently "at": the earliest phase with live
 * matches, else the earliest unfinished one, else the last phase. This is what
 * `followActivePhase` uses to walk a display from pools into top cut on its own.
 */
export function activePhaseOf(event: TournamentEvent, sets: TournamentSet[]): Phase | null {
  const phases = [...event.phases].sort((a, b) => a.phaseOrder - b.phaseOrder);
  if (phases.length === 0) return null;

  for (const phase of phases) {
    if (phaseActivity(sets, phase.id).live > 0) return phase;
  }
  for (const phase of phases) {
    const { completed, total } = phaseActivity(sets, phase.id);
    if (total > 0 && completed < total) return phase;
  }
  return phases[phases.length - 1] ?? null;
}

export function resolveView(store: Store, view: OutputView): ResolvedView {
  const event = view.eventId ? store.getEvent(view.eventId) : null;

  if (!event) {
    return {
      event: null,
      phase: null,
      phaseGroup: null,
      bracketType: 'DOUBLE_ELIMINATION',
      sets: [],
      available: [],
    };
  }

  const allSets = store.listSets(event.id);
  const available = event.phases
    .slice()
    .sort((a, b) => a.phaseOrder - b.phaseOrder)
    .flatMap((phase) => phase.groups.map((group) => ({ phase, group })));

  // An explicit pool wins over everything: the operator named it.
  if (view.phaseGroupId) {
    const match = available.find((entry) => entry.group.id === view.phaseGroupId);
    if (match) {
      return {
        event,
        phase: match.phase,
        phaseGroup: match.group,
        bracketType: match.group.bracketType,
        sets: allSets.filter((s) => s.phaseGroupId === match.group.id),
        available,
      };
    }
    // The pool no longer exists (a reseed can remove one); fall through rather
    // than showing an empty overlay.
  }

  const phase =
    (view.followActivePhase ? activePhaseOf(event, allSets) : null) ??
    (view.phaseId ? event.phases.find((p) => p.id === view.phaseId) ?? null : null) ??
    activePhaseOf(event, allSets);

  if (!phase) {
    return {
      event,
      phase: null,
      phaseGroup: null,
      bracketType: 'DOUBLE_ELIMINATION',
      sets: [],
      available,
    };
  }

  const phaseSets = allSets.filter((s) => s.phaseId === phase.id);

  // A single-group phase is unambiguous. A multi-pool phase needs a choice, and
  // the busiest pool is the most useful default for an unattended display.
  const group =
    phase.groups.length === 1
      ? phase.groups[0]
      : phase.groups
          .slice()
          .sort((a, b) => {
            const activity = (g: PhaseGroup) => {
              const groupSets = phaseSets.filter((s) => s.phaseGroupId === g.id);
              const live = groupSets.filter(
                (s) => s.state === ActivityState.Active || s.state === ActivityState.Called,
              ).length;
              return live * 1000 + groupSets.length;
            };
            return activity(b) - activity(a);
          })[0];

  if (!group) {
    return {
      event,
      phase,
      phaseGroup: null,
      bracketType: phase.bracketType,
      sets: phaseSets,
      available,
    };
  }

  const groupSets = phaseSets.filter((s) => s.phaseGroupId === group.id);

  return {
    event,
    phase,
    phaseGroup: group,
    bracketType: group.bracketType ?? phase.bracketType,
    // Some events omit the phase group on sets; fall back to the phase's sets
    // rather than rendering nothing.
    sets: groupSets.length > 0 ? groupSets : phaseSets,
    available,
  };
}
