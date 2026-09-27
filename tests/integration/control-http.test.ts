import { describe, expect, it } from 'vitest'
import { ContextBrowser } from '../../src/context/browser.js'
import { ControlHttpServer } from '../../src/interfaces/http/control-http-server.js'
import { ObservabilityService } from '../../src/observability.js'
import { HiveSdk } from '../../src/sdk.js'
import { WorkflowService } from '../../src/workflow.js'
import { testActor, workHarness } from '../fixtures.js'
import type { Capability } from '../../src/contracts.js'

const capabilities: Capability[] = ['workspace:read', 'work:mutate', 'work:dispatch', 'context:read', 'context:write']

/** One read-only control HTTP server over a work harness, plus the port it listens on. */
async function server() {
  const actor = testActor('operator', capabilities)
  const harness = workHarness([actor])
  const workflows = new WorkflowService({ ledger: harness.ledger, board: harness.board, now: harness.clock.now })
  const observability = new ObservabilityService({ ledger: harness.ledger, now: harness.clock.now })
  const http = new ControlHttpServer({
    browser: new ContextBrowser(harness.fs, harness.ledger),
    control: { ledger: harness.ledger, workflows, observability, scope: harness.scope },
    actor,
  })
  return { actor, harness, http, port: await http.listen(0) }
}

describe('control HTTP surface: dashboard and SDK', () => {
  it('serves read-only HTML and a /status snapshot over loopback GET only', async () => {
    const { harness, http, port } = await server()

    const page = await fetch(`http://127.0.0.1:${port}/`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('read-only dashboard')
    expect(html).not.toContain('<form')

    const status = await fetch(`http://127.0.0.1:${port}/status`)
    const body = (await status.json()) as { ok: boolean; data?: { scope: { workspace: string } } }
    expect(body.ok).toBe(true)
    expect(body.data?.scope.workspace).toBe('main')

    const post = await fetch(`http://127.0.0.1:${port}/status`, { method: 'POST' })
    expect(post.status).toBe(405)
    await http.close()
    harness.close()
  })

  it('SDK client: reads status and context through the same read-only surface', async () => {
    const { actor, harness, http, port } = await server()
    harness.fs.write(actor, harness.scope, { path: 'page/sdk.md', body: 'sdk readable page' })
    const sdk = new HiveSdk({ baseUrl: `http://127.0.0.1:${port}` })

    const status = await sdk.status()
    expect(status.scope.workspace).toBe('main')
    // `ls` answers with the entry array directly, the same envelope data every surface serves.
    const listed = await sdk.context<unknown[]>('ls', { workspace: 'main', project: 'hive', path: 'page' })
    expect(listed).toHaveLength(1)
    const grep = await sdk.context<unknown[]>('grep', { workspace: 'main', project: 'hive', pattern: 'sdk readable' })
    expect(grep.length).toBeGreaterThanOrEqual(1)
    await http.close()
    harness.close()
  })
})
