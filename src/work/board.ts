import {
  ActorContext,
  IssueType,
  Lease,
  ScopeRef,
  WorkDependency,
  WorkDependencyType,
  WorkItem,
  WorkItemStatus,
  WorkPlanRevision,
  satisfiedDependencyStates,
  terminalWorkItemStates,
} from '../contracts.js'
import { assertCapability } from '../capabilities.js'
import { HiveError } from '../errors.js'
import { Ledger } from '../ledger.js'
import { Clock, ClockOptions, createId, resolveClock } from '../shared.js'
import { workEvent } from './events.js'

/** The legal transitions. `blocked` is derived from dependencies, never chosen by hand. */
const workItemTransitions: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  open: ['assigned', 'cancelled'],
  blocked: ['assigned', 'open', 'cancelled'],
  assigned: ['in_progress', 'open', 'cancelled'],
  in_progress: ['review', 'done', 'failed', 'cancelled'],
  review: ['merged', 'in_progress', 'cancelled'],
  merged: [],
  done: [],
  failed: [],
  cancelled: [],
}

/** How long a task claim holds before another claimant may take over. */
export const defaultClaimTtlMs = 24 * 60 * 60 * 1000

export interface CreateWorkItemInput {
  title: string
  description?: string
  priority?: number
  issueType?: IssueType
  convoyId?: string
  sourceTriggerId?: string
  metadata?: Record<string, unknown>
}

export interface ClaimOptions {
  ttlMs?: number
}

export interface ClaimResult {
  item: WorkItem
  lease: Lease
}

/**
 * C8: one work identity. The board owns status, dependencies, claims, and the
 * plan — the ledger owns the rows, and nothing else mutates work state. A claim
 * is a lease plus a guarded row update, so "two agents cannot hold the same
 * work" is enforced by the storage, not by caller discipline.
 */
export class WorkBoard {
  private readonly now: Clock

  constructor(private readonly ledger: Ledger, options: ClockOptions = {}) {
    this.now = resolveClock(options)
  }

  create(actor: ActorContext, scope: ScopeRef, input: CreateWorkItemInput): WorkItem {
    assertCapability(actor.capabilities, 'work:mutate')
    const title = input.title?.trim()
    if (!title) throw new HiveError('MISSING_ARGUMENT', 'A work item needs a title')
    const occurredAt = this.now().toISOString()
    const item: WorkItem = {
      id: createId(),
      scope,
      title,
      description: input.description ?? '',
      status: 'open',
      priority: input.priority ?? 0,
      issueType: input.issueType ?? 'task',
      ownerActorId: actor.actorId,
      metadata: input.metadata ?? {},
      revision: 0,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }
    if (input.convoyId) item.convoyId = input.convoyId
    if (input.sourceTriggerId) item.sourceTriggerId = input.sourceTriggerId
    this.ledger.insertWorkItem(item)
    this.record(actor, scope, 'created', `created:${item.id}`, occurredAt, { title: item.title, issueType: item.issueType }, item.id)
    return item
  }

  /** Requires `workspace:read`: observing the board is not a mutation. */
  item(actor: ActorContext, workItemId: string): WorkItem {
    assertCapability(actor.capabilities, 'workspace:read')
    return this.require(workItemId)
  }

  list(actor: ActorContext, scope?: ScopeRef, statuses?: readonly WorkItemStatus[]): WorkItem[] {
    assertCapability(actor.capabilities, 'workspace:read')
    return this.ledger.listWorkItems(scope, statuses)
  }

  dependencies(actor: ActorContext, workItemId: string): WorkDependency[] {
    assertCapability(actor.capabilities, 'workspace:read')
    this.require(workItemId)
    return this.ledger.listDependencies(workItemId)
  }

  addDependency(actor: ActorContext, workItemId: string, dependsOnId: string, type: WorkDependencyType = 'blocks'): WorkDependency {
    assertCapability(actor.capabilities, 'work:mutate')
    const item = this.require(workItemId)
    const dependency = this.require(dependsOnId)
    if (workItemId === dependsOnId) throw new HiveError('INVALID_DEPENDENCY', 'A work item cannot depend on itself')
    if (terminalWorkItemStates.includes(item.status)) throw new HiveError('WORK_ITEM_TERMINAL', `Work item ${workItemId} is already ${item.status}`)
    if (this.ledger.listDependencies(workItemId).some((existing) => existing.dependsOnId === dependsOnId)) {
      throw new HiveError('DEPENDENCY_EXISTS', `${workItemId} already depends on ${dependsOnId}`)
    }
    if (this.reaches(dependency.id, workItemId)) {
      throw new HiveError('DEPENDENCY_CYCLE', `Adding ${workItemId} → ${dependsOnId} would create a cycle`)
    }
    const occurredAt = this.now().toISOString()
    this.ledger.insertDependency({ workItemId, dependsOnId, type })
    // `blocked` is derived: a blocking dependency that is not yet satisfied puts
    // an open item behind a gate, which is the state a dispatcher reads.
    if (type === 'blocks' && item.status === 'open' && !satisfiedDependencyStates.includes(dependency.status)) {
      this.ledger.patchWorkItem(workItemId, { status: 'blocked' })
    }
    this.record(actor, item.scope, 'dependency', `dependency:${workItemId}:${dependsOnId}`, occurredAt, { dependsOnId, type }, workItemId)
    return { workItemId, dependsOnId, type }
  }

  /**
   * Claims an item: a task lease plus the guarded assignment. The loser of a
   * race gets the current state and a specific error, never a silent no-op.
   */
  claim(actor: ActorContext, workItemId: string, options: ClaimOptions = {}): ClaimResult {
    assertCapability(actor.capabilities, 'work:mutate')
    const item = this.require(workItemId)
    if (item.assigneeActorId && item.assigneeActorId !== actor.actorId) {
      throw new HiveError('WORK_ITEM_CLAIMED', `Work item ${workItemId} is assigned to ${item.assigneeActorId}`)
    }
    if (item.status !== 'open' && item.status !== 'assigned') {
      throw new HiveError('WORK_ITEM_NOT_CLAIMABLE', `Work item ${workItemId} is ${item.status}, not claimable`)
    }
    const unsatisfied = this.unsatisfiedDependencies(item)
    if (unsatisfied.length > 0) {
      throw new HiveError('WORK_ITEM_BLOCKED', `Work item ${workItemId} is blocked by ${unsatisfied.map((id) => id).join(', ')}`)
    }
    // A re-claim by the current holder is idempotent: one active lease per
    // resource means the holder cannot acquire a second, and does not need one.
    const held = this.ledger.activeLease('task', workItemId)
    if (held) {
      if (held.ownerActorId !== actor.actorId) {
        throw new HiveError('WORK_ITEM_CLAIMED', `Work item ${workItemId} is claimed by ${held.ownerActorId}`)
      }
      return { item, lease: held }
    }
    // acquireLease asserts work:dispatch and expires stale claims first (C19).
    const lease = this.ledger.acquireLease(actor, 'task', workItemId, options.ttlMs ?? defaultClaimTtlMs)
    const occurredAt = this.now().toISOString()
    const claimed = this.ledger.claimWorkItem(workItemId, actor.actorId, occurredAt)
    if (!claimed) {
      this.ledger.releaseLease(actor, lease.id)
      throw new HiveError('WORK_ITEM_CLAIMED', `Work item ${workItemId} was claimed while this claim was in flight`)
    }
    this.record(actor, item.scope, 'claimed', `claimed:${workItemId}:${claimed.revision}`, occurredAt, { assignee: actor.actorId, leaseId: lease.id }, workItemId)
    return { item: claimed, lease }
  }

  /** Transitions status along the legal edges; terminal states release the claim lease. */
  transition(actor: ActorContext, workItemId: string, to: WorkItemStatus): WorkItem {
    assertCapability(actor.capabilities, 'work:mutate')
    const item = this.require(workItemId)
    if (terminalWorkItemStates.includes(item.status)) {
      throw new HiveError('WORK_ITEM_TERMINAL', `Work item ${workItemId} is already ${item.status}`)
    }
    if (!workItemTransitions[item.status].includes(to)) {
      throw new HiveError('INVALID_TRANSITION', `Cannot move ${workItemId} from ${item.status} to ${to}`)
    }
    if (to === 'assigned' || to === 'in_progress') {
      const unsatisfied = this.unsatisfiedDependencies(item)
      if (unsatisfied.length > 0) {
        throw new HiveError('WORK_ITEM_BLOCKED', `Work item ${workItemId} is blocked by ${unsatisfied.map((id) => id).join(', ')}`)
      }
    }
    if (to === 'in_progress') {
      if (!item.assigneeActorId) throw new HiveError('WORK_ITEM_UNASSIGNED', `Work item ${workItemId} must be claimed before it starts`)
      if (item.assigneeActorId !== actor.actorId) {
        throw new HiveError('WORK_ITEM_CLAIMED', `Work item ${workItemId} is assigned to ${item.assigneeActorId}, not ${actor.actorId}`)
      }
    }
    const occurredAt = this.now().toISOString()
    const updated = this.ledger.patchWorkItem(workItemId, {
      status: to,
      closedAt: terminalWorkItemStates.includes(to) ? occurredAt : undefined,
    })
    if (terminalWorkItemStates.includes(to)) {
      // The claim outlived its purpose; the lease ends with the work, not with the TTL.
      this.ledger.cancelLeaseForResource('task', workItemId)
      this.unblockDependents(actor, workItemId, occurredAt)
    }
    this.record(actor, item.scope, 'status', `status:${workItemId}:${updated.revision}`, occurredAt, { from: item.status, to }, workItemId)
    return updated
  }

  /**
   * The plan is the blackboard projection: append-only, and writable only by
   * whoever holds the task lease — one writer is the lease, not a promise.
   */
  plan(actor: ActorContext, workItemId: string, body: string): WorkPlanRevision {
    assertCapability(actor.capabilities, 'work:mutate')
    const item = this.require(workItemId)
    const lease = this.ledger.activeLease('task', workItemId)
    if (!lease || lease.ownerActorId !== actor.actorId) {
      throw new HiveError('WORK_ITEM_NOT_CLAIMED', `Only the claimant of ${workItemId} can write its plan`)
    }
    const occurredAt = this.now().toISOString()
    const revision = this.ledger.upsertWorkPlan(workItemId, body, actor.actorId, occurredAt)
    this.record(actor, item.scope, 'plan', `plan:${workItemId}:${revision.revision}`, occurredAt, { revision: revision.revision, bytes: body.length }, workItemId)
    return revision
  }

  planOf(actor: ActorContext, workItemId: string): WorkPlanRevision | undefined {
    assertCapability(actor.capabilities, 'workspace:read')
    this.require(workItemId)
    return this.ledger.workPlan(workItemId)
  }

  planHistory(actor: ActorContext, workItemId: string): WorkPlanRevision[] {
    assertCapability(actor.capabilities, 'workspace:read')
    this.require(workItemId)
    return this.ledger.workPlanHistory(workItemId)
  }

  /** Every `blocks` dependency not yet satisfied — the item's actual gates. */
  unsatisfiedDependencies(item: WorkItem): string[] {
    return this.ledger
      .listDependencies(item.id)
      .filter((dependency) => dependency.type === 'blocks')
      .map((dependency) => this.ledger.workItem(dependency.dependsOnId))
      .filter((dependency): dependency is WorkItem => dependency !== undefined && !satisfiedDependencyStates.includes(dependency.status))
      .map((dependency) => dependency.id)
  }

  private unblockDependents(actor: ActorContext, workItemId: string, occurredAt: string): void {
    for (const dependent of this.ledger.listDependents(workItemId)) {
      const item = this.ledger.workItem(dependent.workItemId)
      if (!item || item.status !== 'blocked') continue
      if (this.unsatisfiedDependencies(item).length > 0) continue
      const updated = this.ledger.patchWorkItem(item.id, { status: 'open' })
      this.record(actor, item.scope, 'status', `status:${item.id}:${updated.revision}`, occurredAt, { from: 'blocked', to: 'open', reason: 'dependencies satisfied' }, item.id)
    }
  }

  /** Walks the depends-on edges from `from`, looking for `target`: the cycle guard. */
  private reaches(from: string, target: string): boolean {
    const seen = new Set<string>()
    const queue = [from]
    while (queue.length > 0) {
      const current = queue.pop()!
      if (current === target) return true
      if (seen.has(current)) continue
      seen.add(current)
      for (const dependency of this.ledger.listDependencies(current)) queue.push(dependency.dependsOnId)
    }
    return false
  }

  private require(workItemId: string): WorkItem {
    const item = this.ledger.workItem(workItemId)
    if (!item) throw new HiveError('WORK_ITEM_NOT_FOUND', `Work item ${workItemId} not found`)
    return item
  }

  private record(actor: ActorContext, scope: ScopeRef, action: string, key: string, occurredAt: string, payload: Record<string, unknown>, workItemId?: string): void {
    this.ledger.appendEvent(workEvent(actor, scope, 'Work', action, key, occurredAt, payload, workItemId))
  }
}
