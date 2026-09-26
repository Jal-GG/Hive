import { ActorContext, IssueType, ScopeRef, TriggerRecord, WorkflowDefinition, WorkflowRun, WorkflowStep, WorkflowSchedule, WorkflowWatch } from './contracts.js'
import { AdmissionRefusal, TriggerAdmission, TriggerAdmissionPolicy } from './admission.js'
import { assertCapability } from './capabilities.js'
import { HiveError } from './errors.js'
import { Ledger } from './ledger.js'
import { Clock, ClockOptions, createId, resolveClock } from './shared.js'
import { WorkBoard } from './work/board.js'
import { workEvent } from './work/events.js'

const versionPattern = /^\d+\.\d+\.\d+$/
const triggerKinds: readonly TriggerRecord['kind'][] = ['manual', 'webhook', 'github', 'slack', 'feed', 'schedule', 'watch']

/** The control_settings key holding the operator's persisted ingress policy. */
export const admissionSettingKey = 'trigger.admission'

/**
 * What a watch observes, supplied by the host rather than imported into the
 * workflow service: the fingerprint of everything under a URI prefix. The
 * context filesystem owns the content; this service only compares fingerprints.
 */
export interface WorkflowWatchSource {
  /** Deterministic fingerprint of the nodes under a canonical URI prefix. */
  fingerprint(scope: ScopeRef, uriPrefix: string): string
}

export interface WorkflowServiceOptions extends ClockOptions {
  ledger: Ledger
  board: WorkBoard
  /** §5.7 ingress policy. Defaults admit everything; the gate is still live. */
  admission?: TriggerAdmissionPolicy
  /** Cost incurred in a scope, in USD, for the spend cap. Absent means uncapped. */
  spend?: (scope: ScopeRef) => number
  /** Context observation source for watches. Absent means watches never fire. */
  watchSource?: WorkflowWatchSource
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
  private readonly watchSource?: WorkflowWatchSource

  constructor(options: WorkflowServiceOptions) {
    this.ledger = options.ledger
    this.board = options.board
    this.now = resolveClock(options)
    this.watchSource = options.watchSource
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
    const created: string[] = []
    try {
      for (const step of definition.steps) {
        created.push(this.board.create(actor, scope, {
          title: step.title, description: step.description, priority: step.priority, issueType: step.issueType as IssueType | undefined,
          metadata: { workflowId: definition.id, workflowVersion: definition.version, workflowStepId: step.id },
        }).id)
      }
    } catch (error) {
      // A step that cannot enqueue must not leave a run stuck in `queued` with no
      // work in it — that is a run that looks in-flight forever and cannot be
      // retried. The run is closed as failed, the reason is written where an
      // operator looks for it, and the caller gets a named error rather than a
      // bare 500 (§7's bounded failure behaviour).
      const failedAt = this.now().toISOString()
      this.ledger.updateWorkflowRun(run.id, 'failed', failedAt, created, failedAt)
      const detail = error instanceof Error ? error.message : String(error)
      this.ledger.insertTrigger({
        id: createId(),
        scope,
        kind: input.kind,
        workflowId: input.workflowId,
        payload: { reason: 'step_failed', detail: detail.slice(0, 512), triggerId: input.id.slice(0, 64) },
        state: 'rejected',
        workflowRunId: run.id,
        createdAt: failedAt,
      })
      throw new HiveError('WORKFLOW_STEP_FAILED', detail)
    }
    const completed = this.ledger.updateWorkflowRun(run.id, 'completed', timestamp, created, timestamp)
    const accepted: TriggerRecord = { id: input.id, scope, kind: input.kind, workflowId: input.workflowId, payload: input.payload ?? {}, state: 'accepted', workflowRunId: run.id, createdAt: timestamp }
    this.ledger.insertTrigger(accepted)
    return { trigger: accepted, run: completed ?? { ...run, state: 'completed', workItemIds: created, completedAt: timestamp }, duplicate: false }
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
    triggered += this.tickWatches(actor, at)
    return triggered
  }

  /**
   * The watch pass (§7 Phase 8 "watches"). Each due watch's prefix is
   * fingerprinted; a fingerprint that moved since the last observation enqueues
   * the workflow with the change as its trigger. The observation is then
   * advanced either way, so a watch that fired cannot fire again for the same
   * content and a watch that found nothing new still learns what "unchanged"
   * currently is.
   *
   * The first observation of a watch is a baseline, not a firing: registering a
   * watch over content that already exists must not immediately enqueue work —
   * that is the difference between "watch this" and "run this".
   */
  private tickWatches(actor: ActorContext, at: Date): number {
    if (!this.watchSource) return 0
    const timestamp = at.toISOString()
    let triggered = 0
    for (const watch of this.ledger.dueWorkflowWatches(timestamp)) {
      let fingerprint: string
      try {
        fingerprint = this.watchSource.fingerprint(watch.scope, watch.uriPrefix)
      } catch {
        // An unreadable prefix is an observation failure, not a trigger: the
        // watch keeps its state — including an absent baseline, so the first
        // successful observation still baselines rather than firing — and
        // retries next pass.
        this.ledger.deferWorkflowWatch(watch.id, new Date(at.getTime() + 60_000).toISOString(), timestamp)
        continue
      }
      const nextAt = new Date(at.getTime() + 60_000).toISOString()
      if (watch.lastObserved !== undefined && fingerprint !== watch.lastObserved) {
        try {
          this.trigger(actor, watch.scope, { id: `watch:${watch.id}:${fingerprint}`, kind: 'watch', workflowId: watch.workflowId, payload: { uriPrefix: watch.uriPrefix, fingerprint } })
          triggered += 1
        } catch {
          // Refused or failed: recorded in trigger history by `trigger`; the
          // observation still advances so a refused watch does not hot-loop.
        }
      }
      this.ledger.updateWorkflowWatchObservation(watch.id, fingerprint, nextAt, timestamp)
    }
    return triggered
  }

  // --- Context watches (§7 Phase 8 "watches") ---

  watch(actor: ActorContext, input: Omit<WorkflowWatch, 'scope' | 'createdBy' | 'createdAt' | 'updatedAt'> & { scope: ScopeRef }): WorkflowWatch {
    assertCapability(actor.capabilities, 'work:mutate')
    if (!input.id || !/^[a-z0-9][a-z0-9._-]*$/.test(input.id)) throw new HiveError('WATCH_INVALID', 'Watch id must be lowercase and path-safe')
    if (!this.ledger.workflow(input.workflowId)) throw new HiveError('WORKFLOW_NOT_FOUND', `Workflow ${input.workflowId} was not found`)
    const timestamp = this.now().toISOString()
    const record: WorkflowWatch = { ...input, createdBy: actor.actorId, createdAt: timestamp, updatedAt: timestamp }
    this.ledger.upsertWorkflowWatch(record)
    this.record(actor, input.scope, 'watch-registered', `watch:${input.id}`, timestamp, { workflowId: input.workflowId, uriPrefix: input.uriPrefix })
    return record
  }

  watches(scope: ScopeRef, state?: WorkflowWatch['state']): WorkflowWatch[] {
    return this.ledger.listWorkflowWatches(scope, state)
  }

  setWatchState(actor: ActorContext, id: string, state: WorkflowWatch['state']): WorkflowWatch {
    assertCapability(actor.capabilities, 'work:mutate')
    const watch = this.ledger.workflowWatch(id)
    if (!watch) throw new HiveError('WATCH_NOT_FOUND', `Watch ${id} was not found`)
    const updated = this.ledger.setWorkflowWatchState(id, state, this.now().toISOString())
    if (!updated) throw new HiveError('WATCH_NOT_FOUND', `Watch ${id} was not found`)
    this.record(actor, watch.scope, state === 'enabled' ? 'watch-enabled' : 'watch-disabled', `watch-state:${id}`, this.now().toISOString(), { id, state })
    return updated
  }

  removeWatch(actor: ActorContext, id: string): boolean {
    assertCapability(actor.capabilities, 'work:mutate')
    const watch = this.ledger.workflowWatch(id)
    if (!watch) return false
    this.ledger.deleteWorkflowWatch(id)
    this.record(actor, watch.scope, 'watch-removed', `watch-removed:${id}:${this.now().toISOString()}`, this.now().toISOString(), { id })
    return true
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
