import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { startDesktopHost } from '../src/interfaces/desktop/desktop-host.js'

/**
 * The Electron main process, kept deliberately thin.
 *
 * Everything with logic in it lives in `src/interfaces/desktop/desktop-host.ts`,
 * which is plain Node and tested without a display. This file owns only what
 * Electron itself owns: the app lifecycle, one window, and handing the window's
 * webContents to the stream bridge.
 */

// Single-instance lock: two desktops over one ledger would be two writers to
// something designed for one (C19), so the second launch bows out.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

const repoRoot = process.env.HIVE_REPO_ROOT ?? process.cwd()
const userData = app.getPath('userData')
for (const directory of [userData]) {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
}

const desktop = startDesktopHost({
  repoRoot,
  ledgerFile: join(userData, 'hive.db'),
  hostEnv: process.env as Record<string, string | undefined>,
})
desktop.registerIpc(ipcMain)

let window: BrowserWindow | undefined

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Hive',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  window.on('closed', () => {
    window = undefined
  })

  if (process.env.HIVE_DEV_SERVER_URL) {
    await window.loadURL(process.env.HIVE_DEV_SERVER_URL)
  } else {
    await window.loadFile(join(__dirname, 'renderer', 'index.html'))
  }
}

app.whenReady().then(async () => {
  // Recovery before the window opens: the roster the operator first sees is
  // already the reconciled truth, not a pre-restart snapshot.
  await desktop.recover()
  await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // Detach, not kill: a persistent backend's sessions are meant to outlive the app.
  desktop.close()
})
