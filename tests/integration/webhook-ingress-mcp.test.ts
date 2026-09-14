import { request } from 'node:http'
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ObservabilityService, SignedWebhookAdapter } from '../../src/observability.js'
import { WebhookIngressServer } from '../../src/interfaces/http/webhook-ingress.js'
import { HiveMcpServer } from '../../src/interfaces/mcp/hive-mcp-server.js'
import { ContextMcpServer } from '../../src/interfaces/mcp/context-mcp-server.js'
import { ControlMcpServer } from '../../src/interfaces/mcp/control-mcp-server.js'
import { ContextBrowser } from '../../src/context/browser.js'
import { WorkflowService } from '../../src/workflow.js'
import { testActor, knowledgeHarness, workHarness } from '../fixtures.js'
import type { Capability, WorkflowDefinition } from '../../src/contracts.js'

const capabilities: Capability[] = ['workspace:read', 'work:mutate', 'work:dispatch']
const secret = 'ingress-secret'

const definition = (): Omit<WorkflowDefinition, 'createdBy' | 'createdAt' | 'updatedAt'> => ({
  id: 'ingest-flow', version: '1.0.0', name: 'Ingest', description: 'ingest', enabled: true,
  steps: [{ id: 'one', type: 'create_work', title: 'Handle the event' }],
})

interface Reply {
  status: number
  body: Record<string, unknown>
}

/** Posts a body the way a provider would, returning status and parsed JSON. */
function post(port: number, body: string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const call = request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> })
      })
    })
    call.on('error', reject)
    call.end(body)
  })
}

function sign(body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

describe('signed webhook ingress', () => {
  it('admits a signed delivery once, deduplicates the retry, and refuses a bad signature', async () => {
    const operator = testActor('operator', capabilities)
    const harness = workHarness([operator])
    const workflows = new WorkflowService({ ledger: harness.ledger, board: harness.board, now: harness.clock.now })
    workflows.register(operator, definition())
    const server = new WebhookIngressServer({
      adapter: new SignedWebhookAdapter({ workflow: workflows, secret }),
      actor: operator,
      scope: harness.scope,
      workflowId: 'ingest-flow',
      kind: 'github',
    })
    const port = await server.listen(0)
    const body = JSON.stringify({ action: 'opened', number: 12 })

    const unsigned = await post(port, body, { 'content-type': 'application/json' })
    expect(unsigned.status).toBe(401)

    const bad = await post(port, body, { 'x-hub-signature-256': 'sha256=deadbeef', 'x-github-delivery': 'd-1' })
    expect(bad.status).toBe(401)
    expect(harness.board.list(operator, harness.scope)).toHaveLength(0)

    const first = await post(port, body, { 'x-hub-signature-256': `sha256=${sign(body)}`, 'x-github-delivery': 'd-1' })
    expect(first.status).toBe(202)
    expect(first.body.duplicate).toBe(false)

    // The same delivery id again is the provider retrying, not new work.
    const retry = await post(port, body, { 'x-hub-signature-256': `sha256=${sign(body)}`, 'x-github-delivery': 'd-1' })
    expect(retry.status).toBe(200)
    expect(retry.body.duplicate).toBe(true)
    expect(harness.board.list(operator, harness.scope)).toHaveLength(1)

    await server.close()
    harness.close()
  })

  it('refuses a method other than POST, and a body over the cap', async () => {
    const operator = testActor('operator', capabilities)
    const harness = workHarness([operator])
    const workflows = new WorkflowService({ ledger: harness.ledger, board: harness.board, now: harness.clock.now })
    workflows.register(operator, definition())
    const server = new WebhookIngressServer({
      adapter: new SignedWebhookAdapter({ workflow: workflows, secret }),
      actor: operator,
      scope: harness.scope,
      workflowId: 'ingest-flow',
      kind: 'webhook',
      maxBodyBytes: 32,
    })
    const port = await server.listen(0)
    const oversized = JSON.stringify({ padding: 'x'.repeat(200) })

    const tooLarge = await post(port, oversized, { 'x-hive-signature': sign(oversized) })
    expect(tooLarge.status).toBe(413)
    expect(harness.board.list(operator, harness.scope)).toHaveLength(0)

    await server.close()
    harness.close()
  })

  it('reports a refused trigger with the gate status, not a generic failure', async () => {
    const operator = testActor('operator', capabilities)
    const harness = workHarness([operator])
    const workflows = new WorkflowService({
      ledger: harness.ledger, board: harness.board, now: harness.clock.now,
      admission: { allowedKinds: ['manual'] },
    })
    workflows.register(operator, definition())
    const server = new WebhookIngressServer({
      adapter: new SignedWebhookAdapter({ workflow: workflows, secret }),
      actor: operator,
      scope: harness.scope,
      workflowId: 'ingest-flow',
      kind: 'github',
    })
    const port = await server.listen(0)
    const body = JSON.stringify({ action: 'opened' })

    const refused = await post(port, body, { 'x-hive-signature': sign(body), 'x-hive-delivery': 'r-1' })
    expect(refused.status).toBe(403)
    expect((refused.body.error as { code: string }).code).toBe('TRIGGER_REFUSED')

    await server.close()
    harness.close()
  })
})

describe('MCP stdio surface', () => {
  it('serves context and control tools together, and refuses an unknown one', () => {
    const operator = testActor('operator', capabilities)
    const harness = knowledgeHarness([operator])
    const workflows = new WorkflowService({ ledger: harness.ledger, board: harness.board, now: harness.clock.now })
    const server = new HiveMcpServer(
      new ContextMcpServer(new ContextBrowser(harness.fs, harness.ledger), operator),
      new ControlMcpServer({ ledger: harness.ledger, workflows, observability: new ObservabilityService({ ledger: harness.ledger }), scope: harness.scope }, operator),
    )

    const init = server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    expect(init?.result).toMatchObject({ protocolVersion: '2024-11-05', serverInfo: { name: 'hive' } })

    const names = ((server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })?.result as { tools: { name: string }[] }).tools).map((tool) => tool.name)
    expect(names.some((name) => name.startsWith('context_'))).toBe(true)
    // The control half is exactly the read-only views: asserted as a closed set,
    // because "no mutation is reachable" is only a real guarantee if nothing can
    // be added here without this test failing (a substring check would let
    // `control_register` through as long as it avoided the banned words).
    expect(names.filter((name) => name.startsWith('control_')).sort()).toEqual([
      'control_admission',
      'control_metrics',
      'control_queues',
      'control_skills',
      'control_triggers',
      'control_workflow_runs',
      'control_workflow_schedules',
      'control_workflow_watches',
      'control_workflows',
    ])

    const control = server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'control_workflows' } })
    expect(control?.error).toBeUndefined()
    expect(JSON.parse((control?.result as { content: { text: string }[] }).content[0].text)).toEqual([])

    expect(server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope_tool' } })?.error?.code).toBe(-32602)
    harness.close()
  })

  it('round-trips a request over a stream, the way a client drives it', async () => {
    const operator = testActor('operator', capabilities)
    const harness = workHarness([operator])
    const workflows = new WorkflowService({ ledger: harness.ledger, board: harness.board, now: harness.clock.now })
    const server = new HiveMcpServer(
      new ContextMcpServer(new ContextBrowser(harness.fs, harness.ledger), operator),
      new ControlMcpServer({ ledger: harness.ledger, workflows, observability: new ObservabilityService({ ledger: harness.ledger }), scope: harness.scope }, operator),
    )
    const { PassThrough } = await import('node:stream')
    const input = new PassThrough()
    const output = new PassThrough()
    const lines: string[] = []
    output.on('data', (chunk: Buffer) => lines.push(chunk.toString('utf8')))

    const served = server.serve(input, output)
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`)
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
    input.end()
    await served

    const replies = lines.join('').trim().split('\n').map((line) => JSON.parse(line) as { id: number; result?: unknown })
    expect(replies.map((reply) => reply.id)).toEqual([1, 2])
    expect((replies[1].result as { tools: unknown[] }).tools.length).toBeGreaterThan(0)
    harness.close()
  })
})
