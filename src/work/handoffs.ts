import { sep } from 'node:path'
import { isAbsolute, resolve } from 'node:path'
import { ActorContext, Handoff, HandoffView, ScopeRef } from '../contracts.js'
import { assertCapability } from '../capabilities.js'
import { HiveError } from '../errors.js'
import { Ledger } from '../ledger.js'
import { Clock, ClockOptions, createId, resolveClock } from '../shared.js'
import { workEvent } from './events.js'

/** How long an unaccepted handoff stays eligible before expiring. */
export const defaultHandoffTtlMs = 24 * 60 * 60 * 1000

/**
 * Whether `child` is inside the `root` boundary (or is the boundary itself).
 * Windows paths compare case-insensitively because the filesystem does.
 */
export function isWithinBoundary(child: string, root: string): boolean {
  const resolvedChild = resolve(child)
  const resolvedRoot = resolve(root)
  const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value)
  if (fold(resolvedChild) === fold(resolvedRoot)) return true
  return fold(resolvedChild).startsWith(fold(resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep))
}

export interface CreateHandoffInput {
  toAgentId?: string
  cwd: string
  summary: string
  openQuestions?: string[]
  filesTouched?: string[]
  nextSteps?: string[]
}

/**
 * Handoffs are the S1 seam between sessions: durable context a finishing agent
 * leaves for the next one. Acceptance is a claim — one session takes it — and
 * the cwd boundary plus the addressee decide who is eligible.
 */
export class HandoffService {
  private readonly now: Clock

  constructor(private readonly ledger: Ledger, options: ClockOptions = {}) {
    this.now = resolveClock(options)
  }

  create(actor: ActorContext, scope: ScopeRef, input: CreateHandoffInput): Handoff {
    assertCapability(actor.capabilities, 'work:mutate')
    const summary = input.summary?.trim()
    if (!summary) throw new HiveError('MISSING_ARGUMENT', 'A handoff needs a summary')
    if (!isAbsolute(input.cwd)) throw new HiveError('INVALID_ARGUMENT', `A handoff cwd must be absolute, got: ${input.cwd}`)
    const occurredAt = this.now().toISOString()
    const handoff: Handoff = {
      id: createId(),
      scope,
      fromActorId: actor.actorId,
      toAgentId: input.toAgentId,
      cwd: resolve(input.cwd),
      summary,
      openQuestions: input.openQuestions ?? [],
      filesTouched: input.filesTouched ?? [],
      nextSteps: input.nextSteps ?? [],
      state: 'open',
      createdAt: occurredAt,
    }
    this.ledger.insertHandoff(handoff)
    this.ledger.appendEvent(workEvent(actor, scope, 'Work', 'handoff-created', `handoff-created:${handoff.id}`, occurredAt, {
      id: handoff.id, toAgentId: handoff.toAgentId, cwd: handoff.cwd,
    }))
    return handoff
  }

  handoff(actor: ActorContext, handoffId: string): Handoff {
    assertCapability(actor.capabilities, 'workspace:read')
    const handoff = this.ledger.handoff(handoffId)
    if (!handoff) throw new HiveError('HANDOFF_NOT_FOUND', `Handoff ${handoffId} not found`)
    return handoff
  }

  list(actor: ActorContext, scope?: ScopeRef, states?: readonly Handoff['state'][]): Handoff[] {
    assertCapability(actor.capabilities, 'workspace:read')
    return this.ledger.listHandoffs(scope, states)
  }

  /**
   * Accepting is claiming: the guarded update makes a handoff single-taker.
   * Ownership filtering (the addressee) and the cwd boundary are checked before
   * the claim, so a session cannot take a handoff addressed elsewhere or rooted
   * outside where it actually works.
   */
  accept(actor: ActorContext, handoffId: string, options: { cwd?: string } = {}): Handoff {
    assertCapability(actor.capabilities, 'work:mutate')
    const handoff = this.ledger.handoff(handoffId)
    if (!handoff) throw new HiveError('HANDOFF_NOT_FOUND', `Handoff ${handoffId} not found`)
    if (handoff.state !== 'open') {
      throw new HiveError('HANDOFF_NOT_OPEN', `Handoff ${handoffId} is ${handoff.state}`)
    }
    if (handoff.toAgentId && actor.agentId !== handoff.toAgentId) {
      throw new HiveError('HANDOFF_ADDRESSED_ELSEWHERE', `Handoff ${handoffId} is addressed to agent ${handoff.toAgentId}`)
    }
    if (options.cwd && !isWithinBoundary(options.cwd, handoff.cwd)) {
      throw new HiveError('HANDOFF_OUTSIDE_BOUNDARY', `Handoff ${handoffId} is rooted at ${handoff.cwd}, outside the session's ${options.cwd}`)
    }
    const occurredAt = this.now().toISOString()
    const accepted = this.ledger.acceptHandoff(handoffId, actor.actorId, actor.actorId, occurredAt)
    if (!accepted) {
      throw new HiveError('HANDOFF_NOT_OPEN', `Handoff ${handoffId} was accepted while this acceptance was in flight`)
    }
    this.ledger.appendEvent(workEvent(actor, accepted.scope, 'Work', 'handoff-accepted', `handoff-accepted:${accepted.id}`, occurredAt, {
      id: accepted.id, acceptedBy: actor.actorId,
    }))
    return accepted
  }

  /** Only the author can cancel, and only while open — an accepted handoff is work in progress. */
  cancel(actor: ActorContext, handoffId: string): Handoff {
    assertCapability(actor.capabilities, 'work:mutate')
    const cancelled = this.ledger.cancelHandoff(handoffId, actor.actorId)
    if (!cancelled) {
      const handoff = this.ledger.handoff(handoffId)
      if (!handoff) throw new HiveError('HANDOFF_NOT_FOUND', `Handoff ${handoffId} not found`)
      throw new HiveError('HANDOFF_NOT_CANCELLABLE', `Handoff ${handoffId} is ${handoff.state} and not cancellable by ${actor.actorId}`)
    }
    const occurredAt = this.now().toISOString()
    this.ledger.appendEvent(workEvent(actor, cancelled.scope, 'Work', 'handoff-cancelled', `handoff-cancelled:${cancelled.id}`, occurredAt, {
      id: cancelled.id,
    }))
    return cancelled
  }

  /** Expires unaccepted handoffs older than the TTL; returns how many went. */
  expire(actor: ActorContext, scope: ScopeRef, olderThanMs: number = defaultHandoffTtlMs): number {
    assertCapability(actor.capabilities, 'work:mutate')
    const cutoff = new Date(this.now().getTime() - olderThanMs).toISOString()
    const expired = this.ledger.expireHandoffs(cutoff)
    if (expired > 0) {
      this.ledger.appendEvent(workEvent(actor, scope, 'Work', 'handoff-expired', `handoff-expired:${cutoff}`, cutoff, { expired }))
    }
    return expired
  }

  /**
   * The open handoffs a session is eligible for: unaddressed or addressed to
   * this agent, and rooted inside the session's cwd. Oldest first, so the
   * packet compiler's selection is deterministic.
   */
  eligible(actor: ActorContext, scope: ScopeRef, agentId: string, cwd?: string): Handoff[] {
    assertCapability(actor.capabilities, 'workspace:read')
    return this.ledger
      .listHandoffs(scope, ['open'])
      .filter((handoff) => !handoff.toAgentId || handoff.toAgentId === agentId)
      .filter((handoff) => !cwd || isWithinBoundary(cwd, handoff.cwd))
  }

  /** The packet projection of an accepted handoff: content and acceptance, nothing else. */
  toView(handoff: Handoff): HandoffView {
    if (handoff.state !== 'accepted' || !handoff.acceptedAt) {
      throw new HiveError('HANDOFF_NOT_ACCEPTED', `Handoff ${handoff.id} is ${handoff.state}; a packet carries accepted handoffs only`)
    }
    return {
      id: handoff.id,
      fromActorId: handoff.fromActorId,
      cwd: handoff.cwd,
      summary: handoff.summary,
      openQuestions: handoff.openQuestions,
      filesTouched: handoff.filesTouched,
      nextSteps: handoff.nextSteps,
      acceptedAt: handoff.acceptedAt,
    }
  }
}
