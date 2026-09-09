import {
  ActorContext,
  AgentProfile,
  EventEnvelope,
  Run,
  RunReconcileReport,
  RunState,
  RuntimeExit,
  RuntimeHeartbeat,
  RuntimeIdentity,
  RuntimeStatus,
  ScopeRef,
  TranscriptSlice,
  WorktreeCleanupDecision,
  WorktreeRef,
  terminalRunStates,
} from '../contracts.js'
import { HiveError } from '../errors.js'
import { assertCapability } from '../capabilities.js'
import { Ledger } from '../ledger.js'
import { Clock, ClockOptions, resolveClock } from '../shared.js'
import { createId } from '../shared.js'
import { resolveEnvironment } from './environment.js'
import { ProviderCatalog } from './provider-catalog.js'
import { redactArguments, redactEnvironment } from './redaction.js'
import { KillOptions, RuntimeAdapter, RuntimeSession, TranscriptAdapter, Unsubscribe } from './runtime-adapter.js'
import { RuntimeRegistry } from './runtime-registry.js'
import { GitWorktreeManager } from './worktree-manager.js'

/** Marks events this runtime produced, so a hook or watcher never replays them as external activity. */
export const runtimeOriginMarker = 'hive:runtime'

export type RuntimeAction = 'launch' | 'launch_failed' | 'ready' | 'prompt' | 'resize' | 'usage' | 'exit' | 'stop' | 'adopt' | 'reconcile' | 'transcript'

const defaultLeaseTtlMs = 60 * 60 * 1000
const defaultUsageIntervalBytes = 64 * 1024
const defaultReadyTimeoutMs = 30_000
/** Stands in for the prompt in anything recorded: the packet's shape is useful, its content is not. */
const promptPlaceholder = '<prompt>'

export interface RunManagerOptions extends ClockOptions {
  ledger: Ledger
  registry: RuntimeRegistry
  worktrees: GitWorktreeManager
  catalog?: ProviderCatalog
  /** Host environment runs inherit from, injected so a test never has to mutate `process.env`. */
  host?: Record<string, string | undefined>
  leaseTtlMs?: number
  cols?: number
  rows?: number
  readyTimeoutMs?: number
  /** Output volume between usage events. Byte counts only — never the bytes. */
  usageIntervalBytes?: number
}

export interface LaunchRunRequest {
  profileId: string
  workspace: string
  project: string
  workItemId?: string
  agentId?: string
  /** Compiled context packet, delivered the way the profile declares. */
  prompt?: string
  model?: string
  baseBranch?: string
  cols?: number
  rows?: number
  readyTimeoutMs?: number
}

export interface StopRunRequest extends KillOptions {
  runId: string
  /** Removes the worktree when the gates allow it; blocked reasons come back in the decision. */
  cleanup?: boolean
}

export interface StopRunResult {
  run: Run
  exit: RuntimeExit
  cleanup?: WorktreeCleanupDecision
}

interface LiveSession {
  session: RuntimeSession
  run: Run
  profile: AgentProfile
  adapter: RuntimeAdapter
  usageMark: number
  finalized: boolean
  unsubscribe: Unsubscribe[]
}

/**
 * The lifecycle of a run, in one place.
 *
 * Writes are ordered so that nothing can exist without a record of it (C15): the
 * lease, the worktree, and the row all exist before a process is spawned, and the
 * row is patched from the process's own reported status afterwards. A crash
 * between any two steps therefore leaves a row that reconciliation can explain,
 * rather than an untracked process holding a directory nobody knows about.
 *
 * What is recorded about a run is deliberately thin: byte counts, sizes, exit
 * status. Neither the operator's keystrokes nor the agent's output ever reach the
 * ledger, because an append-only log is exactly the wrong place to discover a
 * credential later (C16).
 */
export class RunManager {
  private readonly ledger: Ledger
  private readonly registry: RuntimeRegistry
  private readonly worktrees: GitWorktreeManager
  private readonly catalog: ProviderCatalog
  private readonly now: Clock
  private readonly host?: Record<string, string | undefined>
  private readonly leaseTtlMs: number
  private readonly cols: number
  private readonly rows: number
  private readonly readyTimeoutMs: number
  private readonly usageIntervalBytes: number
  private readonly live = new Map<string, LiveSession>()

  constructor(options: RunManagerOptions) {
    this.ledger = options.ledger
    this.registry = options.registry
    this.worktrees = options.worktrees
    this.catalog = options.catalog ?? new ProviderCatalog()
    this.now = resolveClock(options)
    this.host = options.host
    this.leaseTtlMs = options.leaseTtlMs ?? defaultLeaseTtlMs
    this.cols = options.cols ?? 120
    this.rows = options.rows ?? 30
    this.readyTimeoutMs = options.readyTimeoutMs ?? defaultReadyTimeoutMs
    this.usageIntervalBytes = options.usageIntervalBytes ?? defaultUsageIntervalBytes
  }

  /**
   * Starts one agent in its own worktree.
   *
   * Requires `runtime:control` to launch and `work:dispatch` to hold the run's
   * lease: starting an agent is both an execution decision and a claim on a
   * resource, and an actor allowed to do one is not automatically allowed the
   * other (C16, C19).
   */
  async launch(actor: ActorContext, request: LaunchRunRequest): Promise<Run> {
    assertCapability(actor.capabilities, 'runtime:control')
    const profile = this.catalog.get(request.profileId)
    const adapter = this.registry.forProfile(profile)
    const scope = this.ledger.resolveScope(request.workspace, request.project)
    const runId = createId()
    const sessionKey = sessionKeyFor(runId)

    // Recorded before it is used, so a roster rebuilt after a restart shows exactly
    // what launched rather than what the catalog happens to say today.
    this.ledger.upsertAgentProfile(profile)
    const lease = this.ledger.acquireLease(actor, 'run', runId, this.leaseTtlMs)

    let worktree: WorktreeRef
    try {
      worktree = this.worktrees.create({
        runId,
        workspaceName: scope.workspaceName,
        projectName: scope.projectName,
        workItemId: request.workItemId,
        baseBranch: request.baseBranch,
      })
    } catch (error) {
      // Nothing was started, so the claim must not outlive the attempt.
      this.releaseLease(actor.actorId, lease.id)
      throw error
    }

    const identity: RuntimeIdentity = {
      runId,
      actorId: actor.actorId,
      agentId: request.agentId ?? actor.agentId,
      workspaceName: scope.workspaceName,
      projectName: scope.projectName,
      workItemId: request.workItemId,
      branch: worktree.branch,
      originMarker: runtimeOriginMarker,
    }
    const environment = resolveEnvironment({ policy: profile.environmentPolicy, identity, host: this.host })
    const cols = request.cols ?? this.cols
    const rows = request.rows ?? this.rows

    const run: Run = {
      id: runId,
      workItemId: request.workItemId,
      actorId: actor.actorId,
      agentId: identity.agentId,
      scope,
      runtimeProfile: profile.id,
      backend: profile.backend,
      sessionKey,
      cwd: worktree.path,
      repoFingerprint: worktree.repoFingerprint,
      worktreeFingerprint: worktree.worktreeFingerprint,
      branch: worktree.branch,
      state: 'spawning',
      leaseId: lease.id,
      startedAt: this.now().toISOString(),
      importedEventCount: 0,
      lostEventCount: 0,
    }
    this.ledger.insertRun(run)
    this.ledger.insertWorktree(worktree)
    this.record(actor, scope, 'launch', runId, runId, {
      profile: profile.id,
      backend: profile.backend,
      branch: worktree.branch,
      baseBranch: worktree.baseBranch,
      baseCommit: worktree.baseCommit,
      cwd: worktree.path,
      sessionKey,
      cols,
      rows,
      // Redacted at the boundary: a template can carry a token and a policy can name a key.
      // The prompt is substituted out before the command line is recorded. A profile that
      // delivers by argument would otherwise write verbatim into an append-only log exactly
      // what stdin delivery deliberately records only the length of (C16).
      args: redactArguments(this.catalog.buildCommand(profile, { prompt: request.prompt === undefined ? undefined : promptPlaceholder, model: request.model, cwd: worktree.path, branch: worktree.branch, runId }).args),
      environment: Object.keys(redactEnvironment(environment)).sort(),
    }, request.workItemId)

    let session: RuntimeSession
    try {
      session = await adapter.spawn({ profile, identity, cwd: worktree.path, environment, cols, rows, prompt: request.prompt, sessionKey, model: request.model })
    } catch (error) {
      this.failLaunch(actor, run, error)
      throw error
    }

    const entry: LiveSession = { session, run, profile, adapter, usageMark: 0, finalized: false, unsubscribe: [] }
    this.live.set(runId, entry)
    this.attach(entry)
    this.ledger.updateRun(runId, { state: 'running', pid: session.pid ?? null })

    try {
      await session.ready(request.readyTimeoutMs ?? this.readyTimeoutMs)
    } catch (error) {
      // An agent that never signalled readiness cannot be given a prompt; stopping it
      // is better than leaving a process holding a worktree and answering nothing.
      await this.abandon(actor, entry, error)
      throw error
    }
    this.record(actor, scope, 'ready', runId, runId, { sessionKey, pid: session.pid }, request.workItemId)

    if (request.prompt) {
      // Argument delivery already happened in the spawned command line; stdin delivery is this write.
      if (profile.promptDelivery === 'stdin') session.write(`${request.prompt}\n`)
      // Length only: the packet itself is context, and context is not the ledger's business.
      this.record(actor, scope, 'prompt', runId, runId, { bytes: Buffer.byteLength(request.prompt), delivery: profile.promptDelivery }, request.workItemId)
    }

    return this.require(runId)
  }

  /** Sends operator input to a live run. Nothing about the content is recorded — only its volume, later, as usage. */
  write(actor: ActorContext, runId: string, data: string): void {
    assertCapability(actor.capabilities, 'runtime:control')
    this.liveSession(runId).session.write(data)
  }

  resize(actor: ActorContext, runId: string, cols: number, rows: number): void {
    assertCapability(actor.capabilities, 'runtime:control')
    const entry = this.liveSession(runId)
    if (!entry.adapter.capabilities.includes('resize')) {
      throw new HiveError('RUNTIME_CAPABILITY_MISSING', `Backend ${entry.adapter.backend} does not support resize`)
    }
    entry.session.resize(cols, rows)
    const status = entry.session.inspect()
    // Keyed by size and output volume, so a window dragged back to a previous size is
    // still a new record while an idempotent repeat of the same request is not.
    this.record(actor, entry.run.scope, 'resize', runId, `${runId}:${cols}x${rows}@${status.bytesOut}`, { cols, rows }, entry.run.workItemId)
  }

  /**
   * Ends a run and, when asked, cleans up after it. The exit status recorded is the
   * child's own; cleanup is a separate decision that can refuse.
   */
  async stop(actor: ActorContext, request: StopRunRequest): Promise<StopRunResult> {
    assertCapability(actor.capabilities, 'runtime:control')
    const entry = this.liveSession(request.runId)
    const exit = await entry.session.kill({ signal: request.signal, graceMs: request.graceMs })
    this.record(actor, entry.run.scope, 'stop', request.runId, request.runId, { signal: request.signal ?? 'SIGTERM' }, entry.run.workItemId)
    // The exit listener has already patched the row; this only settles ordering for the caller.
    this.finalize(entry, exit)
    const run = this.require(request.runId)
    if (!request.cleanup) return { run, exit }
    return { run, exit, cleanup: this.cleanup(actor, request.runId) }
  }

  /**
   * Removes a run's worktree when every gate agrees, and reports the reasons when
   * they do not. Never forced from here: discarding an agent's uncommitted work is
   * an explicit act, not a step in stopping it.
   */
  cleanup(actor: ActorContext, runId: string): WorktreeCleanupDecision {
    assertCapability(actor.capabilities, 'runtime:control')
    const run = this.require(runId)
    const worktree = this.ledger.worktree(runId)
    if (!worktree) return { runId, allowed: true, blockedBy: [] }
    const decision = this.worktrees.remove({ ref: worktree, run })
    if (decision.allowed) this.ledger.removeWorktree(runId)
    return decision
  }

  status(runId: string): RuntimeStatus | undefined {
    return this.live.get(runId)?.session.inspect()
  }

  heartbeat(runId: string): RuntimeHeartbeat | undefined {
    const entry = this.live.get(runId)
    if (!entry) return undefined
    const beat = entry.session.heartbeat()
    // Silence past the profile's threshold is a state change, not a lost process:
    // the row moves to `idle` so supervision in a later phase has something to act on.
    const idleAfterMs = entry.profile.idleAfterMs
    if (beat.alive && idleAfterMs !== undefined) {
      const current = this.ledger.run(runId)?.state
      const target: RunState | undefined = beat.idleMs >= idleAfterMs ? 'idle' : 'running'
      if (current && (current === 'running' || current === 'idle') && current !== target) this.ledger.updateRun(runId, { state: target })
    }
    return beat
  }

  scrollback(runId: string): string | undefined {
    return this.live.get(runId)?.session.scrollback()
  }

  /**
   * Streams a live run's output. The retained buffer is replayed first, so a
   * terminal attaching to a run already in flight shows the session rather than an
   * empty pane.
   */
  subscribe(actor: ActorContext, runId: string, listener: (chunk: string) => void): Unsubscribe {
    assertCapability(actor.capabilities, 'runtime:read')
    return this.liveSession(runId).session.onData(listener)
  }

  get(runId: string): Run | undefined {
    return this.ledger.run(runId)
  }

  list(scope?: ScopeRef, states?: readonly RunState[]): Run[] {
    return this.ledger.listRuns(scope, states)
  }

  /** Every run this process is currently supervising, which is not the same as every unfinished run. */
  liveRunIds(): string[] {
    return [...this.live.keys()].sort()
  }

  /** Read-only transcript view (C17). Advances nothing; two callers see the same slice. */
  transcript(actor: ActorContext, runId: string, limit?: number): TranscriptSlice {
    assertCapability(actor.capabilities, 'runtime:read')
    const { run, adapter, identity } = this.transcriptContext(runId)
    return adapter.read({ identity, cwd: run.cwd, cursor: run.transcriptCursor, limit })
  }

  /**
   * Imports the next slice and advances the run's cursor. Separate from `transcript`
   * because moving the cursor is a mutation: a read-only viewer must never be able
   * to make the next import skip entries it consumed.
   */
  importTranscript(actor: ActorContext, runId: string, limit?: number): TranscriptSlice {
    assertCapability(actor.capabilities, 'runtime:control')
    const { run, adapter, identity } = this.transcriptContext(runId)
    const slice = adapter.read({ identity, cwd: run.cwd, cursor: run.transcriptCursor, limit })
    this.ledger.updateRun(runId, {
      transcriptCursor: slice.cursor ?? null,
      importedEventCount: run.importedEventCount + slice.entries.length,
      // Loss is accumulated rather than overwritten: the useful number is how much a
      // run lost in total, not how much the last read happened to miss.
      lostEventCount: run.lostEventCount + slice.lostCount,
    })
    this.record(this.actorFor(actor, run), run.scope, 'transcript', runId, `${runId}:${slice.cursor ?? 'none'}`, {
      schema: slice.schema,
      entries: slice.entries.length,
      lost: slice.lostCount,
      complete: slice.complete,
    }, run.workItemId)
    return slice
  }

  /**
   * Rebuilds supervision after a restart.
   *
   * Every unfinished row is either re-adopted, when its backend outlives the host
   * and the session is still there, or marked a zombie — the honest answer for a
   * process this machine can no longer see. Leases are released on the run owner's
   * behalf and worktrees are only removed when the gates allow it, so a crash never
   * silently discards an agent's work.
   */
  async reconcile(actor: ActorContext): Promise<RunReconcileReport> {
    assertCapability(actor.capabilities, 'runtime:control')
    const report: RunReconcileReport = { scanned: 0, readopted: 0, zombies: 0, leasesReleased: 0, retainedWorktrees: [] }
    for (const run of this.ledger.listUnfinishedRuns()) {
      report.scanned += 1
      if (this.live.has(run.id)) continue

      const adopted = await this.tryAdopt(run)
      if (adopted) {
        report.readopted += 1
        this.ledger.updateRun(run.id, { state: 'running', pid: adopted.session.pid ?? null })
        this.record(actor, run.scope, 'adopt', run.id, `${run.id}:${run.sessionKey}`, { sessionKey: run.sessionKey, backend: run.backend }, run.workItemId)
        continue
      }

      report.zombies += 1
      this.ledger.updateRun(run.id, { state: 'zombie', endedAt: this.now().toISOString(), pid: null })
      if (this.releaseLease(run.actorId, run.leaseId)) report.leasesReleased += 1

      const worktree = this.ledger.worktree(run.id)
      if (worktree) {
        const zombie = this.require(run.id)
        const decision = this.worktrees.remove({ ref: worktree, run: zombie })
        if (decision.allowed) this.ledger.removeWorktree(run.id)
        else report.retainedWorktrees.push(decision)
      }
      this.record(actor, run.scope, 'reconcile', run.id, `${run.id}:zombie`, { outcome: 'zombie', backend: run.backend, sessionKey: run.sessionKey }, run.workItemId)
    }
    return report
  }

  /** Detaches from live sessions without ending them, for a clean host shutdown. */
  detach(): void {
    for (const entry of this.live.values()) {
      for (const unsubscribe of entry.unsubscribe.splice(0)) unsubscribe()
    }
    this.live.clear()
  }

  private attach(entry: LiveSession): void {
    entry.unsubscribe.push(
      entry.session.onData(() => {
        const status = entry.session.inspect()
        const mark = Math.floor(status.bytesOut / this.usageIntervalBytes)
        if (mark <= entry.usageMark) return
        entry.usageMark = mark
        this.recordUsage(entry, status)
      }),
    )
    entry.unsubscribe.push(entry.session.onExit((exit) => this.finalize(entry, exit)))
  }

  /**
   * Writes the child's reported status onto the row exactly once. A kill racing a
   * natural exit must not produce two endings, and the one that is recorded is the
   * child's — never a synthesised success.
   */
  private finalize(entry: LiveSession, exit: RuntimeExit): void {
    if (entry.finalized) return
    entry.finalized = true
    const status = entry.session.inspect()
    this.recordUsage(entry, status)
    this.ledger.updateRun(entry.run.id, {
      state: 'done',
      endedAt: exit.exitedAt,
      exitCode: exit.code ?? null,
      exitSignal: exit.signal ?? null,
      pid: null,
    })
    this.releaseLease(entry.run.actorId, entry.run.leaseId)
    this.record(this.ownerActor(entry.run), entry.run.scope, 'exit', entry.run.id, entry.run.id, {
      code: exit.code,
      signal: exit.signal,
      bytesOut: status.bytesOut,
      bytesIn: status.bytesIn,
    }, entry.run.workItemId)
    for (const unsubscribe of entry.unsubscribe.splice(0)) unsubscribe()
    this.live.delete(entry.run.id)
  }

  private recordUsage(entry: LiveSession, status: RuntimeStatus): void {
    // Volume only (C16): how much an agent produced is observable without any of it being retained.
    this.record(this.ownerActor(entry.run), entry.run.scope, 'usage', entry.run.id, `${entry.run.id}:${status.bytesOut}`, {
      bytesOut: status.bytesOut,
      bytesIn: status.bytesIn,
      lastOutputAt: status.lastOutputAt,
    }, entry.run.workItemId)
  }

  private async tryAdopt(run: Run): Promise<LiveSession | undefined> {
    let adapter: RuntimeAdapter
    try {
      adapter = this.registry.adapter(run.backend)
    } catch {
      // The backend this run used is not configured here; it cannot be observed, so it is gone.
      return undefined
    }
    if (!adapter.adopt || !adapter.capabilities.includes('persistent_session')) return undefined
    const session = await adapter.adopt(run.sessionKey)
    if (!session) return undefined
    const profile = this.ledger.agentProfile(run.runtimeProfile) ?? (this.catalog.has(run.runtimeProfile) ? this.catalog.get(run.runtimeProfile) : undefined)
    if (!profile) return undefined
    const entry: LiveSession = { session, run, profile, adapter, usageMark: Math.floor(session.inspect().bytesOut / this.usageIntervalBytes), finalized: false, unsubscribe: [] }
    this.live.set(run.id, entry)
    this.attach(entry)
    return entry
  }

  /** A spawn that never produced a process leaves nothing behind: no lease, no worktree, no half-live row. */
  private failLaunch(actor: ActorContext, run: Run, error: unknown): void {
    this.ledger.updateRun(run.id, { state: 'cancelled', endedAt: this.now().toISOString() })
    this.releaseLease(run.actorId, run.leaseId)
    this.record(actor, run.scope, 'launch_failed', run.id, run.id, { reason: describe(error) }, run.workItemId)
    const worktree = this.ledger.worktree(run.id)
    if (worktree) {
      const decision = this.worktrees.remove({ ref: worktree, run: this.require(run.id) })
      if (decision.allowed) this.ledger.removeWorktree(run.id)
    }
  }

  private async abandon(actor: ActorContext, entry: LiveSession, error: unknown): Promise<void> {
    try {
      const exit = await entry.session.kill()
      this.finalize(entry, exit)
    } catch {
      // Already gone, or unkillable; either way the row must not stay `running`.
      this.finalize(entry, { exitedAt: this.now().toISOString() })
    }
    this.ledger.updateRun(entry.run.id, { state: 'cancelled' })
    this.record(actor, entry.run.scope, 'launch_failed', entry.run.id, `${entry.run.id}:not_ready`, { reason: describe(error) }, entry.run.workItemId)
  }

  private transcriptContext(runId: string): { run: Run; adapter: TranscriptAdapter; identity: RuntimeIdentity } {
    const run = this.require(runId)
    const profile = this.ledger.agentProfile(run.runtimeProfile) ?? this.catalog.get(run.runtimeProfile)
    const adapter = this.registry.transcript(profile)
    if (!adapter) throw new HiveError('TRANSCRIPT_UNAVAILABLE', `Profile ${profile.id} has no transcript adapter on this host`)
    return {
      run,
      adapter,
      identity: {
        runId: run.id,
        actorId: run.actorId,
        workspaceName: run.scope.workspaceName,
        projectName: run.scope.projectName,
        workItemId: run.workItemId,
        branch: run.branch,
        originMarker: runtimeOriginMarker,
      },
    }
  }

  private liveSession(runId: string): LiveSession {
    const entry = this.live.get(runId)
    if (!entry) {
      const run = this.ledger.run(runId)
      if (!run) throw new HiveError('RUN_NOT_FOUND', `Run ${runId} not found`)
      throw new HiveError('RUN_NOT_LIVE', `Run ${runId} is ${run.state} and not supervised by this process`)
    }
    return entry
  }

  private require(runId: string): Run {
    const run = this.ledger.run(runId)
    if (!run) throw new HiveError('RUN_NOT_FOUND', `Run ${runId} not found`)
    return run
  }

  /**
   * A lease belongs to whoever took it, not to whoever is cleaning up, so release
   * is attempted as the run's owner. Failure is not fatal: an expired or
   * already-released lease is exactly what a crashed host leaves behind.
   */
  private releaseLease(actorId: string, leaseId: string): boolean {
    try {
      this.ledger.releaseLease({ actorId } as ActorContext, leaseId)
      return true
    } catch {
      return false
    }
  }

  private ownerActor(run: Run): ActorContext {
    return {
      actorId: run.actorId,
      actorType: 'supervisor',
      displayName: run.actorId,
      capabilities: [],
      workspaceId: run.scope.workspaceId,
      projectId: run.scope.projectId,
      source: 'internal',
    }
  }

  /** Keeps the acting identity on the record while borrowing the run's scope. */
  private actorFor(actor: ActorContext, run: Run): ActorContext {
    return { ...actor, workspaceId: run.scope.workspaceId, projectId: run.scope.projectId }
  }

  private record(
    actor: ActorContext,
    scope: ScopeRef,
    action: RuntimeAction,
    runId: string,
    key: string,
    payload: Record<string, unknown>,
    workItemId?: string,
  ): void {
    this.ledger.appendEvent(runtimeEvent(actor, scope, action, key, this.now().toISOString(), payload, runId, workItemId))
  }
}

/**
 * Session keys are derived from the run id, never generated (C19). A persistent
 * backend can then be asked "is run X still there?" after a restart by recomputing
 * the key, instead of hoping a name was written down before the crash.
 */
export function sessionKeyFor(runId: string): string {
  return `hive-${runId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12).toLowerCase()}`
}

/**
 * Builds a runtime event (C13). Keys are derived from the run and the thing that
 * happened rather than from a clock, so replaying a launch or an exit is recognised
 * as the same event instead of doubling it.
 */
export function runtimeEvent(
  actor: ActorContext,
  scope: ScopeRef,
  action: RuntimeAction,
  key: string,
  occurredAt: string,
  payload: Record<string, unknown>,
  runId?: string,
  workItemId?: string,
): EventEnvelope {
  return {
    version: 1,
    eventId: createId(),
    idempotencyKey: `runtime:${action}:${key}`,
    eventType: action === 'reconcile' ? 'System' : 'Pty',
    source: actor.source,
    actor,
    scope,
    runId,
    workItemId,
    occurredAt,
    payload,
    originMarker: runtimeOriginMarker,
  }
}

export function isTerminal(state: RunState): boolean {
  return terminalRunStates.includes(state)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
