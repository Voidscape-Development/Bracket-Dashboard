/**
 * Data access.
 *
 * All SQL lives here. Everything above works with domain objects. The one piece
 * of cleverness is `upsertSets`, which hashes each mapped set and skips rows
 * whose content is unchanged — start.gg's `updatedAfter` filter still returns
 * sets whose visible state did not move, and pushing those to overlays would
 * cause pointless re-renders.
 */

import { createHash, randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import {
  ActivityState,
  BUILT_IN_THEMES,
  DEFAULT_AUTO_FOLLOW,
  DEFAULT_CAMERA,
  DEFAULT_THEME_TOKENS,
  defaultConfigFor,
  normalizeTheme,
  type AutoFollowConfig,
  type BracketType,
  type CameraState,
  type Entrant,
  type EventStatus,
  type Id,
  type OutboxEntry,
  type OutputView,
  type Phase,
  type PhaseGroup,
  type ReportCommand,
  type Role,
  type Standing,
  type Theme,
  type Tournament,
  type TournamentEvent,
  type TournamentSet,
  type User,
  type ViewConfig,
  type ViewKind,
} from '@bracket/shared';

import { migrate } from './schema.js';

type Row = Record<string, any>;

function json<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Content hash over the fields that affect what a viewer sees. Deliberately
 * excludes remote timestamps so a set that was merely re-saved upstream does not
 * count as a change.
 */
export function hashSet(set: TournamentSet): string {
  const material = JSON.stringify([
    set.identifier,
    set.round,
    set.fullRoundText,
    set.state,
    set.winnerId,
    set.displayScore,
    set.totalGames,
    set.stationNumber,
    set.streamName,
    set.slots.map((s) => [s.slotIndex, s.entrantId, s.entrantName, s.seed, s.score, s.prereqId]),
    set.games.map((g) => [g.orderNum, g.winnerId, g.selections.map((x) => [x.entrantId, x.characterName])]),
  ]);
  return createHash('sha1').update(material).digest('hex').slice(0, 16);
}

export interface SetChanges {
  upserted: TournamentSet[];
  unchanged: number;
}

export class Store {
  readonly db: BetterSqlite3.Database;

  constructor(filename: string) {
    this.db = new Database(filename);
    migrate(this.db);
    this.seedThemes();
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  // -------------------------------------------------------------------------
  // Tournament structure
  // -------------------------------------------------------------------------

  saveTournament(tournament: Tournament): void {
    const upsertTournament = this.db.prepare(`
      INSERT INTO tournaments (id, slug, name, start_at, end_at, timezone, venue_name, city, imported_at)
      VALUES (@id, @slug, @name, @startAt, @endAt, @timezone, @venueName, @city, @importedAt)
      ON CONFLICT(id) DO UPDATE SET
        slug = excluded.slug, name = excluded.name, start_at = excluded.start_at,
        end_at = excluded.end_at, timezone = excluded.timezone,
        venue_name = excluded.venue_name, city = excluded.city
    `);
    const upsertEvent = this.db.prepare(`
      INSERT INTO events (id, tournament_id, name, slug, state, start_at, num_entrants,
                          videogame_id, videogame_name, videogame_image)
      VALUES (@id, @tournamentId, @name, @slug, @state, @startAt, @numEntrants,
              @videogameId, @videogameName, @videogameImage)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, slug = excluded.slug, state = excluded.state,
        start_at = excluded.start_at, num_entrants = excluded.num_entrants,
        videogame_id = excluded.videogame_id, videogame_name = excluded.videogame_name,
        videogame_image = excluded.videogame_image
    `);
    const upsertPhase = this.db.prepare(`
      INSERT INTO phases (id, event_id, name, phase_order, bracket_type, group_count, state)
      VALUES (@id, @eventId, @name, @phaseOrder, @bracketType, @groupCount, @state)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, phase_order = excluded.phase_order,
        bracket_type = excluded.bracket_type, group_count = excluded.group_count,
        state = excluded.state
    `);
    const upsertGroup = this.db.prepare(`
      INSERT INTO phase_groups (id, phase_id, event_id, display_identifier, bracket_type, state, rounds_json)
      VALUES (@id, @phaseId, @eventId, @displayIdentifier, @bracketType, @state, @roundsJson)
      ON CONFLICT(id) DO UPDATE SET
        display_identifier = excluded.display_identifier,
        bracket_type = excluded.bracket_type, state = excluded.state,
        rounds_json = excluded.rounds_json
    `);

    this.db.transaction(() => {
      upsertTournament.run({
        id: tournament.id,
        slug: tournament.slug,
        name: tournament.name,
        startAt: tournament.startAt,
        endAt: tournament.endAt,
        timezone: tournament.timezone,
        venueName: tournament.venueName,
        city: tournament.city,
        importedAt: Date.now(),
      });

      for (const event of tournament.events) {
        upsertEvent.run({
          id: event.id,
          tournamentId: tournament.id,
          name: event.name,
          slug: event.slug,
          state: event.state,
          startAt: event.startAt,
          numEntrants: event.numEntrants,
          videogameId: event.videogameId,
          videogameName: event.videogameName,
          videogameImage: event.videogameImageUrl,
        });
        for (const phase of event.phases) {
          upsertPhase.run({
            id: phase.id,
            eventId: event.id,
            name: phase.name,
            phaseOrder: phase.phaseOrder,
            bracketType: phase.bracketType,
            groupCount: phase.groupCount,
            state: phase.state,
          });
          for (const group of phase.groups) {
            upsertGroup.run({
              id: group.id,
              phaseId: phase.id,
              eventId: event.id,
              displayIdentifier: group.displayIdentifier,
              bracketType: group.bracketType,
              state: group.state,
              roundsJson: JSON.stringify(group.rounds),
            });
          }
        }
      }
    })();
  }

  listTournaments(): Tournament[] {
    const rows = this.db
      .prepare('SELECT * FROM tournaments ORDER BY imported_at DESC')
      .all() as Row[];
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      startAt: row.start_at,
      endAt: row.end_at,
      timezone: row.timezone,
      venueName: row.venue_name,
      city: row.city,
      events: this.listEvents(row.id),
    }));
  }

  getTournament(id: Id): Tournament | null {
    const row = this.db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      startAt: row.start_at,
      endAt: row.end_at,
      timezone: row.timezone,
      venueName: row.venue_name,
      city: row.city,
      events: this.listEvents(row.id),
    };
  }

  getTournamentBySlug(slug: string): Tournament | null {
    const row = this.db.prepare('SELECT id FROM tournaments WHERE slug = ?').get(slug) as Row | undefined;
    return row ? this.getTournament(row.id) : null;
  }

  deleteTournament(id: Id): void {
    this.db.prepare('DELETE FROM tournaments WHERE id = ?').run(id);
  }

  listEvents(tournamentId?: Id): TournamentEvent[] {
    const rows = (
      tournamentId
        ? this.db.prepare('SELECT * FROM events WHERE tournament_id = ? ORDER BY start_at, name').all(tournamentId)
        : this.db.prepare('SELECT * FROM events ORDER BY start_at, name').all()
    ) as Row[];
    return rows.map((row) => this.hydrateEvent(row));
  }

  getEvent(eventId: Id): TournamentEvent | null {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as Row | undefined;
    return row ? this.hydrateEvent(row) : null;
  }

  private hydrateEvent(row: Row): TournamentEvent {
    const phaseRows = this.db
      .prepare('SELECT * FROM phases WHERE event_id = ? ORDER BY phase_order')
      .all(row.id) as Row[];
    const groupRows = this.db
      .prepare('SELECT * FROM phase_groups WHERE event_id = ?')
      .all(row.id) as Row[];

    const phases: Phase[] = phaseRows.map((p) => ({
      id: p.id,
      eventId: row.id,
      name: p.name,
      phaseOrder: p.phase_order,
      bracketType: p.bracket_type as BracketType,
      groupCount: p.group_count,
      state: p.state,
      groups: groupRows
        .filter((g) => g.phase_id === p.id)
        .map(
          (g): PhaseGroup => ({
            id: g.id,
            phaseId: g.phase_id,
            eventId: row.id,
            displayIdentifier: g.display_identifier,
            bracketType: g.bracket_type as BracketType,
            state: g.state,
            rounds: json(g.rounds_json, []),
          }),
        ),
    }));

    return {
      id: row.id,
      tournamentId: row.tournament_id,
      name: row.name,
      slug: row.slug,
      state: row.state,
      startAt: row.start_at,
      numEntrants: row.num_entrants,
      videogameId: row.videogame_id,
      videogameName: row.videogame_name,
      videogameImageUrl: row.videogame_image,
      phases,
    };
  }

  setEventTracked(eventId: Id, tracked: boolean): void {
    this.db.prepare('UPDATE events SET tracked = ? WHERE id = ?').run(tracked ? 1 : 0, eventId);
  }

  listTrackedEventIds(): Id[] {
    return (this.db.prepare('SELECT id FROM events WHERE tracked = 1').all() as Row[]).map(
      (r) => r.id as Id,
    );
  }

  // -------------------------------------------------------------------------
  // Sync watermarks
  // -------------------------------------------------------------------------

  getWatermark(eventId: Id): number | null {
    const row = this.db
      .prepare('SELECT sync_watermark FROM events WHERE id = ?')
      .get(eventId) as Row | undefined;
    return row?.sync_watermark ?? null;
  }

  recordSyncSuccess(eventId: Id, watermark: number): void {
    this.db
      .prepare(
        'UPDATE events SET sync_watermark = ?, last_synced_at = ?, sync_error = NULL WHERE id = ?',
      )
      .run(watermark, Date.now(), eventId);
  }

  recordSyncError(eventId: Id, error: string): void {
    this.db
      .prepare('UPDATE events SET last_synced_at = ?, sync_error = ? WHERE id = ?')
      .run(Date.now(), error, eventId);
  }

  markFullSync(tournamentId: Id): void {
    this.db
      .prepare('UPDATE tournaments SET last_full_sync_at = ? WHERE id = ?')
      .run(Date.now(), tournamentId);
  }

  // -------------------------------------------------------------------------
  // Entrants, sets, standings
  // -------------------------------------------------------------------------

  replaceEntrants(eventId: Id, entrants: Entrant[]): void {
    const insert = this.db.prepare(`
      INSERT INTO entrants (id, event_id, name, seed, is_disqualified, participants_json)
      VALUES (@id, @eventId, @name, @seed, @isDq, @participants)
      ON CONFLICT(event_id, id) DO UPDATE SET
        name = excluded.name, seed = excluded.seed,
        is_disqualified = excluded.is_disqualified,
        participants_json = excluded.participants_json
    `);
    this.db.transaction(() => {
      for (const entrant of entrants) {
        insert.run({
          id: entrant.id,
          eventId,
          name: entrant.name,
          seed: entrant.seed,
          isDq: entrant.isDisqualified ? 1 : 0,
          participants: JSON.stringify(entrant.participants),
        });
      }
    })();
  }

  listEntrants(eventId: Id): Entrant[] {
    const rows = this.db
      .prepare('SELECT * FROM entrants WHERE event_id = ? ORDER BY seed IS NULL, seed')
      .all(eventId) as Row[];
    return rows.map((row) => ({
      id: row.id,
      eventId,
      name: row.name,
      seed: row.seed,
      isDisqualified: !!row.is_disqualified,
      participants: json(row.participants_json, []),
    }));
  }

  /** Upserts sets, returning only those whose visible content actually moved. */
  upsertSets(sets: TournamentSet[]): SetChanges {
    if (sets.length === 0) return { upserted: [], unchanged: 0 };

    const existing = this.db.prepare(
      'SELECT id, content_hash, pending_local FROM sets WHERE id = ?',
    );
    const insert = this.db.prepare(`
      INSERT INTO sets (
        id, event_id, phase_id, phase_group_id, identifier, round, full_round_text,
        state, winner_id, loser_id, display_score, total_games, best_of,
        started_at, completed_at, remote_updated_at, station_number, station_id,
        stream_name, stream_id, slots_json, games_json, content_hash,
        pending_local, local_updated_at
      ) VALUES (
        @id, @eventId, @phaseId, @phaseGroupId, @identifier, @round, @fullRoundText,
        @state, @winnerId, @loserId, @displayScore, @totalGames, @bestOf,
        @startedAt, @completedAt, @remoteUpdatedAt, @stationNumber, @stationId,
        @streamName, @streamId, @slotsJson, @gamesJson, @contentHash,
        @pendingLocal, @localUpdatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        phase_id = excluded.phase_id, phase_group_id = excluded.phase_group_id,
        identifier = excluded.identifier, round = excluded.round,
        full_round_text = excluded.full_round_text, state = excluded.state,
        winner_id = excluded.winner_id, loser_id = excluded.loser_id,
        display_score = excluded.display_score, total_games = excluded.total_games,
        best_of = excluded.best_of, started_at = excluded.started_at,
        completed_at = excluded.completed_at, remote_updated_at = excluded.remote_updated_at,
        station_number = excluded.station_number, station_id = excluded.station_id,
        stream_name = excluded.stream_name, stream_id = excluded.stream_id,
        slots_json = excluded.slots_json, games_json = excluded.games_json,
        content_hash = excluded.content_hash, pending_local = excluded.pending_local,
        local_updated_at = excluded.local_updated_at
    `);

    const changed: TournamentSet[] = [];
    let unchanged = 0;

    this.db.transaction(() => {
      for (const set of sets) {
        const hash = hashSet(set);
        const prior = existing.get(set.id) as Row | undefined;
        // A row still flagged pending must be rewritten even when the hash
        // matches: the common case is that the optimistic local result was
        // exactly right, and skipping here would leave it marked "syncing"
        // forever.
        if (prior && prior.content_hash === hash && !prior.pending_local) {
          unchanged += 1;
          continue;
        }
        insert.run({
          id: set.id,
          eventId: set.eventId,
          phaseId: set.phaseId || null,
          phaseGroupId: set.phaseGroupId || null,
          identifier: set.identifier,
          round: set.round,
          fullRoundText: set.fullRoundText,
          state: set.state,
          winnerId: set.winnerId,
          loserId: set.loserId,
          displayScore: set.displayScore,
          totalGames: set.totalGames,
          bestOf: set.bestOf,
          startedAt: set.startedAt,
          completedAt: set.completedAt,
          remoteUpdatedAt: set.updatedAt,
          stationNumber: set.stationNumber,
          stationId: set.stationId,
          streamName: set.streamName,
          streamId: set.streamId,
          slotsJson: JSON.stringify(set.slots),
          gamesJson: JSON.stringify(set.games),
          contentHash: hash,
          // A confirmed remote value always clears the optimistic flag.
          pendingLocal: 0,
          localUpdatedAt: Date.now(),
        });
        changed.push({ ...set, pendingLocal: false });
      }
    })();

    return { upserted: changed, unchanged };
  }

  private hydrateSet(row: Row): TournamentSet {
    return {
      id: row.id,
      eventId: row.event_id,
      phaseId: row.phase_id ?? '',
      phaseGroupId: row.phase_group_id ?? '',
      identifier: row.identifier,
      round: row.round,
      fullRoundText: row.full_round_text,
      state: row.state as ActivityState,
      winnerId: row.winner_id,
      loserId: row.loser_id,
      displayScore: row.display_score,
      totalGames: row.total_games,
      bestOf: row.best_of,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      updatedAt: row.remote_updated_at,
      stationNumber: row.station_number,
      stationId: row.station_id,
      streamName: row.stream_name,
      streamId: row.stream_id,
      slots: json(row.slots_json, []),
      games: json(row.games_json, []),
      pendingLocal: !!row.pending_local,
    };
  }

  listSets(eventId: Id): TournamentSet[] {
    const rows = this.db
      .prepare('SELECT * FROM sets WHERE event_id = ? ORDER BY round, identifier')
      .all(eventId) as Row[];
    return rows.map((r) => this.hydrateSet(r));
  }

  listSetsByPhaseGroup(phaseGroupId: Id): TournamentSet[] {
    const rows = this.db
      .prepare('SELECT * FROM sets WHERE phase_group_id = ? ORDER BY round, identifier')
      .all(phaseGroupId) as Row[];
    return rows.map((r) => this.hydrateSet(r));
  }

  getSet(setId: Id): TournamentSet | null {
    const row = this.db.prepare('SELECT * FROM sets WHERE id = ?').get(setId) as Row | undefined;
    return row ? this.hydrateSet(row) : null;
  }

  /**
   * Writes an optimistic local result. Flagged `pending_local` so the UI can
   * show it as unconfirmed, and overwritten wholesale by the next remote value.
   */
  applyOptimisticSet(set: TournamentSet): void {
    this.db
      .prepare(
        `UPDATE sets SET state = ?, winner_id = ?, loser_id = ?, display_score = ?,
           slots_json = ?, games_json = ?, station_number = ?, stream_name = ?,
           content_hash = ?, pending_local = 1, local_updated_at = ?
         WHERE id = ?`,
      )
      .run(
        set.state,
        set.winnerId,
        set.loserId,
        set.displayScore,
        JSON.stringify(set.slots),
        JSON.stringify(set.games),
        set.stationNumber,
        set.streamName,
        hashSet(set),
        Date.now(),
        set.id,
      );
  }

  replaceStandings(eventId: Id, standings: Standing[]): void {
    const insert = this.db.prepare(`
      INSERT INTO standings (event_id, entrant_id, entrant_name, placement, is_final)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(event_id, entrant_id) DO UPDATE SET
        entrant_name = excluded.entrant_name, placement = excluded.placement,
        is_final = excluded.is_final
    `);
    this.db.transaction(() => {
      for (const s of standings) {
        insert.run(eventId, s.entrantId, s.entrantName, s.placement, s.isFinal ? 1 : 0);
      }
    })();
  }

  listStandings(eventId: Id): Standing[] {
    const rows = this.db
      .prepare('SELECT * FROM standings WHERE event_id = ? ORDER BY placement')
      .all(eventId) as Row[];
    return rows.map((row) => ({
      eventId,
      entrantId: row.entrant_id,
      entrantName: row.entrant_name,
      placement: row.placement,
      isFinal: !!row.is_final,
    }));
  }

  eventStatuses(): EventStatus[] {
    const rows = this.db
      .prepare(
        `SELECT e.id AS event_id, e.last_synced_at, e.sync_error,
                COUNT(s.id) AS total,
                SUM(CASE WHEN s.state = 3 THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN s.state IN (2, 6) THEN 1 ELSE 0 END) AS active
         FROM events e LEFT JOIN sets s ON s.event_id = e.id
         GROUP BY e.id`,
      )
      .all() as Row[];

    return rows.map((row) => {
      const total = Number(row.total ?? 0);
      const completed = Number(row.completed ?? 0);
      const active = Number(row.active ?? 0);
      return {
        eventId: row.event_id,
        totalSets: total,
        completedSets: completed,
        activeSets: active,
        pendingSets: Math.max(0, total - completed - active),
        lastSyncedAt: row.last_synced_at ?? null,
        syncError: row.sync_error ?? null,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Themes
  // -------------------------------------------------------------------------

  private seedThemes(): void {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM themes').get() as Row;
    if (Number(count.n) > 0) return;
    for (const theme of BUILT_IN_THEMES) {
      this.saveTheme({ ...theme, updatedAt: Date.now() });
    }
  }

  saveTheme(theme: Theme): Theme {
    this.db
      .prepare(
        `INSERT INTO themes (id, name, built_in, tokens_json, custom_css, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, tokens_json = excluded.tokens_json,
           custom_css = excluded.custom_css, updated_at = excluded.updated_at`,
      )
      .run(
        theme.id,
        theme.name,
        theme.builtIn ? 1 : 0,
        JSON.stringify(theme.tokens),
        theme.customCss,
        theme.updatedAt || Date.now(),
      );
    return theme;
  }

  listThemes(): Theme[] {
    const rows = this.db.prepare('SELECT * FROM themes ORDER BY built_in DESC, name').all() as Row[];
    return rows.map((row) =>
      normalizeTheme({
        id: row.id,
        name: row.name,
        builtIn: !!row.built_in,
        tokens: { ...DEFAULT_THEME_TOKENS, ...json(row.tokens_json, {}) },
        customCss: row.custom_css,
        updatedAt: row.updated_at,
      }),
    );
  }

  getTheme(id: string): Theme | null {
    const row = this.db.prepare('SELECT * FROM themes WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    return normalizeTheme({
      id: row.id,
      name: row.name,
      builtIn: !!row.built_in,
      tokens: { ...DEFAULT_THEME_TOKENS, ...json(row.tokens_json, {}) },
      customCss: row.custom_css,
      updatedAt: row.updated_at,
    });
  }

  deleteTheme(id: string): boolean {
    const theme = this.getTheme(id);
    if (!theme || theme.builtIn) return false;
    // Views pointing at a removed theme fall back to the default.
    this.db.prepare('UPDATE views SET theme_id = ? WHERE theme_id = ?').run('startgg-dark', id);
    this.db.prepare('DELETE FROM themes WHERE id = ?').run(id);
    return true;
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  createView(input: {
    name: string;
    kind: ViewKind;
    eventId: Id | null;
    phaseId?: Id | null;
    phaseGroupId: Id | null;
    followActivePhase?: boolean;
    themeId?: string;
    config?: ViewConfig;
    width?: number;
    height?: number;
  }): OutputView {
    const view: OutputView = {
      id: randomUUID().slice(0, 8),
      name: input.name,
      kind: input.kind,
      secret: randomUUID().replace(/-/g, ''),
      eventId: input.eventId,
      phaseId: input.phaseId ?? null,
      phaseGroupId: input.phaseGroupId,
      followActivePhase: input.followActivePhase ?? false,
      themeId: input.themeId ?? 'startgg-dark',
      config: input.config ?? defaultConfigFor(input.kind),
      camera: { ...DEFAULT_CAMERA },
      autoFollow: { ...DEFAULT_AUTO_FOLLOW },
      width: input.width ?? 1920,
      height: input.height ?? 1080,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.writeView(view);
    return view;
  }

  private writeView(view: OutputView): void {
    this.db
      .prepare(
        `INSERT INTO views (id, name, kind, secret, event_id, phase_id, phase_group_id,
                            follow_active_phase, theme_id,
                            config_json, camera_json, autofollow_json, width, height,
                            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, kind = excluded.kind, event_id = excluded.event_id,
           phase_id = excluded.phase_id, phase_group_id = excluded.phase_group_id,
           follow_active_phase = excluded.follow_active_phase,
           theme_id = excluded.theme_id,
           config_json = excluded.config_json, camera_json = excluded.camera_json,
           autofollow_json = excluded.autofollow_json, width = excluded.width,
           height = excluded.height, updated_at = excluded.updated_at`,
      )
      .run(
        view.id,
        view.name,
        view.kind,
        view.secret,
        view.eventId,
        view.phaseId,
        view.phaseGroupId,
        view.followActivePhase ? 1 : 0,
        view.themeId,
        JSON.stringify(view.config),
        JSON.stringify(view.camera),
        JSON.stringify(view.autoFollow),
        view.width,
        view.height,
        view.createdAt,
        Date.now(),
      );
  }

  private hydrateView(row: Row): OutputView {
    const kind = row.kind as ViewKind;
    return {
      id: row.id,
      name: row.name,
      kind,
      secret: row.secret,
      eventId: row.event_id,
      phaseId: row.phase_id ?? null,
      phaseGroupId: row.phase_group_id,
      followActivePhase: !!row.follow_active_phase,
      themeId: row.theme_id,
      config: json(row.config_json, defaultConfigFor(kind)),
      camera: { ...DEFAULT_CAMERA, ...json<Partial<CameraState>>(row.camera_json, {}) },
      autoFollow: {
        ...DEFAULT_AUTO_FOLLOW,
        ...json<Partial<AutoFollowConfig>>(row.autofollow_json, {}),
      },
      width: row.width,
      height: row.height,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listViews(): OutputView[] {
    const rows = this.db.prepare('SELECT * FROM views ORDER BY created_at').all() as Row[];
    return rows.map((r) => this.hydrateView(r));
  }

  getView(id: string): OutputView | null {
    const row = this.db.prepare('SELECT * FROM views WHERE id = ?').get(id) as Row | undefined;
    return row ? this.hydrateView(row) : null;
  }

  updateView(id: string, patch: Partial<OutputView>): OutputView | null {
    const current = this.getView(id);
    if (!current) return null;
    const next: OutputView = { ...current, ...patch, id: current.id, secret: current.secret };
    this.writeView(next);
    return next;
  }

  deleteView(id: string): void {
    this.db.prepare('DELETE FROM views WHERE id = ?').run(id);
  }

  /** Rotates a view's secret, invalidating any URL already pasted elsewhere. */
  rotateViewSecret(id: string): OutputView | null {
    const current = this.getView(id);
    if (!current) return null;
    const next = { ...current, secret: randomUUID().replace(/-/g, ''), updatedAt: Date.now() };
    this.db
      .prepare('UPDATE views SET secret = ?, updated_at = ? WHERE id = ?')
      .run(next.secret, next.updatedAt, id);
    return next;
  }

  // -------------------------------------------------------------------------
  // Users and sessions
  // -------------------------------------------------------------------------

  createUser(input: {
    username: string;
    passwordHash: string;
    role: Role;
    eventScope?: Id[];
  }): User {
    const user: User = {
      id: randomUUID(),
      username: input.username,
      role: input.role,
      eventScope: input.eventScope ?? [],
      createdAt: Date.now(),
      lastSeenAt: null,
      disabled: false,
    };
    this.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, event_scope_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.id,
        user.username,
        input.passwordHash,
        user.role,
        JSON.stringify(user.eventScope),
        user.createdAt,
      );
    return user;
  }

  private hydrateUser(row: Row): User {
    return {
      id: row.id,
      username: row.username,
      role: row.role as Role,
      eventScope: json(row.event_scope_json, []),
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      disabled: !!row.disabled,
    };
  }

  listUsers(): User[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY created_at').all() as Row[];
    return rows.map((r) => this.hydrateUser(r));
  }

  getUser(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    return row ? this.hydrateUser(row) : null;
  }

  getUserByUsername(username: string): (User & { passwordHash: string }) | null {
    const row = this.db
      .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
      .get(username) as Row | undefined;
    if (!row) return null;
    return { ...this.hydrateUser(row), passwordHash: row.password_hash };
  }

  updateUser(
    id: string,
    patch: Partial<Pick<User, 'role' | 'eventScope' | 'disabled'>> & { passwordHash?: string },
  ): User | null {
    const current = this.getUser(id);
    if (!current) return null;
    this.db
      .prepare(
        `UPDATE users SET role = ?, event_scope_json = ?, disabled = ?,
           password_hash = COALESCE(?, password_hash) WHERE id = ?`,
      )
      .run(
        patch.role ?? current.role,
        JSON.stringify(patch.eventScope ?? current.eventScope),
        (patch.disabled ?? current.disabled) ? 1 : 0,
        patch.passwordHash ?? null,
        id,
      );
    return this.getUser(id);
  }

  deleteUser(id: string): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  countUsers(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as Row).n);
  }

  createSession(userId: string, ttlMs: number, userAgent: string | null): string {
    const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    this.db
      .prepare(
        'INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
      )
      .run(token, userId, Date.now(), Date.now() + ttlMs, userAgent);
    return token;
  }

  getSessionUser(token: string): User | null {
    const row = this.db
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?`,
      )
      .get(token, Date.now()) as Row | undefined;
    if (!row || row.disabled) return null;
    this.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), row.id);
    return this.hydrateUser(row);
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  deleteSessionsForUser(userId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  purgeExpiredSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  }

  // -------------------------------------------------------------------------
  // Outbox
  // -------------------------------------------------------------------------

  enqueueCommand(input: {
    command: ReportCommand;
    baseVersion: Record<string, unknown>;
    userId: string | null;
    username: string | null;
  }): OutboxEntry {
    const entry: OutboxEntry = {
      id: randomUUID(),
      command: input.command,
      status: 'queued',
      attempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      nextAttemptAt: Date.now(),
      lastError: null,
      baseVersion: input.baseVersion,
      conflict: null,
      userId: input.userId,
      username: input.username,
    };
    const targetId =
      'setId' in input.command ? input.command.setId : (input.command as any).phaseId ?? null;

    this.db
      .prepare(
        `INSERT INTO outbox (id, kind, event_id, target_id, command_json, status, attempts,
                             created_at, updated_at, next_attempt_at, base_version_json,
                             user_id, username)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        input.command.kind,
        input.command.eventId ?? null,
        targetId,
        JSON.stringify(input.command),
        entry.status,
        0,
        entry.createdAt,
        entry.updatedAt,
        entry.nextAttemptAt,
        JSON.stringify(entry.baseVersion),
        entry.userId,
        entry.username,
      );
    return entry;
  }

  private hydrateOutbox(row: Row): OutboxEntry {
    return {
      id: row.id,
      command: json(row.command_json, {} as ReportCommand),
      status: row.status,
      attempts: row.attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error,
      baseVersion: json(row.base_version_json, {}),
      conflict: row.conflict_json ? json(row.conflict_json, null) : null,
      userId: row.user_id,
      username: row.username,
    };
  }

  listOutbox(statuses?: string[]): OutboxEntry[] {
    const rows = (
      statuses && statuses.length > 0
        ? this.db
            .prepare(
              `SELECT * FROM outbox WHERE status IN (${statuses.map(() => '?').join(',')})
               ORDER BY created_at`,
            )
            .all(...statuses)
        : this.db.prepare('SELECT * FROM outbox ORDER BY created_at DESC LIMIT 500').all()
    ) as Row[];
    return rows.map((r) => this.hydrateOutbox(r));
  }

  getOutboxEntry(id: string): OutboxEntry | null {
    const row = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as Row | undefined;
    return row ? this.hydrateOutbox(row) : null;
  }

  /** Commands ready to send now, oldest first so reports replay in order. */
  claimSendableCommands(limit = 10): OutboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox
         WHERE status IN ('queued', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at LIMIT ?`,
      )
      .all(Date.now(), limit) as Row[];
    return rows.map((r) => this.hydrateOutbox(r));
  }

  updateOutbox(id: string, patch: Partial<OutboxEntry>): void {
    const current = this.getOutboxEntry(id);
    if (!current) return;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    this.db
      .prepare(
        `UPDATE outbox SET status = ?, attempts = ?, updated_at = ?, next_attempt_at = ?,
           last_error = ?, conflict_json = ?, command_json = ?, base_version_json = ?
         WHERE id = ?`,
      )
      .run(
        next.status,
        next.attempts,
        next.updatedAt,
        next.nextAttemptAt,
        next.lastError,
        next.conflict ? JSON.stringify(next.conflict) : null,
        JSON.stringify(next.command),
        JSON.stringify(next.baseVersion ?? {}),
        id,
      );
  }

  deleteOutboxEntry(id: string): void {
    this.db.prepare('DELETE FROM outbox WHERE id = ?').run(id);
  }

  outboxCounts(): { queued: number; conflicts: number } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status IN ('queued','failed','sending') THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN status = 'conflict' THEN 1 ELSE 0 END) AS conflicts
         FROM outbox`,
      )
      .get() as Row;
    return { queued: Number(row.queued ?? 0), conflicts: Number(row.conflicts ?? 0) };
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  audit(entry: {
    userId: string | null;
    username: string | null;
    action: string;
    target?: string | null;
    detail?: unknown;
  }): void {
    this.db
      .prepare(
        'INSERT INTO audit_log (at, user_id, username, action, target, detail_json) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        Date.now(),
        entry.userId,
        entry.username,
        entry.action,
        entry.target ?? null,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
      );
  }

  listAudit(limit = 200): Row[] {
    return this.db
      .prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?')
      .all(limit) as Row[];
  }
}
