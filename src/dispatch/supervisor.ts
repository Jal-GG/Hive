import {
  ActorContext,
  Run,
  RuntimeHeartbeat,
  ScopeRef,
  SupervisionReport,
  WorkItem,
} from '../contracts.js'
import { assertCapability } from '../capabilities.js'
import { Ledger } from '../ledger.js'
import { RunManager } from '../runtime/run-manager.js'
import { Clock, ClockOptions, resolveClock } from '../shared.js'
import { MailService } from '../work/mail.js'
import { WorkBoard } from '../work/board.js'
import { workEvent } from '../work/events.js'

/** The projection name the supervisor's durable cursor is stored under. */
export const supervisorProjection = 'supervisor'

/** The queue supervision mail lands in: POLECAT reports come in, escalations go out. */
export const supervisorQueue = 'supervisor'

export interface SupervisorOptions extends ClockOptions {
  ledger: Ledger
  board: WorkBoard
  mail: MailService
  manager: RunManager
  scope: ScopeRef
  /** Stall threshold as a multiple of the profile's idle threshold. */
  stallFactor?: number
  /** Escalation threshold as a multiple of the profile's idle threshold. */
  escalateFactor?: number
  /** How long a mail claim is worth before requeue treats the worker as gone. */
  claimExpiryMs?: number
}

/**
 * Phase 5's supervisor: the loop that watches the fleet so nobody else has to.
 *
 * One pass does four things, each idempotent: it heartbeats every live run
 * (persisting running↔idle), escalates runs silent past their thresholds, turns
 * POLECAT_DONE reports into work item transitions, and reacts to runs that
 * exited with their work item still open. A durable event cursor makes the pass
 * resumable: a restarted supervisor picks up exactly where the last one stopped,
 * so an exit is reacted to once no matter how many restarts happen in between.
 */
export class Supervisor {
  private readonly ledger: Ledger
  private readonly board: WorkBoard
  private readonly mail: MailService
  private readonly manager: RunManager
  private readonly scope: ScopeRef
  private readonly now: Clock
  private readonly stallFactor: number
  private readonly escalateFactor: number
  private readonly claimExpiryMs: number

  constructor(options: SupervisorOptions) {
    this.ledger = options.ledger
    this.board = options.board
    this.mail = options.mail
    this.manager = options.manager
    this.scope = options.scope
    this.now = resolveClock(options)
    this.stallFactor = options.stallFactor ?? 2
    this.escalateFactor = options.escalateFactor ?? 3
    this.claimExpiryMs = options.claimExpiryMs ?? 60_000
  }

  /** One supervision pass. Safe to run as often as the scheduler wakes it. */
  supervise(actor: ActorContext): SupervisionReport {
    assertCapability(actor.capabilities, 'work:dispatch')
    const occurredAt = this.now().toISOString()
    const report: SupervisionReport = { inspected: 0, idled: 0, stalled: 0, escalated: 0, completions: 0, cursor: 0 }

    this.sweepRuns(actor, occurredAt, report)
    report.completions = this.processPolecatReports(actor, occurredAt)
    this.reactToExits(actor, occurredAt, report)

    report.cursor = this.ledger.latestEventSequence()
    this.ledger.setProjectionCursor(supervisorProjection, report.cursor)
    return report
  }

  /**
   * Restart recovery: reconcile the runtime plane, return abandoned mail claims
   * to their queues, then run one pass. Dispatch is deliberately absent —
   * recovery resumes supervision, it never launches new work.
   */
  async recover(actor: ActorContext): Promise<SupervisionReport> {
    assertCapability(actor.capabilities, 'work:dispatch')
    await this.manager.reconcile(actor)
    this.mail.requeue(actor, this.scope, this.claimExpiryMs)
    return this.supervise(actor)
  }

  /**
   * Heartbeats every live run and escalates the silent ones. `manager.heartbeat`
   * already persists running↔idle; this pass adds the two reactions the runtime
   * plane cannot decide on its own: stalled, then escalated with mail attached.
   */
  private sweepRuns(actor: ActorContext, occurredAt: string, report: SupervisionReport): void {
    for (const runId of this.manager.liveRunIds()) {
      const run = this.manager.get(runId)
      const beat = this.manager.heartbeat(runId)
      report.inspected += 1
      if (!run || !beat || !beat.alive) continue
      // Escalated is terminal: the operator owns the session from here, and a
      // second escalation would be noise, not information.
      if (run.state === 'escalated') continue
      const idleAfter = this.idleAfterMsOf(run)
      if (idleAfter === undefined) continue

      if (beat.idleMs >= idleAfter * this.escalateFactor) {
        this.ledger.updateRun(runId, { state: 'escalated' })
        this.mail.send(actor, this.scope, {
          queue: supervisorQueue,
          subject: 'RECOVERY_NEEDED',
          body: `Run ${runId} (agent ${run.agentId ?? 'unknown'}) has been silent for ${Math.round(beat.idleMs / 1000)}s and was escalated.`,
          type: 'escalation',
          priority: 'urgent',
        })
        this.record(actor, 'escalated', `escalated:${runId}`, occurredAt, { runId, agentId: run.agentId, idleMs: beat.idleMs })
        report.escalated += 1
      } else if (beat.idleMs >= idleAfter * this.stallFactor && run.state !== 'stalled') {
        this.ledger.updateRun(runId, { state: 'stalled' })
        this.record(actor, 'stalled', `stalled:${runId}`, occurredAt, { runId, agentId: run.agentId, idleMs: beat.idleMs })
        report.stalled += 1
        report.idled += 1
      } else if (beat.idleMs >= idleAfter) {
        report.idled += 1
      }
    }
  }

  /**
   * POLECAT_DONE: an agent's own report that its work is finished. Each report
   * moves the sender's in-flight item to review — done is a judgement the
   * operator makes; finished-for-now is all the agent can claim — and the
   * acknowledgement closes the mail loop.
   */
  private processPolecatReports(actor: ActorContext, occurredAt: string): number {
    const pending = this.mail
      .inbox(actor, { queue: supervisorQueue, states: ['pending'] })
      .filter((message) => message.subject === 'POLECAT_DONE')
    let completions = 0
    for (const message of pending) {
      const claimed = this.mail.claim(actor, message)
      if (!claimed) continue
      const item = this.itemOfSender(claimed.from)
      if (item) {
        this.board.transition(actor, item.id, 'review')
        this.record(actor, 'polecat-processed', `polecat:${claimed.id}`, occurredAt, { taskId: item.id, from: claimed.from }, item.id)
        completions += 1
      } else {
        this.record(actor, 'polecat-orphaned', `polecat-orphaned:${claimed.id}`, occurredAt, { from: claimed.from })
      }
      this.mail.ack(actor, claimed.id)
    }
    return completions
  }

  /**
   * The event-cursor reaction: a run that exited while its work item was still
   * open is a crash or an abandonment, and the operator hears about each one
   * exactly once, across any number of supervisor restarts.
   */
  private reactToExits(actor: ActorContext, occurredAt: string, report: SupervisionReport): void {
    const cursor = this.ledger.projectionCursor(supervisorProjection)
    const exits = this.ledger
      .readEvents(cursor, 1000)
      .filter((event) => event.runId !== undefined && event.idempotencyKey.startsWith('runtime:exit:'))
    for (const exit of exits) {
      const run: Run | undefined = this.ledger.run(exit.runId!)
      if (!run?.workItemId) continue
      const item = this.ledger.workItem(run.workItemId)
      if (!item || (item.status !== 'in_progress' && item.status !== 'review')) continue
      this.mail.send(actor, this.scope, {
        queue: supervisorQueue,
        subject: 'Agent exited with work unfinished',
        body: `Run ${run.id} for task ${run.workItemId} (${item.title}) ended in state ${run.state}; the task is still ${item.status}.`,
        type: 'notification',
        priority: 'high',
      })
      this.record(actor, 'exit-notified', `exit-notified:${run.id}`, occurredAt, { runId: run.id, taskId: item.id }, item.id)
      report.escalated += 1
    }
  }

  private idleAfterMsOf(run: Run): number | undefined {
    return this.ledger.agentProfile(run.runtimeProfile)?.idleAfterMs
  }

  /** The sender's in-flight item: an agent reports on the work it holds. */
  private itemOfSender(from: string): WorkItem | undefined {
    const actorId = from.startsWith('actor:') ? from.slice('actor:'.length) : from
    const held = this.ledger.listWorkItems(this.scope, ['assigned', 'in_progress'], actorId)
    return held.find((item) => item.status === 'in_progress') ?? held[0]
  }

  private record(actor: ActorContext, action: string, key: string, occurredAt: string, payload: Record<string, unknown>, workItemId?: string): void {
    this.ledger.appendEvent(workEvent(actor, this.scope, 'System', action, key, occurredAt, payload, workItemId))
  }
}
