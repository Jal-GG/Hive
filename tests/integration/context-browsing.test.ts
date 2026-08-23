import { Readable, Writable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ContextNode, ResultEnvelope } from '../../src/contracts.js'
import {
  ContextBrowseOperation,
  ContextBrowseRequest,
  contextBrowseOperations,
} from '../../src/context/browser.js'
import { HiveError } from '../../src/errors.js'
import { runContextCli, usage } from '../../src/interfaces/cli/context-cli.js'
import { ContextHttpServer } from '../../src/interfaces/http/context-http-server.js'
import { ContextMcpServer, JsonRpcRequest, JsonRpcResponse } from '../../src/interfaces/mcp/context-mcp-server.js'
import { IpcHandler, contextIpcPrefix, registerContextIpc } from '../../src/interfaces/desktop/context-ipc.js'
import { BrowserHarness, browserHarness, testActor } from '../fixtures.js'

const writer = testActor('writer-1', ['context:read', 'context:write'])
const reader = testActor('reader-1', ['context:read'], 'viewer')
const stranger = testActor('stranger-1', [], 'viewer')

/** Verbs the browsing contract must not expose, however a surface is addressed. */
const mutations = ['write', 'rename', 'remove', 'delete', 'restore', 'reconcile']

// Read-only surfaces over one immutable fixture: building it once keeps a single
// setup for the whole file instead of one per test.
let harness: BrowserHarness
beforeAll(() => {
  harness = browserHarness([writer, reader, stranger], writer, { initializeGit: false })
})
afterAll(() => harness.close())

describe('context browsing — one contract behind every surface (C4)', () => {
  it('exposes exactly the same twelve read-only operations everywhere', () => {
    expect(contextBrowseOperations).toEqual(['ls', 'tree', 'stat', 'read', 'grep', 'glob', 'find', 'history', 'readAt', 'tombstones', 'snapshots', 'pack'])
    expect(contextBrowseOperations.some((operation) => mutations.includes(operation))).toBe(false)

    const mcpNames = (new ContextMcpServer(harness.browser, reader).tools() as { name: string }[]).map((tool) => tool.name)
    expect(mcpNames).toEqual(contextBrowseOperations.map((operation) => `context_${operation}`))

    const channels = registerContextIpc({ handle: () => {} }, harness.browser, reader)
    expect(channels).toEqual(contextBrowseOperations.map((operation) => `${contextIpcPrefix}${operation}`))

    for (const operation of contextBrowseOperations) expect(usage()).toContain(operation)
  })

  it('answers every operation it advertises', () => {
    // A listed operation that is not wired up would otherwise look implemented.
    const node = { uri: harness.uri('page/readme.md') }
    const requests: Record<ContextBrowseOperation, Omit<ContextBrowseRequest, 'version' | 'operation'>> = {
      ls: harness.root,
      tree: { ...harness.root, depth: 2 },
      stat: node,
      read: node,
      grep: { ...harness.root, pattern: 'line' },
      glob: { ...harness.root, pattern: '**/*.md' },
      find: { ...harness.root, pattern: 'note' },
      history: node,
      readAt: { ...node, revision: 'HEAD' },
      tombstones: harness.root,
      snapshots: harness.root,
      pack: harness.root,
    }
    for (const operation of contextBrowseOperations) {
      const result = harness.browser.browse(reader, { version: 1, operation, ...requests[operation] })
      expect(result.ok, `${operation} failed: ${result.ok ? '' : result.error.message}`).toBe(true)
    }
  })

  it('resolves a URI target and a workspace/project target identically', () => {
    const viaUri = harness.browser.browse(reader, { version: 1, operation: 'ls', uri: harness.uri('page') })
    const viaNames = harness.browser.browse(reader, { version: 1, operation: 'ls', ...harness.root, path: 'page' })
    expect(ok(viaUri)).toEqual(ok(viaNames))
  })

  it('reports failures as envelopes rather than throwing', () => {
    const missing = harness.browser.browse(reader, { version: 1, operation: 'read', uri: harness.uri('page/absent.md') })
    expect(missing.ok).toBe(false)
    expect(error(missing).code).toBe('NOT_FOUND')

    const unscoped = harness.browser.browse(reader, { version: 1, operation: 'ls', workspace: 'nope', project: 'nope' })
    expect(error(unscoped).code).toBe('SCOPE_NOT_FOUND')

    const unarmed = harness.browser.browse(stranger, { version: 1, operation: 'ls', ...harness.root })
    expect(error(unarmed).code).toBe('FORBIDDEN')

    const noPattern = harness.browser.browse(reader, { version: 1, operation: 'grep', ...harness.root })
    expect(error(noPattern).code).toBe('MISSING_ARGUMENT')

    // A `viking://` URI always names a resource, so the project root has no URI spelling.
    const rootAsUri = harness.browser.browse(reader, { version: 1, operation: 'ls', uri: 'viking://workspace/main/project/hive' })
    expect(error(rootAsUri).code).toBe('INVALID_URI')

    const invented = harness.browser.browse(reader, { version: 1, operation: 'write' as ContextBrowseOperation, ...harness.root })
    expect(error(invented).code).toBe('UNKNOWN_OPERATION')
  })

  it('echoes the caller request id so a surface can correlate replies', () => {
    const result = harness.browser.browse(reader, { version: 1, requestId: 'req-7', operation: 'ls', ...harness.root })
    expect(result.requestId).toBe('req-7')
  })
})

describe('context browsing — CLI', () => {
  /** The project root has no URI, so the CLI addresses it by scope name. */
  const rootFlags = () => ['--workspace', harness.root.workspace, '--project', harness.root.project]

  it('renders JSON for a bare URI target', () => {
    const output = runContextCli(harness.browser, reader, ['read', harness.uri('page/readme.md')])
    expect((JSON.parse(output) as ContextNode).body).toBe('# Hive\nalpha line')
  })

  it('accepts flag targets, numeric flags, and --ignore-case', () => {
    const tree = runContextCli(harness.browser, reader, ['tree', ...rootFlags(), '--path', 'page', '--depth', '1'])
    expect((JSON.parse(tree) as { path: string }[]).map((entry) => entry.path)).toEqual(['page/guides', 'page/readme.md'])

    const grep = runContextCli(harness.browser, reader, ['grep', ...rootFlags(), '--pattern', 'ALPHA', '--ignore-case'])
    expect(JSON.parse(grep)).toHaveLength(1)
  })

  it('prints usage with no arguments and refuses anything that is not an operation', () => {
    expect(runContextCli(harness.browser, reader, [])).toContain('Operations (all read-only)')
    expect(runContextCli(harness.browser, reader, ['--help'])).toBe(usage())
    for (const verb of mutations) {
      expect(() => runContextCli(harness.browser, reader, [verb, ...rootFlags()])).toThrowError('Unknown context operation')
    }
  })

  it('rejects malformed flags before reaching the browser', () => {
    expect(() => runContextCli(harness.browser, reader, ['ls', '--path'])).toThrowError('needs a value')
    expect(() => runContextCli(harness.browser, reader, ['ls', '--nope', 'x'])).toThrowError('Unknown option')
    expect(() => runContextCli(harness.browser, reader, ['tree', ...rootFlags(), '--depth', 'deep'])).toThrowError('positive integer')
    expect(() => runContextCli(harness.browser, reader, ['tree', ...rootFlags(), '--depth', '0'])).toThrowError('positive integer')
  })

  it('surfaces a browse failure as a thrown HiveError carrying the code', () => {
    try {
      runContextCli(harness.browser, stranger, ['ls', ...rootFlags()])
      expect.unreachable('an actor without context:read must not list')
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(HiveError)
      expect((thrown as HiveError).code).toBe('FORBIDDEN')
    }
  })
})

describe('context browsing — MCP over stdio', () => {
  /** One server per call, so no test can depend on another's protocol state. */
  function ask(request: JsonRpcRequest): JsonRpcResponse | undefined {
    return new ContextMcpServer(harness.browser, reader).handle(request)
  }

  function callTool(name: string, args: Record<string, unknown> = {}): JsonRpcResponse | undefined {
    return ask({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  }

  it('answers initialize and describes every tool', () => {
    const initialized = ask({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    expect((initialized?.result as { protocolVersion: string }).protocolVersion).toBe('2024-11-05')
    // A notification carries no id, so it gets no reply at all.
    expect(ask({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined()

    const tools = (ask({ jsonrpc: '2.0', id: 2, method: 'tools/list' })?.result as { tools: { name: string; description: string }[] }).tools
    expect(tools).toHaveLength(contextBrowseOperations.length)
    expect(tools.every((tool) => tool.description.length > 0)).toBe(true)
  })

  it('calls a tool and returns its data as text content', () => {
    const result = callTool('context_read', { uri: harness.uri('memory/note.md') })?.result as { isError: boolean; content: { type: string; text: string }[] }
    expect(result.isError).toBe(false)
    expect(result.content[0].type).toBe('text')
    expect((JSON.parse(result.content[0].text) as ContextNode).body).toBe('gamma line')
  })

  it('reports a browse failure inside the result, not as a protocol error', () => {
    const response = callTool('context_read', { uri: harness.uri('page/absent.md') })
    expect(response?.error).toBeUndefined()
    const result = response?.result as { isError: boolean; content: { text: string }[] }
    expect(result.isError).toBe(true)
    expect((JSON.parse(result.content[0].text) as { code: string }).code).toBe('NOT_FOUND')
  })

  it('refuses unknown methods and tools that are not browse operations', () => {
    expect(ask({ jsonrpc: '2.0', id: 5, method: 'resources/list' })?.error?.code).toBe(-32601)
    for (const verb of [...mutations, 'shell']) {
      expect(callTool(`context_${verb}`)?.error?.message).toBe(`Unknown tool: context_${verb}`)
    }
  })

  it('frames newline-delimited JSON over a stream and skips blank lines', async () => {
    const written: string[] = []
    const output = new Writable({
      write(chunk, _encoding, done) {
        written.push(String(chunk))
        done()
      },
    })
    const input = Readable.from([
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`,
      '\n',
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'context_glob', arguments: { ...harness.root, pattern: 'page/*.md' } } })}\n`,
      'not json at all\n',
    ])

    await new ContextMcpServer(harness.browser, reader).serve(input, output)
    const responses = written.join('').trimEnd().split('\n').map((line) => JSON.parse(line) as JsonRpcResponse)
    // Three replies: initialize, the tool call, and the parse failure. The
    // notification and the blank line produce none.
    expect(responses.map((response) => response.id)).toEqual([1, 2, null])
    const globbed = JSON.parse((responses[1].result as { content: { text: string }[] }).content[0].text) as string[]
    expect(globbed).toEqual(['page/readme.md'])
    expect(responses[2].error?.code).toBe(-32602)
  })
})

describe('context browsing — local HTTP', () => {
  let base: string
  let http: ContextHttpServer

  beforeAll(async () => {
    http = new ContextHttpServer(harness.browser, reader)
    base = `http://127.0.0.1:${await http.listen(0)}`
  })
  afterAll(() => http.close())

  it('binds loopback and publishes its operation catalogue', async () => {
    const response = await fetch(`${base}/context`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = (await response.json()) as ResultEnvelope<{ operations: { operation: string }[] }>
    expect(ok(body).operations.map((entry) => entry.operation)).toEqual([...contextBrowseOperations])
  })

  it('serves a browse operation from the query string', async () => {
    const response = await fetch(`${base}/context/read?uri=${encodeURIComponent(harness.uri('page/guides/setup.md'))}`)
    expect(response.status).toBe(200)
    expect(ok((await response.json()) as ResultEnvelope<ContextNode>).body).toBe('beta line')

    const grep = await fetch(`${base}/context/grep?workspace=main&project=hive&pattern=ALPHA&ignoreCase=true`)
    expect(ok((await grep.json()) as ResultEnvelope<unknown[]>)).toHaveLength(1)
  })

  it('refuses every method that could mutate, before parsing the request', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await fetch(`${base}/context/read?uri=${encodeURIComponent(harness.uri('page/readme.md'))}`, { method })
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('GET')
      expect(error((await response.json()) as ResultEnvelope<unknown>).code).toBe('METHOD_NOT_ALLOWED')
    }
  })

  it('maps error codes onto statuses a client can act on', async () => {
    const absent = await fetch(`${base}/context/read?uri=${encodeURIComponent(harness.uri('page/absent.md'))}`)
    expect(absent.status).toBe(404)

    const unroutable = await fetch(`${base}/nope`)
    expect(unroutable.status).toBe(404)

    for (const verb of mutations) {
      const response = await fetch(`${base}/context/${verb}?workspace=main&project=hive`)
      expect(response.status).toBe(404)
      expect(error((await response.json()) as ResultEnvelope<unknown>).code).toBe('UNKNOWN_OPERATION')
    }

    const incomplete = await fetch(`${base}/context/grep?workspace=main&project=hive`)
    expect(incomplete.status).toBe(400)
  })
})

describe('context browsing — desktop main process IPC', () => {
  function handlers(): Map<string, IpcHandler> {
    const registered = new Map<string, IpcHandler>()
    registerContextIpc({ handle: (channel, handler) => registered.set(channel, handler) }, harness.browser, reader)
    return registered
  }

  it('registers one channel per operation and answers on it', () => {
    const registered = handlers()
    const result = registered.get(`${contextIpcPrefix}stat`)!({}, { uri: harness.uri('page/readme.md') })
    expect(ok(result as ResultEnvelope<{ namespace: string }>).namespace).toBe('page')
    for (const verb of mutations) expect(registered.has(`${contextIpcPrefix}${verb}`)).toBe(false)
  })

  it('takes the operation from the channel, never from the renderer payload', () => {
    // A renderer that tries to smuggle a different operation still gets `ls`.
    const result = handlers().get(`${contextIpcPrefix}ls`)!({}, { operation: 'read', uri: harness.uri('page') })
    expect(Array.isArray(ok(result as ResultEnvelope<unknown[]>))).toBe(true)
  })

  it('tolerates a missing or non-object payload', () => {
    const registered = handlers()
    for (const payload of [undefined, null, 'string', 42]) {
      const result = registered.get(`${contextIpcPrefix}ls`)!({}, payload)
      // No target given, so it fails cleanly rather than throwing into Electron.
      expect(error(result as ResultEnvelope<unknown>).code).toBe('MISSING_ARGUMENT')
    }
  })
})

function ok<T>(result: ResultEnvelope<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`)
  return result.data
}

function error(result: ResultEnvelope<unknown>): { code: string; message: string } {
  if (result.ok) throw new Error('expected a failure envelope')
  return result.error
}
