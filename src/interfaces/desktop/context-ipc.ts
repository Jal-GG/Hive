import { ActorContext, ResultEnvelope } from '../../contracts.js'
import {
  ContextBrowseOperation,
  ContextBrowseRequest,
  ContextBrowser,
  contextBrowseOperations,
} from '../../context/browsing/context-browser.js'

export const contextIpcPrefix = 'hive:context:'

/** The shape `ipcMain.handle` expects, declared structurally so this module needs no Electron dependency. */
export type IpcHandler = (event: unknown, payload: unknown) => ResultEnvelope<unknown>

export interface IpcRegistrar {
  handle(channel: string, handler: IpcHandler): void
}

/**
 * Electron main-process handlers, one channel per read-only operation:
 * `hive:context:ls`, `hive:context:read`, and so on. The renderer therefore has
 * exactly the browsing surface the CLI, MCP, and HTTP adapters have — and no
 * mutation channel exists for it to reach (C4).
 */
export function contextIpcHandlers(browser: ContextBrowser, actor: ActorContext): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>()
  for (const operation of contextBrowseOperations) {
    handlers.set(`${contextIpcPrefix}${operation}`, (_event, payload) => browser.browse(actor, toRequest(operation, payload)))
  }
  return handlers
}

export function registerContextIpc(registrar: IpcRegistrar, browser: ContextBrowser, actor: ActorContext): string[] {
  const channels: string[] = []
  for (const [channel, handler] of contextIpcHandlers(browser, actor)) {
    registrar.handle(channel, handler)
    channels.push(channel)
  }
  return channels
}

/**
 * The operation comes from the channel, never from the payload, so a renderer
 * cannot reach a different operation by sending a different body.
 */
function toRequest(operation: ContextBrowseOperation, payload: unknown): ContextBrowseRequest {
  const supplied = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
  return { ...supplied, version: 1, operation } as ContextBrowseRequest
}
