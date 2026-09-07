import { Run, RunState, RuntimeStatus } from '../../contracts.js'
import { RuntimeBridge, RuntimeStreamData, runtimeIpcPrefix, runtimeStreamChannels, type Unsubscribe } from './runtime-channels.js'

/** Same bound as a session's scrollback: a terminal view keeps a tail, not a history. */
const defaultBufferBytes = 256 * 1024

export interface ProfileView {
  id: string
  provider: string
  backend: string
  available: boolean
  promptDelivery: string
}

export interface RosterRow {
  runId: string
  short: string
  profile: string
  state: RunState
  branch: string
  workItemId?: string
  /** Present once the run has ended: `exit 0`, `signal SIGTERM`, or `ended`. */
  outcome?: string
  live: boolean
}

export interface RuntimeViewState {
  profiles: ProfileView[]
  runs: Run[]
  roster: RosterRow[]
  selectedRunId?: string
  terminal: string
  status?: RuntimeStatus
  /** Last event sequence the view has seen, so a reconnect resumes rather than restarts. */
  cursor: number
  busy: boolean
  error?: string
}

export interface LaunchFields {
  profileId: string
  workspace: string
  project: string
  workItemId?: string
  prompt?: string
  model?: string
}

export interface RuntimeViewModelOptions {
  bridge: RuntimeBridge
  bufferBytes?: number
}

/**
 * The desktop runtime view, as state and transitions with no framework in them.
 *
 * A React component subscribes to this and renders `state()`; xterm is fed
 * `terminal`. Keeping the logic here means the roster, the status line, and the
 * cursor arithmetic are testable without a renderer process, and means the same
 * view model can back a second front end later without being rewritten.
 *
 * Every read goes through the bridge, so this file has no access to the ledger, a
 * session, or an environment — the renderer's view of a run is exactly what the
 * main process chose to expose (C16).
 */
export class RuntimeViewModel {
  private readonly bridge: RuntimeBridge
  private readonly bufferBytes: number
  private readonly listeners = new Set<(state: RuntimeViewState) => void>()
  private readonly subscriptions: Unsubscribe[] = []
  private current: RuntimeViewState = { profiles: [], runs: [], roster: [], terminal: '', cursor: 0, busy: false }

  constructor(options: RuntimeViewModelOptions) {
    this.bridge = options.bridge
    this.bufferBytes = options.bufferBytes ?? defaultBufferBytes
    this.subscriptions.push(this.bridge.on(runtimeStreamChannels.data, (payload) => this.onData(payload as RuntimeStreamData)))
    this.subscriptions.push(this.bridge.on(runtimeStreamChannels.exit, () => void this.refresh()))
    this.subscriptions.push(this.bridge.on(runtimeStreamChannels.events, (payload) => this.onEvents(payload)))
  }

  state(): RuntimeViewState {
    return this.current
  }

  subscribe(listener: (state: RuntimeViewState) => void): Unsubscribe {
    this.listeners.add(listener)
    listener(this.current)
    return () => this.listeners.delete(listener)
  }

  /** Reloads the roster and the selected run's status. Safe to call on every event page. */
  async refresh(): Promise<void> {
    const profiles = await this.read('profiles')
    const runs = await this.read('runs')
    // A failed read leaves the last good view in place: blanking the roster because one
    // poll failed tells an operator their fleet vanished, which is worse than stale.
    const patch: Partial<RuntimeViewState> = {}
    if (Array.isArray(profiles)) patch.profiles = profiles as ProfileView[]
    if (Array.isArray(runs)) {
      patch.runs = runs as Run[]
      patch.roster = rosterRows(patch.runs, this.current.selectedRunId)
    }
    this.update(patch)
    if (this.current.selectedRunId) await this.refreshStatus(this.current.selectedRunId)
  }

  /**
   * Selects a run and seeds the terminal from its retained scrollback, so switching
   * runs shows the session rather than only what arrives after the click.
   */
  async select(runId: string): Promise<void> {
    this.update({ selectedRunId: runId, terminal: '', status: undefined })
    const scrollback = await this.read('scrollback', { runId })
    const text = typeof scrollback === 'object' && scrollback !== null ? String((scrollback as { text?: unknown }).text ?? '') : ''
    this.update({ terminal: this.bound(text), roster: rosterRows(this.current.runs, runId) })
    await this.refreshStatus(runId)
  }

  async launch(fields: LaunchFields): Promise<string | undefined> {
    const run = await this.mutate('launch', { ...fields })
    const runId = typeof run === 'object' && run !== null ? String((run as { id?: unknown }).id ?? '') : ''
    await this.refresh()
    if (runId) await this.select(runId)
    return runId || undefined
  }

  async send(data: string): Promise<void> {
    const runId = this.current.selectedRunId
    if (!runId) return
    await this.mutate('write', { runId, data })
  }

  async resize(cols: number, rows: number): Promise<void> {
    const runId = this.current.selectedRunId
    if (!runId) return
    await this.mutate('resize', { runId, cols, rows })
  }

  async stop(options: { cleanup?: boolean; signal?: string } = {}): Promise<void> {
    const runId = this.current.selectedRunId
    if (!runId) return
    await this.mutate('stop', { runId, ...options })
    await this.refresh()
  }

  dispose(): void {
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe()
    this.listeners.clear()
  }

  private async refreshStatus(runId: string): Promise<void> {
    const status = await this.read('status', { runId })
    this.update({ status: (status as RuntimeStatus | null) ?? undefined })
  }

  private onData(payload: RuntimeStreamData): void {
    if (!payload || payload.runId !== this.current.selectedRunId) return
    this.update({ terminal: this.bound(this.current.terminal + payload.chunk) })
  }

  private onEvents(payload: unknown): void {
    const page = payload as { cursor?: number } | null
    const cursor = typeof page?.cursor === 'number' ? page.cursor : this.current.cursor
    // Never move the cursor backwards: an out-of-order page would otherwise make the
    // view re-request events it has already applied.
    this.update({ cursor: Math.max(cursor, this.current.cursor) })
    void this.refresh()
  }

  private async read(operation: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const result = await this.bridge.invoke(`${runtimeIpcPrefix}${operation}`, payload)
    if (!result.ok) {
      this.update({ error: `${result.error.code}: ${result.error.message}` })
      return undefined
    }
    if (this.current.error) this.update({ error: undefined })
    return result.data
  }

  private async mutate(operation: string, payload: Record<string, unknown>): Promise<unknown> {
    this.update({ busy: true })
    try {
      return await this.read(operation, payload)
    } finally {
      this.update({ busy: false })
    }
  }

  private bound(text: string): string {
    if (text.length <= this.bufferBytes) return text
    // Cut at the next line boundary so the view never opens mid-escape-sequence.
    const trimmed = text.slice(text.length - this.bufferBytes)
    const newline = trimmed.indexOf('\n')
    return newline === -1 ? trimmed : trimmed.slice(newline + 1)
  }

  private update(patch: Partial<RuntimeViewState>): void {
    this.current = { ...this.current, ...patch }
    for (const listener of this.listeners) listener(this.current)
  }
}

/** Turns run rows into what the roster renders, including how each finished one ended. */
export function rosterRows(runs: readonly Run[], selectedRunId?: string): RosterRow[] {
  return runs.map((run) => ({
    runId: run.id,
    short: run.id.slice(0, 8),
    profile: run.runtimeProfile,
    state: run.state,
    branch: run.branch,
    workItemId: run.workItemId,
    outcome: outcomeOf(run),
    live: run.id === selectedRunId,
  }))
}

/**
 * How a run ended, in the terms the child reported. A signalled exit is never
 * shown as a code, because "exit 0" beside a SIGKILL is the one summary an
 * operator must not be given.
 */
export function outcomeOf(run: Run): string | undefined {
  if (run.exitSignal) return `signal ${run.exitSignal}`
  if (run.exitCode !== undefined) return `exit ${run.exitCode}`
  return run.endedAt ? 'ended' : undefined
}
