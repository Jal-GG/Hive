import { ActorContext, IssueType, ScopeRef, TriggerRecord, WorkflowDefinition, WorkflowRun, WorkflowStep, WorkflowSchedule } from './contracts.js'
import { AdmissionRefusal, TriggerAdmission, TriggerAdmissionPolicy } from './admission.js'
import { assertCapability } from './capabilities.js'
import { HiveError } from './errors.js'
import { Ledger } from './ledger.js'
import { Clock, ClockOptions, createId, resolveClock } from './shared.js'
import { WorkBoard } from './work/board.js'
import { workEvent } from './work/events.js'

const versionPattern = /^\d+\.\d+\.\d+$/
const triggerKinds: readonly TriggerRecord['kind'][] = ['manual', 'webhook', 'github', 'slack', 'feed', 'schedule']

/** The control_settings key holding the operator's persisted ingress policy. */
export const admissionSettingKey = 'trigger.admission'

export interface WorkflowServiceOptions extends ClockOptions {
  ledger: Ledger
  board: WorkBoard
  /** §5.7 ingress policy. Defaults admit everything; the gate is still live. */
  admission?: TriggerAdmissionPolicy
  /** Cost incurred in a scope, in USD, for the spend cap. Absent means uncapped. */
  spend?: (scope: ScopeRef) => number
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
  private readonly admission: TriggerAdmission

  constructor(options: WorkflowServiceOptions) {
    this.ledger = options.ledger
    this.board = options.board
    this.now = resolveClock(options)
    this.admission = new TriggerAdmission(options.admission ?? {}, {
      now: this.now,
      admittedSince: (scope, since) => this.ledger.listWorkflowRuns(scope).filter((run) => run.createdAt >= since).length,
      spend: options.spend,
      // Persisted, so `hive workflow pause` in one process stops another.
      readPolicy: () => {
        const raw = this.ledger.setting(admissionSettingKey)
        if (!raw) return undefined
        try {
          return JSON.parse(raw) as TriggerAdmissionPolicy
        } catch {
          // A corrupt setting must not wedge ingress; the deployment default stands.
          return undefined
        }
      },
      writePolicy: (policy) => this.ledger.setSetting(admissionSettingKey, JSON.stringify(policy), this.now().toISOString()),
    })
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

    // Idempotency precedes admission (§5.7). A retried delivery of an event that
    // was already accepted is a duplicate, not fresh work — so a pause or an
    // exhausted quota must not turn an accepted event into an error.
    const prior = this.ledger.workflowRunByTrigger(input.id)
    if (prior) return { trigger: this.recordDuplicate(scope, input, prior.id), run: prior, duplicate: true }

    // §5.7: the policy check sits after validation and before anything is enqueued.
    // It lives here, not in the adapters, so no ingress can bypass it.
    const decision = this.admission.evaluate(actor, scope, input.kind)
    if (!decision.admitted) {
      this.recordRefusal(scope, input, decision.reason, decision.detail)
      throw new HiveError('TRIGGER_REFUSED', `${decision.reason}: ${decision.detail}`)
    }
    const timestamp = this.now().toISOString()
    const run: WorkflowRun = { id: createId(), scope, workflowId: definition.id, workflowVersion: definition.version, triggerId: input.id, state: 'queued', workItemIds: [], createdAt: timestamp, updatedAt: timestamp }
    const inserted = this.ledger.insertWorkflowRun(run)
    if (!inserted) {
      // A concurrent caller won the same trigger id between the check and here.
      const existing = this.ledger.workflowRunByTrigger(input.id)
      return { trigger: this.recordDuplicate(scope, input, existing?.id), run: existing, duplicate: true }
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

  /** Operator stop/resume for the whole ingress (§5.7 pause). */
  setPaused(actor: ActorContext, scope: ScopeRef, paused: boolean): TriggerAdmissionPolicy {
    assertCapability(actor.capabilities, 'work:mutate')
    const timestamp = this.now().toISOString()
    this.record(actor, scope, paused ? 'trigger-paused' : 'trigger-resumed', `ingress:${paused}`, timestamp, { paused })
    return this.admission.setPaused(paused)
  }

  admissionPolicy(): TriggerAdmissionPolicy {
    return this.admission.current()
  }

  /** Breaker state, so an operator can see why ingress is refusing without reading logs. */
  admissionState(): { policy: TriggerAdmissionPolicy; breaker: { failures: number; openUntil?: string } } {
    return { policy: this.admission.current(), breaker: this.admission.breaker() }
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
      try {
        this.trigger(actor, schedule.scope, { id: `schedule:${schedule.id}:${schedule.nextRunAt}`, kind: 'schedule', workflowId: schedule.workflowId })
      } catch {
        // A refused or unusable tick is not an error here: the schedule keeps its
        // due time and waits for the gate, rather than advancing past work it was
        // never allowed to enqueue. The refusal itself is already in trigger history.
        continue
      }
      this.ledger.updateWorkflowSchedule(schedule.id, 'enabled', new Date(at.getTime() + schedule.intervalMs).toISOString(), timestamp)
      triggered += 1
    }
    return triggered
  }

  /**
   * The durable audit trail for a refused trigger (§5.7). It gets its own row id
   * on purpose: the trigger id belongs to the run that was admitted, so a
   * refusal must not consume it — otherwise a retry after unpause would be
   * recorded as a duplicate of a run that never existed.
   */
  private recordRefusal(scope: ScopeRef, input: TriggerInput, reason: AdmissionRefusal, detail: string): void {
    this.ledger.insertTrigger({
      id: createId(),
      scope,
      kind: input.kind,
      workflowId: input.workflowId,
      payload: { reason, detail: detail.slice(0, 512), triggerId: input.id.slice(0, 64) },
      state: 'rejected',
      createdAt: this.now().toISOString(),
    })
  }

  /** A replay of an already-admitted trigger: recorded once, answered as a duplicate. */
  private recordDuplicate(scope: ScopeRef, input: TriggerInput, runId?: string): TriggerRecord {
    const trigger: TriggerRecord = {
      id: input.id,
      scope,
      kind: input.kind,
      workflowId: input.workflowId,
      payload: input.payload ?? {},
      state: 'duplicate',
      workflowRunId: runId,
      createdAt: this.now().toISOString(),
    }
    this.ledger.insertTrigger(trigger)
    return trigger
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
