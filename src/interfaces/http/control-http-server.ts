import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { ActorContext, HiveStatusSnapshot, RunState, ScopeRef, WorkItemStatus } from '../../contracts.js'
import { asResult } from '../../errors.js'
import { ContextBrowser } from '../../context/browser.js'
import { Ledger } from '../../ledger.js'
import { ObservabilityService } from '../../observability.js'
import { WorkflowService } from '../../workflow.js'
import { createId } from '../../shared.js'

const loopback = '127.0.0.1'

export interface ControlHttpOptions {
  browser: ContextBrowser
  control: { ledger: Ledger; workflows: WorkflowService; observability: ObservabilityService; scope: ScopeRef }
  actor: ActorContext
}

const liveRunStates: readonly RunState[] = ['spawning', 'running', 'idle', 'completing']
const liveWorkStates: readonly WorkItemStatus[] = ['assigned', 'in_progress', 'review']

/**
 * The read-only control view over HTTP (§7 Phase 8 "read-only web dashboard"),
 * C4's fourth surface: loopback, GET only, the same services the CLI, MCP, and
 * desktop read. `GET /` renders the dashboard; the JSON endpoints it polls are
 * the same envelopes every other client consumes.
 */
export class ControlHttpServer {
  private readonly server: Server

  constructor(private readonly options: ControlHttpOptions) {
    this.server = createServer((request, response) => this.route(request, response))
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, loopback, () => resolve((this.server.address() as AddressInfo).port))
    })
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()))
    })
  }

  /** Exposed for tests and for embedding in a host that already owns an HTTP server. */
  route(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'GET') {
      reply(response, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'The dashboard is read-only' } }, { allow: 'GET' })
      return
    }
    const url = new URL(request.url ?? '/', `http://${loopback}`)
    if (url.pathname === '/' || url.pathname === '/index.html') {
      reply(response, 200, dashboardPage(), { 'content-type': 'text/html; charset=utf-8' })
      return
    }
    if (url.pathname === '/status') {
      reply(response, 200, asResult(createId(), () => this.snapshot()))
      return
    }
    const contextMatch = /^\/context\/([A-Za-z]+)$/.exec(url.pathname)
    if (contextMatch) {
      // The existing context browser answers, unchanged: one browse service, four surfaces.
      const request2: Record<string, string> = {}
      for (const [key, value] of url.searchParams) request2[key] = value
      const result = this.options.browser.browse(this.options.actor, { version: 1, operation: contextMatch[1] as never, ...request2 })
      reply(response, result.ok ? 200 : 404, result)
      return
    }
    reply(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: `No such route: ${url.pathname}` } })
  }

  private snapshot(): HiveStatusSnapshot {
    const { ledger, workflows, observability, scope } = this.options.control
    const runs = ledger.listRuns(scope)
    const items = ledger.listWorkItems(scope)
    const admission = workflows.admissionState()
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    return {
      version: '0.1.0',
      scope: { workspace: scope.workspaceName, project: scope.projectName },
      runs: { live: runs.filter((run) => liveRunStates.includes(run.state)).length, total: runs.length },
      work: {
        open: items.filter((item) => item.status === 'open' || item.status === 'blocked').length,
        inFlight: items.filter((item) => liveWorkStates.includes(item.status)).length,
        total: items.length,
      },
      queues: observability.queueDiagnostics(this.options.actor, scope),
      triggerIngress: {
        paused: admission.policy.paused === true,
        breakerFailures: admission.breaker.failures,
        recentAccepted: ledger.listTriggers(scope).filter((trigger) => trigger.state === 'accepted' && trigger.createdAt >= hourAgo).length,
      },
      telemetryEnabled: observability.isEnabled(),
    }
  }
}

function reply(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload).toString(),
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(payload)
}

/** The dashboard: one static page that polls `/status`. No scripts from anywhere else. */
function dashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hive</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 13px/1.5 ui-monospace, monospace; background: #0e1118; color: #e6e9f2; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 14px; letter-spacing: .2em; color: #f5b942; margin: 0 0 4px; }
  .sub { color: #7d859c; font-size: 11px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .card { background: #151a26; border: 1px solid #232a3d; border-radius: 10px; padding: 12px 14px; }
  .card h2 { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: #7d859c; margin: 0 0 8px; }
  .num { font-size: 22px; font-weight: 700; color: #f5b942; }
  .num small { font-size: 11px; color: #7d859c; font-weight: 400; }
  .quiet { color: #7d859c; }
  footer { margin-top: 28px; font-size: 11px; color: #7d859c; }
</style>
</head>
<body>
<main>
  <h1>HIVE</h1>
  <p class="sub">read-only dashboard — loopback, GET only, no mutations (C4)</p>
  <div class="grid" id="cards"></div>
  <footer id="foot">loading…</footer>
</main>
<script>
  async function refresh() {
    try {
      const result = await (await fetch('/status')).json();
      const data = result.ok ? result.data : null;
      if (!data) { document.getElementById('foot').textContent = 'status unavailable: ' + JSON.stringify(result.error); return; }
      const cards = [
        ['runs', data.runs.live + ' <small>live of ' + data.runs.total + '</small>'],
        ['work', data.work.open + ' <small>open · ' + data.work.inFlight + ' in flight of ' + data.work.total + '</small>'],
        ['ingress', data.triggerIngress.paused ? 'paused' : 'live', data.triggerIngress.paused ? 'paused' : 'live · ' + data.triggerIngress.recentAccepted + ' accepted last hour'],
        ['queues', data.queues.map(function (q) { return q.queue + ' ' + q.depth; }).join('<br>') || 'empty'],
        ['telemetry', data.telemetryEnabled ? 'on' : 'off'],
        ['scope', data.scope.workspace + '/' + data.scope.project],
      ];
      document.getElementById('cards').innerHTML = cards.map(function (card) {
        return '<div class="card"><h2>' + card[0] + '</h2><div class="num">' + card[1] + '</div>' + (card[2] ? '<div class="quiet">' + card[2] + '</div>' : '') + '</div>';
      }).join('');
      document.getElementById('foot').textContent = 'hive ' + data.version + ' · refreshed ' + new Date().toLocaleTimeString();
    } catch (error) {
      document.getElementById('foot').textContent = 'refresh failed: ' + error;
    }
  }
  refresh();
  setInterval(refresh, 3000);
</script>
</body>
</html>
`
}
