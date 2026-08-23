import { RuntimeBackend, RuntimeCapability, RuntimeExit, RuntimeHeartbeat, RuntimeStatus } from '../contracts.js'
import { HiveError } from '../errors.js'
import { Clock, ClockOptions, resolveClock } from '../shared.js'
import { KillOptions, RuntimeAdapter, RuntimeSession, RuntimeSpawnRequest, Unsubscribe } from './runtime-adapter.js'
import { buildCommand } from './provider-catalog.js'
import { SessionOutput } from './runtime-session-support.js'

/**
 * Sessions keyed by session key, outliving any single adapter instance.
 *
 * This is what makes the fake backend able to stand in for a persistent one: a
 * test can throw away the manager, the adapter, and the ledger connection, build
 * them again, and re-adopt exactly what a real tmux server would still be
 * running. Restart recovery is then exercised for real rather than mocked.
 */
export const fakeSessionStore = new Map<string, FakeSession>()

export function resetFakeSessions(): void {
  for (const session of fakeSessionStore.values()) session.forget()
  fakeSessionStore.clear()
}

export interface FakeRuntimeOptions extends ClockOptions {
  /** Declares `persistent_session` and enables `adopt`, standing in for tmux. */
  persistent?: boolean
  store?: Map<string, FakeSession>
  scrollbackBytes?: number
}

const fakeCapabilities: RuntimeCapability[] = ['interactive', 'resize', 'heartbeat', 'process_tree_kill']

/**
 * A provider that runs no external binary at all.
 *
 * Everything it does is a direct consequence of a call — no timers, no polling,
 * no wall-clock waits — so a launch either has produced its output by the time
 * `spawn` resolves or never will. That determinism is the point: the entire
 * launch path can be asserted without a real CLI installed and without a test
 * ever sleeping.
 *
 * Input is interpreted as a tiny control language so tests can drive outcomes
 * they otherwise could not reach: `!exit <code>`, `!signal <name>`,
 * `!emit <text>`, and `!quiet`. Anything else is echoed.
 */
export class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly backend: RuntimeBackend = 'fake'
  readonly capabilities: readonly RuntimeCapability[]
  private readonly now: Clock
  private readonly store: Map<string, FakeSession>
  private readonly scrollbackBytes?: number

  constructor(options: FakeRuntimeOptions = {}) {
    this.now = resolveClock(options)
    this.store = options.store ?? fakeSessionStore
    this.scrollbackBytes = options.scrollbackBytes
    this.capabilities = options.persistent ? [...fakeCapabilities, 'persistent_session'] : fakeCapabilities
  }

  async spawn(request: RuntimeSpawnRequest): Promise<RuntimeSession> {
    const existing = this.store.get(request.sessionKey)
    if (existing && existing.inspect().alive) {
      throw new HiveError('SESSION_EXISTS', `A session named ${request.sessionKey} is already running`)
    }
    const session = new FakeSession(request, { now: this.now, scrollbackBytes: this.scrollbackBytes, store: this.store })
    this.store.set(request.sessionKey, session)
    session.emitBanner()
    return session
  }

  async adopt(sessionKey: string): Promise<RuntimeSession | undefined> {
    if (!this.capabilities.includes('persistent_session')) return undefined
    const session = this.store.get(sessionKey)
    if (!session || !session.inspect().alive) return undefined
    return session
  }
}

interface FakeSessionOptions {
  now: Clock
  store: Map<string, FakeSession>
  scrollbackBytes?: number
}

export class FakeSession implements RuntimeSession {
  readonly sessionKey: string
  readonly backend: RuntimeBackend = 'fake'
  readonly pid: number
  private readonly output: SessionOutput
  private readonly now: Clock
  private readonly store: Map<string, FakeSession>
  private readonly request: RuntimeSpawnRequest
  private pendingInput = ''
  private cols: number
  private rows: number

  constructor(request: RuntimeSpawnRequest, options: FakeSessionOptions) {
    this.request = request
    this.sessionKey = request.sessionKey
    this.now = options.now
    this.store = options.store
    this.cols = request.cols
    this.rows = request.rows
    // Derived from the session key rather than allocated, so it survives re-adoption unchanged.
    this.pid = derivePid(request.sessionKey)
    this.output = new SessionOutput(this.now().toISOString(), {
      now: this.now,
      readyPattern: request.profile.readyPattern,
      scrollbackBytes: options.scrollbackBytes,
    })
  }

  /** Echoes the resolved command and identity, then the profile's ready marker. */
  emitBanner(): void {
    const command = buildCommand(this.request.profile, {
      prompt: this.request.profile.promptDelivery === 'argument' ? this.request.prompt : undefined,
      model: this.request.model,
      cwd: this.request.cwd,
      branch: this.request.identity.branch,
      runId: this.request.identity.runId,
    })
    this.output.push(`${command.executable} ${command.args.join(' ')}\r\n`)
    this.output.push(`cwd=${this.request.cwd} run=${this.request.identity.runId} branch=${this.request.identity.branch}\r\n`)
    this.output.push(`size=${this.cols}x${this.rows}\r\n`)
    this.output.push('HIVE_FAKE_READY\r\n')
  }

  ready(timeoutMs?: number): Promise<void> {
    return this.output.waitForReady(timeoutMs)
  }

  write(data: string): void {
    this.assertAlive()
    this.output.countInput(data)
    this.pendingInput += data
    let newline = this.pendingInput.indexOf('\n')
    while (newline >= 0) {
      const line = this.pendingInput.slice(0, newline).replace(/\r$/, '')
      this.pendingInput = this.pendingInput.slice(newline + 1)
      this.interpret(line)
      if (this.output.exit) return
      newline = this.pendingInput.indexOf('\n')
    }
  }

  resize(cols: number, rows: number): void {
    this.assertAlive()
    this.cols = cols
    this.rows = rows
    this.output.push(`size=${cols}x${rows}\r\n`)
  }

  async kill(options: KillOptions = {}): Promise<RuntimeExit> {
    if (this.output.exit) return this.output.exit
    // A killed process reports the signal that ended it, never a fabricated code.
    return this.settle({ signal: options.signal ?? 'SIGTERM', exitedAt: this.now().toISOString() })
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

  /** Drops the store entry without settling, standing in for a session lost with its host. */
  forget(): void {
    this.store.delete(this.sessionKey)
  }

  private interpret(line: string): void {
    const exitMatch = /^!exit(?:\s+(-?\d+))?$/.exec(line)
    if (exitMatch) {
      this.settle({ code: exitMatch[1] === undefined ? 0 : Number(exitMatch[1]), exitedAt: this.now().toISOString() })
      return
    }
    const signalMatch = /^!signal\s+([A-Za-z0-9]+)$/.exec(line)
    if (signalMatch) {
      this.settle({ signal: signalMatch[1].toUpperCase(), exitedAt: this.now().toISOString() })
      return
    }
    const emitMatch = /^!emit\s?(.*)$/.exec(line)
    if (emitMatch) {
      this.output.push(`${emitMatch[1]}\r\n`)
      return
    }
    // Produces nothing at all, so `idleMs` keeps growing and idle detection can be asserted.
    if (line === '!quiet') return
    this.output.push(`echo: ${line}\r\n`)
  }

  private settle(exit: RuntimeExit): RuntimeExit {
    this.output.push(`exit ${exit.code ?? exit.signal ?? 'unknown'}\r\n`)
    this.output.finish(exit)
    this.store.delete(this.sessionKey)
    return exit
  }

  private assertAlive(): void {
    if (this.output.exit) throw new HiveError('RUNTIME_EXITED', `Session ${this.sessionKey} has already exited`)
  }
}

function derivePid(sessionKey: string): number {
  let hash = 0
  for (const character of sessionKey) hash = (hash * 31 + character.charCodeAt(0)) % 30_000
  return hash + 1_000
}
