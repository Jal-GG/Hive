import { constants } from 'node:os'
import { RuntimeBackend, RuntimeCapability, RuntimeExit, RuntimeHeartbeat, RuntimeStatus } from '../contracts.js'
import { HiveError } from '../errors.js'
import { Clock, ClockOptions, resolveClock } from '../shared.js'
import { buildCommand } from './provider-catalog.js'
import { KillOptions, RuntimeAdapter, RuntimeSession, RuntimeSpawnRequest, Unsubscribe } from './runtime-adapter.js'
import { SessionOutput } from './runtime-session-support.js'
import { killProcessTree, ProcessControl, systemProcessControl } from './process-tree.js'

/**
 * node-pty's surface, declared structurally.
 *
 * Following the same convention as the Electron bridge: the shape is written out
 * here so this module compiles, and is unit-testable, on a machine with no native
 * module built. The real dependency is loaded at spawn time and only then.
 */
export interface NodePtyDisposable {
  dispose(): void
}

export interface NodePtyExitEvent {
  exitCode: number
  signal?: number
}

export interface NodePtyProcess {
  readonly pid: number
  onData(listener: (data: string) => void): NodePtyDisposable
  onExit(listener: (event: NodePtyExitEvent) => void): NodePtyDisposable
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface NodePtySpawnOptions {
  name: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
  /** Windows: use the ConPTY API rather than the winpty shim. */
  useConpty?: boolean
  conptyInheritCursor?: boolean
  windowsHide?: boolean
}

export interface NodePtyModule {
  spawn(file: string, args: string[], options: NodePtySpawnOptions): NodePtyProcess
}

export type NodePtyLoader = () => Promise<NodePtyModule>

const nodePtySpecifier = 'node-pty'
let cachedModule: NodePtyModule | undefined

/**
 * Loaded through a variable specifier so the optional native dependency is not a
 * build-time requirement: hosts that only ever run the fake or tmux backend never
 * need it compiled, and the failure when it is genuinely missing is a clear error
 * rather than a module-resolution crash at import time.
 */
export async function loadNodePty(): Promise<NodePtyModule> {
  if (cachedModule) return cachedModule
  try {
    const loaded = await import(nodePtySpecifier)
    cachedModule = (loaded.default ?? loaded) as NodePtyModule
    return cachedModule
  } catch (error) {
    throw new HiveError('PTY_UNAVAILABLE', `node-pty is not available: ${(error as Error).message}`)
  }
}

export interface NodePtyRuntimeOptions extends ClockOptions {
  loader?: NodePtyLoader
  control?: ProcessControl
  platform?: NodeJS.Platform
  scrollbackBytes?: number
  /** Time a graceful signal is given before the tree is force-killed. */
  graceMs?: number
  terminalName?: string
}

export const defaultGraceMs = 5_000

/** C6: the primary execution abstraction. Every other backend is measured against this behaviour. */
export class NodePtyRuntimeAdapter implements RuntimeAdapter {
  readonly backend: RuntimeBackend = 'node_pty'
  readonly capabilities: readonly RuntimeCapability[] = ['interactive', 'resize', 'heartbeat', 'process_tree_kill']
  private readonly now: Clock
  private readonly loader: NodePtyLoader
  private readonly control: ProcessControl
  private readonly platform: NodeJS.Platform
  private readonly scrollbackBytes?: number
  private readonly graceMs: number
  private readonly terminalName: string

  constructor(options: NodePtyRuntimeOptions = {}) {
    this.now = resolveClock(options)
    this.loader = options.loader ?? loadNodePty
    this.control = options.control ?? systemProcessControl
    this.platform = options.platform ?? this.control.platform
    this.scrollbackBytes = options.scrollbackBytes
    this.graceMs = options.graceMs ?? defaultGraceMs
    this.terminalName = options.terminalName ?? 'xterm-256color'
  }

  async spawn(request: RuntimeSpawnRequest): Promise<RuntimeSession> {
    const pty = await this.loader()
    const command = buildCommand(request.profile, {
      prompt: request.profile.promptDelivery === 'argument' ? request.prompt : undefined,
      model: request.model,
      cwd: request.cwd,
      branch: request.identity.branch,
      runId: request.identity.runId,
    })
    const child = pty.spawn(command.executable, command.args, {
      name: this.terminalName,
      cols: request.cols,
      rows: request.rows,
      cwd: request.cwd,
      env: request.environment,
      useConpty: this.platform === 'win32',
      conptyInheritCursor: false,
      windowsHide: true,
    })
    return new NodePtySession(child, request, {
      now: this.now,
      control: this.control,
      graceMs: this.graceMs,
      scrollbackBytes: this.scrollbackBytes,
    })
  }
}

interface NodePtySessionOptions {
  now: Clock
  control: ProcessControl
  graceMs: number
  scrollbackBytes?: number
}

export class NodePtySession implements RuntimeSession {
  readonly sessionKey: string
  readonly backend: RuntimeBackend = 'node_pty'
  readonly pid: number
  private readonly output: SessionOutput
  private readonly now: Clock
  private readonly control: ProcessControl
  private readonly graceMs: number
  private readonly disposables: NodePtyDisposable[] = []
  private cols: number
  private rows: number

  constructor(private readonly child: NodePtyProcess, request: RuntimeSpawnRequest, options: NodePtySessionOptions) {
    this.sessionKey = request.sessionKey
    this.pid = child.pid
    this.now = options.now
    this.control = options.control
    this.graceMs = options.graceMs
    this.cols = request.cols
    this.rows = request.rows
    this.output = new SessionOutput(this.now().toISOString(), {
      now: this.now,
      readyPattern: request.profile.readyPattern,
      scrollbackBytes: options.scrollbackBytes,
    })
    this.disposables.push(child.onData((data) => this.output.push(data)))
    this.disposables.push(
      child.onExit((event) => {
        this.output.finish(toRuntimeExit(event, this.now))
        for (const disposable of this.disposables.splice(0)) disposable.dispose()
      }),
    )
  }

  ready(timeoutMs?: number): Promise<void> {
    return this.output.waitForReady(timeoutMs)
  }

  write(data: string): void {
    this.assertAlive()
    this.output.countInput(data)
    this.child.write(data)
  }

  resize(cols: number, rows: number): void {
    this.assertAlive()
    if (cols <= 0 || rows <= 0) throw new HiveError('INVALID_TERMINAL_SIZE', `Refusing to resize to ${cols}x${rows}`)
    this.child.resize(cols, rows)
    this.cols = cols
    this.rows = rows
  }

  /**
   * Signals the whole tree, waits out the grace period, then forces. It resolves
   * with the status the child actually reported — never a synthesised one — so a
   * run's recorded exit code is the child's own. When even a forced kill leaves it
   * running, that is surfaced as an error instead of hanging the caller forever;
   * reconciliation then treats the run as a zombie.
   */
  async kill(options: KillOptions = {}): Promise<RuntimeExit> {
    if (this.output.exit) return this.output.exit
    const graceMs = options.graceMs ?? this.graceMs
    killProcessTree(this.pid, options.signal ?? 'SIGTERM', this.control)
    const graceful = await this.settleWithin(graceMs)
    if (graceful) return graceful
    killProcessTree(this.pid, 'SIGKILL', this.control)
    const forced = await this.settleWithin(graceMs)
    if (forced) return forced
    throw new HiveError('RUNTIME_KILL_FAILED', `Process ${this.pid} survived a forced kill`)
  }

  inspect(): RuntimeStatus {
    return {
      sessionKey: this.sessionKey,
      backend: this.backend,
      pid: this.pid,
      alive: this.output.exit === undefined,
      ready: this.output.ready,
      cols: this.cols,
      rows: this.rows,
      bytesOut: this.output.bytesOut,
      bytesIn: this.output.bytesIn,
      lastOutputAt: this.output.lastOutputAt,
      exit: this.output.exit,
    }
  }

  heartbeat(): RuntimeHeartbeat {
    return {
      sessionKey: this.sessionKey,
      observedAt: this.now().toISOString(),
      // Checked against the operating system rather than inferred from silence: a
      // quiet agent is still working, while a vanished one must not look alive.
      alive: this.output.exit === undefined,
      idleMs: this.output.idleMs(),
    }
  }

  onData(listener: (chunk: string) => void): Unsubscribe {
    return this.output.onData(listener)
  }

  onExit(listener: (exit: RuntimeExit) => void): Unsubscribe {
    return this.output.onExit(listener)
  }

  exited(): Promise<RuntimeExit> {
    return this.output.waitForExit()
  }

  scrollback(): string {
    return this.output.scrollback()
  }

  private settleWithin(ms: number): Promise<RuntimeExit | undefined> {
    if (this.output.exit) return Promise.resolve(this.output.exit)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), ms)
      timer.unref()
      void this.output.waitForExit().then((exit) => {
        clearTimeout(timer)
        resolve(exit)
      })
    })
  }

  private assertAlive(): void {
    if (this.output.exit) throw new HiveError('RUNTIME_EXITED', `Session ${this.sessionKey} has already exited`)
  }
}

/**
 * A signalled child reports the signal alone. Its numeric code in that case is an
 * artefact of the platform (often 0), and recording a zero next to SIGKILL would
 * read as a clean finish in every roster and merge gate downstream.
 */
export function toRuntimeExit(event: NodePtyExitEvent, now: Clock): RuntimeExit {
  const exitedAt = now().toISOString()
  if (event.signal !== undefined && event.signal !== 0) return { signal: signalName(event.signal), exitedAt }
  return { code: event.exitCode, exitedAt }
}

export function signalName(signal: number): string {
  for (const [name, value] of Object.entries(constants.signals)) {
    if (value === signal) return name
  }
  return `SIG${signal}`
}
