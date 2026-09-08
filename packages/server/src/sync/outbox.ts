/**
 * Reporting outbox.
 *
 * Reports are written locally first and sent when start.gg is reachable. That
 * makes the venue keep working through a Wi-Fi drop, which is the whole point,
 * but it means a queued command can arrive at start.gg after someone else has
 * already changed the same set from the website.
 *
 * The policy chosen for this app is "flag conflicts for human review": before
 * sending, the worker re-reads the set and compares it against the state the
 * operator wrote against. If it moved, the command stops and surfaces both
 * versions for a person to decide. Nothing is silently overwritten and nothing
 * is silently dropped.
 */

import { EventEmitter } from 'node:events';

import {
  ActivityState,
  type BaseVersion,
  type ConflictDetail,
  type ConflictResolution,
  type GameReport,
  type Id,
  type OutboxEntry,
  type ReportCommand,
  type TournamentSet,
} from '@bracket/shared';

import type { Store } from '../db/store.js';
import type { StartggClient } from '../startgg/client.js';
import { GqlError } from '../startgg/transport.js';

export interface OutboxWorkerOptions {
  /** How often to look for sendable commands. */
  tickMs?: number;
  maxAttempts?: number;
  batchSize?: number;
}

export interface OutboxResult {
  entry: OutboxEntry;
  sets: TournamentSet[];
}

export class OutboxWorker extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private drainPromise: Promise<void> | null = null;
  private readonly tickMs: number;
  private readonly maxAttempts: number;
  private readonly batchSize: number;

  constructor(
    private readonly store: Store,
    private readonly client: StartggClient,
    options: OutboxWorkerOptions = {},
  ) {
    super();
    this.tickMs = options.tickMs ?? 3000;
    this.maxAttempts = options.maxAttempts ?? 6;
    this.batchSize = options.batchSize ?? 5;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drain(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Records the operator's intent and applies it locally straight away, so the
   * dashboard and every overlay react at once regardless of connectivity.
   */
  enqueue(
    command: ReportCommand,
    actor: { userId: string | null; username: string | null },
  ): OutboxEntry {
    const baseVersion = this.captureBaseVersion(command);
    const entry = this.store.enqueueCommand({
      command,
      baseVersion: baseVersion as unknown as Record<string, unknown>,
      userId: actor.userId,
      username: actor.username,
    });

    const optimistic = this.applyOptimistically(command);
    this.store.audit({
      userId: actor.userId,
      username: actor.username,
      action: `queue:${command.kind}`,
      target: 'setId' in command ? command.setId : (command as any).phaseId,
      detail: command,
    });

    this.emit('queued', { entry, sets: optimistic });
    this.emit('changed');
    // Try immediately rather than waiting for the next tick; a reported set
    // should reach start.gg in the time it takes the operator to look up.
    void this.drain();
    return entry;
  }

  private captureBaseVersion(command: ReportCommand): BaseVersion {
    if (!('setId' in command)) return {};
    const set = this.store.getSet(command.setId);
    if (!set) return { setId: command.setId };
    return {
      setId: set.id,
      state: set.state,
      winnerId: set.winnerId,
      updatedAt: set.updatedAt,
      displayScore: set.displayScore,
    };
  }

  /** Mirrors the command's effect onto the local set so the UI moves now. */
  private applyOptimistically(command: ReportCommand): TournamentSet[] {
    if (!('setId' in command)) return [];
    const set = this.store.getSet(command.setId);
    if (!set) return [];

    const next: TournamentSet = { ...set, pendingLocal: true };

    switch (command.kind) {
      case 'reportSet': {
        next.state = ActivityState.Completed;
        next.winnerId = command.winnerId;
        next.completedAt = Math.floor(Date.now() / 1000);
        next.slots = set.slots.map((slot) => {
          const scored = command.scores.find((s) => s.entrantId === slot.entrantId);
          return scored ? { ...slot, score: scored.score } : slot;
        });
        next.loserId =
          next.slots.find((s) => s.entrantId && s.entrantId !== command.winnerId)?.entrantId ??
          null;
        next.displayScore = next.slots
          .map((s) => `${s.entrantName ?? 'TBD'} ${s.score ?? 0}`)
          .join(' - ');
        if (command.games) {
          next.games = command.games.map((g) => ({
            id: `local-${command.setId}-${g.gameNum}`,
            orderNum: g.gameNum,
            winnerId: g.winnerId,
            selections: (g.selections ?? []).map((s) => ({
              entrantId: s.entrantId,
              characterName: s.characterName ?? null,
              characterImageUrl: null,
            })),
            stageName: null,
          }));
        }
        break;
      }
      case 'markInProgress':
        next.state = ActivityState.Active;
        next.startedAt = Math.floor(Date.now() / 1000);
        break;
      case 'resetSet':
        next.state = ActivityState.Created;
        next.winnerId = null;
        next.loserId = null;
        next.completedAt = null;
        next.startedAt = null;
        next.displayScore = null;
        next.games = [];
        next.slots = set.slots.map((slot) => ({ ...slot, score: null }));
        break;
      case 'assignStation':
        next.stationId = command.stationId;
        next.stationNumber = command.stationNumber;
        break;
      case 'assignStream':
        next.streamId = command.streamId;
        next.streamName = command.streamName;
        break;
    }

    this.store.applyOptimisticSet(next);
    return [next];
  }

  /**
   * Re-reads the target from start.gg and decides whether the queued command is
   * still valid. Only called for set-targeted commands; seeding updates are
   * whole-phase operations with no comparable base state.
   */
  private async detectConflict(entry: OutboxEntry): Promise<ConflictDetail | null> {
    const command = entry.command;
    if (!('setId' in command)) return null;
    // A fresh report against an untouched set is the common case; only look
    // closer when the base version recorded something to compare against.
    const base = entry.baseVersion;
    // A human has already looked at this disagreement and chosen to proceed.
    if (base.overrideConflict) return null;
    if (base.state === undefined && base.winnerId === undefined) return null;

    let remote: TournamentSet | null = null;
    try {
      const { sets } = await this.client.fetchEventSets(command.eventId, null);
      remote = sets.find((s) => s.id === command.setId) ?? null;
    } catch (error) {
      // Cannot verify: treat as a transient send failure rather than a conflict,
      // so the command stays queued instead of demanding a human decision.
      throw error;
    }

    if (!remote) {
      return {
        reason: 'rejected',
        message: 'start.gg no longer has this set; it may have been reseeded or deleted.',
        local: { command },
        remote: {},
        detectedAt: Date.now(),
      };
    }

    const wasCompleted = base.state === ActivityState.Completed;
    const isCompleted = remote.state === ActivityState.Completed;

    // Someone reported it while we were offline, and to a different result.
    if (!wasCompleted && isCompleted && command.kind === 'reportSet') {
      if (remote.winnerId === command.winnerId) {
        // Same outcome already recorded upstream — not a conflict, just done.
        return null;
      }
      return {
        reason: 'already-reported',
        message:
          'This set was already reported on start.gg with a different winner while the queue was offline.',
        local: {
          winnerId: command.winnerId,
          scores: command.scores,
        },
        remote: {
          winnerId: remote.winnerId,
          displayScore: remote.displayScore,
          completedAt: remote.completedAt,
        },
        detectedAt: Date.now(),
      };
    }

    // The set moved on in some other way since the operator wrote the report.
    const changedSinceBase =
      base.winnerId !== undefined && base.winnerId !== remote.winnerId && wasCompleted;
    if (changedSinceBase) {
      return {
        reason: 'remote-changed',
        message: 'start.gg has a different result for this set than the one this report was based on.',
        local: { baseWinnerId: base.winnerId, command },
        remote: { winnerId: remote.winnerId, displayScore: remote.displayScore },
        detectedAt: Date.now(),
      };
    }

    return null;
  }

  private async send(entry: OutboxEntry): Promise<TournamentSet[]> {
    const command = entry.command;
    switch (command.kind) {
      case 'reportSet': {
        const gameData = command.games ? buildGameData(command.games, command) : undefined;
        return this.client.reportSet({
          setId: command.setId,
          winnerId: command.winnerId,
          isDq: command.isDq ?? false,
          gameData,
        });
      }
      case 'markInProgress': {
        const set = await this.client.markInProgress(command.setId);
        return set ? [set] : [];
      }
      case 'resetSet': {
        const set = await this.client.resetSet(command.setId, command.resetDependents);
        return set ? [set] : [];
      }
      case 'assignStation': {
        if (!command.stationId) return [];
        const set = await this.client.assignStation(command.setId, command.stationId);
        return set ? [set] : [];
      }
      case 'assignStream': {
        if (!command.streamId) return [];
        const set = await this.client.assignStream(command.setId, command.streamId);
        return set ? [set] : [];
      }
      case 'updateSeeding': {
        await this.client.updateSeeding(command.phaseId, command.seedMapping);
        return [];
      }
    }
  }

  /**
   * Sends everything currently due.
   *
   * Concurrent callers join the in-flight pass rather than returning early, so
   * awaiting `drain()` always means "the queue has been worked" — the manual
   * "try sending now" button and the enqueue-triggered send would otherwise race.
   */
  async drain(): Promise<void> {
    if (this.draining) {
      await this.drainPromise;
      return;
    }
    this.draining = true;
    this.drainPromise = this.runDrain().finally(() => {
      this.draining = false;
      this.drainPromise = null;
    });
    await this.drainPromise;
  }

  private async runDrain(): Promise<void> {
    try {
      if (!this.client.health.online) return;

      const batch = this.store.claimSendableCommands(this.batchSize);
      for (const entry of batch) {
        this.store.updateOutbox(entry.id, { status: 'sending' });
        this.emit('changed');

        try {
          const conflict = await this.detectConflict(entry);
          if (conflict) {
            this.store.updateOutbox(entry.id, { status: 'conflict', conflict });
            this.store.audit({
              userId: entry.userId,
              username: entry.username,
              action: 'conflict',
              target: 'setId' in entry.command ? entry.command.setId : null,
              detail: conflict,
            });
            this.emit('conflict', { entry, conflict });
            this.emit('changed');
            continue;
          }

          const sets = await this.send(entry);
          if (sets.length > 0) {
            const { upserted } = this.store.upsertSets(sets);
            if (upserted.length > 0) this.emit('sets', { sets: upserted });
          } else if ('setId' in entry.command) {
            // A mutation that returns nothing useful still needs the local
            // pending flag cleared; the next sync pass supplies the truth.
            const local = this.store.getSet(entry.command.setId);
            if (local) this.store.upsertSets([{ ...local, pendingLocal: false }]);
          }

          this.store.updateOutbox(entry.id, {
            status: 'sent',
            lastError: null,
            conflict: null,
          });
          this.store.audit({
            userId: entry.userId,
            username: entry.username,
            action: `sent:${entry.command.kind}`,
            target: 'setId' in entry.command ? entry.command.setId : null,
          });
          this.emit('sent', { entry, sets });
          this.emit('changed');
        } catch (error) {
          this.handleSendFailure(entry, error);
        }
      }
    } catch (error) {
      // A failure outside a single command (e.g. reading the queue) must not
      // wedge the worker; the next tick tries again.
      this.emit('error', error);
    }
  }

  private handleSendFailure(entry: OutboxEntry, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = entry.attempts + 1;

    // A rejection start.gg will never accept (bad ids, no permission) is a
    // conflict for a human, not something to retry until the attempt cap.
    const permanent =
      error instanceof GqlError && (error.kind === 'auth' || error.kind === 'graphql');

    if (permanent || attempts >= this.maxAttempts) {
      const conflict: ConflictDetail = {
        reason: 'rejected',
        message: permanent
          ? `start.gg rejected this report: ${message}`
          : `Giving up after ${attempts} attempts: ${message}`,
        local: { command: entry.command },
        remote: {},
        detectedAt: Date.now(),
      };
      this.store.updateOutbox(entry.id, {
        status: 'conflict',
        attempts,
        lastError: message,
        conflict,
      });
      this.emit('conflict', { entry, conflict });
    } else {
      // 2s, 4s, 8s... capped, so a flapping connection recovers quickly.
      const backoff = Math.min(60_000, 2 ** attempts * 1000);
      this.store.updateOutbox(entry.id, {
        status: 'failed',
        attempts,
        lastError: message,
        nextAttemptAt: Date.now() + backoff,
      });
    }
    this.emit('changed');
  }

  /** Applies a human decision to a conflicted entry. */
  resolveConflict(
    entryId: string,
    resolution: ConflictResolution,
    actor: { userId: string | null; username: string | null },
  ): OutboxEntry | null {
    const entry = this.store.getOutboxEntry(entryId);
    if (!entry) return null;

    switch (resolution) {
      case 'force-local':
        this.store.updateOutbox(entryId, {
          status: 'queued',
          attempts: 0,
          conflict: null,
          lastError: null,
          nextAttemptAt: Date.now(),
          // Without this the next pass would re-detect the same conflict and
          // block the command the operator just approved.
          baseVersion: { ...entry.baseVersion, overrideConflict: true },
        });
        break;
      case 'keep-remote': {
        this.store.updateOutbox(entryId, { status: 'abandoned', conflict: entry.conflict });
        // Drop the optimistic local value so the next sync restores start.gg's.
        if ('setId' in entry.command) {
          const local = this.store.getSet(entry.command.setId);
          if (local) this.store.upsertSets([{ ...local, pendingLocal: false }]);
        }
        break;
      }
      case 'defer':
      default:
        return entry;
    }

    this.store.audit({
      userId: actor.userId,
      username: actor.username,
      action: `resolve:${resolution}`,
      target: entryId,
    });
    this.emit('changed');
    if (resolution === 'force-local') void this.drain();
    return this.store.getOutboxEntry(entryId);
  }
}

/**
 * Maps per-game reports into start.gg's `BracketSetGameDataInput` shape. Scores
 * are carried per game as well as on the set, which is what the website sends.
 */
function buildGameData(
  games: GameReport[],
  command: { scores: { entrantId: Id; score: number }[] },
): Record<string, unknown>[] {
  const entrantIds = command.scores.map((s) => s.entrantId);
  return games
    .slice()
    .sort((a, b) => a.gameNum - b.gameNum)
    .map((game) => {
      const wins = { first: 0, second: 0 };
      for (const g of games) {
        if (g.gameNum > game.gameNum) continue;
        if (g.winnerId === entrantIds[0]) wins.first += 1;
        else if (g.winnerId === entrantIds[1]) wins.second += 1;
      }
      return {
        gameNum: game.gameNum,
        winnerId: game.winnerId,
        entrant1Score: wins.first,
        entrant2Score: wins.second,
        stageId: game.stageId ?? null,
        selections: (game.selections ?? [])
          .filter((s) => s.characterId !== undefined)
          .map((s) => ({ entrantId: s.entrantId, characterId: s.characterId })),
      };
    });
}
