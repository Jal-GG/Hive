import { ActorContext, IssueType, ScopeRef, TriggerRecord, WorkflowDefinition, WorkflowRun, WorkflowStep, WorkflowSchedule } from './contracts.js'
import { assertCapability } from './capabilities.js'
import { HiveError } from './errors.js'
import { Ledger } from './ledger.js'
import { Clock, ClockOptions, createId, resolveClock } from './shared.js'
import { WorkBoard } from './work/board.js'
import { workEvent } from './work/events.js'

const versionPattern = /^\d+\.\d+\.\d+$/
const triggerKinds: readonly TriggerRecord['kind'][] = ['manual', 'webhook', 'github', 'slack', 'feed', 'schedule']

export interface WorkflowServiceOptions extends ClockOptions {
  ledger: Ledger
  board: WorkBoard
}

export interface TriggerInput {
  id: string
  kind: TriggerRecord['kind']
  workflowId: string
  version?: string
  payload?: Record<string, unknown>
}

export class WorkflowService {
  private readonly ledger: Ledger
  private readonly board: WorkBoard
  private readonly now: Clock

  constructor(options: WorkflowServiceOptions) {
    this.ledger = options.ledger
    this.board = options.board
    this.now = resolveClock(options)
  }

  register(actor: ActorContext, input: Omit<WorkflowDefinition, 'createdBy' | 'createdAt' | 'updatedAt'>): WorkflowDefinition {
    assertCapability(actor.capabilities, 'work:mutate')
    validateDefinition(input)
    const timestamp = this.now().toISOString()
    const definition: WorkflowDefinition = { ...input, createdBy: actor.actorId, createdAt: timestamp, updatedAt: timestamp }
    this.ledger.upsertWorkflow(definition)
    return definition
  }

  trigger(actor: ActorContext, scope: ScopeRef, input: TriggerInput): { trigger: TriggerRecord; run?: WorkflowRun; duplicate: boolean } {
    assertCapability(actor.capabilities, 'work:dispatch')
    if (!input.id.trim()) throw new HiveError('INVALID_ARGUMENT', 'Trigger id is required')
    if (!triggerKinds.includes(input.kind)) throw new HiveError('INVALID_ARGUMENT', `Unknown trigger kind: ${input.kind}`)
    const definition = this.ledger.workflow(input.workflowId, input.version)
    if (!definition || !definition.enabled) throw new HiveError('WORKFLOW_NOT_FOUND', `Enabled workflow ${input.workflowId} was not found`)
    const timestamp = this.now().toISOString()
    const run: WorkflowRun = { id: createId(), scope, workflowId: definition.id, workflowVersion: definition.version, triggerId: input.id, state: 'queued', workItemIds: [], createdAt: timestamp, updatedAt: timestamp }
    const inserted = this.ledger.insertWorkflowRun(run)
    if (!inserted) {
      const existing = this.ledger.workflowRunByTrigger(input.id)
      const trigger: TriggerRecord = { id: input.id, scope, kind: input.kind, workflowId: input.workflowId, payload: input.payload ?? {}, state: 'duplicate', workflowRunId: existing?.id, createdAt: timestamp }
      this.ledger.insertTrigger(trigger)
      return { trigger, run: existing, duplicate: true }
    }
    const workItemIds = definition.steps.map((step) => this.board.create(actor, scope, {
      title: step.title, description: step.description, priority: step.priority, issueType: step.issueType as IssueType | undefined,
      metadata: { workflowId: definition.id, workflowVersion: definition.version, workflowStepId: step.id },
    }).id)
    const completed = this.ledger.updateWorkflowRun(run.id, 'completed', timestamp, workItemIds, timestamp)
    const accepted: TriggerRecord = { id: input.id, scope, kind: input.kind, workflowId: input.workflowId, payload: input.payload ?? {}, state: 'accepted', workflowRunId: run.id, createdAt: timestamp }
    this.ledger.insertTrigger(accepted)
    return { trigger: accepted, run: completed ?? { ...run, state: 'completed', workItemIds, completedAt: timestamp }, duplicate: false }
  }

  cancel(actor: ActorContext, runId: string): WorkflowRun {
    assertCapability(actor.capabilities, 'work:mutate')
    const run = this.ledger.workflowRun(runId)
    if (!run) throw new HiveError('WORKFLOW_RUN_NOT_FOUND', `Workflow run ${runId} was not found`)
    const timestamp = this.now().toISOString()
    const cancelled = this.ledger.updateWorkflowRun(runId, 'cancelled', timestamp, run.workItemIds, undefined, timestamp)
    if (!cancelled) throw new HiveError('WORKFLOW_ALREADY_TERMINAL', `Workflow run ${runId} is already terminal`)
    this.record(actor, run.scope, 'workflow-cancelled', `workflow-run:${runId}`, timestamp, { runId })
    return cancelled
  }

  schedule(actor: ActorContext, input: Omit<WorkflowSchedule, 'scope' | 'createdBy' | 'createdAt' | 'updatedAt'> & { scope: ScopeRef }): WorkflowSchedule {
    assertCapability(actor.capabilities, 'work:mutate')
    if (!input.id || input.intervalMs < 1000 || !Number.isFinite(input.intervalMs)) throw new HiveError('SCHEDULE_INVALID', 'Schedule id and interval of at least one second are required')
    if (!this.ledger.workflow(input.workflowId)) throw new HiveError('WORKFLOW_NOT_FOUND', `Workflow ${input.workflowId} was not found`)
    const timestamp = this.now().toISOString()
    const schedule: WorkflowSchedule = { ...input, createdBy: actor.actorId, createdAt: timestamp, updatedAt: timestamp }
    this.ledger.upsertWorkflowSchedule(schedule)
    return schedule
  }

  schedules(scope: ScopeRef, state?: WorkflowSchedule['state']): WorkflowSchedule[] {
    return this.ledger.listWorkflowSchedules(scope, state)
  }

  setScheduleState(actor: ActorContext, id: string, state: WorkflowSchedule['state']): WorkflowSchedule {
    assertCapability(actor.capabilities, 'work:mutate')
    const schedule = this.ledger.workflowSchedule(id)
    if (!schedule) throw new HiveError('SCHEDULE_NOT_FOUND', `Schedule ${id} was not found`)
    const updated = this.ledger.updateWorkflowSchedule(id, state, schedule.nextRunAt, this.now().toISOString())
    if (!updated) throw new HiveError('SCHEDULE_NOT_FOUND', `Schedule ${id} was not found`)
    return updated
  }

  tick(actor: ActorContext, at = this.now()): number {
    assertCapability(actor.capabilities, 'work:dispatch')
    const timestamp = at.toISOString()
    let triggered = 0
    for (const schedule of this.ledger.dueWorkflowSchedules(timestamp)) {
      this.trigger(actor, schedule.scope, { id: `schedule:${schedule.id}:${schedule.nextRunAt}`, kind: 'schedule', workflowId: schedule.workflowId })
      this.ledger.updateWorkflowSchedule(schedule.id, 'enabled', new Date(at.getTime() + schedule.intervalMs).toISOString(), timestamp)
      triggered += 1
    }
    return triggered
  }

  private record(actor: ActorContext, scope: ScopeRef, action: string, key: string, occurredAt: string, payload: Record<string, unknown>): void {
    this.ledger.appendEvent(workEvent(actor, scope, 'Trigger', action, key, occurredAt, payload))
  }
}

function validateDefinition(input: Omit<WorkflowDefinition, 'createdBy' | 'createdAt' | 'updatedAt'>): void {
  if (!input.id || !/^[a-z0-9][a-z0-9._-]*$/.test(input.id)) throw new HiveError('WORKFLOW_INVALID', 'Workflow id must be lowercase and path-safe')
  if (!versionPattern.test(input.version)) throw new HiveError('WORKFLOW_INVALID', 'Workflow version must be major.minor.patch')
  if (!input.name.trim()) throw new HiveError('WORKFLOW_INVALID', 'Workflow name is required')
  if (!Array.isArray(input.steps) || input.steps.length === 0) throw new HiveError('WORKFLOW_INVALID', 'Workflow needs at least one step')
  for (const step of input.steps) validateStep(step)
}

function validateStep(step: WorkflowStep): void {
  if (!step.id || !/^[a-z0-9][a-z0-9._-]*$/.test(step.id)) throw new HiveError('WORKFLOW_INVALID', 'Workflow step id must be lowercase and path-safe')
  if (step.type !== 'create_work') throw new HiveError('WORKFLOW_INVALID', `Unsupported workflow step: ${step.type}`)
  if (!step.title.trim()) throw new HiveError('WORKFLOW_INVALID', 'Workflow step title is required')
  if (step.requiredSkills?.some((skill) => !/^[a-z0-9][a-z0-9._-]*$/.test(skill))) throw new HiveError('WORKFLOW_INVALID', 'Workflow skill tags must be path-safe')
}
