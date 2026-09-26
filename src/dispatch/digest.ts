import { ActorContext, FleetDigest, RunState, ScopeRef, WorkItemStatus } from '../contracts.js'
import { assertCapability } from '../capabilities.js'
import { Ledger } from '../ledger.js'
import { Clock, ClockOptions, resolveClock } from '../shared.js'
import { MailService } from '../work/mail.js'
import { workEvent } from '../work/events.js'

/**
 * The one scheduled task Phase 5 calls for by name: a weekly digest of the
 * fleet, mailed to the supervision queue. Counts, not contents — the digest is
 * a nudge to look, not a second place to look at.
 */
export function weeklyDigest(options: DigestOptions): (actor: ActorContext, scope: ScopeRef) => FleetDigest {
  const now = resolveClock(options)
  return (actor: ActorContext, scope: ScopeRef) => {
    assertCapability(actor.capabilities, 'work:dispatch')
    const ledger = options.ledger
    const liveStates: readonly RunState[] = ['spawning', 'running', 'idle', 'completing', 'stalled']
    const digest: FleetDigest = {
      generatedAt: now().toISOString(),
      liveRuns: ledger.listRuns(scope, liveStates).length,
      openTasks: countBy(ledger, scope, ['open']),
      blockedTasks: countBy(ledger, scope, ['blocked']),
      inFlightTasks: countBy(ledger, scope, ['assigned', 'in_progress', 'review']),
      completedTasks: countBy(ledger, scope, terminalWorkStatuses),
      // Run states that mean "a supervisor had to intervene" (§6.3).
      escalations: ledger.listRuns(scope, ['escalated']).length,
    }
    options.mail.send(actor, scope, {
      queue: 'supervisor',
      subject: 'Weekly status digest',
      body: [
        `Fleet digest as of ${digest.generatedAt}`,
        `live runs: ${digest.liveRuns}`,
        `open tasks: ${digest.openTasks} (blocked: ${digest.blockedTasks})`,
        `in flight: ${digest.inFlightTasks}, completed: ${digest.completedTasks}`,
        `escalations: ${digest.escalations}`,
      ].join('\n'),
      type: 'notification',
      priority: 'low',
    })
    ledger.appendEvent(workEvent(actor, scope, 'System', 'digest', `digest:${digest.generatedAt}`, digest.generatedAt, { ...digest }))
    return digest
  }
}

export interface DigestOptions extends ClockOptions {
  ledger: Ledger
  mail: MailService
}

const terminalWorkStatuses: readonly WorkItemStatus[] = ['merged', 'done', 'failed', 'cancelled']

function countBy(ledger: Ledger, scope: ScopeRef, statuses: readonly WorkItemStatus[]): number {
  return ledger.listWorkItems(scope, statuses).length
}
