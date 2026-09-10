import { join } from 'node:path'
import { ActorContext, Capability, ScopeRef } from '../../contracts.js'
import { ContextBrowser } from '../../context/browser.js'
import { ContextFilesystem } from '../../context/context-filesystem.js'
import { Ledger } from '../../ledger.js'
import { createRuntimeHost, RuntimeHost } from '../../runtime/runtime-host.js'
import { HandoffService } from '../../work/handoffs.js'
import { MailService } from '../../work/mail.js'
import { runManagerMailInterrupt } from '../../work/mail-interrupts.js'
import { PacketCompiler } from '../../work/packet.js'
import { WorkBoard } from '../../work/board.js'
import {
  registerContextIpc,
  IpcRegistrar as ContextIpcRegistrar,
} from './context-ipc.js'
import { RuntimeIpcRegistrar, WebContentsSender } from './runtime-channels.js'
import { registerRuntimeIpc, RuntimeStreamBridge } from './runtime-ipc.js'
import { registerWorkIpc } from './work-ipc.js'

/**
 * What the desktop main process needs before it can show anything: a repo to run
 * agents in, a ledger file to persist runs under, and where to put worktrees.
 *
 * `hostEnv` is injected rather than read from `process.env` inside, so a test (or
 * a second process) can state exactly what the operator's machine contributes.
 */
export interface DesktopHostOptions {
  repoRoot: string
  ledgerFile?: string
  worktreeRoot?: string
  runtimeDir?: string
  /** Root of the Git-backed context store; defaults to `<repoRoot>/.hive/context`. */
  contextRoot?: string
  hostEnv?: Record<string, string | undefined>
}

/**
 * The desktop operator's authority: every capability, because the main process is
 * the surface an operator sits behind (C16). A stricter desktop deployment passes
 * its own actor to `DesktopHost.start()`; this default is the single-operator
 * install the plan describes.
 */
export const desktopOperatorCapabilities: readonly Capability[] = [
  'workspace:read',
  'workspace:write',
  'work:dispatch',
  'work:mutate',
  'runtime:control',
  'merge:execute',
  'merge:approve',
  'context:read',
  'context:write',
  'event:ingest',
  'backup:create',
  'runtime:read',
]

export function desktopOperator(actorId = 'desktop-operator'): ActorContext {
  return {
    actorId,
    actorType: 'operator',
    displayName: 'Desktop Operator',
    source: 'desktop',
    capabilities: [...desktopOperatorCapabilities],
  }
}

/** Everything a desktop main process assembled from a `DesktopHostOptions`. */
export interface DesktopHost {
  host: RuntimeHost
  actor: ActorContext
  stream: RuntimeStreamBridge
  /** Read-only context browsing, the same surface the CLI, MCP, and HTTP expose (C4). */
  context: ContextBrowser
  /** The work plane's default scope: where the desktop's task board lives. */
  workScope: ScopeRef
  /** Registers every IPC channel on the provided registrar; returns the full channel list. */
  registerIpc(registrar: RuntimeIpcRegistrar & ContextIpcRegistrar): string[]
  /** Re-adopts or retires whatever the last desktop session left behind. */
  recover(): Promise<void>
  /** Detaches from live sessions without ending them, for app quit. */
  close(): void
}

/**
 * Assembles the runtime plane for the desktop, once, the same way every time.
 *
 * This is the Electron main process's whole job regarding the runtime: build this,
 * register its channels on `ipcMain`, and hand the stream to the window. The
 * assembly — ledger, catalog, registry, worktrees, recovery — lives here rather
 * than in a main-process entry so it is exercisable from a plain Node test with
 * no display, no Electron, and no window lifecycle in the way.
 */
export function startDesktopHost(options: DesktopHostOptions, actor: ActorContext = desktopOperator()): DesktopHost {
  const ledger = new Ledger(options.ledgerFile ?? ':memory:')
  const workScope = ensureDefaultScope(ledger, 'main', 'hive')
  const host = createRuntimeHost({
    ledger,
    repoRoot: options.repoRoot,
    worktreeRoot: options.worktreeRoot,
    runtimeDir: options.runtimeDir,
    host: options.hostEnv,
  })
  const filesystem = new ContextFilesystem(options.contextRoot ?? join(options.repoRoot, '.hive', 'context'), ledger)
  const context = new ContextBrowser(filesystem, ledger)
  const stream = new RuntimeStreamBridge({ manager: host.manager, browser: host.browser, actor })
  const board = new WorkBoard(ledger)
  // Interrupt mail is wired straight into the live sessions the same host runs:
  // a message to an agent reaches that agent's terminal without a polling hop.
  const mail = new MailService(ledger, { interrupt: runManagerMailInterrupt(host.manager, actor) })
  const handoffs = new HandoffService(ledger)
  const packets = new PacketCompiler({ ledger, board, mail, handoffs, filesystem })

  return {
    host,
    actor,
    stream,
    context,
    workScope,
    registerIpc: (registrar) => [
      ...registerRuntimeIpc(registrar, { browser: host.browser, controller: host.controller }, actor),
      ...registerContextIpc(registrar, context, actor),
      ...registerWorkIpc(registrar, { scope: workScope, board, mail, handoffs, packets, ledger }, actor),
      ...stream.registerControl(registrar),
    ],
    recover: () => host.recover(actor),
    close: () => {
      stream.stop()
      host.close()
      ledger.close()
    },
  }
}

/** Idempotent default scope so the roster has something to resolve on first launch; returns the scope either way. */
function ensureDefaultScope(ledger: Ledger, workspaceName: string, projectName: string): ScopeRef {
  try {
    return ledger.resolveScope(workspaceName, projectName)
  } catch {
    ledger.createActor(desktopOperator())
    const workspaceId = ledger.createWorkspace(workspaceName)
    const projectId = ledger.createProject(workspaceId, projectName)
    return { workspaceId, projectId, workspaceName, projectName }
  }
}
