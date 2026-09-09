import { app, BrowserWindow, ipcMain } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

/**
 * Smoke mode: `HIVE_SMOKE=1 electron .` boots this exact production entry
 * against a throwaway fixture repository, drives the renderer over the real
 * preload, and exits with the verdict. It is how the Phase 3 gate is checked
 * without a human at the window.
 */
const smoke = process.env.HIVE_SMOKE === '1'

function fixtureRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'hive-smoke-repo-'))
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git(['init', '--quiet', '--initial-branch=main'])
  writeFileSync(join(root, 'README.md'), '# smoke\n', 'utf8')
  git(['add', '--all'])
  git(['-c', 'user.name=Hive', '-c', 'user.email=hive@localhost', 'commit', '--quiet', '-m', 'initial'])
  return root
}

const repoRoot = smoke ? fixtureRepository() : (process.env.HIVE_REPO_ROOT ?? process.cwd())
const userData = smoke ? mkdtempSync(join(tmpdir(), 'hive-smoke-data-')) : app.getPath('userData')
if (!existsSync(userData)) mkdirSync(userData, { recursive: true })

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
    show: !smoke,
    title: 'Hive',
    webPreferences: {
      // .cjs to match the bundled extension; a mismatch here loads nothing and
      // silently yields a window with no bridge.
      preload: join(__dirname, 'preload.cjs'),
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
  if (smoke) {
    try {
      const steps: string[] = []
      const page = window!.webContents
      const hasBridge = await page.executeJavaScript('typeof window.hive === "object" && typeof window.hive.runtime.invoke === "function"')
      if (!hasBridge) throw new Error('window.hive is not exposed by the preload')
      steps.push('preload bridge exposed')

      const profiles = (await page.executeJavaScript('window.hive.runtime.invoke("profiles")')) as { ok: boolean; data?: { id: string }[] }
      if (!profiles?.ok) throw new Error(`profiles invoke failed: ${JSON.stringify(profiles)}`)
      if (!profiles.data?.some((profile) => profile.id === 'fake')) throw new Error('fake profile missing from catalog')
      steps.push('profiles browsed over IPC')

      const launched = (await page.executeJavaScript('window.hive.runtime.invoke("launch", { profileId: "fake", workspace: "main", project: "hive" })')) as { ok: boolean; data?: { id: string; state: string } }
      if (!launched?.ok) throw new Error(`launch failed: ${JSON.stringify(launched)}`)
      if (launched.data?.state !== 'running') throw new Error(`launched run is ${launched.data?.state}, expected running`)
      steps.push('fake run launched over IPC')

      const stopped = (await page.executeJavaScript(`window.hive.runtime.invoke("stop", { runId: ${JSON.stringify(launched.data!.id)} })`)) as { ok: boolean; data?: { run: { state: string } } }
      if (!stopped?.ok) throw new Error(`stop failed: ${JSON.stringify(stopped)}`)
      if (stopped.data?.run.state !== 'done') throw new Error(`stopped run is ${stopped.data?.run.state}, expected done`)
      steps.push('run stopped with real exit status')

      const created = (await page.executeJavaScript('window.hive.work.invoke("create", { title: "smoke task" })')) as { ok: boolean; data?: { id: string; status: string } }
      if (!created?.ok) throw new Error(`work create failed: ${JSON.stringify(created)}`)
      if (created.data?.status !== 'open') throw new Error(`created task is ${created.data?.status}, expected open`)
      const items = (await page.executeJavaScript('window.hive.work.invoke("items")')) as { ok: boolean; data?: { id: string }[] }
      if (!items?.ok || !items.data?.some((item) => item.id === created.data!.id)) throw new Error('created task missing from the board')
      const claimed = (await page.executeJavaScript(`window.hive.work.invoke("claim", { workItemId: ${JSON.stringify(created.data!.id)} })`)) as { ok: boolean; data?: { item: { status: string } } }
      if (!claimed?.ok || claimed.data?.item.status !== 'assigned') throw new Error(`work claim failed: ${JSON.stringify(claimed)}`)
      steps.push('task created, listed, and claimed over IPC')

      console.log(`SMOKE OK: ${steps.join('; ')}`)
      desktop.close()
      app.exit(0)
    } catch (error) {
      console.error(`SMOKE FAIL: ${error instanceof Error ? error.message : String(error)}`)
      desktop.close()
      app.exit(1)
    }
    return
  }
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
