import { ResultEnvelope } from '../../contracts.js'

/** Stands in for the runtime adapter's own unsubscribe type, which lives on the Node side. */
export type Unsubscribe = () => void

/** The context namespace's channel prefix, shared by the main and preload sides. */
export const contextIpcPrefix = 'hive:context:'

/**
 * The operation names, as strings, so the preload allowlist can be built in a
 * browser bundle without importing the Node-side services that own the typed
 * versions. Drift is impossible: the service modules' own lists are typed to
 * these constants, and a test asserts the two stay equal.
 */
export const runtimeBrowseOperationNames: readonly string[] = ['profiles', 'backends', 'runs', 'run', 'status', 'heartbeat', 'scrollback', 'transcript', 'events', 'worktree']

export const runtimeControlOperationNames: readonly string[] = ['launch', 'write', 'resize', 'stop', 'cleanup', 'import', 'reconcile']

export const contextBrowseOperationNames: readonly string[] = ['ls', 'tree', 'stat', 'read', 'grep', 'glob', 'find', 'history', 'pack', 'readAt', 'snapshots', 'tombstones']

/**
 * The renderer-safe half of the runtime IPC surface: channel names, request and
 * bridge shapes, and nothing else.
 *
 * Every import here is type-only apart from string constants, so this module can
 * be bundled into a browser renderer without dragging the ledger, the PTY
 * backends, or any of Node's built-ins along (C4: the renderer's view of a run
 * is exactly what the main process chose to expose).
 */
export const runtimeIpcPrefix = 'hive:runtime:'
export const runtimeStreamChannels = {
  data: `${runtimeIpcPrefix}stream:data`,
  exit: `${runtimeIpcPrefix}stream:exit`,
  events: `${runtimeIpcPrefix}stream:events`,
} as const

/**
 * Invoke channels that steer the push streams. Attaching is what a renderer does
 * when an operator clicks a run; following is what it does once, at startup, to
 * receive the event pages the roster is built from. They are channels rather
 * than stream payloads because they answer a request, like every other invoke.
 */
export const runtimeStreamControlChannels = {
  attach: `${runtimeIpcPrefix}stream:attach`,
  detach: `${runtimeIpcPrefix}stream:detach`,
  follow: `${runtimeIpcPrefix}stream:follow`,
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

export interface RuntimeStreamData {
  runId: string
  chunk: string
}

/**
 * The operation comes from the channel, never from the payload, so a renderer
 * cannot reach a different operation by sending a different body.
 */
export function toRequest<R extends { version: 1; operation: O }, O>(operation: O, payload: unknown): R {
  const supplied = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
  return { ...supplied, version: 1, operation } as R
}
