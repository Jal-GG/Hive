import { ActorContext, ResultEnvelope } from '../../contracts.js'
import { HiveError, asAsyncResult } from '../../errors.js'
import { assertCapability } from '../../identity/capabilities.js'
import { createId } from '../../shared/ids.js'
import { RunManager } from '../run-manager.js'

export type RuntimeControlOperation = 'launch' | 'write' | 'resize' | 'stop' | 'cleanup' | 'import' | 'reconcile'

export const runtimeControlOperations: readonly RuntimeControlOperation[] = ['launch', 'write', 'resize', 'stop', 'cleanup', 'import', 'reconcile']

export const runtimeControlHelp: Record<RuntimeControlOperation, string> = {
  launch: 'Start an agent profile in a fresh worktree',
  write: 'Send input to a running agent',
  resize: 'Change a running agent\'s terminal size',
  stop: 'Signal a run, wait for its real exit status, and optionally clean up',
  cleanup: 'Remove a finished run\'s worktree when every gate allows it',
  import: 'Import the next transcript slice and advance the run\'s cursor',
  reconcile: 'Re-adopt or retire unfinished runs after a restart',
}

/** One request shape for every surface, mirroring the browse request. */
export interface RuntimeControlRequest {
  version: 1
  requestId?: string
  operation: RuntimeControlOperation
  runId?: string
  profileId?: string
  workspace?: string
  project?: string
  workItemId?: string
  agentId?: string
  prompt?: string
  model?: string
  baseBranch?: string
  data?: string
  cols?: number
  rows?: number
  signal?: string
  graceMs?: number
  cleanup?: boolean
  limit?: number
  readyTimeoutMs?: number
}

/**
 * The mutating runtime surface (C4). Deliberately a different object from
 * `RuntimeBrowser` and deliberately not mounted on HTTP: a browser tab is the one
 * client whose origin cannot be established, so it gets the read side only.
 *
 * Everything here is async because starting and stopping a process is, and every
 * failure comes back in the same envelope as a read — an operator who cannot
 * launch sees a code and a reason, not a stack trace.
 */
export class RuntimeController {
  constructor(private readonly manager: RunManager) {}

  /** Never throws: failures arrive as `ResultEnvelope` errors, identically on all surfaces. */
  async control(actor: ActorContext, request: RuntimeControlRequest): Promise<ResultEnvelope<unknown>> {
    const requestId = request.requestId ?? createId()
    return asAsyncResult(requestId, () => this.dispatch(actor, request))
  }

  private async dispatch(actor: ActorContext, request: RuntimeControlRequest): Promise<unknown> {
    assertCapability(actor.capabilities, 'runtime:control')
    switch (request.operation) {
      case 'launch':
        return this.manager.launch(actor, {
          profileId: this.require(request.profileId, 'profileId'),
          workspace: this.require(request.workspace, 'workspace'),
          project: this.require(request.project, 'project'),
          workItemId: request.workItemId,
          agentId: request.agentId,
          prompt: request.prompt,
          model: request.model,
          baseBranch: request.baseBranch,
          cols: request.cols,
          rows: request.rows,
          readyTimeoutMs: request.readyTimeoutMs,
        })
      case 'write': {
        // An empty string is a legitimate no-op; a missing one is a malformed request.
        const data = request.data
        if (data === undefined) throw new HiveError('MISSING_ARGUMENT', 'data is required for this operation')
        this.manager.write(actor, this.requireRunId(request), data)
        return { runId: request.runId, bytes: Buffer.byteLength(data) }
      }
      case 'resize':
        this.manager.resize(actor, this.requireRunId(request), this.positive(request.cols, 'cols'), this.positive(request.rows, 'rows'))
        return { runId: request.runId, cols: request.cols, rows: request.rows }
      case 'stop':
        return this.manager.stop(actor, {
          runId: this.requireRunId(request),
          signal: request.signal,
          graceMs: request.graceMs,
          cleanup: request.cleanup,
        })
      case 'cleanup':
        return this.manager.cleanup(actor, this.requireRunId(request))
      case 'import':
        return this.manager.importTranscript(actor, this.requireRunId(request), request.limit)
      case 'reconcile':
        return this.manager.reconcile(actor)
      default:
        throw new HiveError('UNKNOWN_OPERATION', `Not a runtime control operation: ${String(request.operation)}`)
    }
  }

  private requireRunId(request: RuntimeControlRequest): string {
    return this.require(request.runId, 'runId')
  }

  private positive(value: number | undefined, name: string): number {
    const resolved = this.require(value, name)
    if (!Number.isInteger(resolved) || resolved < 1) throw new HiveError('INVALID_ARGUMENT', `${name} must be a positive integer`)
    return resolved
  }

  private require<T>(value: T | undefined, name: string): T {
    if (value === undefined || value === '') throw new HiveError('MISSING_ARGUMENT', `${name} is required for this operation`)
    return value
  }
}
