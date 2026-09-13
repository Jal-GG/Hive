import { describe, expect, it } from 'vitest'
import { ObservabilityService } from '../../src/observability.js'
import { VoiceOperator } from '../../src/voice.js'
import { WorkflowService } from '../../src/workflow.js'
import { testActor, workHarness } from '../fixtures.js'
import type { Capability, WorkflowDefinition } from '../../src/contracts.js'

const capabilities: Capability[] = ['workspace:read', 'work:mutate', 'work:dispatch', 'context:read', 'context:write', 'runtime:read']

function definition(): Omit<WorkflowDefinition, 'createdBy' | 'createdAt' | 'updatedAt'> {
  return {
    id: 'voice-flow', version: '1.0.0', name: 'Voice flow', description: 'Creates work voice can ask for', enabled: true,
    steps: [{ id: 'react', type: 'create_work', title: 'React to the voice request' }],
  }
}

describe('voice operator', () => {
  it('answers reads from the real services, refuses unknown phrases, and spend-caps actions only', () => {
    const actor = testActor('operator', capabilities)
    const harness = workHarness([actor])
    const workflows = new WorkflowService({ ledger: harness.ledger, board: harness.board, now: harness.clock.now })
    workflows.register(actor, definition())
    workflows.trigger(actor, harness.scope, { id: 'voice-seed:1', kind: 'manual', workflowId: 'voice-flow' })

    const observability = new ObservabilityService({ ledger: harness.ledger, enabled: true, now: harness.clock.now })
    observability.usage(actor, harness.scope, 'fake', 1, 1, 1.5)
    const voice = new VoiceOperator({
      ledger: harness.ledger, workflows, observability, scope: harness.scope,
      spend: () => 1.5, spendCapUsd: 1.0,
    })

    const status = voice.turn(actor, 'status')
    expect(status.outcome.kind).toBe('answered')
    if (status.outcome.kind === 'answered') {
      const data = status.outcome.data as { work: { open: number } }
      expect(data.work.open).toBeGreaterThanOrEqual(1)
    }

    // An action under a spent cap is refused; a read never is.
    const refused = voice.turn(actor, 'trigger workflow voice-flow')
    expect(refused.outcome.kind).toBe('refused')
    if (refused.outcome.kind === 'refused') expect(refused.outcome.reason).toBe('spend_exceeded')
    expect(voice.turn(actor, 'show the runs').outcome.kind).toBe('answered')

    const gibberish = voice.turn(actor, 'make me a sandwich')
    expect(gibberish.outcome.kind).toBe('refused')
    if (gibberish.outcome.kind === 'refused') expect(gibberish.outcome.reason).toBe('unrecognized')

    // Without a cap the action goes through — to the same service the CLI uses.
    const uncapped = new VoiceOperator({ ledger: harness.ledger, workflows, observability, scope: harness.scope })
    expect(uncapped.turn(actor, 'pause').outcome.kind).toBe('answered')
    expect(workflows.admissionState().policy.paused).toBe(true)
    harness.close()
  })

  it('is capability-checked like every other surface: a viewer cannot pause', () => {
    const actor = testActor('operator', capabilities)
    const harness = workHarness([actor])
    const viewer = testActor('viewer', ['workspace:read', 'runtime:read'])
    harness.ledger.createActor(viewer)
    const workflows = new WorkflowService({ ledger: harness.ledger, board: harness.board, now: harness.clock.now })
    const observability = new ObservabilityService({ ledger: harness.ledger })
    const voice = new VoiceOperator({ ledger: harness.ledger, workflows, observability, scope: harness.scope })

    expect(voice.turn(viewer, 'status').outcome.kind).toBe('answered')
    const action = voice.turn(viewer, 'pause')
    expect(action.outcome.kind).toBe('refused')
    if (action.outcome.kind === 'refused') expect(action.outcome.detail).toMatch(/capability/i)
    harness.close()
  })
})
