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
      // Renderer errors are smoke failures: a window that loads its bridge but
      // fails its own scripts is a white screen wearing a green test.
      const rendererErrors: string[] = []
      page.on('console-message', (_event, level, message) => {
        if (level >= 3) rendererErrors.push(message)
      })
      page.on('did-fail-load', (_event, code, description, url) => rendererErrors.push(`did-fail-load ${code} ${description} ${url}`))

      const hasBridge = await page.executeJavaScript('typeof window.hive === "object" && typeof window.hive.runtime.invoke === "function"')
      if (!hasBridge) throw new Error('window.hive is not exposed by the preload')
      steps.push('preload bridge exposed')

      // The visual check: a rendered root, a dark body, and no dead scripts.
      const visuals = (await page.executeJavaScript(`(() => {
        const scripts = [...document.querySelectorAll('script')]
        return {
          rootChildren: document.getElementById('root')?.childElementCount ?? -1,
          bodyBackground: getComputedStyle(document.body).backgroundColor,
          scripts: scripts.map((script) => ({ src: script.getAttribute('src'), type: script.getAttribute('type') })),
          links: [...document.querySelectorAll('link')].map((link) => link.getAttribute('href')),
        }
      })()`)) as { rootChildren: number; bodyBackground: string; scripts: Array<{ src: string | null; type: string | null }>; links: Array<string | null> }
      console.log(`[renderer state] ${JSON.stringify(visuals, null, 2)}`)
      if (visuals.rootChildren < 1) throw new Error(`renderer did not mount: root has ${visuals.rootChildren} children; body is ${visuals.bodyBackground}`)
      steps.push('renderer mounted with theme applied')
      if (rendererErrors.length > 0) throw new Error(`renderer console errors: ${rendererErrors.join(' | ')}`)

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

      const fleet = (await page.executeJavaScript('window.hive.work.invoke("agents")')) as { ok: boolean; data?: unknown[] }
      if (!fleet?.ok || !Array.isArray(fleet.data)) throw new Error(`fleet browse failed: ${JSON.stringify(fleet)}`)
      steps.push('fleet browsed over IPC')

      // The Phase 8 control plane, driven the way the renderer drives it.
      const registered = (await page.executeJavaScript(
        'window.hive.control.invoke("register", { definition: { id: "smoke-flow", version: "1.0.0", name: "Smoke", description: "smoke", enabled: true, steps: [{ id: "one", type: "create_work", title: "Smoke work" }] } })',
      )) as { ok: boolean }
      if (!registered?.ok) throw new Error(`control register failed: ${JSON.stringify(registered)}`)
      const triggered = (await page.executeJavaScript('window.hive.control.invoke("trigger", { id: "smoke:1", workflowId: "smoke-flow" })')) as { ok: boolean; data?: { run?: { state: string } } }
      if (!triggered?.ok) throw new Error(`control trigger failed: ${JSON.stringify(triggered)}`)
      if (triggered.data?.run?.state !== 'completed') throw new Error(`workflow run is ${triggered.data?.run?.state}, expected completed`)
      steps.push('workflow registered and triggered over the control channels')

      // Bring the ingress panel in front, so the renderer's own control reads run
      // and any bridge mistake shows up in the error check below. A panel that is
      // never opened is a panel that is never verified.
      const openedIngress = (await page.executeJavaScript(
        `(() => {
          const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === 'Ingress')
          if (!button) return false
          button.click()
          return true
        })()`,
      )) as boolean
      if (!openedIngress) throw new Error('the Ingress tab is not present in the sidebar')
      steps.push('ingress panel opened')

      // The office visualization (§7 Phase 8): a UI-only projection, so its smoke
      // check is that it renders and contains no control that reaches the bridge —
      // presence and read-only-ness, exactly what the plan gates on.
      const openedOffice = (await page.executeJavaScript(
        `(() => {
          const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === 'Office')
          if (!button) return false
          button.click()
          return true
        })()`,
      )) as boolean
      if (!openedOffice) throw new Error('the Office tab is not present in the sidebar')
      steps.push('office view opened')

      // The renderer's own view model runs on its own schedule, so the raw
      // invokes above cannot prove the UI is healthy. Wait for it to settle and
      // fail on a bridge error rendered into the page: that is exactly how a
      // doubled channel (`hive:runtime:hive:runtime:runs`) reached an operator
      // as UNKNOWN_CHANNEL while every step above still passed.
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const renderedText = (await page.executeJavaScript('document.body.innerText')) as string
      const surfaced = renderedText.split('\n').filter((line) => /UNKNOWN_CHANNEL|INTERNAL_ERROR|SCOPE_NOT_FOUND/.test(line))
      if (surfaced.length > 0) throw new Error(`renderer surfaced a bridge error: ${surfaced.join(' | ')}`)
      steps.push('no bridge error rendered in the UI')

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
