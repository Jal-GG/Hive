import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { ActorContext, ScopeRef } from '../../contracts.js'
import { HiveError } from '../../errors.js'
import { SignedWebhookAdapter } from '../../observability.js'

const loopback = '127.0.0.1'

/** The trigger kinds an external delivery may carry; the ingress cannot be configured to anything else. */
export type WebhookKind = 'webhook' | 'github' | 'slack' | 'feed'

/** Where a provider's signature header arrives. Each is matched case-insensitively. */
const signatureHeaders = ['x-hive-signature', 'x-hub-signature-256', 'x-slack-signature'] as const

export interface WebhookIngressOptions {
  adapter: SignedWebhookAdapter
  actor: ActorContext
  scope: ScopeRef
  /** The workflow a verified event enqueues against. Config-time, not attacker-supplied. */
  workflowId: string
  kind: WebhookKind
  maxBodyBytes?: number
}

/**
 * The HTTP ingress for signed external events (§5.7, §7 Phase 8).
 *
 * The adapters could verify a payload long before this existed; what was missing
 * was a door. This is that door, and it is deliberately narrow: bound to
 * loopback, POST only, one configured workflow, and a body cap enforced before
 * the payload is parsed. The workflow and the kind come from configuration, so a
 * caller cannot choose what their event enqueues — only whether it is authentic.
 */
export class WebhookIngressServer {
  private readonly server: Server
  private readonly adapter: SignedWebhookAdapter
  private readonly actor: ActorContext
  private readonly scope: ScopeRef
  private readonly workflowId: string
  private readonly kind: WebhookIngressOptions['kind']
  private readonly maxBodyBytes: number

  constructor(options: WebhookIngressOptions) {
    if (!options.workflowId) throw new HiveError('WEBHOOK_INVALID', 'A workflow id is required to route verified events')
    this.adapter = options.adapter
    this.actor = options.actor
    this.scope = options.scope
    this.workflowId = options.workflowId
    this.kind = options.kind
    this.maxBodyBytes = options.maxBodyBytes ?? 256 * 1024
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

  route(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'POST') {
      reply(response, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'The ingress accepts POST only' } }, { allow: 'POST' })
      return
    }
    const signature = signatureOf(request)
    if (!signature) {
      reply(response, 401, { ok: false, error: { code: 'WEBHOOK_UNAUTHORIZED', message: 'No signature header was supplied' } })
      return
    }

    // The cap is enforced on the stream, so an oversized body is refused without
    // ever being buffered whole.
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    request.on('data', (chunk: Buffer) => {
      if (aborted) return
      size += chunk.length
      if (size > this.maxBodyBytes) {
        aborted = true
        reply(response, 413, { ok: false, error: { code: 'WEBHOOK_TOO_LARGE', message: 'Webhook body exceeds the configured limit' } })
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (aborted) return
      const body = Buffer.concat(chunks).toString('utf8')
      // The delivery id is the caller's idempotency key: a replay of the same
      // event must land as a duplicate, never as a second run.
      const deliveryId = deliveryIdOf(request, body)
      try {
        const result = this.adapter.receiveKind(this.actor, this.scope, this.kind, { id: deliveryId, workflowId: this.workflowId, body, signature })
        // The run's state travels with the reply: a retry of a delivery whose run
        // failed must not read as a clean duplicate, or a provider's retry would
        // look successful while the work sat failed.
        reply(response, result.duplicate ? 200 : 202, { ok: true, duplicate: result.duplicate, runId: result.run?.id, state: result.run?.state })
      } catch (error) {
        const hiveError = error instanceof HiveError ? error : new HiveError('INTERNAL_ERROR', String(error))
        reply(response, statusFor(hiveError.code), { ok: false, error: { code: hiveError.code, message: hiveError.message } })
      }
    })
    request.on('error', () => {
      if (!response.headersSent) reply(response, 400, { ok: false, error: { code: 'WEBHOOK_INVALID', message: 'The request stream failed' } })
    })
  }
}

function signatureOf(request: IncomingMessage): string | undefined {
  for (const header of signatureHeaders) {
    const value = request.headers[header]
    if (typeof value === 'string' && value.length > 0) {
      // GitHub sends `sha256=<hex>`; Hive's own header is the bare hex digest.
      return value.includes('=') ? value.slice(value.indexOf('=') + 1) : value
    }
  }
  return undefined
}

/** The caller's delivery id, or a digest of the body when the provider sends none. */
function deliveryIdOf(request: IncomingMessage, body: string): string {
  const header = request.headers['x-hive-delivery'] ?? request.headers['x-github-delivery'] ?? request.headers['x-slack-request-timestamp']
  if (typeof header === 'string' && header.length > 0) return header.slice(0, 128)
  return `body:${createHash(body)}`
}

function createHash(body: string): string {
  // Not a security primitive here: this only needs to be stable per body so a
  // retry without a delivery header still deduplicates.
  let hash = 0
  for (let index = 0; index < body.length; index += 1) {
    hash = (hash * 31 + body.charCodeAt(index)) | 0
  }
  return Math.abs(hash).toString(16)
}

function statusFor(code: string): number {
  switch (code) {
    case 'WEBHOOK_UNAUTHORIZED': return 401
    case 'WEBHOOK_TOO_LARGE': return 413
    case 'WEBHOOK_INVALID': return 400
    case 'TRIGGER_REFUSED': return 403
    case 'WORKFLOW_NOT_FOUND': return 404
    default: return 500
  }
}

function reply(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (response.headersSent) return
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload).toString(),
    ...headers,
  })
  response.end(payload)
}
