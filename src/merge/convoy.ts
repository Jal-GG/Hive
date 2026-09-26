import {
  ActorContext,
  ConvoyRecord,
  ConvoyScanReport,
  MergeRequest,
  ScopeRef,
  WorkItem,
  satisfiedDependencyStates,
  terminalWorkItemStates,
} from '../contracts.js'
import { assertCapability } from '../capabilities.js'
import { HiveError } from '../errors.js'
import { Ledger } from '../ledger.js'
import { Clock, ClockOptions, resolveClock } from '../shared.js'
import { MailService } from '../work/mail.js'
import { WorkBoard } from '../work/board.js'
import { workEvent } from '../work/events.js'
import { Dispatcher } from '../dispatch/dispatcher.js'

export interface ConvoyOptions extends ClockOptions {
  ledger: Ledger
  board: WorkBoard
  mail: MailService
  scope: ScopeRef
  /** Present when a convoy should dispatch the next unblocked item itself. */
  dispatcher?: Dispatcher
}

/**
 * A convoy is work that must land together, and this is the loop that watches
 * it converge. Closure is a guarded transition — exactly once, whoever notices
 * first — and the notification rides the event log's idempotency, so a scanner
 * that runs twice sends one letter, not two.
 */
export class ConvoyService {
  private readonly ledger: Ledger
  private readonly board: WorkBoard
  private readonly mail: MailService
  private readonly scope: ScopeRef
  private readonly dispatcher?: Dispatcher
  private readonly now: Clock

  constructor(options: ConvoyOptions) {
    this.ledger = options.ledger
    this.board = options.board
    this.mail = options.mail
    this.scope = options.scope
    this.dispatcher = options.dispatcher
    this.now = resolveClock(options)
  }

  /** Brings a convoy into being idempotently; naming it on a work item is enough. */
  ensure(actor: ActorContext, convoyId: string): ConvoyRecord {
    assertCapability(actor.capabilities, 'merge:execute')
    const occurredAt = this.now().toISOString()
    this.ledger.upsertConvoy({ id: convoyId, scope: this.scope, state: 'active', createdAt: occurredAt })
    return this.require(convoyId)
  }

  convoys(actor: ActorContext, states?: readonly ConvoyRecord['state'][]): ConvoyRecord[] {
    assertCapability(actor.capabilities, 'workspace:read')
    return this.ledger.listConvoys(this.scope, states)
  }

  /**
   * One convergence pass: close what has finished, dispatch what unblocked, and
   * count what stranded. Safe to run as often as the scheduler wakes it.
   */
  async scan(actor: ActorContext): Promise<ConvoyScanReport> {
    assertCapability(actor.capabilities, 'merge:execute')
    const report: ConvoyScanReport = { scanned: 0, closed: 0, dispatched: 0, stranded: 0 }
    for (const convoy of this.ledger.listConvoys(this.scope, ['active'])) {
      report.scanned += 1
      const items = this.itemsOf(convoy.id)
      const openRequests = this.openRequestsFor(items)
      const allItemsTerminal = items.length > 0 && items.every((item) => terminalWorkItemStates.includes(item.status))
      const allMerged = items.every((item) => item.status === 'merged' || item.status === 'done')
      if (allItemsTerminal && allMerged && openRequests.length === 0) {
        const closed = this.ledger.closeConvoy(convoy.id, actor.actorId, this.now().toISOString())
        if (closed) {
          report.closed += 1
          this.mail.send(actor, this.scope, {
            queue: 'supervisor',
            subject: 'MERGED',
            body: `Convoy ${convoy.id} closed: ${items.length} items landed together.`,
            type: 'protocol',
            priority: 'normal',
          })
          this.ledger.appendEvent(workEvent(actor, this.scope, 'Merge', 'convoy-closed', `convoy-closed:${convoy.id}`, closed.closedAt ?? this.now().toISOString(), {
            convoyId: convoy.id, items: items.map((item) => item.id),
          }))
        }
        // A convoy closed by a concurrent scan is still closed exactly once.
        continue
      }
      // Stranded: an open item blocked behind a dependency that can no longer
      // succeed — the convoy should have landed together, and did not.
      for (const item of items) {
        if (terminalWorkItemStates.includes(item.status)) continue
        const blocked = this.board.unsatisfiedDependencies(item)
        const strandedBehind = blocked.filter((dependencyId) => {
          const dependency = this.ledger.workItem(dependencyId)
          return dependency !== undefined && terminalWorkItemStates.includes(dependency.status) && !satisfiedDependencyStates.includes(dependency.status)
        })
        if (strandedBehind.length > 0) report.stranded += 1
      }
      // Next-unblocked dispatch: an open item whose gates just cleared, in a
      // convoy where something already landed, gets dispatched immediately.
      if (this.dispatcher && allItemsTerminal === false) {
        for (const item of items) {
          if (item.status !== 'open' || item.assigneeActorId) continue
          if (this.board.unsatisfiedDependencies(item).length > 0) continue
          const outcome = await this.dispatcher.dispatch(actor, this.scope, item.id)
          if (!outcome.rejection) report.dispatched += 1
        }
      }
    }
    return report
  }

  /** The operator's escape hatch: close a convoy that will not converge on its own. */
  forceClose(actor: ActorContext, convoyId: string): ConvoyRecord {
    assertCapability(actor.capabilities, 'merge:execute')
    this.require(convoyId)
    const closed = this.ledger.forceCloseConvoy(convoyId, actor.actorId, this.now().toISOString())
    if (!closed) throw new HiveError('CONVOY_STATE', `Convoy ${convoyId} is not active`)
    this.mail.send(actor, this.scope, {
      queue: 'supervisor',
      subject: 'RECOVERY_NEEDED',
      body: `Convoy ${convoyId} was force-closed by ${actor.actorId}; its unfinished work needs a decision.`,
      type: 'escalation',
      priority: 'urgent',
    })
    this.ledger.appendEvent(workEvent(actor, this.scope, 'Merge', 'convoy-forced', `convoy-forced:${convoyId}`, closed.closedAt ?? this.now().toISOString(), {
      convoyId, by: actor.actorId,
    }))
    return closed
  }

  private itemsOf(convoyId: string): WorkItem[] {
    return this.ledger.listWorkItems(this.scope).filter((item) => item.convoyId === convoyId)
  }

  private openRequestsFor(items: readonly WorkItem[]): MergeRequest[] {
    const ids = new Set(items.map((item) => item.id))
    return this.ledger
      // A request held for approval is unfinished work: a convoy that closed
      // around it would declare a landing that no approver has released.
      .listMergeRequests(this.scope, ['open', 'awaiting_approval', 'preparing', 'gated', 'landing'])
      .filter((request) => request.workItemId !== undefined && ids.has(request.workItemId))
  }

  private require(convoyId: string): ConvoyRecord {
    const convoy = this.ledger.convoy(convoyId)
    if (!convoy) throw new HiveError('CONVOY_NOT_FOUND', `Convoy ${convoyId} not found`)
    return convoy
  }
}
