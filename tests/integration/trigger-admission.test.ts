import { describe, expect, it } from 'vitest'
import { TriggerAdmission, type TriggerAdmissionPolicy } from '../../src/admission.js'
import { ObservabilityService } from '../../src/observability.js'
import { WorkflowService } from '../../src/workflow.js'
import { testActor, workHarness } from '../fixtures.js'
import type { ActorContext, Capability, WorkflowDefinition } from '../../src/contracts.js'

const capabilities: Capability[] = ['workspace:read', 'work:mutate', 'work:dispatch']

const definition = (): Omit<WorkflowDefinition, 'createdBy' | 'createdAt' | 'updatedAt'> => ({
  id: 'gate-flow', version: '1.0.0', name: 'Gate flow', description: 'Admission test', enabled: true,
  steps: [{ id: 'step', type: 'create_work', title: 'Admitted work' }],
})

function harnessWith(policy: TriggerAdmissionPolicy, actor: ActorContext = testActor('operator', capabilities), options: { spend?: (scope: import('../../src/contracts.js').ScopeRef) => number } = {}) {
  const harness = workHarness([actor])
  const workflows = new WorkflowService({ ledger: harness.ledger, board: harness.board, admission: policy, spend: options.spend, now: harness.clock.now })
  workflows.register(actor, definition())
  return { harness, workflows, actor }
}

describe('trigger admission (§5.7)', () => {
  it('records a refusal and enqueues nothing when the kind is not allowlisted', () => {
    const { harness, workflows, actor } = harnessWith({ allowedKinds: ['webhook'] })

    expect(() => workflows.trigger(actor, harness.scope, { id: 'manual-1', kind: 'manual', workflowId: 'gate-flow' }))
      .toThrowError(/kind_not_allowed/)

    expect(harness.board.list(actor, harness.scope)).toHaveLength(0)
    expect(harness.ledger.listWorkflowRuns(harness.scope)).toHaveLength(0)
    const history = harness.ledger.listTriggers(harness.scope)
    expect(history).toHaveLength(1)
    expect(history[0].state).toBe('rejected')
    expect(history[0].payload.reason).toBe('kind_not_allowed')
    harness.close()
  })

  it('refuses every kind while paused, and lets the same trigger through after resume', () => {
    const { harness, workflows, actor } = harnessWith({})
    workflows.setPaused(actor, harness.scope, true)

    expect(() => workflows.trigger(actor, harness.scope, { id: 'paused-1', kind: 'manual', workflowId: 'gate-flow' }))
      .toThrowError(/paused/)

    workflows.setPaused(actor, harness.scope, false)
    // The refusal must not have consumed the trigger id, or this would be a duplicate.
    const admitted = workflows.trigger(actor, harness.scope, { id: 'paused-1', kind: 'manual', workflowId: 'gate-flow' })
    expect(admitted.duplicate).toBe(false)
    expect(admitted.run?.state).toBe('completed')
    expect(harness.board.list(actor, harness.scope)).toHaveLength(1)
    harness.close()
  })

  it('persists the pause across processes, so a one-shot CLI stop reaches the desktop', () => {
    const operator = testActor('operator', capabilities)
    const harness = workHarness([operator])
    const ledgerFile = harness.ledger
    const first = new WorkflowService({ ledger: ledgerFile, board: harness.board, now: harness.clock.now })
    first.register(operator, definition())
    first.setPaused(operator, harness.scope, true)

    // A second service over the same ledger is what a restarted process looks like.
    const second = new WorkflowService({ ledger: ledgerFile, board: harness.board, now: harness.clock.now })
    expect(second.admissionPolicy().paused).toBe(true)
    expect(() => second.trigger(operator, harness.scope, { id: 'after-restart', kind: 'manual', workflowId: 'gate-flow' }))
      .toThrowError(/paused/)
    harness.close()
  })

  it('refuses a source that is not allowlisted', () => {
    const operator = testActor('operator', capabilities)
    const { harness, workflows } = harnessWith({ allowedSources: ['webhook'] }, operator)

    expect(() => workflows.trigger(operator, harness.scope, { id: 'source-1', kind: 'manual', workflowId: 'gate-flow' }))
      .toThrowError(/source_not_allowed/)
    harness.close()
  })

  it('refuses once the recorded spend reaches the cap', () => {
    const operator = testActor('operator', capabilities)
    let spent = 0
    const { harness, workflows } = harnessWith({ spendCapUsd: 1 }, operator, { spend: () => spent })

    expect(workflows.trigger(operator, harness.scope, { id: 'spend-1', kind: 'manual', workflowId: 'gate-flow' }).duplicate).toBe(false)
    spent = 1
    expect(() => workflows.trigger(operator, harness.scope, { id: 'spend-2', kind: 'manual', workflowId: 'gate-flow' }))
      .toThrowError(/spend_exceeded/)
    harness.close()
  })

  it('reads the spend cap from recorded usage metrics when telemetry is on', () => {
    const operator = testActor('operator', capabilities)
    const harness = workHarness([operator])
    const observability = new ObservabilityService({ ledger: harness.ledger, enabled: true, now: harness.clock.now })
    const workflows = new WorkflowService({
      ledger: harness.ledger, board: harness.board, now: harness.clock.now,
      admission: { spendCapUsd: 0.5 },
      spend: (scope) => observability.costUsd(operator, scope),
    })
    workflows.register(operator, definition())

    observability.usage(operator, harness.scope, 'fake', 10, 5, 0.75)
    expect(() => workflows.trigger(operator, harness.scope, { id: 'cost-1', kind: 'manual', workflowId: 'gate-flow' }))
      .toThrowError(/spend_exceeded/)
    harness.close()
  })

  it('refuses past the window quota, and counts only admitted runs', () => {
    const operator = testActor('operator', capabilities)
    const { harness, workflows } = harnessWith({ maxRunsPerWindow: 1, windowMs: 60_000 }, operator)

    workflows.trigger(operator, harness.scope, { id: 'quota-1', kind: 'manual', workflowId: 'gate-flow' })
    expect(() => workflows.trigger(operator, harness.scope, { id: 'quota-2', kind: 'manual', workflowId: 'gate-flow' }))
      .toThrowError(/quota_exceeded/)

    // Replaying the same id is a duplicate, not a fresh admission, so it still passes the gate.
    const replay = workflows.trigger(operator, harness.scope, { id: 'quota-1', kind: 'manual', workflowId: 'gate-flow' })
    expect(replay.duplicate).toBe(true)
    harness.close()
  })

  it('opens the breaker after consecutive refusals and admits again after the cooldown', () => {
    const harness = workHarness([testActor('operator', capabilities)])
    let now = new Date('2026-01-01T00:00:00.000Z')
    const admission = new TriggerAdmission(
      { allowedKinds: ['webhook'], breakerThreshold: 2, breakerCooldownMs: 30_000 },
      { now: () => now, admittedSince: () => 0 },
    )
    const actor = testActor('operator', capabilities)

    expect(admission.evaluate(actor, harness.scope, 'manual')).toMatchObject({ admitted: false, reason: 'kind_not_allowed' })
    expect(admission.breaker().failures).toBe(1)
    expect(admission.evaluate(actor, harness.scope, 'manual')).toMatchObject({ admitted: false, reason: 'kind_not_allowed' })
    // Threshold reached: the next call is fast-pathed, and even an allowed kind is refused.
    expect(admission.breaker().openUntil).toBe('2026-01-01T00:00:30.000Z')
    expect(admission.evaluate(actor, harness.scope, 'webhook')).toMatchObject({ admitted: false, reason: 'breaker_open' })
    expect(admission.breaker().failures).toBe(2)

    now = new Date('2026-01-01T00:00:31.000Z')
    expect(admission.evaluate(actor, harness.scope, 'webhook')).toMatchObject({ admitted: true })
    expect(admission.breaker().openUntil).toBeUndefined()
    expect(admission.breaker().failures).toBe(0)
    harness.close()
  })

  it('resets the breaker on an admission, so scattered refusals never trip it', () => {
    const harness = workHarness([testActor('operator', capabilities)])
    const admission = new TriggerAdmission(
      { allowedKinds: ['webhook'], breakerThreshold: 3 },
      { now: harness.clock.now, admittedSince: () => 0 },
    )
    const actor = testActor('operator', capabilities)

    expect(admission.evaluate(actor, harness.scope, 'manual')).toMatchObject({ admitted: false })
    expect(admission.evaluate(actor, harness.scope, 'manual')).toMatchObject({ admitted: false })
    expect(admission.evaluate(actor, harness.scope, 'webhook')).toMatchObject({ admitted: true })
    expect(admission.breaker().failures).toBe(0)
    expect(admission.evaluate(actor, harness.scope, 'manual')).toMatchObject({ admitted: false })
    expect(admission.breaker().openUntil).toBeUndefined()
    harness.close()
  })

  it('holds a schedule at its due time while paused instead of skipping the work', () => {
    const operator = testActor('operator', capabilities)
    const { harness, workflows } = harnessWith({}, operator)
    workflows.schedule(operator, {
      id: 'nightly', scope: harness.scope, workflowId: 'gate-flow', intervalMs: 60_000,
      state: 'enabled', nextRunAt: '2026-01-01T00:00:00.000Z',
    })
    workflows.setPaused(operator, harness.scope, true)
    expect(workflows.tick(operator, new Date('2026-01-01T00:00:01.000Z'))).toBe(0)

    // Still due: the pause did not advance it past work it was never allowed to enqueue.
    workflows.setPaused(operator, harness.scope, false)
    expect(workflows.tick(operator, new Date('2026-01-01T00:00:02.000Z'))).toBe(1)
    expect(harness.ledger.listWorkflowRuns(harness.scope)).toHaveLength(1)
    harness.close()
  })

  it('admits by default, so an unconfigured deployment is unchanged', () => {
    const { harness, workflows, actor } = harnessWith({})
    expect(workflows.trigger(actor, harness.scope, { id: 'default-1', kind: 'github', workflowId: 'gate-flow' }).duplicate).toBe(false)
    expect(workflows.admissionPolicy()).toEqual({})
    harness.close()
  })

  /**
   * Found by running the ingress as a process, not by these tests: an actor that
   * could dispatch but not create work produced a 500 and left the run stuck in
   * `queued` with no work items, where a later retry read as a clean duplicate.
   */
  it('closes the run as failed, and records why, when a step cannot enqueue', () => {
    const operator = testActor('operator', capabilities)
    const dispatcher = testActor('integration', ['work:dispatch'])
    const harness = workHarness([operator, dispatcher])
    const workflows = new WorkflowService({ ledger: harness.ledger, board: harness.board, now: harness.clock.now })
    workflows.register(operator, definition())

    expect(() => workflows.trigger(dispatcher, harness.scope, { id: 'no-mutate', kind: 'github', workflowId: 'gate-flow' }))
      .toThrowError(/work:mutate/)

    const runs = harness.ledger.listWorkflowRuns(harness.scope)
    expect(runs).toHaveLength(1)
    expect(runs[0].state).toBe('failed')
    expect(harness.board.list(operator, harness.scope)).toHaveLength(0)

    const history = harness.ledger.listTriggers(harness.scope)
    expect(history.some((record) => record.state === 'rejected' && record.payload.reason === 'step_failed')).toBe(true)
    harness.close()
  })
})
