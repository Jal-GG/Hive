import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { ActorContext, ResultEnvelope } from '../../contracts.js'
import {
  ContextBrowseOperation,
  ContextBrowseRequest,
  ContextBrowser,
  contextBrowseHelp,
  contextBrowseOperations,
} from '../../context/browser.js'

const loopback = '127.0.0.1'

/**
 * A read-only local HTTP view of the context root: `GET /context/{operation}?…`.
 *
 * Bound to loopback and limited to GET on purpose — C4 says the browser-facing
 * surface exposes no mutations by default, and refusing every other method is
 * how that is enforced rather than merely documented.
 */
export class ContextHttpServer {
  private readonly server: Server

  constructor(
    private readonly browser: ContextBrowser,
    private readonly actor: ActorContext,
  ) {
    this.server = createServer((request, response) => this.route(request, response))
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, loopback, () => resolve((this.server.address() as AddressInfo).port))
    })
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())))
  }

  /** Exposed for tests and for embedding in a host that already owns an HTTP server. */
  route(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'GET') {
      // Anything that could mutate is refused before it is even parsed.
      reply(response, 405, { version: 1, requestId: '', ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'The context browser is read-only' } }, { allow: 'GET' })
      return
    }
    const url = new URL(request.url ?? '/', `http://${loopback}`)
    if (url.pathname === '/context') {
      reply(response, 200, { version: 1, requestId: '', ok: true, data: { operations: contextBrowseOperations.map((operation) => ({ operation, description: contextBrowseHelp[operation] })) } })
      return
    }
    const match = /^\/context\/([A-Za-z]+)$/.exec(url.pathname)
    if (!match) {
      reply(response, 404, { version: 1, requestId: '', ok: false, error: { code: 'NOT_FOUND', message: `No such route: ${url.pathname}` } })
      return
    }
    const result = this.browser.browse(this.actor, toRequest(match[1], url.searchParams))
    reply(response, result.ok ? 200 : statusFor(result.error.code), result)
  }
}

function toRequest(operation: string, query: URLSearchParams): ContextBrowseRequest {
  const request: ContextBrowseRequest = { version: 1, operation: operation as ContextBrowseOperation }
  for (const field of ['uri', 'workspace', 'project', 'path', 'pattern', 'revision', 'requestId'] as const) {
    const value = query.get(field)
    if (value !== null) request[field] = value
  }
  for (const field of ['depth', 'limit'] as const) {
    const value = query.get(field)
    if (value !== null) request[field] = Number(value)
  }
  if (query.get('ignoreCase') === 'true') request.ignoreCase = true
  return request
}

/** Error codes map onto the status a client can act on; anything unrecognized is a 400. */
function statusFor(code: string): number {
  switch (code) {
    case 'NOT_FOUND':
    case 'SCOPE_NOT_FOUND':
    case 'NOT_DELETED':
      return 404
    case 'FORBIDDEN':
    case 'SCOPE_VIOLATION':
      return 403
    case 'UNKNOWN_OPERATION':
      return 404
    case 'INTERNAL_ERROR':
      return 500
    default:
      return 400
  }
}

function reply(response: ServerResponse, status: number, body: ResultEnvelope<unknown>, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload).toString(),
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(payload)
}
