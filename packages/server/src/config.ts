/**
 * Runtime configuration.
 *
 * Resolution order: explicit argument > environment variable > default. The
 * desktop shell passes values directly; the CLI and dev workflow use env vars.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { TransportKind } from './startgg/transport.js';

export interface AppConfig {
  /** Where the SQLite file and any local assets live. */
  dataDir: string;
  databaseFile: string;
  host: string;
  port: number;
  /** Bind beyond localhost so phones and a second stream PC can connect. */
  allowLan: boolean;
  transport: TransportKind;
  /** Only the official endpoint requires this; the site endpoint reads without it. */
  startggToken: string | null;
  /** Extra headers for the site endpoint, e.g. a session cookie for mutations. */
  startggHeaders: Record<string, string>;
  requestsPerMinute: number;
  /** Directory of built web assets to serve; null in dev (Vite serves them). */
  webRoot: string | null;
  sessionTtlMs: number;
  /** Disable the sync loop, e.g. in tests. */
  syncEnabled: boolean;
}

function defaultDataDir(): string {
  const base =
    process.env.BRACKET_DATA_DIR ??
    (process.platform === 'win32'
      ? join(process.env.APPDATA ?? homedir(), 'BracketDashboard')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'BracketDashboard')
        : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'bracket-dashboard'));
  return base;
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = overrides.dataDir ?? defaultDataDir();
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const allowLan = overrides.allowLan ?? bool(process.env.BRACKET_ALLOW_LAN, true);
  const transportEnv = (process.env.STARTGG_TRANSPORT ?? 'web') as TransportKind;

  return {
    dataDir,
    databaseFile: overrides.databaseFile ?? join(dataDir, 'bracket-dashboard.sqlite'),
    host: overrides.host ?? process.env.BRACKET_HOST ?? (allowLan ? '0.0.0.0' : '127.0.0.1'),
    port: overrides.port ?? Number(process.env.BRACKET_PORT ?? 4747),
    allowLan,
    transport: overrides.transport ?? transportEnv,
    startggToken: overrides.startggToken ?? process.env.STARTGG_TOKEN ?? null,
    startggHeaders: overrides.startggHeaders ?? parseHeaders(process.env.STARTGG_HEADERS),
    requestsPerMinute:
      overrides.requestsPerMinute ?? Number(process.env.STARTGG_RPM ?? 45),
    webRoot: overrides.webRoot ?? process.env.BRACKET_WEB_ROOT ?? null,
    sessionTtlMs: overrides.sessionTtlMs ?? 1000 * 60 * 60 * 24 * 14,
    syncEnabled: overrides.syncEnabled ?? bool(process.env.BRACKET_SYNC, true),
  };
}
