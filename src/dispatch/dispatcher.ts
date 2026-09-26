import {
  ActorContext,
  Agent,
  Capability,
  DispatchOutcome,
  Run,
  ScopeRef,
  WorkItem,
} from '../contracts.js'
import { assertCapability } from '../capabilities.js'
import { HiveError } from '../errors.js'
import { Ledger } from '../ledger.js'
import { RunManager } from '../runtime/run-manager.js'
import { Clock, ClockOptions, resolveClock } from '../shared.js'
import { PacketCompiler } from '../work/packet.js'
import { WorkBoard } from '../work/board.js'
import { workEvent } from '../work/events.js'

/**
 * What a dispatched agent may do: read its task, claim it, hold the dispatch
 * lease, run, and read the context its packet is compiled from. It deliberately
 * excludes everything else — a dispatched agent steers itself, not the fleet.
 */
export const dispatchedAgentCapabilities: readonly Capability[] = ['workspace:read', 'work:mutate', 'work:dispatch', 'runtime:control', 'context:read']

/** The actor a dispatch acts through: the agent itself, not whoever dispatched. */
export function agentActor(agent: Agent): ActorContext {
  return {
    actorId: agent.id,
    actorType: 'agent',
    displayName: agent.name,
    source: 'internal',
    capabilities: [...dispatchedAgentCapabilities],
    agentId: agent.id,
  }
}

export interface RegisterAgentInput {
  agentId: string
  name?: string
  profileId: string
  cwd?: string
  skills?: string[]
  energy?: number
  maxEnergy?: number
}

export interface RouteContext {
  agents: readonly Agent[]
  /** Live runs per agent id: energy is what is left after the work already in flight. */
  liveRuns?: ReadonlyMap<string, number>
}

export interface RouteDecision {
  agent: Agent
  reason: 'worker' | 'skill' | 'energy'
}

export interface IntakeInput {
  title: string
  description?: string
  priority?: number
  /** Skills the task wants; routed by overlap when agents declare them. */
  requiredSkills?: string[]
  /** The trigger that caused this work; a trigger produces at most one item (dedupe). */
  sourceTriggerId?: string
}

export interface IntakeResult {
  item: WorkItem
  /** Present when a dispatch was attempted; absent when the trigger was a duplicate. */
  outcome?: DispatchOutcome
  /** True when this trigger had already produced its item, so nothing new was created. */
  duplicate: boolean
}

/**
 * The routing decision, pure and total: same task, same fleet, same answer.
 *
 * Order is the policy: an assigned item stays with its worker, a task that
 * names skills goes to an agent that has them, and everything else goes to
 * whoever has the most energy left after the runs it is already carrying. Ties
 * break by agent id, so the decision is a function of state, not of time.
 */
export function route(item: WorkItem, context: RouteContext): RouteDecision | undefined {
  const liveRuns = context.liveRuns ?? new Map<string, number>()
  const effectiveEnergy = (agent: Agent) => agent.energy - (liveRuns.get(agent.id) ?? 0)

  // Worker routing: the item names its agent, and that assignment is a promise.
  if (item.assigneeActorId) {
    const named = context.agents.find((agent) => agent.id === item.assigneeActorId)
    if (named) return { agent: named, reason: 'worker' }
  }

  // Skill routing: a task that names skills needs an agent that has all of them.
  const required = requiredSkillsOf(item)
  if (required && required.length > 0) {
    const qualified = context.agents.filter((agent) => required.every((skill) => agent.skills.includes(skill)))
    if (qualified.length === 0) return undefined
    return { agent: byEnergy(qualified, effectiveEnergy), reason: 'skill' }
  }

  // Energy routing: the rest goes to the best-rested agent that still has one to spend.
  return { agent: byEnergy(context.agents, effectiveEnergy), reason: 'energy' }
}

function byEnergy(agents: readonly Agent[], energy: (agent: Agent) => number): Agent {
  return [...agents].sort((a, b) => energy(b) - energy(a) || (a.id < b.id ? -1 : 1))[0]
}

function requiredSkillsOf(item: WorkItem): string[] | undefined {
  const value = item.metadata.requiredSkills
  return Array.isArray(value) ? (value as string[]) : undefined
}

export interface DispatcherOptions extends ClockOptions {
  /** The fleet's home scope: where fleet-level events (registration, rest) are recorded. */
  scope: ScopeRef
}

/**
 * Phase 5's dispatcher: turns work items into runs. One dispatch is one claim,
 * one packet, one launch, one unit of energy — and a second dispatch of the
 * same item cannot happen, because the claim is the guard.
 */
export class Dispatcher {
  private readonly now: Clock
  private readonly scope: ScopeRef

  constructor(
    private readonly ledger: Ledger,
    private readonly board: WorkBoard,
    private readonly packets: PacketCompiler,
    private readonly manager: RunManager,
    options: DispatcherOptions,
  ) {
    this.now = resolveClock(options)
    this.scope = options.scope
  }

  registerAgent(actor: ActorContext, input: RegisterAgentInput): Agent {
    assertCapability(actor.capabilities, 'work:dispatch')
    const agentId = input.agentId?.trim()
    if (!agentId) throw new HiveError('MISSING_ARGUMENT', 'An agent needs an id')
    const maxEnergy = input.maxEnergy ?? input.energy ?? 10
    const energy = Math.min(input.energy ?? maxEnergy, maxEnergy)
    const occurredAt = this.now().toISOString()
    const agent: Agent = {
      id: agentId,
      name: input.name ?? agentId,
      profileId: input.profileId,
      cwd: input.cwd,
      skills: input.skills ?? [],
      energy,
      maxEnergy: maxEnergy,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }
    this.ledger.upsertAgent(agent)
    this.ledger.appendEvent(workEvent(actor, this.scope, 'Work', 'agent-registered', `agent-registered:${agent.id}`, occurredAt, {
      agentId: agent.id, profileId: agent.profileId, skills: agent.skills, energy: agent.energy,
    }))
    return agent
  }

  agents(actor: ActorContext): Agent[] {
    assertCapability(actor.capabilities, 'workspace:read')
    return this.ledger.listAgents()
  }

  /** The routing decision without dispatching: what would happen, and why. */
  routeOf(actor: ActorContext, workItemId: string): RouteDecision | undefined {
    assertCapability(actor.capabilities, 'workspace:read')
    const item = this.board.item(actor, workItemId)
    return route(item, { agents: this.ledger.listAgents(), liveRuns: this.liveRuns() })
  }

  /**
   * A trigger's entry point: one trigger produces at most one item, and that
   * item is dispatched immediately when a route exists. Re-firing the trigger
   * is a no-op that returns the original item — the dedupe is the point.
   */
  intake(actor: ActorContext, scope: ScopeRef, input: IntakeInput): Promise<IntakeResult> {
    assertCapability(actor.capabilities, 'work:dispatch')
    if (input.sourceTriggerId) {
      const existing = this.ledger.workItemByTrigger(input.sourceTriggerId)
      if (existing) return Promise.resolve({ item: existing, duplicate: true })
    }
    const item = this.board.create(actor, scope, {
      title: input.title,
      description: input.description,
      priority: input.priority,
      sourceTriggerId: input.sourceTriggerId,
      metadata: input.requiredSkills ? { requiredSkills: input.requiredSkills } : {},
    })
    return this.dispatch(actor, scope, item.id).then((outcome) => ({ item, outcome, duplicate: false }))
  }

  /**
   * Dispatches one work item: claim for the routed agent, compile its packet,
   * launch its run, spend one unit of energy. The claim is the duplicate guard:
   * a second dispatch of an item in flight is refused with the current owner.
   */
  dispatch(actor: ActorContext, scope: ScopeRef, workItemId: string): Promise<DispatchOutcome> {
    assertCapability(actor.capabilities, 'work:dispatch')
    const occurredAt = this.now().toISOString()
    const item = this.board.item(actor, workItemId)
    const decision = route(item, { agents: this.ledger.listAgents(), liveRuns: this.liveRuns() })
    if (!decision) {
      return Promise.resolve(this.rejected(actor, scope, item, occurredAt, { reason: 'no_eligible_agent', candidates: this.ledger.listAgents().length }))
    }
    const live = this.liveRuns().get(decision.agent.id) ?? 0
    if (decision.agent.energy - live <= 0) {
      return Promise.resolve(this.rejected(actor, scope, item, occurredAt, { reason: 'energy_exhausted', agentId: decision.agent.id }))
    }
    const agent = decision.agent
    const runAs = agentActor(agent)
    this.ledger.ensureActor(runAs)
    try {
      this.board.claim(runAs, workItemId)
      this.board.transition(runAs, workItemId, 'in_progress')
      const packet = this.packets.compile(runAs, scope, { taskId: workItemId, agentId: agent.id, cwd: agent.cwd })
      const launched = this.manager.launch(runAs, {
        profileId: agent.profileId,
        workspace: scope.workspaceName,
        project: scope.projectName,
        workItemId,
        agentId: agent.id,
        prompt: this.packets.render(packet),
      })
      // The claim, packet, and launch hold: only the await is deferred, so a
      // concurrent dispatch of this item loses on the claim, not on a race here.
      return launched.then(
        (run) => {
          this.ledger.setAgentEnergy(agent.id, agent.energy - 1, occurredAt)
          this.ledger.appendEvent(workEvent(actor, scope, 'Work', 'dispatched', `dispatched:${workItemId}:${run.id}`, occurredAt, {
            taskId: workItemId, agentId: agent.id, runId: run.id, reason: decision.reason,
          }, workItemId))
          return { taskId: workItemId, agent, runId: run.id, occurredAt }
        },
        (error: unknown) =>
          this.rejected(actor, scope, item, occurredAt, {
            reason: 'launch_failed', agentId: agent.id, error: error instanceof Error ? error.message : String(error),
          }),
      )
    } catch (error) {
      // The claim may have landed while the launch refused to start: the work
      // is held, not lost — the operator sees an assigned item with no run.
      return Promise.resolve(this.rejected(actor, scope, item, occurredAt, {
        reason: 'launch_failed', agentId: agent.id, error: error instanceof Error ? error.message : String(error),
      }))
    }
  }

  /**
   * The rest tick: every agent gains back one unit, up to its maximum. The
   * scheduler calls this on its own cadence; nothing else restores energy.
   */
  rest(actor: ActorContext): number {
    assertCapability(actor.capabilities, 'work:dispatch')
    const occurredAt = this.now().toISOString()
    let restored = 0
    for (const agent of this.ledger.listAgents()) {
      if (agent.energy >= agent.maxEnergy) continue
      this.ledger.setAgentEnergy(agent.id, agent.energy + 1, occurredAt)
      restored += 1
    }
    if (restored > 0) {
      this.ledger.appendEvent(workEvent(actor, this.scope, 'Work', 'rest', `rest:${occurredAt}`, occurredAt, { restored }))
    }
    return restored
  }

  /** Live runs per agent: the dispatcher's view of who is carrying what. */
  liveRuns(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const runId of this.manager.liveRunIds()) {
      const run: Run | undefined = this.manager.get(runId)
      if (!run?.agentId) continue
      counts.set(run.agentId, (counts.get(run.agentId) ?? 0) + 1)
    }
    return counts
  }

  private rejected(actor: ActorContext, scope: ScopeRef, item: WorkItem, occurredAt: string, rejection: DispatchOutcome['rejection']): DispatchOutcome {
    this.ledger.appendEvent(workEvent(actor, scope, 'Work', 'dispatch-rejected', `dispatch-rejected:${item.id}:${occurredAt}`, occurredAt, {
      taskId: item.id, rejection,
    }, item.id))
    return { taskId: item.id, rejection, occurredAt }
  }
}
