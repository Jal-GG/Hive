/**
 * The remote `ExecutionAgent` protocol (§7 Phase 9): a small binary framing
 * over TLS streams, one request per frame, replies matched by request ID.
 *
 * Deliberately not HTTP: the agent is a long-lived authenticated session that
 * multiplexes command requests and a server-push event stream, and framing is
 * a handful of lines rather than a second protocol stack. Every message is a
 * length-prefixed JSON body with a type tag, bounded at 1 MiB so a hostile
 * header cannot demand unbounded memory before authentication lands.
 */

/** The only protocol version this build speaks. Negotiation is exact (§7 Phase 9 "compatibility negotiation"). */
export const protocolVersion = 1

/** A frame larger than this is a protocol violation, not a big request. */
export const maxFrameBytes = 1024 * 1024

export type FrameType =
  | 'hello'          // client → server: protocol version + capabilities
  | 'welcome'        // server → client: accepted version + agent identity
  | 'request'        // client → server: one command invocation
  | 'reply'          // server → client: result or refusal for a request
  | 'events'         // server → client: pushed event page
  | 'cancel'         // client → server: cancel an in-flight request
  | 'error'          // either direction: fatal protocol error, connection dies

export interface HelloFrame {
  type: 'hello'
  protocolVersion: number
  /** The capabilities the client wants, from the policy vocabulary below. */
  capabilities: string[]
}

export interface WelcomeFrame {
  type: 'welcome'
  protocolVersion: number
  /** The agent's certificate identity, echoed so the client confirms the peer. */
  identity: string
  /** Capabilities the server's policy actually granted, a subset of what was asked. */
  capabilities: string[]
}

export interface RequestFrame {
  type: 'request'
  requestId: string
  capability: string
  /** The command, from the policy's allowlist. */
  command: string
  arguments: Record<string, unknown>
}

export interface ReplyFrame {
  type: 'reply'
  requestId: string
  ok: boolean
  data?: unknown
  error?: { code: string; message: string }
}

export interface EventsFrame {
  type: 'events'
  /** The cursor the client last consumed; pages resume exactly here. */
  cursor: number
  events: unknown[]
  latest: number
}

export interface CancelFrame {
  type: 'cancel'
  requestId: string
}

export interface ErrorFrame {
  type: 'error'
  code: string
  message: string
}

export type Frame = HelloFrame | WelcomeFrame | RequestFrame | ReplyFrame | EventsFrame | CancelFrame | ErrorFrame

/** Encodes one frame: 1 type byte, 4 length bytes (big-endian), then JSON. */
export function encodeFrame(frame: Frame): Buffer {
  const body = Buffer.from(JSON.stringify(frame), 'utf8')
  const header = Buffer.alloc(5)
  header.writeUInt8(frameTypeByte(frame.type), 0)
  header.writeUInt32BE(body.length, 1)
  return Buffer.concat([header, body])
}

const typeBytes: Record<FrameType, number> = {
  hello: 1, welcome: 2, request: 3, reply: 4, events: 5, cancel: 6, error: 7,
}
const byteTypes = new Map<number, FrameType>(Object.entries(typeBytes).map(([type, byte]) => [byte, type as FrameType]))

function frameTypeByte(type: FrameType): number {
  const byte = typeBytes[type]
  if (byte === undefined) throw new Error(`Unknown frame type: ${type}`)
  return byte
}

/**
 * Incremental frame decoder: feed it bytes as they arrive, take complete frames
 * as they appear. Carries partial state between feeds so TCP segmentation
 * cannot split a frame into a protocol error.
 */
export class FrameDecoder {
  private buffer = Buffer.alloc(0)

  /** Returns every complete frame in the input, in order. Throws on oversize or malformed frames. */
  feed(chunk: Buffer): Frame[] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const frames: Frame[] = []
    while (this.buffer.length >= 5) {
      const type = byteTypes.get(this.buffer.readUInt8(0))
      if (!type) throw new Error(`Unknown frame type byte: ${this.buffer.readUInt8(0)}`)
      const length = this.buffer.readUInt32BE(1)
      if (length > maxFrameBytes) throw new Error(`Frame of ${length} bytes exceeds the ${maxFrameBytes} limit`)
      if (this.buffer.length < 5 + length) break
      const body = this.buffer.subarray(5, 5 + length)
      this.buffer = this.buffer.subarray(5 + length)
      try {
        frames.push({ ...(JSON.parse(body.toString('utf8')) as Frame), type } as Frame)
      } catch {
        throw new Error('Frame body is not valid JSON')
      }
    }
    return frames
  }
}

/**
 * The server-side policy (§7 Phase 9 "command allowlist, branch restrictions"):
 * which capabilities and commands an agent may serve, and which branches a
 * remote peer may push to. Everything not listed is refused — an allowlist, not
 * a blocklist, so an unknown capability cannot slip through a default.
 */
export interface RemotePolicy {
  /** The agent identity this policy governs. */
  identity: string
  /** Optional client identities trusted by this agent; omitted means any leaf from the pinned CA. */
  allowedClientIdentities?: readonly string[]
  /** Capabilities the agent serves, e.g. `git.push`, `git.fetch`, `context.read`. */
  capabilities: readonly string[]
  /** Per-capability command allowlists. */
  commands: Record<string, readonly string[]>
  /**
   * Branch restrictions for `git.push`: exact names or `prefix*` patterns. An
   * empty list refuses every push — restrictions must be granted, never assumed.
   */
  allowedBranches: readonly string[]
}

export function policyAllows(policy: RemotePolicy, capability: string, command: string): boolean {
  return policy.capabilities.includes(capability) && (policy.commands[capability] ?? []).includes(command)
}

/** Branch match, sharing the merge queue's exact-or-trailing-star semantics. */
export function branchAllowed(branch: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (!pattern.endsWith('*')) return pattern === branch
    return branch.startsWith(pattern.slice(0, -1))
  })
}
