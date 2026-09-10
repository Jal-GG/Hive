import { ResultEnvelope } from '../../contracts.js'
import {
  contextBrowseOperationNames,
  contextIpcPrefix,
  mergeBrowseOperationNames,
  mergeControlOperationNames,
  mergeIpcPrefix,
  runtimeBrowseOperationNames,
  runtimeControlOperationNames,
  RuntimeBridge,
  runtimeIpcPrefix,
  runtimeStreamChannels,
  runtimeStreamControlChannels,
  workBrowseOperationNames,
  workControlOperationNames,
  workIpcPrefix,
  type Unsubscribe,
} from './runtime-channels.js'

/**
 * `window.hive`, as the renderer is allowed to see it.
 *
 * The preload script builds one of these over `ipcRenderer.invoke` /
 * `ipcRenderer.on` and freezes it onto the window. Keeping the construction in a
 * module with no Electron import means the channel allowlist — the one thing a
 * compromised renderer must not be able to widen — is data that can be tested,
 * not a copy-paste inside a preload bundle.
 */
export interface HiveWindow {
  /** Invoke plus the push streams: what a terminal view model needs. */
  runtime: RuntimeBridge
  context: PreloadBridge
  /** The task board, mail, handoffs, and packet compilation (§6.2, §6.5). */
  work: PreloadBridge
  /** The merge queue, branch graph, gate output, conflicts, and recovery (§7 Phase 7). */
  merge: PreloadBridge
  /** Stream control: attach a terminal, follow the event log. */
  stream: {
    attach(runId: string): Promise<ResultEnvelope<unknown>>
    detach(runId: string): Promise<ResultEnvelope<unknown>>
    follow(afterSequence?: number): Promise<ResultEnvelope<unknown>>
    onData(listener: (payload: unknown) => void): Unsubscribe
    onExit(listener: (payload: unknown) => void): Unsubscribe
    onEvents(listener: (payload: unknown) => void): Unsubscribe
  }
}

/**
 * One namespace's invoke surface. The operation is the channel name; a payload
 * is optional. There is deliberately no generic `invoke(channel, ...)` here: the
 * set of things a renderer can ask for is the set of channels the main process
 * registered, spelled out as methods on the bridge.
 */
export interface PreloadBridge {
  invoke(operation: string, payload?: unknown): Promise<ResultEnvelope<unknown>>
}

/** The transports a preload is built over, declared structurally: no Electron import. */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
}

/**
 * Builds the frozen `window.hive` over an `ipcRenderer`.
 *
 * Every channel is checked against the allowlist before it is forwarded, and the
 * two directions are kept distinct: `invoke` goes to a channel the main process
 * registered a handler for, and `on` only ever subscribes to a push channel. A
 * renderer passing any other string gets a refused envelope, not a forward.
 */
export function createHiveWindow(ipc: IpcRendererLike): HiveWindow {
  const invokable = new Set(allowedChannels())
  const subscribable = new Set(subscribeChannels())

  const subscribe = (channel: string, listener: (payload: unknown) => void): Unsubscribe => {
    if (!subscribable.has(channel)) throw new Error(`Channel does not carry a stream: ${channel}`)
    const wrapped = (_event: unknown, payload: unknown) => listener(payload)
    ipc.on(channel, wrapped)
    return () => ipc.removeListener(channel, wrapped)
  }

  const invokeOnly = (prefix: string): PreloadBridge => ({
    invoke: async (operation, payload) => {
      const channel = `${prefix}${operation}`
      if (!invokable.has(channel)) {
        return { version: 1, requestId: `refused:${channel}`, ok: false, error: { code: 'UNKNOWN_CHANNEL', message: `Channel is not part of the preload surface: ${channel}` } }
      }
      const result = await ipc.invoke(channel, payload)
      return result as ResultEnvelope<unknown>
    },
  })

  /**
   * The runtime namespace carries the push streams as well as the invokes,
   * because the terminal view model subscribes to data/exit/events through the
   * same bridge it invokes reads on (C4: one bridge, one allowlist).
   */
  const runtimeBridge: RuntimeBridge = {
    invoke: invokeOnly(runtimeIpcPrefix).invoke,
    on: subscribe,
  }

  const streamInvoke = async (channel: string, payload: Record<string, unknown>): Promise<ResultEnvelope<unknown>> => {
    if (!invokable.has(channel)) {
      return { version: 1, requestId: `refused:${channel}`, ok: false, error: { code: 'UNKNOWN_CHANNEL', message: `Channel is not part of the preload surface: ${channel}` } }
    }
    const result = await ipc.invoke(channel, payload)
    return result as ResultEnvelope<unknown>
  }

  const hive: HiveWindow = {
    runtime: runtimeBridge,
    context: invokeOnly(contextIpcPrefix),
    work: invokeOnly(workIpcPrefix),
    merge: invokeOnly(mergeIpcPrefix),
    stream: {
      attach: (runId) => streamInvoke(runtimeStreamControlChannels.attach, { runId }),
      detach: (runId) => streamInvoke(runtimeStreamControlChannels.detach, { runId }),
      follow: (afterSequence = 0) => streamInvoke(runtimeStreamControlChannels.follow, { afterSequence }),
      onData: (listener) => subscribe(runtimeStreamChannels.data, listener),
      onExit: (listener) => subscribe(runtimeStreamChannels.exit, listener),
      onEvents: (listener) => subscribe(runtimeStreamChannels.events, listener),
    },
  }
  return hive
}

/**
 * The complete invoke allowlist: every channel the main process registers a
 * handler for, and nothing else. Exported so a test can assert it matches what
 * `registerIpc` actually registered — the two sides of the bridge cannot drift
 * if they share one definition (C4).
 */
export function allowedChannels(): string[] {
  return [
    ...runtimeBrowseOperationNames.map((operation) => `${runtimeIpcPrefix}${operation}`),
    ...runtimeControlOperationNames.map((operation) => `${runtimeIpcPrefix}${operation}`),
    ...contextBrowseOperationNames.map((operation) => `${contextIpcPrefix}${operation}`),
    ...workBrowseOperationNames.map((operation) => `${workIpcPrefix}${operation}`),
    ...workControlOperationNames.map((operation) => `${workIpcPrefix}${operation}`),
    ...mergeBrowseOperationNames.map((operation) => `${mergeIpcPrefix}${operation}`),
    ...mergeControlOperationNames.map((operation) => `${mergeIpcPrefix}${operation}`),
    ...Object.values(runtimeStreamControlChannels),
  ].sort()
}

/** The push channels a renderer may subscribe to. Nothing else carries a stream to it. */
export function subscribeChannels(): string[] {
  return [...Object.values(runtimeStreamChannels)].sort()
}
