import { HiveStatusSnapshot, ResultEnvelope } from './contracts.js'

export interface HiveSdkOptions {
  /** Base URL of a read-only Hive control HTTP server, e.g. `http://127.0.0.1:8788`. */
  baseUrl: string
  /** Standard `fetch`; injectable so tests never open sockets they do not own. */
  fetch?: typeof fetch
  /** Request timeout in milliseconds; a stuck dashboard must not hang a client. */
  timeoutMs?: number
}

/**
 * The SDK client (§7 Phase 8): a small typed reader for the read-only HTTP
 * surface. It deliberately speaks only GETs — the same C4 rule the dashboard
 * obeys — so embedding the SDK in a build, a notebook, or another operator
 * console can observe Hive but never steer it.
 */
export class HiveSdk {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: HiveSdkOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? 5000
  }

  async status(): Promise<HiveStatusSnapshot> {
    return this.unwrap<HiveStatusSnapshot>(this.get('/status'))
  }

  /** Read one context browse operation; the operation names are the browser's own list. */
  async context<T = unknown>(operation: string, query: Record<string, string> = {}): Promise<T> {
    const params = new URLSearchParams(query)
    const suffix = params.size > 0 ? `?${params}` : ''
    return this.unwrap<T>(this.get(`/context/${operation}${suffix}`))
  }

  private get(path: string): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    return this.fetchImpl(`${this.baseUrl}${path}`, { signal: controller.signal, headers: { accept: 'application/json' } })
      .finally(() => clearTimeout(timer))
  }

  private async unwrap<T>(pending: Promise<Response>): Promise<T> {
    const response = await pending
    const body = (await response.json()) as ResultEnvelope<T>
    if (!body.ok) throw new Error(body.error ? `${body.error.code}: ${body.error.message}` : `Request failed: HTTP ${response.status}`)
    return body.data
  }
}
