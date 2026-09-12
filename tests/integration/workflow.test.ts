import { describe, expect, it } from 'vitest'
import { runWorkflowCli } from '../../src/interfaces/cli/workflow-cli.js'
import { WorkflowService } from '../../src/workflow.js'
import { testActor, workHarness } from '../fixtures.js'
import type { Capability, WorkflowDefinition } from '../../src/contracts.js'

const capabilities: Capability[] = ['workspace:read', 'work:mutate', 'work:dispatch']

function definition(): Omit<WorkflowDefinition, 'createdBy' | 'createdAt' | 'updatedAt'> {
  return {
    id: 'review-flow', version: '1.0.0', name: 'Review flow', description: 'Creates review work', enabled: true,
    steps: [{ id: 'review', type: 'create_work', title: 'Review the change', description: 'Check the submitted change', priority: 2 }],
  }
}

describe('declarative workflows', () => {
  it('registers versions, creates ordinary work, and deduplicates triggers', () => {
    const actor = testActor('operator', capabilities)
    const harness = workHarness([actor])
    const workflows = new WorkflowService({ ledger: harness.ledger, board: harness.board, now: harness.clock.now })
    workflows.register(actor, definition())

    const first = workflows.trigger(actor, harness.scope, { id: 'github:42', kind: 'github', workflowId: 'review-flow', payload: { number: 42 } })
    const second = workflows.trigger(actor, harness.scope, { id: 'github:42', kind: 'github', workflowId: 'review-flow', payload: { number: 42 } })

    expect(first.duplicate).toBe(false)
    expect(first.run?.state).toBe('completed')
    expect(first.run?.workItemIds).toHaveLength(1)
    expect(second.duplicate).toBe(true)
    expect(second.run?.id).toBe(first.run?.id)
    expect(harness.board.list(actor, harness.scope)).toHaveLength(1)
    expect(harness.ledger.listTriggers(harness.scope)).toHaveLength(1)
    harness.close()
  })

  it('rejects unsupported executable steps and cancels a run exactly once', () => {
    const actor = testActor('operator', capabilities)
    const harness = workHarness([actor])
    const workflows = new WorkflowService({ ledger: harness.ledger, board: harness.board, now: harness.clock.now })

    expect(() => workflows.register(actor, { ...definition(), steps: [{ id: 'shell', type: 'shell' as never, title: 'danger' }] })).toThrowError(/Unsupported workflow step/)
    workflows.register(actor, definition())
    const run = workflows.trigger(actor, harness.scope, { id: 'manual:1', kind: 'manual', workflowId: 'review-flow' }).run!
    expect(() => workflows.cancel(actor, run.id)).toThrowError(/already terminal/)
    harness.close()
  })

  it('executes due schedules once per interval and exposes schedule state through the CLI', async () => {
    const actor = testActor('operator', capabilities)
    const harness = workHarness([actor])
    const workflows = new WorkflowService({ ledger: harness.ledger, board: harness.board, now: harness.clock.now })
    workflows.register(actor, definition())
    workflows.schedule(actor, { id: 'review-every-minute', scope: harness.scope, workflowId: 'review-flow', intervalMs: 60000, state: 'enabled', nextRunAt: '2026-01-01T00:00:00.000Z' })
    expect(workflows.tick(actor, new Date('2025-12-31T23:59:00.000Z'))).toBe(0)
    expect(workflows.tick(actor, new Date('2026-01-01T00:00:01.000Z'))).toBe(1)
    expect(workflows.tick(actor, new Date('2026-01-01T00:00:02.000Z'))).toBe(0)
    expect(harness.board.list(actor, harness.scope)).toHaveLength(1)
    workflows.setScheduleState(actor, 'review-every-minute', 'disabled')
    expect(JSON.parse(await runWorkflowCli({ ledger: harness.ledger, workflows }, actor, ['schedules']))[0].state).toBe('disabled')
    harness.close()
  })

  it('serves workflow registration, trigger, runs, and trigger history through the CLI adapter', async () => {
    const actor = testActor('operator', capabilities)
    const harness = workHarness([actor])
    const workflows = new WorkflowService({ ledger: harness.ledger, board: harness.board, now: harness.clock.now })
    const cli = (argv: string[]) => runWorkflowCli({ ledger: harness.ledger, workflows }, actor, argv)
    await cli(['register', '--definition', JSON.stringify(definition())])
    const triggered = JSON.parse(await cli(['trigger', '--id', 'manual:cli', '--workflow', 'review-flow'])) as { run: { id: string } }
    expect(JSON.parse(await cli(['runs']))).toHaveLength(1)
    expect(JSON.parse(await cli(['triggers']))).toHaveLength(1)
    await expect(cli(['cancel', '--run', triggered.run.id])).rejects.toThrow(/already terminal/)
    harness.close()
  })
})
