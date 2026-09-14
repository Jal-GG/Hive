import { createServer, type Server, type TLSSocket } from 'node:tls'
import { connect as tlsConnect } from 'node:tls'
import { AddressInfo } from 'node:net'
import { createId } from '../shared.js'
import { CertificateAuthority } from './certs.js'
import {
  CancelFrame,
  Frame,
  FrameDecoder,
  HelloFrame,
  ReplyFrame,
  WelcomeFrame,
  branchAllowed,
  encodeFrame,
  policyAllows,
  protocolVersion,
  type RemotePolicy,
} from './protocol.js'
import type { PushBundleRequest } from './git-relay.js'
import type { RemoteObjectStore } from './object-store.js'

/**
 * The remote `ExecutionAgent` (§7 Phase 9): an mTLS-authenticated server whose
 * entire capability surface is the policy's allowlist. There is no shell, no
 * arbitrary git invocation, and no filesystem path from the wire: the commands
 * are typed operations — git bundle push/fetch, object store put/get, ledger
 * events page, ping — and each one runs against a fixed target the agent owns.
 *
 * Authentication is the certificate, verified fail-closed against the CA, and
 * identity is the leaf CN. Authorization is the policy, intersected with what
 * the client asked for in hello. Request IDs make replays idempotent for a
 * bounded window: a connection drop and retry of the same request ID returns
 * the first reply, not a second execution.
 */

/** The typed operations an agent serves. Everything else is a policy refusal. */
export type AgentCommand =
  | { command: 'ping' }
  | { command: 'git.push'; push: PushBundleRequest }
  | { command: 'git.fetch'; branch: string }
  | { command: 'git.head'; branch: string }
  | { command: 'store.put'; tenant: string; bytes: Buffer }
  | { command: 'store.get'; tenant: string; sha256: string }
  | { command: 'events'; after: number; limit: number }

export interface ExecutionAgentOptions {
  /** The policy this agent enforces. Its identity names the certificate CN that may connect. */
  policy: RemotePolicy
  /** Verifies client certificates and maps them to identities. */
  authority: CertificateAuthority
  /** The agent's own TLS identity, presented to clients and verified by them. */
  serverCertificate: { certificate: string; privateKey: string }
  /** The git relay this agent's `git.*` commands run against. */
  relay: { push(request: PushBundleRequest): Promise<unknown>; fetch(branch: string): Promise<{ bundle: Buffer; head: string }>; headOf(branch: string): string | undefined }
  /** The object store this agent's `store.*` commands run against. */
  store: RemoteObjectStore
  /** Pages the agent's durable event log for `events` commands. */
  events: (after: number, limit: number) => { events: unknown[]; latest: number }
  /** How many recent request replies are remembered for idempotent retry. */
  replyCacheSize?: number
  /**
   * Concurrent in-flight requests this agent will serve; beyond it, requests
   * are refused with `TOO_BUSY` rather than queued without bound. A bounded
   * refusal, not an unbounded pile-up (§7 "bounded failure behavior").
   */
  maxConcurrentRequests?: number
}

export class ExecutionAgent {
  private readonly server: Server
  private readonly replies = new Map<string, ReplyFrame>()
  private readonly replyOrder: string[] = []
  private readonly replyCacheSize: number
  private readonly maxConcurrentRequests: number
  private readonly active = new Map<string, { cancelled: boolean }>()
  private readonly sockets = new Set<TLSSocket>()
  connections = 0

  constructor(private readonly options: ExecutionAgentOptions) {
    this.replyCacheSize = options.replyCacheSize ?? 256
    this.maxConcurrentRequests = options.maxConcurrentRequests ?? 16
    this.server = createServer(
      {
        // mTLS: the server presents its own leaf, and a client certificate is
        // required and verified against the CA.
        key: options.serverCertificate.privateKey,
        cert: options.serverCertificate.certificate,
        requestCert: true,
        rejectUnauthorized: true,
        ca: options.authority.certificatePem(),
      },
      (socket) => this.onConnection(socket),
    )
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, '127.0.0.1', () => resolve((this.server.address() as AddressInfo).port))
    })
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    return new Promise((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())))
  }

  private onConnection(socket: TLSSocket): void {
    this.sockets.add(socket)
    this.connections += 1
    socket.on('close', () => {
      this.sockets.delete(socket)
      this.connections -= 1
    })

    // Authentication before anything else: an unverified client never reaches
    // the decoder, let alone a command.
    const peer = socket.getPeerCertificate()
    if (!peer || peer.raw === undefined) {
      socket.destroy()
      return
    }
    const leafPem = `-----BEGIN CERTIFICATE-----\n${peer.raw.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`
    const verified = this.options.authority.verify(leafPem)
    if (!verified.ok) {
      socket.destroy()
      return
    }
    const identity = this.options.authority.identityOf(leafPem)
    const allowedClients = this.options.policy.allowedClientIdentities
    if (allowedClients !== undefined && (identity === undefined || !allowedClients.includes(identity))) {
      // The certificate is valid but is not an identity this agent is configured to trust.
      socket.destroy()
      return
    }

    const decoder = new FrameDecoder()
    let welcomed = false
    socket.on('data', (chunk: Buffer) => {
      let frames: Frame[]
      try {
        frames = decoder.feed(chunk)
      } catch (error) {
        this.fatal(socket, 'FRAME_INVALID', error instanceof Error ? error.message : String(error))
        return
      }
      for (const frame of frames) {
        try {
          this.handle(socket, frame, () => welcomed, (value: boolean) => { welcomed = value })
        } catch (error) {
          this.fatal(socket, 'PROTOCOL_ERROR', error instanceof Error ? error.message : String(error))
          return
        }
      }
    })
  }

  private handle(socket: TLSSocket, frame: Frame, welcomed: () => boolean, setWelcomed: (value: boolean) => void): void {
    if (frame.type === 'hello') {
      if (welcomed()) return this.fatal(socket, 'PROTOCOL_ERROR', 'hello after welcome')
      const hello = frame as HelloFrame
      if (hello.protocolVersion !== protocolVersion) {
        return this.fatal(socket, 'VERSION_MISMATCH', `server speaks ${protocolVersion}, client offered ${hello.protocolVersion}`)
      }
      const granted = hello.capabilities.filter((capability) => this.options.policy.capabilities.includes(capability))
      const welcome: WelcomeFrame = { type: 'welcome', protocolVersion, identity: this.options.policy.identity, capabilities: granted }
      socket.write(encodeFrame(welcome))
      setWelcomed(true)
      return
    }
    if (!welcomed()) return this.fatal(socket, 'PROTOCOL_ERROR', 'request before hello')

    if (frame.type === 'request') {
      void this.execute(socket, frame.requestId, frame.capability, frame.command, frame.arguments)
      return
    }
    if (frame.type === 'cancel') {
      const entry = this.active.get((frame as CancelFrame).requestId)
      if (entry) entry.cancelled = true
      return
    }
    this.fatal(socket, 'PROTOCOL_ERROR', `unexpected frame type ${frame.type} from client`)
  }

  private async execute(socket: TLSSocket, requestId: string, capability: string, command: string, args: Record<string, unknown>): Promise<void> {
    // Idempotent retry: the same request ID returns the remembered reply.
    const remembered = this.replies.get(requestId)
    if (remembered) {
      socket.write(encodeFrame({ ...remembered, requestId }))
      return
    }
    if (!policyAllows(this.options.policy, capability, command)) {
      this.remember(socket, requestId, { type: 'reply', requestId, ok: false, error: { code: 'POLICY_REFUSED', message: `${capability}:${command} is not in this agent's allowlist` } })
      return
    }
    if (this.active.size >= this.maxConcurrentRequests) {
      // Refused, not queued: an overloaded agent answers immediately rather
      // than letting a hostile client pile up unbounded in-flight work. The
      // refusal is not remembered — the client may retry the same ID once
      // load drops, and the request never executed.
      socket.write(encodeFrame({ type: 'reply', requestId, ok: false, error: { code: 'TOO_BUSY', message: `${this.active.size} requests are already in flight` } }))
      return
    }
    const entry = { cancelled: false }
    this.active.set(requestId, entry)
    try {
      const data = await this.dispatch(command, args, entry)
      if (entry.cancelled) return // the reply was withheld; the client moved on
      this.remember(socket, requestId, { type: 'reply', requestId, ok: true, data })
    } catch (error) {
      if (entry.cancelled) return
      this.remember(socket, requestId, { type: 'reply', requestId, ok: false, error: { code: 'COMMAND_FAILED', message: error instanceof Error ? error.message : String(error) } })
    } finally {
      this.active.delete(requestId)
    }
  }

  /** One typed dispatch per command; there is deliberately no generic path. */
  private async dispatch(command: string, args: Record<string, unknown>, entry: { cancelled: boolean }): Promise<unknown> {
    switch (command) {
      case 'ping':
        return { pong: true, identity: this.options.policy.identity }
      case 'git.push': {
        const branch = requireString(args.branch, 'branch')
        // Branch authorization is the relay's own first check, enforced again here
        // so the policy file and the relay can never drift apart silently.
        if (!branchAllowed(branch, this.options.policy.allowedBranches)) throw new Error(`branch ${branch} is not allowed by policy`)
        const bundle = requireBuffer(args.bundle, 'bundle')
        return this.options.relay.push({ branch, expectedHead: typeof args.expectedHead === 'string' ? args.expectedHead : undefined, bundle })
      }
      case 'git.fetch': {
        const fetched = await this.options.relay.fetch(requireString(args.branch, 'branch'))
        return { head: fetched.head, bundle: fetched.bundle.toString('base64') }
      }
      case 'git.head':
        return { head: this.options.relay.headOf(requireString(args.branch, 'branch')) ?? null }
      case 'store.put':
        return this.options.store.put(requireString(args.tenant, 'tenant'), requireBuffer(args.bytes, 'bytes'))
      case 'store.get': {
        const bytes = await this.options.store.get(requireString(args.tenant, 'tenant'), requireString(args.sha256, 'sha256'))
        return { bytes: bytes.toString('base64') }
      }
      case 'events': {
        const after = typeof args.after === 'number' ? args.after : 0
        const limit = typeof args.limit === 'number' ? Math.min(args.limit, 500) : 100
        void entry
        return this.options.events(after, limit)
      }
      default:
        throw new Error(`unknown command: ${command}`)
    }
  }

  private remember(socket: TLSSocket, requestId: string, reply: ReplyFrame): void {
    this.replies.set(requestId, reply)
    this.replyOrder.push(requestId)
    while (this.replyOrder.length > this.replyCacheSize) {
      this.replies.delete(this.replyOrder.shift()!)
    }
    socket.write(encodeFrame(reply))
  }

  private fatal(socket: TLSSocket, code: string, message: string): void {
    socket.write(encodeFrame({ type: 'error', code, message }))
    socket.end()
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${name} is required`)
  return value
}

function requireBuffer(value: unknown, name: string): Buffer {
  if (typeof value !== 'string') throw new Error(`${name} is required (base64)`)
  return Buffer.from(value, 'base64')
}

/**
 * The client half: connects with its own leaf certificate, negotiates, and
 * matches replies to requests by ID. Reconnecting and re-sending a request
 * returns the remembered reply — the DoD's "reconnect without duplicate events"
 * for the command plane.
 */
export class RemoteAgentClient {
  private socket?: TLSSocket
  private decoder = new FrameDecoder()
  private welcome?: WelcomeFrame
  private welcomeWaiter?: { resolve: (welcome: WelcomeFrame) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }
  private readonly pending = new Map<string, { resolve: (reply: ReplyFrame) => void }>()
  private readonly listeners = new Set<(frame: Frame) => void>()

  constructor(private readonly options: {
    host: string
    port: number
    /** The client's own leaf, presented as the mTLS certificate. */
    certificate: string
    privateKey: string
    /** The CA that must have signed the server's certificate. */
    serverAuthority: string
    /**
     * The agent identity the client expects to reach. When set, a welcome
     * naming a different agent fails the connect — a mis-routed port must
     * fail loudly, not push somewhere wrong.
     */
    expectedIdentity?: string
    /** Capabilities the client intends to use; the server grants the intersection. */
    capabilities?: readonly string[]
  }) {}

  /** Connects and completes the hello/welcome negotiation. Fail-closed on any mismatch. */
  async connect(): Promise<WelcomeFrame> {
    const socket = tlsConnect({
      host: this.options.host,
      port: this.options.port,
      cert: this.options.certificate,
      key: this.options.privateKey,
      ca: this.options.serverAuthority,
      // The server's certificate must chain to the pinned CA — no system roots —
      // and its SAN must cover the host we dialed (DNS or IP, per the leaf).
      rejectUnauthorized: true,
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('TLS handshake timeout'))
      }, 5000)
      const fail = (error: Error) => {
        clearTimeout(timer)
        socket.destroy()
        reject(error)
      }
      socket.once('secureConnect', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once('error', fail)
      socket.once('close', () => {
        if (!socket.authorized) fail(new Error('TLS handshake closed before authorization'))
      })
    })
    this.socket = socket
    socket.on('data', (chunk: Buffer) => {
      try {
        const frames = this.decoder.feed(chunk)
        for (const frame of frames) this.receive(frame)
      } catch {
        socket.destroy()
      }
    })
    socket.write(encodeFrame({ type: 'hello', protocolVersion, capabilities: [...(this.options.capabilities ?? [])] }))
    const welcome = await new Promise<WelcomeFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.welcomeWaiter = undefined
        reject(new Error('welcome timeout'))
      }, 5000)
      this.welcomeWaiter = { resolve, reject, timer }
      // A server that refuses us (mTLS rejection lands here under TLS 1.3, after
      // hello is written) must fail the connect immediately, not on the timer.
      socket.once('close', () => {
        const waiter = this.welcomeWaiter
        if (!waiter) return
        this.welcomeWaiter = undefined
        clearTimeout(waiter.timer)
        waiter.reject(new Error('connection closed before welcome'))
      })
    })
    this.welcome = welcome
    if (this.options.expectedIdentity !== undefined && welcome.identity !== this.options.expectedIdentity) {
      socket.destroy()
      throw new Error(`agent answered as ${welcome.identity}, expected ${this.options.expectedIdentity}`)
    }
    return welcome
  }

  /** Sends one request and awaits its reply. */
  async request(capability: string, command: string, args: Record<string, unknown> = {}): Promise<ReplyFrame> {
    return this.requestWithId(createId(), capability, command, args)
  }

  /**
   * The same request with an explicit ID — the idempotent-retry path. A
   * reconnect that re-sends the ID it already used receives the remembered
   * reply instead of a second execution.
   */
  async requestWithId(requestId: string, capability: string, command: string, args: Record<string, unknown> = {}): Promise<ReplyFrame> {
    if (!this.socket) throw new Error('not connected')
    return new Promise<ReplyFrame>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`reply timeout for ${command}`)) }, 15000)
      this.pending.set(requestId, { resolve: (reply) => { clearTimeout(timer); resolve(reply) } })
      this.socket!.write(encodeFrame({ type: 'request', requestId, capability, command, arguments: args }))
    })
  }

  /** Cancels an in-flight request by ID; its reply, if any, is withheld. */
  cancel(requestId: string): void {
    this.socket?.write(encodeFrame({ type: 'cancel', requestId }))
  }

  onFrame(listener: (frame: Frame) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  connected(): boolean {
    return this.socket !== undefined
  }

  welcomeCapabilities(): string[] {
    return this.welcome?.capabilities ?? []
  }

  private receive(frame: Frame): void {
    for (const listener of this.listeners) listener(frame)
    if (frame.type === 'welcome') {
      const waiter = this.welcomeWaiter
      if (waiter) {
        this.welcomeWaiter = undefined
        clearTimeout(waiter.timer)
        waiter.resolve(frame)
      }
      return
    }
    if (frame.type === 'reply') {
      const waiter = this.pending.get(frame.requestId)
      if (waiter) {
        this.pending.delete(frame.requestId)
        waiter.resolve(frame)
      }
    }
  }

  close(): void {
    this.socket?.destroy()
    this.socket = undefined
  }
}
