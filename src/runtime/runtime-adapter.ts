import {
  AgentProfile,
  RuntimeBackend,
  RuntimeCapability,
  RuntimeExit,
  RuntimeHeartbeat,
  RuntimeIdentity,
  RuntimeStatus,
  TranscriptSlice,
} from '../contracts.js'
import { HiveError } from '../errors.js'

export type Unsubscribe = () => void

export interface RuntimeSpawnRequest {
  profile: AgentProfile
  identity: RuntimeIdentity
  cwd: string
  /** Already resolved against the profile's allowlist; the adapter passes it through unchanged. */
  environment: Record<string, string>
  cols: number
  rows: number
  /** Compiled context packet, delivered the way the profile declares. */
  prompt?: string
  /** Model override for this run, substituted into the profile's `{model}` token. */
  model?: string
  /**
   * Backend session name. Derived from the run id rather than generated, so a
   * persistent backend can be re-adopted after a restart by recomputing it.
   */
  sessionKey: string
}

export interface KillOptions {
  signal?: string
  /** Time a graceful signal is given before the tree is force-killed. */
  graceMs?: number
}

/**
 * One live agent process, seen the same way whatever started it (C6). Every
 * method here is backend-neutral on purpose: supervision, recovery, and the
 * desktop terminal all speak to this and never to node-pty or tmux directly.
 */
export interface RuntimeSession {
  readonly sessionKey: string
  readonly backend: RuntimeBackend
  readonly pid?: number

  /**
   * Resolves once the provider has signalled it can accept input — matching the
   * profile's ready pattern, or immediately when it declares none. Readiness is
   * observed, never assumed, because writing to an unready CLI loses the input.
   */
  ready(timeoutMs?: number): Promise<void>

  write(data: string): void
  resize(cols: number, rows: number): void

  /** Ends the process and everything it started, then resolves with the real exit status. */
  kill(options?: KillOptions): Promise<RuntimeExit>

  inspect(): RuntimeStatus
  heartbeat(): RuntimeHeartbeat

  /** Replays buffered output to a new listener first, so a late subscriber still sees the session. */
  onData(listener: (chunk: string) => void): Unsubscribe
  onExit(listener: (exit: RuntimeExit) => void): Unsubscribe

  /** Resolves with the exit status, immediately if the process has already ended. */
  exited(): Promise<RuntimeExit>

  /** Retained tail of output, for attaching a terminal view to a run already in flight. */
  scrollback(): string
}

export interface RuntimeAdapter {
  readonly backend: RuntimeBackend
  readonly capabilities: readonly RuntimeCapability[]
  spawn(request: RuntimeSpawnRequest): Promise<RuntimeSession>
  /**
   * Re-attaches to a session that outlived this process, or resolves undefined
   * when it is gone. Only backends declaring `persistent_session` implement it;
   * for the rest, a host restart genuinely ends the run.
   */
  adopt?(sessionKey: string): Promise<RuntimeSession | undefined>
}

export interface TranscriptReadRequest {
  identity: RuntimeIdentity
  /** Working directory of the run; native stores are usually keyed by it. */
  cwd: string
  cursor?: string
  limit?: number
}

/**
 * Read-only import of a provider's native transcript (C17). The contract has no
 * write method at all: native schemas are private and rewrite themselves in
 * place, so the only safe posture is to observe and report what could not be
 * read rather than to touch the store.
 */
export interface TranscriptAdapter {
  readonly id: string
  /** Versioned name of the native format, recorded on every imported slice. */
  readonly schema: string
  supports(profile: AgentProfile): boolean
  read(request: TranscriptReadRequest): TranscriptSlice
}

export function assertRuntimeCapability(adapter: RuntimeAdapter, capability: RuntimeCapability): void {
  if (!adapter.capabilities.includes(capability)) {
    throw new HiveError('RUNTIME_CAPABILITY_MISSING', `Backend ${adapter.backend} does not support ${capability}`)
  }
}
