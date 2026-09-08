#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * `npx bracket-dashboard` for anyone who would rather run this from a terminal
 * or on a venue mini-PC than install the desktop app.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../app.js';
import { loadConfig, type AppConfig } from '../config.js';
import { createServices } from '../services.js';

function parseArgs(argv: string[]): Partial<AppConfig> {
  const out: Partial<AppConfig> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--port':
        out.port = Number(next());
        break;
      case '--host':
        out.host = next();
        break;
      case '--data-dir':
        out.dataDir = next();
        break;
      case '--localhost-only':
        out.allowLan = false;
        out.host = '127.0.0.1';
        break;
      case '--mock':
        out.transport = 'mock';
        break;
      case '--token':
        out.startggToken = next() ?? null;
        out.transport = 'official';
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`
Bracket Dashboard — local tournament bracket dashboard and OBS overlay server

Usage: bracket-dashboard [options]

  --port <n>          Port to listen on (default 4747)
  --host <addr>       Address to bind (default 0.0.0.0, or 127.0.0.1 with --localhost-only)
  --data-dir <path>   Where the database lives
  --localhost-only    Do not accept connections from other devices on the network
  --mock              Run against a simulated tournament instead of start.gg
  --token <token>     Use the documented start.gg API endpoint with this token
  -h, --help          Show this message
`);
}

/** Locates the built web assets relative to the installed server package. */
function findWebRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.BRACKET_WEB_ROOT,
    resolve(here, '../../../web/dist'),
    resolve(here, '../../../../web/dist'),
    join(process.cwd(), 'packages/web/dist'),
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

async function main(): Promise<void> {
  const overrides = parseArgs(process.argv.slice(2));
  const config = loadConfig({ webRoot: findWebRoot(), ...overrides });
  const services = createServices(config);
  const server = await startServer(services, config);

  console.log('');
  console.log('  Bracket Dashboard is running');
  console.log(`  Local:    ${server.url}`);
  for (const lan of server.lanUrls) {
    console.log(`  Network:  ${lan}`);
  }
  if (config.transport === 'mock') {
    console.log('  Mode:     MOCK — using a simulated tournament, not start.gg');
  }
  if (server.lanUrls.length > 0) {
    console.log('');
    console.log('  Reachable by other devices on this network. Anyone who can reach');
    console.log('  these addresses can attempt to sign in. Use --localhost-only to');
    console.log('  restrict access to this machine.');
  }
  if (server.credentials) {
    console.log('');
    console.log('  First run — an admin account was created:');
    console.log(`    username: ${server.credentials.username}`);
    console.log(`    password: ${server.credentials.password}`);
    console.log('  This password is not stored and will not be shown again.');
  }
  console.log('');

  const shutdown = async () => {
    console.log('\nShutting down...');
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  console.error('Failed to start Bracket Dashboard:', error);
  process.exit(1);
});
