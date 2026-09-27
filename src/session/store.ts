import { ActorContext, ContextLevel, EventEnvelope, IngestChunk, Run, ScopeRef, SessionRecord, WorkItem } from '../contracts.js'
import { assertCapability } from '../capabilities.js'
import { Ledger } from '../ledger.js'
import { createResourceUri } from '../resource-uri.js'
import { Clock, ClockOptions, resolveClock } from '../shared.js'

/** How many events one replay page returns; a session is a walk, not a dump. */
export const replayPageSize = 100

export interface ReplayPage {
  events: EventEnvelope[]
  /** The cursor to resume from: the last event's sequence, or the start when empty. */
  cursor: number
}

/**
 * Phase 6's session abstraction: one durable record per run, distilled into an
 * L0 summary and an L1 overview, both deterministic — the same run always
 * summarizes the same way, with no model in the loop. The summary chunks land
 * in the lexical index, so "what did we do about the parser" finds the session
 * that did it.
 */
export class SessionStore {
  private readonly now: Clock

  constructor(private readonly ledger: Ledger, options: ClockOptions = {}) {
    this.now = resolveClock(options)
  }

  /**
   * Captures a run as a session: the run row is the truth, the work item names
   * the work, and the summary is composed from both. Recapturing the same run
   * overwrites, so a stopped run's exit status lands when it becomes known.
   */
  capture(actor: ActorContext, runId: string): SessionRecord {
    assertCapability(actor.capabilities, 'work:dispatch')
    const run = this.requireRun(runId)
    const item = run.workItemId ? this.ledger.workItem(run.workItemId) : undefined
    const scope = run.scope
    const summary = this.summarize(run, item)
    const overview = this.overviewOf(run, item)
    const record: SessionRecord = {
      id: run.id,
      scope,
      runId: run.id,
      agentId: run.agentId,
      workItemId: run.workItemId,
      runtimeProfile: run.runtimeProfile,
      branch: run.branch,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      exitCode: run.exitCode,
      exitSignal: run.exitSignal,
      summary,
      overview,
      capturedAt: this.now().toISOString(),
    }
    this.ledger.upsertSession(record)
    this.indexSummary(scope, record)
    return record
  }

  session(actor: ActorContext, sessionId: string): SessionRecord {
    assertCapability(actor.capabilities, 'workspace:read')
    const record = this.ledger.session(sessionId)
    if (!record) throw new Error(`Session ${sessionId} not found`)
    return record
  }

  list(actor: ActorContext, scope?: ScopeRef): SessionRecord[] {
    assertCapability(actor.capabilities, 'workspace:read')
    return this.ledger.listSessions(scope)
  }

  /** A session's events, by cursor: replay is a paged walk, resumable across restarts. */
  replay(actor: ActorContext, sessionId: string, afterSequence = 0): ReplayPage {
    assertCapability(actor.capabilities, 'workspace:read')
    const record = this.session(actor, sessionId)
    if (!record.runId) return { events: [], cursor: afterSequence }
    const events = this.ledger.readRunEvents(record.runId, afterSequence, replayPageSize)
    const last = events[events.length - 1]
    return { events, cursor: last?.sequence ?? afterSequence }
  }

  /** L0: one line, what this session was. */
  private summarize(run: Run, item?: WorkItem): string {
    const what = item ? item.title : run.runtimeProfile
    const outcome = run.exitSignal
      ? `ended by ${run.exitSignal}`
      : run.exitCode !== undefined
        ? `exit ${run.exitCode}`
        : run.endedAt
          ? 'ended'
          : 'in flight'
    return `${what} — ${outcome}`
  }

  /** L1: a paragraph, what happened and how it ended — still facts, no invented narrative. */
  private overviewOf(run: Run, item?: WorkItem): string {
    const parts: string[] = []
    if (item) parts.push(`Task: ${item.title}.`)
    parts.push(`Agent ${run.agentId ?? 'unknown'} on profile ${run.runtimeProfile}, branch ${run.branch}, worktree ${run.cwd}.`)
    if (item?.description) parts.push(`Task notes: ${item.description.slice(0, 300)}`)
    if (run.endedAt) {
      const outcome = run.exitSignal ? `ended by signal ${run.exitSignal}` : run.exitCode !== undefined ? `exited ${run.exitCode}` : 'ended'
      parts.push(`Session ${outcome} at ${run.endedAt}.`)
    }
    return parts.join(' ')
  }

  /** The summary and overview become searchable chunks under the session's own URI. */
  private indexSummary(scope: ScopeRef, record: SessionRecord): void {
    const uri = sessionUri(scope, record.id)
    const chunks: IngestChunk[] = []
    if (record.summary) {
      chunks.push({ uri, chunkId: 'l0', tier: 'L0' satisfies ContextLevel, title: `Session ${record.id}`, body: record.summary })
    }
    if (record.overview) {
      chunks.push({ uri, chunkId: 'l1', tier: 'L1' satisfies ContextLevel, title: `Session ${record.id}`, body: record.overview })
    }
    if (chunks.length === 0) return
    this.ledger.replaceIngestChunks(uri, chunks)
    this.ledger.upsertIngestSource({
      uri,
      path: `session://${record.id}`,
      scope,
      sha256: '',
      sizeBytes: 0,
      mtimeMs: 0,
      parser: 'session',
      chunkCount: chunks.length,
      ingestedAt: record.capturedAt ?? this.now().toISOString(),
    })
  }

  private requireRun(runId: string): Run {
    const run = this.ledger.run(runId)
    if (!run) throw new Error(`Run ${runId} not found`)
    return run
  }
}

/** Sessions live under a reserved URI space so they cannot collide with ingested files. */
export function sessionUri(scope: ScopeRef, sessionId: string): string {
  return createResourceUri(scope, `sessions/${sessionId}`)
}
