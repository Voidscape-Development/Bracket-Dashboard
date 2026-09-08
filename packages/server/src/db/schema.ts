/**
 * Database schema and migrations.
 *
 * SQLite in WAL mode: a tournament's worth of sets is small, reads are frequent
 * (every overlay refresh), and writes are bursty (a sync pass). Migrations are
 * append-only and run inside a transaction at startup.
 */

import type BetterSqlite3 from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: `
      CREATE TABLE tournaments (
        id            TEXT PRIMARY KEY,
        slug          TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL,
        start_at      INTEGER,
        end_at        INTEGER,
        timezone      TEXT,
        venue_name    TEXT,
        city          TEXT,
        imported_at   INTEGER NOT NULL,
        last_full_sync_at INTEGER
      );

      CREATE TABLE events (
        id              TEXT PRIMARY KEY,
        tournament_id   TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        slug            TEXT,
        state           INTEGER,
        start_at        INTEGER,
        num_entrants    INTEGER,
        videogame_id    TEXT,
        videogame_name  TEXT,
        videogame_image TEXT,
        -- Watermark passed to start.gg as updatedAfter on the next delta poll.
        sync_watermark  INTEGER,
        last_synced_at  INTEGER,
        sync_error      TEXT,
        tracked         INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX idx_events_tournament ON events(tournament_id);

      CREATE TABLE phases (
        id           TEXT PRIMARY KEY,
        event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        phase_order  INTEGER NOT NULL DEFAULT 0,
        bracket_type TEXT NOT NULL,
        group_count  INTEGER NOT NULL DEFAULT 1,
        state        INTEGER
      );
      CREATE INDEX idx_phases_event ON phases(event_id);

      CREATE TABLE phase_groups (
        id                 TEXT PRIMARY KEY,
        phase_id           TEXT NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
        event_id           TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        display_identifier TEXT NOT NULL,
        bracket_type       TEXT NOT NULL,
        state              INTEGER,
        rounds_json        TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX idx_groups_event ON phase_groups(event_id);
      CREATE INDEX idx_groups_phase ON phase_groups(phase_id);

      CREATE TABLE entrants (
        id                TEXT NOT NULL,
        event_id          TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        name              TEXT NOT NULL,
        seed              INTEGER,
        is_disqualified   INTEGER NOT NULL DEFAULT 0,
        participants_json TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (event_id, id)
      );

      CREATE TABLE sets (
        id             TEXT PRIMARY KEY,
        event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        phase_id       TEXT,
        phase_group_id TEXT,
        identifier     TEXT NOT NULL,
        round          INTEGER NOT NULL DEFAULT 0,
        full_round_text TEXT NOT NULL DEFAULT '',
        state          INTEGER NOT NULL DEFAULT 1,
        winner_id      TEXT,
        loser_id       TEXT,
        display_score  TEXT,
        total_games    INTEGER,
        best_of        INTEGER,
        started_at     INTEGER,
        completed_at   INTEGER,
        remote_updated_at INTEGER,
        station_number INTEGER,
        station_id     TEXT,
        stream_name    TEXT,
        stream_id      TEXT,
        slots_json     TEXT NOT NULL DEFAULT '[]',
        games_json     TEXT NOT NULL DEFAULT '[]',
        -- Hash of the mapped payload; lets a sync pass skip unchanged rows.
        content_hash   TEXT NOT NULL,
        -- Set while a local report is queued but unconfirmed.
        pending_local  INTEGER NOT NULL DEFAULT 0,
        local_updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_sets_event ON sets(event_id);
      CREATE INDEX idx_sets_group ON sets(phase_group_id);
      CREATE INDEX idx_sets_state ON sets(event_id, state);

      CREATE TABLE standings (
        event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        entrant_id   TEXT NOT NULL,
        entrant_name TEXT NOT NULL,
        placement    INTEGER NOT NULL,
        is_final     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (event_id, entrant_id)
      );

      CREATE TABLE themes (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        built_in   INTEGER NOT NULL DEFAULT 0,
        tokens_json TEXT NOT NULL,
        custom_css TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE views (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        kind           TEXT NOT NULL,
        secret         TEXT NOT NULL,
        event_id       TEXT,
        phase_group_id TEXT,
        theme_id       TEXT NOT NULL,
        config_json    TEXT NOT NULL,
        camera_json    TEXT NOT NULL,
        autofollow_json TEXT NOT NULL,
        width          INTEGER NOT NULL DEFAULT 1920,
        height         INTEGER NOT NULL DEFAULT 1080,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );

      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL,
        event_scope_json TEXT NOT NULL DEFAULT '[]',
        created_at    INTEGER NOT NULL,
        last_seen_at  INTEGER,
        disabled      INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE sessions (
        token      TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        user_agent TEXT
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);

      CREATE TABLE outbox (
        id             TEXT PRIMARY KEY,
        kind           TEXT NOT NULL,
        event_id       TEXT,
        target_id      TEXT,
        command_json   TEXT NOT NULL,
        status         TEXT NOT NULL,
        attempts       INTEGER NOT NULL DEFAULT 0,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        next_attempt_at INTEGER,
        last_error     TEXT,
        base_version_json TEXT NOT NULL DEFAULT '{}',
        conflict_json  TEXT,
        user_id        TEXT,
        username       TEXT
      );
      CREATE INDEX idx_outbox_status ON outbox(status, next_attempt_at);

      CREATE TABLE audit_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        at         INTEGER NOT NULL,
        user_id    TEXT,
        username   TEXT,
        action     TEXT NOT NULL,
        target     TEXT,
        detail_json TEXT
      );
      CREATE INDEX idx_audit_at ON audit_log(at DESC);

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];

MIGRATIONS.push({
  version: 2,
  name: 'view-phase-targeting',
  up: `
    -- An event's phases have unrelated round numbering, so a bracket view has
    -- to name the phase it renders rather than pooling every set in the event.
    ALTER TABLE views ADD COLUMN phase_id TEXT;
    ALTER TABLE views ADD COLUMN follow_active_phase INTEGER NOT NULL DEFAULT 0;
  `,
});

export function migrate(db: BetterSqlite3.Database): number {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set<number>(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => (row as { version: number }).version),
  );

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  let count = 0;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.up);
      record.run(migration.version, migration.name, Date.now());
    })();
    count += 1;
  }
  return count;
}
