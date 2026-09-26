import { ActorContext, ResultEnvelope } from '../../contracts.js'
import { HiveError } from '../../errors.js'
import {
  RuntimeBrowseOperation,
  RuntimeBrowseRequest,
  RuntimeBrowser,
  runtimeBrowseOperations,
} from '../../runtime/runtime-browser.js'
import {
  RuntimeControlOperation,
  RuntimeControlRequest,
  RuntimeController,
  runtimeControlOperations,
} from '../../runtime/runtime-controller.js'
import { RunManager } from '../../runtime/run-manager.js'
import {
  RuntimeIpcHandler,
  RuntimeIpcRegistrar,
  RuntimeStreamData,
  WebContentsSender,
  runtimeIpcPrefix,
  runtimeStreamChannels,
  runtimeStreamControlChannels,
  toRequest,
  type RuntimeBridge,
  type Unsubscribe,
} from './runtime-channels.js'

export interface RuntimeIpcSurfaces {
  browser: RuntimeBrowser
  controller?: RuntimeController
}

/**
 * Main-process handlers, one channel per operation: `hive:runtime:runs`,
 * `hive:runtime:launch`, and so on.
 *
 * The renderer gets exactly the operations the CLI has and nothing else — no
 * channel carries a backend name, an adapter, or an environment, so a compromised
 * renderer can ask for a launch it is authorized to make and cannot reach past the
 * services to make any other kind (C4, C16).
 */
export function runtimeIpcHandlers(surfaces: RuntimeIpcSurfaces, actor: ActorContext): Map<string, RuntimeIpcHandler> {
  const handlers = new Map<string, RuntimeIpcHandler>()
  for (const operation of runtimeBrowseOperations) {
    handlers.set(`${runtimeIpcPrefix}${operation}`, (_event, payload) => surfaces.browser.browse(actor, toRequest<RuntimeBrowseRequest, RuntimeBrowseOperation>(operation, payload)))
  }
  const controller = surfaces.controller
  if (controller) {
    for (const operation of runtimeControlOperations) {
      handlers.set(`${runtimeIpcPrefix}${operation}`, (_event, payload) => controller.control(actor, toRequest<RuntimeControlRequest, RuntimeControlOperation>(operation, payload)))
    }
  }
  return handlers
}

export function registerRuntimeIpc(registrar: RuntimeIpcRegistrar, surfaces: RuntimeIpcSurfaces, actor: ActorContext): string[] {
  const channels: string[] = []
  for (const [channel, handler] of runtimeIpcHandlers(surfaces, actor)) {
    registrar.handle(channel, handler)
    channels.push(channel)
  }
  return channels
}

export function runtimeBridgeChannels(includeControl = true): string[] {
  const operations = includeControl ? [...runtimeBrowseOperations, ...runtimeControlOperations] : [...runtimeBrowseOperations]
  return [...operations.map((operation) => `${runtimeIpcPrefix}${operation}`), ...Object.values(runtimeStreamChannels), ...Object.values(runtimeStreamControlChannels)].sort()
}

export interface RuntimeStreamOptions {
  manager: RunManager
  browser: RuntimeBrowser
  actor: ActorContext
  /** Interval between event-cursor polls. Unreferenced, so it never holds the process open. */
  pollMs?: number
}

/**
 * Pushes a live run to a renderer: output as it arrives, and runtime events by
 * cursor.
 *
 * Two mechanisms because they answer different questions. Terminal output is
 * ephemeral and only interesting live, so it is forwarded and never stored. Events
 * are the durable record, so the renderer follows them by sequence and can be
 * behind, disconnect, and catch up from exactly where it stopped — a restarted
 * window rebuilds its view instead of starting blank.
 */
export class RuntimeStreamBridge {
  private readonly manager: RunManager
  private readonly browser: RuntimeBrowser
  private readonly actor: ActorContext
  private readonly pollMs: number
  private readonly attached = new Map<string, Unsubscribe>()
  private timer?: ReturnType<typeof setInterval>
  private cursor = 0

  constructor(options: RuntimeStreamOptions) {
    this.manager = options.manager
    this.browser = options.browser
    this.actor = options.actor
    this.pollMs = options.pollMs ?? 250
  }

  /** Streams one run's output. Re-attaching replaces the previous subscription rather than doubling it. */
  attach(runId: string, sender: WebContentsSender): Unsubscribe {
    this.detach(runId)
    const unsubscribe = this.manager.subscribe(this.actor, runId, (chunk) => {
      // The scrollback replay a new subscriber receives arrives through this same
      // path, so a window opened mid-run is populated by the act of attaching.
      this.send(sender, runtimeStreamChannels.data, { runId, chunk })
    })
    this.attached.set(runId, unsubscribe)
    return () => this.detach(runId)
  }

  detach(runId: string): void {
    this.attached.get(runId)?.()
    this.attached.delete(runId)
  }

  /** Begins following the event log from `afterSequence`, pushing each new page. */
  follow(sender: WebContentsSender, afterSequence = 0): Unsubscribe {
    this.cursor = afterSequence
    this.pump(sender)
    this.timer = setInterval(() => this.pump(sender), this.pollMs)
    // The renderer's poll is not a reason for the host to stay alive.
    this.timer.unref?.()
    return () => this.stop()
  }

  /** Delivers whatever is newer than the cursor. Public so a test can advance the stream without a timer. */
  pump(sender: WebContentsSender): void {
    const result = this.browser.browse(this.actor, { version: 1, operation: 'events', afterSequence: this.cursor, limit: 200 })
    if (!result.ok) return
    const page = result.data as { events: unknown[]; cursor: number }
    if (page.events.length === 0) return
    this.cursor = page.cursor
    this.send(sender, runtimeStreamChannels.events, page)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const runId of [...this.attached.keys()]) this.detach(runId)
  }

  /**
   * Registers the attach/detach/follow channels, so a renderer drives this bridge
   * through the same registrar as every other channel rather than reaching the
   * object directly. The payload supplies `runId` (attach/detach) and
   * `afterSequence` (follow); everything else about the stream is the main
   * process's decision, not the renderer's.
   */
  registerControl(registrar: RuntimeIpcRegistrar): string[] {
    const channels: string[] = []
    const register = (channel: string, handler: RuntimeIpcHandler) => {
      registrar.handle(channel, handler)
      channels.push(channel)
    }
    // The sender comes from the IPC event, never the payload: `event.sender` is
    // the webContents Electron itself identified, so a renderer cannot point a
    // stream at some other window or fabricate a destination.
    register(runtimeStreamControlChannels.attach, (event, payload) => {
      const runId = streamRunId(payload)
      this.attach(runId, senderFrom(event))
      return { version: 1, requestId: `attach:${runId}`, ok: true, data: { runId } }
    })
    register(runtimeStreamControlChannels.detach, (_event, payload) => {
      const runId = streamRunId(payload)
      this.detach(runId)
      return { version: 1, requestId: `detach:${runId}`, ok: true, data: { runId } }
    })
    register(runtimeStreamControlChannels.follow, (event, payload) => {
      const afterSequence = typeof (payload as { afterSequence?: unknown } | null)?.afterSequence === 'number' ? (payload as { afterSequence: number }).afterSequence : 0
      this.follow(senderFrom(event), afterSequence)
      return { version: 1, requestId: `follow:${afterSequence}`, ok: true, data: { afterSequence } }
    })
    return channels
  }

  private send(sender: WebContentsSender, channel: string, payload: unknown): void {
    // A closed window is the normal end of a stream, not an error worth throwing over.
    if (sender.isDestroyed?.()) return
    sender.send(channel, payload)
  }
}

/**
 * The one value a stream control channel needs from the payload. An empty or
 * non-string run id is refused rather than defaulted: attaching to "run 0" would
 * silently subscribe the renderer to nothing.
 */
function streamRunId(payload: unknown): string {
  const runId = (payload as { runId?: unknown } | null)?.runId
  if (typeof runId !== 'string' || runId === '') throw new HiveError('MISSING_ARGUMENT', 'runId is required for this operation')
  return runId
}

/**
 * The destination a stream pushes to, taken from the IPC event: `event.sender`
 * is the webContents Electron identified as the caller. A test supplies a plain
 * recorder shaped like it, which is the same shape the real event carries.
 */
function senderFrom(event: unknown): WebContentsSender {
  const sender = (event as { sender?: unknown } | null)?.sender
  if (typeof sender !== 'object' || sender === null || typeof (sender as WebContentsSender).send !== 'function') {
    throw new HiveError('MISSING_ARGUMENT', 'sender is required for this operation')
  }
  return sender as WebContentsSender
}
