import { ActorContext, EventEnvelope, ResultEnvelope, Run, RunState, ScopeRef } from '../../contracts.js'
import { HiveError, asResult } from '../../errors.js'
import { assertCapability } from '../../identity/capabilities.js'
import { Ledger } from '../../ledger.js'
import { createId } from '../../shared/ids.js'
import { ProviderCatalog } from '../provider-catalog.js'
import { RunManager } from '../run-manager.js'
import { RuntimeRegistry } from '../runtime-registry.js'
import { GitWorktreeManager } from '../worktree/git-worktree.js'

export type RuntimeBrowseOperation =
  | 'profiles'
  | 'backends'
  | 'runs'
  | 'run'
  | 'status'
  | 'heartbeat'
  | 'scrollback'
  | 'transcript'
  | 'events'
  | 'worktree'

export const runtimeBrowseOperations: readonly RuntimeBrowseOperation[] = [
  'profiles', 'backends', 'runs', 'run', 'status', 'heartbeat', 'scrollback', 'transcript', 'events', 'worktree',
]

export const runtimeBrowseHelp: Record<RuntimeBrowseOperation, string> = {
  profiles: 'List agent profiles this host can launch',
  backends: 'List runtime backends and transcript adapters available here',
  runs: 'List runs, optionally filtered by scope and state',
  run: 'One run row, including exit status once it has ended',
  status: 'Live process status for a supervised run: pid, size, byte counts',
  heartbeat: 'Liveness and idle time for a supervised run',
  scrollback: 'Retained tail of a supervised run\'s output',
  transcript: 'Read the provider\'s native transcript without advancing the cursor',
  events: 'Runtime events after a sequence number, for cursor subscriptions',
  worktree: 'Worktree reference, working-tree status, and whether cleanup is allowed',
}

/** One request shape for every surface, mirroring `ContextBrowseRequest`. */
export interface RuntimeBrowseRequest {
  version: 1
  requestId?: string
  operation: RuntimeBrowseOperation
  runId?: string
  workspace?: string
  project?: string
  states?: RunState[]
  provider?: string
  backend?: string
  limit?: number
  /** Exclusive lower bound for `events`; the cursor a subscriber last saw. */
  afterSequence?: number
}

export interface RuntimeEventPage {
  events: EventEnvelope[]
  /** Sequence to pass back as `afterSequence` next time. */
  cursor: number
  /** Highest sequence in the ledger, so a subscriber knows whether it is caught up. */
  latest: number
}

export interface RuntimeBrowserOptions {
  ledger: Ledger
  manager: RunManager
  catalog: ProviderCatalog
  registry: RuntimeRegistry
  worktrees?: GitWorktreeManager
}

/**
 * The read-only runtime surface behind every transport (C4).
 *
 * It is a separate service from `RuntimeController` rather than a read mode of it,
 * because the two answer to different capabilities: watching a fleet is something
 * a viewer may do, and starting a process is not. Splitting them means a transport
 * that only ever mounts this one — an HTTP endpoint, a read-only dashboard —
 * cannot be talked into a mutation, since none exists here to reach (C16).
 */
export class RuntimeBrowser {
  private readonly ledger: Ledger
  private readonly manager: RunManager
  private readonly catalog: ProviderCatalog
  private readonly registry: RuntimeRegistry
  private readonly worktrees?: GitWorktreeManager

  constructor(options: RuntimeBrowserOptions) {
    this.ledger = options.ledger
    this.manager = options.manager
    this.catalog = options.catalog
    this.registry = options.registry
    this.worktrees = options.worktrees
  }

  /** Never throws: every failure comes back as a `ResultEnvelope` error, identically on all surfaces. */
  browse(actor: ActorContext, request: RuntimeBrowseRequest): ResultEnvelope<unknown> {
    const requestId = request.requestId ?? createId()
    return asResult(requestId, () => this.dispatch(actor, request))
  }

  private dispatch(actor: ActorContext, request: RuntimeBrowseRequest): unknown {
    assertCapability(actor.capabilities, 'runtime:read')
    switch (request.operation) {
      case 'profiles':
        // Filtered by string rather than by narrowed type: these values arrive from a
        // transport payload, and an unknown provider name is a filter that matches
        // nothing, not a cast that lies about what was received.
        return this.catalog.list()
          .filter((profile) => (request.provider ? profile.provider === request.provider : true))
          .filter((profile) => (request.backend ? profile.backend === request.backend : true))
          .map((profile) => ({
            id: profile.id,
            provider: profile.provider,
            backend: profile.backend,
            capabilities: profile.capabilities,
            promptDelivery: profile.promptDelivery,
            transcriptAdapter: profile.transcriptAdapter,
            // The executable is named but never its arguments: a template can carry a key.
            executable: profile.executable,
            available: this.registry.has(profile.backend),
          }))
      case 'backends':
        return { backends: this.registry.backends(), transcripts: this.registry.transcriptAdapters() }
      case 'runs':
        return this.manager.list(this.scope(request), request.states)
      case 'run':
        return this.requireRun(request)
      case 'status':
        return this.manager.status(this.requireRunId(request)) ?? null
      case 'heartbeat':
        return this.manager.heartbeat(this.requireRunId(request)) ?? null
      case 'scrollback': {
        const runId = this.requireRunId(request)
        return { runId, text: this.manager.scrollback(runId) ?? '' }
      }
      case 'transcript':
        return this.manager.transcript(actor, this.requireRunId(request), request.limit)
      case 'events':
        return this.events(request)
      case 'worktree':
        return this.worktree(request)
      default:
        throw new HiveError('UNKNOWN_OPERATION', `Not a runtime browse operation: ${String(request.operation)}`)
    }
  }

  /**
   * Pages runtime events by sequence. The cursor returned is the last sequence
   * actually delivered, so a subscriber that drops a page re-requests exactly what
   * it missed instead of skipping it.
   */
  private events(request: RuntimeBrowseRequest): RuntimeEventPage {
    const after = request.afterSequence ?? 0
    const limit = request.limit ?? 100
    const events = request.runId ? this.ledger.readRunEvents(request.runId, after, limit) : this.ledger.readEvents(after, limit)
    const last = events[events.length - 1]?.sequence
    return { events, cursor: last ?? after, latest: this.ledger.latestEventSequence() }
  }

  private worktree(request: RuntimeBrowseRequest): unknown {
    const run = this.requireRun(request)
    const ref = this.ledger.worktree(run.id)
    if (!ref) return null
    if (!this.worktrees) return { ref }
    // The decision is reported, not acted on: this surface cannot delete anything.
    return { ref, status: this.worktrees.status(ref), cleanup: this.worktrees.cleanupDecision({ ref, run }) }
  }

  private scope(request: RuntimeBrowseRequest): ScopeRef | undefined {
    if (request.workspace === undefined && request.project === undefined) return undefined
    return this.ledger.resolveScope(this.require(request.workspace, 'workspace'), this.require(request.project, 'project'))
  }

  private requireRun(request: RuntimeBrowseRequest): Run {
    const runId = this.requireRunId(request)
    const run = this.ledger.run(runId)
    if (!run) throw new HiveError('RUN_NOT_FOUND', `Run ${runId} not found`)
    return run
  }

  private requireRunId(request: RuntimeBrowseRequest): string {
    return this.require(request.runId, 'runId')
  }

  private require<T>(value: T | undefined, name: string): T {
    if (value === undefined || value === '') throw new HiveError('MISSING_ARGUMENT', `${name} is required for this operation`)
    return value
  }
}
