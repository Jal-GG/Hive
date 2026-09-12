import { describe, expect, it } from 'vitest'
import { ControlMcpServer } from '../../src/interfaces/mcp/control-mcp-server.js'
import { ObservabilityService } from '../../src/observability.js'
import { checkUpdate } from '../../src/release.js'
import { WorkflowService } from '../../src/workflow.js'
import { testActor, workHarness } from '../fixtures.js'
import type { Capability, WorkflowDefinition } from '../../src/contracts.js'

const capabilities: Capability[] = ['workspace:read', 'work:mutate', 'work:dispatch']
const definition = (): Omit<WorkflowDefinition, 'createdBy' | 'createdAt' | 'updatedAt'> => ({
  id: 'mcp-flow', version: '1.0.0', name: 'MCP flow', description: 'Read-only state test', enabled: true,
  steps: [{ id: 'step', type: 'create_work', title: 'MCP item' }],
})

describe('Phase 8 parity and release foundations', () => {
  it('exposes workflow, schedule, trigger, and metric state through read-only MCP tools', () => {
    const actor = testActor('operator', capabilities)
    const harness = workHarness([actor])
    const workflows = new WorkflowService({ ledger: harness.ledger, board: harness.board, now: harness.clock.now })
    workflows.register(actor, definition())
    workflows.trigger(actor, harness.scope, { id: 'mcp:1', kind: 'manual', workflowId: 'mcp-flow' })
    const server = new ControlMcpServer({ ledger: harness.ledger, workflows, observability: new ObservabilityService({ ledger: harness.ledger }), scope: harness.scope }, actor)
    const names = (server.tools() as Array<{ name: string }>).map((tool) => tool.name)
    expect(names).toEqual(['control_workflows', 'control_workflow_runs', 'control_workflow_schedules', 'control_triggers', 'control_skills', 'control_metrics', 'control_admission'])
    const result = server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'control_workflow_runs' } })
    expect(result?.error).toBeUndefined()
    expect(JSON.parse((result?.result as { content: Array<{ text: string }> }).content[0].text)).toHaveLength(1)
    expect(server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'control_cancel' } })?.error?.code).toBe(-32602)
    harness.close()
  })

  it('compares release versions without network or install side effects', () => {
    expect(checkUpdate('1.0.0', { version: '1.1.0', channel: 'stable' }).updateAvailable).toBe(true)
    expect(checkUpdate('1.1.0', { version: '1.0.0', channel: 'stable' }).updateAvailable).toBe(false)
    expect(checkUpdate('1.0.0', undefined)).toEqual({ currentVersion: '1.0.0', updateAvailable: false, manifest: undefined })
  })
})
