import {
  ActorContext,
  HandoffState,
  IssueType,
  MessageState,
  ResultEnvelope,
  ScopeRef,
  WorkItemStatus,
} from '../../contracts.js'
import { asResult } from '../../errors.js'
import { createId } from '../../shared.js'
import { Ledger } from '../../ledger.js'
import { HandoffService } from '../../work/handoffs.js'
import { MailService } from '../../work/mail.js'
import { PacketCompiler } from '../../work/packet.js'
import { WorkBoard } from '../../work/board.js'
import { RuntimeIpcHandler, RuntimeIpcRegistrar, workBrowseOperationNames, workControlOperationNames, workIpcPrefix } from './runtime-channels.js'
import { optional, payloadOf, required, strings, whole } from './ipc-payload.js'

/**
 * The work plane on the desktop: the same task-board, mail, handoff, and packet
 * operations the CLI has, one channel per operation (C8's "JSON/CLI/desktop
 * task views" — this is the desktop one). Every handler is the corresponding
 * service call wrapped in an envelope, so nothing here can out-drift the
 * services the other surfaces share.
 */
export interface WorkIpcSurfaces {
  scope: ScopeRef
  board: WorkBoard
  mail: MailService
  handoffs: HandoffService
  packets: PacketCompiler
  /** The registered fleet with energy levels, straight from the ledger (§6.2). */
  ledger: Ledger
}

export function workIpcHandlers(surfaces: WorkIpcSurfaces, actor: ActorContext): Map<string, RuntimeIpcHandler> {
  const { scope, board, mail, handoffs, packets, ledger } = surfaces
  const handlers = new Map<string, RuntimeIpcHandler>()
  const envelope = <T>(operation: () => T): ResultEnvelope<T> => asResult(createId(), operation)

  for (const operation of workBrowseOperationNames) {
    handlers.set(`${workIpcPrefix}${operation}`, (_event, payload) =>
      envelope(() => {
        const body = payloadOf(payload)
        switch (operation) {
          case 'items': return board.list(actor, scope, strings(body, 'states') as WorkItemStatus[])
          case 'item': return board.item(actor, required(body, 'workItemId'))
          case 'plan': return board.planOf(actor, required(body, 'workItemId')) ?? null
          case 'plan-history': return board.planHistory(actor, required(body, 'workItemId'))
          case 'handoffs': return handoffs.list(actor, scope, strings(body, 'states') as HandoffState[])
          case 'agents': return ledger.listAgents()
          case 'inbox': return mail.inbox(actor, {
            scope,
            queue: optional(body, 'queue'),
            states: strings(body, 'states') as MessageState[],
          })
        }
      }),
    )
  }

  for (const operation of workControlOperationNames) {
    handlers.set(`${workIpcPrefix}${operation}`, (_event, payload) =>
      envelope(() => {
        const body = payloadOf(payload)
        switch (operation) {
          case 'create':
            return board.create(actor, scope, {
              title: required(body, 'title'),
              description: optional(body, 'description'),
              priority: whole(body, 'priority'),
              issueType: (optional(body, 'issueType') as IssueType | undefined) ?? 'task',
              convoyId: optional(body, 'convoyId'),
              sourceTriggerId: optional(body, 'sourceTriggerId'),
            })
          case 'claim': return board.claim(actor, required(body, 'workItemId'))
          case 'start': return board.transition(actor, required(body, 'workItemId'), 'in_progress')
          case 'status': return board.transition(actor, required(body, 'workItemId'), required(body, 'to') as WorkItemStatus)
          case 'plan-write': return board.plan(actor, required(body, 'workItemId'), required(body, 'body'))
          case 'handoff-accept': return handoffs.accept(actor, required(body, 'handoffId'), { cwd: optional(body, 'cwd') })
          case 'context': {
            const packet = packets.compile(actor, scope, {
              taskId: required(body, 'taskId'),
              agentId: optional(body, 'agentId'),
              cwd: optional(body, 'cwd'),
              runId: optional(body, 'runId'),
              byteBudget: whole(body, 'byteBudget'),
            })
            return { packet, prompt: packets.render(packet) }
          }
        }
      }),
    )
  }
  return handlers
}

export function registerWorkIpc(registrar: RuntimeIpcRegistrar, surfaces: WorkIpcSurfaces, actor: ActorContext): string[] {
  const channels: string[] = []
  for (const [channel, handler] of workIpcHandlers(surfaces, actor)) {
    registrar.handle(channel, handler)
    channels.push(channel)
  }
  return channels
}
