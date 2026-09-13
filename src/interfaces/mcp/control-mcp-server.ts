import { ActorContext, ScopeRef } from '../../contracts.js'
import { Ledger } from '../../ledger.js'
import { ObservabilityService } from '../../observability.js'
import { WorkflowService } from '../../workflow.js'
import { JsonRpcRequest, JsonRpcResponse } from './context-mcp-server.js'

const protocolVersion = '2024-11-05'
const tools = ['workflows', 'workflow_runs', 'workflow_schedules', 'triggers', 'skills', 'metrics', 'admission'] as const

type ControlTool = (typeof tools)[number]

export interface ControlMcpSurfaces {
  ledger: Ledger
  workflows: WorkflowService
  observability: ObservabilityService
  scope: ScopeRef
}

export class ControlMcpServer {
  constructor(private readonly surfaces: ControlMcpSurfaces, private readonly actor: ActorContext) {}

  handle(request: JsonRpcRequest): JsonRpcResponse | undefined {
    const id = request.id ?? null
    switch (request.method) {
      case 'initialize':
        return { jsonrpc: '2.0', id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'hive-control', version: '1' } } }
      case 'notifications/initialized': return undefined
      case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: this.tools() } }
      case 'tools/call': return this.call(id, request.params ?? {})
      default: return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported method: ${request.method}` } }
    }
  }

  tools(): unknown[] {
    return tools.map((name) => ({
      name: `control_${name}`,
      description: `Read-only ${name.replace('_', ' ')} view`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    }))
  }

  private call(id: string | number | null, params: Record<string, unknown>): JsonRpcResponse {
    const name = params.name
    if (typeof name !== 'string' || !name.startsWith('control_')) return { jsonrpc: '2.0', id, error: { code: -32602, message: 'tools/call requires a control tool name' } }
    const tool = name.slice('control_'.length) as ControlTool
    if (!tools.includes(tool)) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown control tool: ${name}` } }
    const data = tool === 'workflows' ? this.surfaces.ledger.listWorkflows()
      : tool === 'workflow_runs' ? this.surfaces.ledger.listWorkflowRuns(this.surfaces.scope)
      : tool === 'workflow_schedules' ? this.surfaces.workflows.schedules(this.surfaces.scope)
      : tool === 'triggers' ? this.surfaces.ledger.listTriggers(this.surfaces.scope)
      : tool === 'skills' ? this.surfaces.ledger.listSkills(this.surfaces.scope)
      : tool === 'admission' ? this.surfaces.workflows.admissionState()
      : this.surfaces.observability.metrics(this.actor, this.surfaces.scope)
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } }
  }
}
