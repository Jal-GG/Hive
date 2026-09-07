import { Readable, Writable } from 'node:stream'
import { createInterface } from 'node:readline'
import { ActorContext } from '../../contracts.js'
import {
  ContextBrowseOperation,
  ContextBrowseRequest,
  ContextBrowser,
  contextBrowseHelp,
  contextBrowseOperations,
} from '../../context/browser.js'

const protocolVersion = '2024-11-05'
const toolPrefix = 'context_'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

const methodNotFound = -32601
const invalidParams = -32602

/**
 * MCP over stdio, hand-rolled rather than pulled from an SDK: the surface is
 * `initialize`, `tools/list`, and `tools/call`, and every tool is one read-only
 * `ContextBrowser` operation. No mutation is reachable from here (C4).
 */
export class ContextMcpServer {
  constructor(
    private readonly browser: ContextBrowser,
    private readonly actor: ActorContext,
  ) {}

  /** Pure request/response, so the protocol is testable without spawning a process. */
  handle(request: JsonRpcRequest): JsonRpcResponse | undefined {
    const id = request.id ?? null
    switch (request.method) {
      case 'initialize':
        return { jsonrpc: '2.0', id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'hive-context', version: '1' } } }
      case 'notifications/initialized':
        // A notification has no id and therefore no reply.
        return undefined
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: this.tools() } }
      case 'tools/call':
        return this.call(id, request.params ?? {})
      default:
        return { jsonrpc: '2.0', id, error: { code: methodNotFound, message: `Unsupported method: ${request.method}` } }
    }
  }

  tools(): unknown[] {
    return contextBrowseOperations.map((operation) => ({
      name: `${toolPrefix}${operation}`,
      description: contextBrowseHelp[operation],
      inputSchema: {
        type: 'object',
        properties: {
          uri: { type: 'string', description: 'viking:// URI of the target' },
          workspace: { type: 'string' },
          project: { type: 'string' },
          path: { type: 'string' },
          pattern: { type: 'string' },
          revision: { type: 'string' },
          depth: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1 },
          ignoreCase: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    }))
  }

  /** Reads newline-delimited JSON-RPC from `input` and writes replies to `output`. */
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

  private call(id: string | number | null, params: Record<string, unknown>): JsonRpcResponse {
    const name = typeof params.name === 'string' ? params.name : ''
    const operation = name.startsWith(toolPrefix) ? name.slice(toolPrefix.length) : name
    if (!contextBrowseOperations.includes(operation as ContextBrowseOperation)) {
      return { jsonrpc: '2.0', id, error: { code: invalidParams, message: `Unknown tool: ${name}` } }
    }
    const argumentsValue = params.arguments
    const supplied = typeof argumentsValue === 'object' && argumentsValue !== null ? (argumentsValue as Record<string, unknown>) : {}
    const request = { ...supplied, version: 1, operation: operation as ContextBrowseOperation } as ContextBrowseRequest
    const result = this.browser.browse(this.actor, request)
    // MCP reports tool failures inside the result, not as protocol errors, so the
    // caller can see the reason instead of a transport fault.
    return {
      jsonrpc: '2.0',
      id,
      result: {
        isError: !result.ok,
        content: [{ type: 'text', text: JSON.stringify(result.ok ? result.data : result.error, null, 2) }],
      },
    }
  }
}
