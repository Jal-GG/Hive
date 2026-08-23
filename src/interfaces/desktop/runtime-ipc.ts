import { ActorContext, ResultEnvelope } from '../../contracts.js'
import {
  RuntimeBrowseOperation,
  RuntimeBrowseRequest,
  RuntimeBrowser,
  runtimeBrowseOperations,
} from '../../runtime/browsing/runtime-browser.js'
import {
  RuntimeControlOperation,
  RuntimeControlRequest,
  RuntimeController,
  runtimeControlOperations,
} from '../../runtime/control/runtime-controller.js'
import { RunManager } from '../../runtime/run-manager.js'
import { Unsubscribe } from '../../runtime/runtime-adapter.js'

export const runtimeIpcPrefix = 'hive:runtime:'
export const runtimeStreamChannels = {
  data: `${runtimeIpcPrefix}stream:data`,
  exit: `${runtimeIpcPrefix}stream:exit`,
  events: `${runtimeIpcPrefix}stream:events`,
} as const

/** The shapes Electron provides, declared structurally so this module needs no Electron dependency. */
export type RuntimeIpcHandler = (event: unknown, payload: unknown) => ResultEnvelope<unknown> | Promise<ResultEnvelope<unknown>>

export interface RuntimeIpcRegistrar {
  handle(channel: string, handler: RuntimeIpcHandler): void
}

/** `webContents`, reduced to the one method a stream needs. */
export interface WebContentsSender {
  send(channel: string, payload: unknown): void
  isDestroyed?(): boolean
}

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

/**
 * The contract a preload script exposes as `window.hive.runtime`.
 *
 * Written down here rather than in the preload so the renderer's view model can be
 * typed against it and tested with a plain object, and so the preload has an
 * explicit channel allowlist to check against instead of forwarding whatever
 * string the renderer passes.
 */
export interface RuntimeBridge {
  invoke(channel: string, payload?: unknown): Promise<ResultEnvelope<unknown>>
  on(channel: string, listener: (payload: unknown) => void): Unsubscribe
}

export function runtimeBridgeChannels(includeControl = true): string[] {
  const operations = includeControl ? [...runtimeBrowseOperations, ...runtimeControlOperations] : [...runtimeBrowseOperations]
  return [...operations.map((operation) => `${runtimeIpcPrefix}${operation}`), ...Object.values(runtimeStreamChannels)].sort()
}

export interface RuntimeStreamOptions {
  manager: RunManager
  browser: RuntimeBrowser
  actor: ActorContext
  /** Interval between event-cursor polls. Unreferenced, so it never holds the process open. */
  pollMs?: number
}

export interface RuntimeStreamData {
  runId: string
  chunk: string
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

  private send(sender: WebContentsSender, channel: string, payload: unknown): void {
    // A closed window is the normal end of a stream, not an error worth throwing over.
    if (sender.isDestroyed?.()) return
    sender.send(channel, payload)
  }
}

/**
 * The operation comes from the channel, never from the payload, so a renderer
 * cannot reach a different operation by sending a different body.
 */
function toRequest<R extends { version: 1; operation: O }, O>(operation: O, payload: unknown): R {
  const supplied = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
  return { ...supplied, version: 1, operation } as R
}
