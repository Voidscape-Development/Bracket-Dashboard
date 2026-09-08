/**
 * Electron shell.
 *
 * Boots the backend in the main process — no sidecar, no port juggling — and
 * points a window at it. The same server binary also runs headless from the CLI,
 * so the desktop app is a convenience wrapper rather than a separate product.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServices, loadConfig, localAddresses, startServer } from '@bracket/server';
import type { StartedServer } from '@bracket/server';
import { BrowserWindow, Menu, app, clipboard, dialog, shell } from 'electron';

const here = dirname(fileURLToPath(import.meta.url));

let server: StartedServer | null = null;
let mainWindow: BrowserWindow | null = null;

/** Built web assets, whether running from source or from a packaged app. */
function findWebRoot(): string | null {
  const candidates = [
    process.env.BRACKET_WEB_ROOT,
    resolve(here, '../../web/dist'),
    // Packaged builds carry the web bundle as an extra resource beside the asar.
    resolve(process.resourcesPath ?? '', 'web'),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

async function boot(): Promise<void> {
  const config = loadConfig({
    // Electron's userData keeps the database beside the app's own state.
    dataDir: app.getPath('userData'),
    webRoot: findWebRoot(),
  });

  const services = createServices(config);
  server = await startServer(services, config);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    title: 'Bracket Dashboard',
    webPreferences: {
      // The window only ever loads our own local server; no bridge is needed and
      // nothing from the renderer should reach Node.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // External links (start.gg, docs) belong in the user's browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(server.url);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  buildMenu(server);

  // The generated admin password only exists in memory for this one moment.
  if (server.credentials) {
    const lan = server.lanUrls.length > 0 ? `\n\nOn this network: ${server.lanUrls.join(', ')}` : '';
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'First run',
      message: 'An admin account was created',
      detail:
        `Username: ${server.credentials.username}\n` +
        `Password: ${server.credentials.password}\n\n` +
        'This password is not stored and will not be shown again. ' +
        'Write it down or change it in Settings.' +
        lan,
      buttons: ['Copy password', 'OK'],
      defaultId: 1,
    }).then((result) => {
      if (result.response === 0 && server?.credentials) {
        clipboard.writeText(server.credentials.password);
      }
    });
  }
}

function buildMenu(started: StartedServer): void {
  const addresses = localAddresses();

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [
          {
            label: 'Open in browser',
            click: () => void shell.openExternal(started.url),
          },
          {
            label: 'Copy network address',
            enabled: addresses.length > 0,
            click: () => {
              clipboard.writeText(`http://${addresses[0]}:${started.services.config.port}`);
            },
          },
          { type: 'separator' },
          {
            label: 'Open data folder',
            click: () => void shell.openPath(started.services.config.dataDir),
          },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Where do I find this on the network?',
            click: () => {
              void dialog.showMessageBox({
                type: 'info',
                title: 'Network access',
                message: 'Reachable at these addresses',
                detail:
                  addresses.length > 0
                    ? addresses
                        .map((a) => `http://${a}:${started.services.config.port}`)
                        .join('\n') +
                      '\n\nUse these for OBS on another PC, scorekeepers on phones, ' +
                      'or a venue TV. Anyone who can reach these addresses can attempt ' +
                      'to sign in.'
                    : 'This machine only. Network access is disabled.',
              });
            },
          },
        ],
      },
    ]),
  );
}

app.whenReady().then(
  () => void boot(),
  (error) => {
    dialog.showErrorBox('Bracket Dashboard failed to start', String(error));
    app.quit();
  },
);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && server) {
    void boot();
  }
});

app.on('before-quit', () => {
  // Flush the queue's state and close the database cleanly.
  void server?.stop();
});
