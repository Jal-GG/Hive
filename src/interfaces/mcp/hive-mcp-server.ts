import { createInterface } from 'node:readline'
import { Readable, Writable } from 'node:stream'
import { ContextMcpServer, JsonRpcRequest, JsonRpcResponse } from './context-mcp-server.js'
import { ControlMcpServer } from './control-mcp-server.js'

const protocolVersion = '2024-11-05'
const methodNotFound = -32601
const invalidParams = -32602

/**
 * The MCP surface a client actually connects to: one stdio server exposing the
 * context tools and the Phase 8 control tools together (C4's "one versioned
 * domain contract, exposed through CLI, local HTTP, MCP, and Electron IPC").
 *
 * Both halves are read-only on purpose. C4 says the browser-facing surface
 * exposes no mutation by default, and the plan's §7.0 defaults keep integrations
 * off until configured — so `trigger`, `cancel`, `pause`, and `schedule` are
 * reachable from the CLI and the desktop, and deliberately not from here.
 */
export class HiveMcpServer {
  constructor(
    private readonly context: ContextMcpServer,
    private readonly control: ControlMcpServer,
  ) {}

  handle(request: JsonRpcRequest): JsonRpcResponse | undefined {
    const id = request.id ?? null
    switch (request.method) {
      case 'initialize':
        return { jsonrpc: '2.0', id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'hive', version: '1' } } }
      case 'notifications/initialized':
        return undefined
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: [...this.context.tools(), ...this.control.tools()] } }
      case 'tools/call': {
        const name = typeof request.params?.name === 'string' ? request.params.name : ''
        // Routed by the tool's own namespace, so a tool cannot be reached under
        // the other half's name and the two lists can never disagree.
        if (name.startsWith('context_')) return this.context.handle(request)
        if (name.startsWith('control_')) return this.control.handle(request)
        return { jsonrpc: '2.0', id, error: { code: invalidParams, message: `Unknown tool: ${name}` } }
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: methodNotFound, message: `Unsupported method: ${request.method}` } }
    }
  }

  /** Newline-delimited JSON-RPC over stdio, the transport an MCP client speaks. */
  serve(input: Readable, output: Writable): Promise<void> {
    const lines = createInterface({ input, crlfDelay: Infinity })
    lines.on('line', (line) => {
      const trimmed = line.trim()
      if (trimmed.length === 0) return
      let response: JsonRpcResponse | undefined
      try {
        response = this.handle(JSON.parse(trimmed) as JsonRpcRequest)
      } catch (error) {
        response = { jsonrpc: '2.0', id: null, error: { code: invalidParams, message: error instanceof Error ? error.message : String(error) } }
      }
      if (response) output.write(`${JSON.stringify(response)}\n`)
    })
    return new Promise((resolve) => lines.on('close', resolve))
  }
}
