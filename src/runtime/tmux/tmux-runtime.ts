import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RuntimeBackend, RuntimeCapability, RuntimeExit, RuntimeHeartbeat, RuntimeStatus } from '../../contracts.js'
import { HiveError } from '../../errors.js'
import { Clock, ClockOptions, resolveClock } from '../../shared/clock.js'
import { ensureParentDirectory } from '../../shared/fs.js'
import { buildCommand } from '../provider-catalog.js'
import { KillOptions, RuntimeAdapter, RuntimeSession, RuntimeSpawnRequest, Unsubscribe } from '../runtime-adapter.js'
import { SessionOutput } from '../runtime-session-support.js'
import { signalName } from '../pty/node-pty-runtime.js'

/** Injected so command construction can be asserted without a tmux server. */
export interface TmuxCommandRunner {
  run(args: string[]): string
  /** False when tmux exits non-zero, which is how `has-session` answers "no". */
  probe(args: string[]): boolean
}

export function systemTmuxRunner(binary = 'tmux'): TmuxCommandRunner {
  return {
    run: (args) => execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim(),
    probe: (args) => {
      try {
        execFileSync(binary, args, { stdio: ['ignore', 'ignore', 'ignore'] })
        return true
      } catch {
        return false
      }
    },
  }
}

export interface TmuxRuntimeOptions extends ClockOptions {
  /** Where per-session output logs and exit-status files live. */
  runtimeDir: string
  runner?: TmuxCommandRunner
  scrollbackBytes?: number
  /** How often the log and session liveness are sampled; tests call `pump` instead. */
  pollMs?: number
  shell?: string
}

/**
 * The optional Unix backend (C6). It exists for one reason the primary backend
 * cannot offer: the session belongs to the tmux server, not to Hive, so an
 * operator can attach to a run from a plain terminal and a Hive restart re-adopts
 * live agents instead of orphaning them.
 *
 * Everything else about it is deliberately unremarkable — it answers the same
 * interface, so supervision, recovery, and the desktop terminal cannot tell the
 * two apart.
 */
export class TmuxRuntimeAdapter implements RuntimeAdapter {
  readonly backend: RuntimeBackend = 'tmux'
  readonly capabilities: readonly RuntimeCapability[] = ['interactive', 'resize', 'heartbeat', 'process_tree_kill', 'persistent_session']
  private readonly now: Clock
  private readonly runner: TmuxCommandRunner
  private readonly runtimeDir: string
  private readonly scrollbackBytes?: number
  private readonly pollMs: number
  private readonly shell: string

  constructor(options: TmuxRuntimeOptions) {
    this.now = resolveClock(options)
    this.runner = options.runner ?? systemTmuxRunner()
    this.runtimeDir = options.runtimeDir
    this.scrollbackBytes = options.scrollbackBytes
    this.pollMs = options.pollMs ?? 250
    this.shell = options.shell ?? 'sh'
  }

  async spawn(request: RuntimeSpawnRequest): Promise<RuntimeSession> {
    this.assertAvailable()
    if (this.runner.probe(['has-session', '-t', request.sessionKey])) {
      throw new HiveError('SESSION_EXISTS', `A tmux session named ${request.sessionKey} is already running`)
    }
    const paths = sessionPaths(this.runtimeDir, request.sessionKey)
    ensureParentDirectory(paths.log)
    // Truncated up front so an adopted session never replays a previous run's output.
    writeFileSync(paths.log, '')
    if (existsSync(paths.status)) writeFileSync(paths.status, '')

    const command = buildCommand(request.profile, {
      prompt: request.profile.promptDelivery === 'argument' ? request.prompt : undefined,
      model: request.model,
      cwd: request.cwd,
      branch: request.identity.branch,
      runId: request.identity.runId,
    })
    const argv = ['new-session', '-d', '-s', request.sessionKey, '-x', String(request.cols), '-y', String(request.rows), '-c', request.cwd]
    for (const [name, value] of Object.entries({ ...request.environment, [statusVariable]: paths.status })) {
      argv.push('-e', `${name}=${value}`)
    }
    // The wrapper exists purely to keep the child's exit status: tmux discards it
    // when the pane closes, and a run whose result is "the pane is gone" cannot be
    // told apart from a clean finish.
    argv.push('--', this.shell, '-c', statusWrapper, 'hive-run', command.executable, ...command.args)
    this.runner.run(argv)

    const session = new TmuxSession(request.sessionKey, {
      now: this.now,
      runner: this.runner,
      paths,
      readyPattern: request.profile.readyPattern,
      scrollbackBytes: this.scrollbackBytes,
      pollMs: this.pollMs,
      cols: request.cols,
      rows: request.rows,
    })
    session.startPipe()
    return session
  }

  async adopt(sessionKey: string): Promise<RuntimeSession | undefined> {
    this.assertAvailable()
    if (!this.runner.probe(['has-session', '-t', sessionKey])) return undefined
    const paths = sessionPaths(this.runtimeDir, sessionKey)
    const session = new TmuxSession(sessionKey, {
      now: this.now,
      runner: this.runner,
      paths,
      // A readopted session has already printed whatever marked it ready; waiting
      // for the pattern again would block on output that will never come twice.
      scrollbackBytes: this.scrollbackBytes,
      pollMs: this.pollMs,
      cols: readNumber(this.runner, sessionKey, 'window_width', 80),
      rows: readNumber(this.runner, sessionKey, 'window_height', 24),
    })
    session.startPipe()
    return session
  }

  private assertAvailable(): void {
    if (!this.runner.probe(['-V'])) throw new HiveError('TMUX_UNAVAILABLE', 'tmux is not available on this machine')
  }
}

const statusVariable = 'HIVE_EXIT_STATUS_FILE'
const statusWrapper = '"$@"; code=$?; printf %s "$code" > "$HIVE_EXIT_STATUS_FILE"; exit $code'

export interface TmuxSessionPaths {
  log: string
  status: string
}

export function sessionPaths(runtimeDir: string, sessionKey: string): TmuxSessionPaths {
  return { log: join(runtimeDir, `${sessionKey}.log`), status: join(runtimeDir, `${sessionKey}.status`) }
}

interface TmuxSessionOptions {
  now: Clock
  runner: TmuxCommandRunner
  paths: TmuxSessionPaths
  readyPattern?: string
  scrollbackBytes?: number
  pollMs: number
  cols: number
  rows: number
}

export class TmuxSession implements RuntimeSession {
  readonly backend: RuntimeBackend = 'tmux'
  readonly pid?: number
  private readonly output: SessionOutput
  private readonly now: Clock
  private readonly runner: TmuxCommandRunner
  private readonly paths: TmuxSessionPaths
  private readonly pollMs: number
  private timer?: NodeJS.Timeout
  private offset = 0
  private cols: number
  private rows: number

  constructor(readonly sessionKey: string, options: TmuxSessionOptions) {
    this.now = options.now
    this.runner = options.runner
    this.paths = options.paths
    this.pollMs = options.pollMs
    this.cols = options.cols
    this.rows = options.rows
    this.pid = readOptionalNumber(this.runner, sessionKey, 'pane_pid')
    this.output = new SessionOutput(this.now().toISOString(), {
      now: this.now,
      readyPattern: options.readyPattern,
      scrollbackBytes: options.scrollbackBytes,
    })
  }

  /** Redirects pane output to the log and begins sampling it. */
  startPipe(): void {
    this.runner.run(['pipe-pane', '-o', '-t', this.sessionKey, `cat >> ${shellQuote(this.paths.log)}`])
    this.timer = setInterval(() => this.pump(), this.pollMs)
    // Unreferenced so an attached session never keeps a CLI process alive on its own.
    this.timer.unref()
  }

  /**
   * Reads whatever the pane has written since the last look and settles the
   * session once tmux no longer knows about it. Exposed rather than left to the
   * timer so a test — or a surface refreshing on demand — gets the same result
   * without waiting for a tick.
   */
  pump(): void {
    this.drainLog()
    if (this.output.exit) return
    if (this.runner.probe(['has-session', '-t', this.sessionKey])) return
    // One last read: output written just before the pane closed is still the run's.
    this.drainLog()
    this.settle(this.readExitStatus())
  }

  ready(timeoutMs?: number): Promise<void> {
    return this.output.waitForReady(timeoutMs)
  }

  write(data: string): void {
    this.assertAlive()
    this.output.countInput(data)
    // `-l` sends the bytes literally; Enter is sent as a key so the shell sees a
    // submitted line rather than a raw newline character.
    const segments = data.split('\n')
    segments.forEach((segment, index) => {
      if (segment.length > 0) this.runner.run(['send-keys', '-t', this.sessionKey, '-l', '--', segment])
      if (index < segments.length - 1) this.runner.run(['send-keys', '-t', this.sessionKey, 'Enter'])
    })
  }

  resize(cols: number, rows: number): void {
    this.assertAlive()
    if (cols <= 0 || rows <= 0) throw new HiveError('INVALID_TERMINAL_SIZE', `Refusing to resize to ${cols}x${rows}`)
    this.runner.run(['resize-window', '-t', this.sessionKey, '-x', String(cols), '-y', String(rows)])
    this.cols = cols
    this.rows = rows
  }

  async kill(options: KillOptions = {}): Promise<RuntimeExit> {
    if (this.output.exit) return this.output.exit
    // Killing the session takes the pane's whole process tree with it, which is
    // why this backend needs no separate tree walk.
    this.runner.run(['kill-session', '-t', this.sessionKey])
    this.drainLog()
    const status = this.readExitStatus()
    this.settle(status.code === undefined && status.signal === undefined ? { signal: options.signal ?? 'SIGTERM', exitedAt: status.exitedAt } : status)
    return this.output.exit as RuntimeExit
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
    this.pump()
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

  private drainLog(): void {
    if (!existsSync(this.paths.log)) return
    const size = statSync(this.paths.log).size
    if (size <= this.offset) {
      // A truncated log means someone restarted the pipe; start over rather than read past the end.
      if (size < this.offset) this.offset = size
      return
    }
    const length = size - this.offset
    const buffer = Buffer.allocUnsafe(length)
    const fd = openSync(this.paths.log, 'r')
    try {
      const read = readSync(fd, buffer, 0, length, this.offset)
      this.offset += read
      this.output.push(buffer.subarray(0, read).toString('utf8'))
    } finally {
      closeSync(fd)
    }
  }

  /**
   * Decodes the wrapper's recorded status. A shell reports a signalled child as
   * 128 plus the signal number, so that is translated back into the signal name;
   * an unreadable status yields an exit with neither field, which honestly says
   * "it ended and the reason was lost" rather than inventing a zero.
   */
  private readExitStatus(): RuntimeExit {
    const exitedAt = this.now().toISOString()
    if (!existsSync(this.paths.status)) return { exitedAt }
    const raw = readFileSync(this.paths.status, 'utf8').trim()
    if (raw.length === 0) return { exitedAt }
    const code = Number.parseInt(raw, 10)
    if (!Number.isInteger(code)) return { exitedAt }
    if (code > 128 && code < 192) return { signal: signalName(code - 128), exitedAt }
    return { code, exitedAt }
  }

  private settle(exit: RuntimeExit): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.output.finish(exit)
  }

  private assertAlive(): void {
    if (this.output.exit) throw new HiveError('RUNTIME_EXITED', `Session ${this.sessionKey} has already exited`)
  }
}

function readNumber(runner: TmuxCommandRunner, sessionKey: string, format: string, fallback: number): number {
  return readOptionalNumber(runner, sessionKey, format) ?? fallback
}

function readOptionalNumber(runner: TmuxCommandRunner, sessionKey: string, format: string): number | undefined {
  try {
    const value = Number.parseInt(runner.run(['display-message', '-p', '-t', sessionKey, `#{${format}}`]), 10)
    return Number.isInteger(value) ? value : undefined
  } catch {
    return undefined
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
