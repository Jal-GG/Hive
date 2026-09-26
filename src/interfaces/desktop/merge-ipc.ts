import {
  ActorContext,
  MergeGateResult,
  MergeRequest,
  MergeRequestState,
  ResultEnvelope,
  ScopeRef,
} from '../../contracts.js'
import { asResult, HiveError } from '../../errors.js'
import { createId } from '../../shared.js'
import { Ledger } from '../../ledger.js'
import { MergeCoordinator } from '../../merge/coordinator.js'
import { ConvoyService } from '../../merge/convoy.js'
import { mergeBrowseOperationNames, mergeControlOperationNames, mergeIpcPrefix, RuntimeIpcHandler, RuntimeIpcRegistrar } from './runtime-channels.js'

/**
 * The merge plane on the desktop (§7 Phase 7, task 6). Every handler is a
 * service call in an envelope, so the operator's views cannot drift from what
 * the CLI and the queue itself see. Nothing here re-derives merge state: the
 * ledger is the authority, and these are projections of it.
 */
export interface MergeIpcSurfaces {
  scope: ScopeRef
  ledger: Ledger
  queue: MergeCoordinator
  convoys: ConvoyService
  /**
   * False when this install has no remote and no gates configured. The read
   * views still work — they are ledger projections — but anything that would
   * move a branch refuses, because a queue with no gates is a queue that
   * bypasses them.
   */
  configured?: boolean
}

/** One row of the branch graph: a target, the batch that touched it, and the branches riding it. */
export interface MergeGraphNode {
  batchId: string
  targetBranch: string
  targetSha: string
  state: string
  isolationOf?: string
  createdAt: string
  branches: { requestId: string; sourceBranch: string; sourceCommit?: string; state: MergeRequestState; mergeCommit?: string }[]
}

/** What the queue left for a human: unfinished merges and worktrees it refused to delete. */
export interface MergeRecoveryView {
  conflicted: MergeRequest[]
  failed: MergeRequest[]
  awaitingApproval: MergeRequest[]
  /** Integration worktrees preserved on disk because git refused or they were dirty. */
  preservedWorktrees: { path: string; reason: string; occurredAt: string }[]
}

export function mergeIpcHandlers(surfaces: MergeIpcSurfaces, actor: ActorContext): Map<string, RuntimeIpcHandler> {
  const { scope, ledger, queue, convoys } = surfaces
  const handlers = new Map<string, RuntimeIpcHandler>()
  const envelope = <T>(operation: () => T | Promise<T>): Promise<ResultEnvelope<T>> => asResultAsync(operation)

  for (const operation of mergeBrowseOperationNames) {
    handlers.set(`${mergeIpcPrefix}${operation}`, (_event, payload) =>
      envelope(() => {
        const body = payloadOf(payload)
        switch (operation) {
          case 'requests': return queue.requests(actor, scope, strings(body, 'states') as MergeRequestState[] | undefined)
          case 'request': return requestOf(queue, actor, scope, required(body, 'requestId'))
          case 'batches': return ledger.listMergeBatches(scope)
          case 'graph': return graph(queue, ledger, actor, scope)
          case 'gates': return gatesOf(queue, actor, scope, required(body, 'requestId'))
          case 'conflicts': return conflictsOf(queue, actor, scope)
          case 'convoys': return convoys.convoys(actor)
          case 'recovery': return recovery(queue, ledger, actor, scope)
        }
      }),
    )
  }

  for (const operation of mergeControlOperationNames) {
    handlers.set(`${mergeIpcPrefix}${operation}`, (_event, payload) =>
      envelope(async () => {
        if (surfaces.configured === false) {
          throw new HiveError('MERGE_NOT_CONFIGURED', 'This install has no merge remote or gates configured; the queue is read-only here')
        }
        const body = payloadOf(payload)
        switch (operation) {
          case 'enqueue': return queue.enqueue(actor, {
            sourceBranch: required(body, 'sourceBranch'),
            targetBranch: required(body, 'targetBranch'),
            workItemId: optional(body, 'workItemId'),
            runId: optional(body, 'runId'),
          })
          case 'prepare': return await queue.prepare(actor)
          case 'land': return await queue.land(actor)
          case 'process': return await queue.process(actor)
          case 'approve': return queue.approve(actor, required(body, 'requestId'))
          case 'convoy-scan': return await convoys.scan(actor)
          case 'convoy-close': return convoys.forceClose(actor, required(body, 'convoyId'))
        }
      }),
    )
  }
  return handlers
}

export function registerMergeIpc(registrar: RuntimeIpcRegistrar, surfaces: MergeIpcSurfaces, actor: ActorContext): string[] {
  const channels: string[] = []
  for (const [channel, handler] of mergeIpcHandlers(surfaces, actor)) {
    registrar.handle(channel, handler)
    channels.push(channel)
  }
  return channels
}

/** The branch graph: batches as nodes, the requests riding each one as its branches. */
function graph(queue: MergeCoordinator, ledger: Ledger, actor: ActorContext, scope: ScopeRef): MergeGraphNode[] {
  const requests = new Map(queue.requests(actor, scope).map((request) => [request.id, request]))
  return ledger.listMergeBatches(scope).map((batch) => ({
    batchId: batch.id,
    targetBranch: batch.targetBranch,
    targetSha: batch.targetSha,
    state: batch.state,
    isolationOf: batch.isolationOf,
    createdAt: batch.createdAt,
    branches: batch.mergeRequestIds.flatMap((id) => {
      const request = requests.get(id)
      return request
        ? [{
            requestId: request.id,
            sourceBranch: request.sourceBranch,
            sourceCommit: request.sourceCommit,
            state: request.state,
            mergeCommit: request.mergeCommit,
          }]
        : []
    }),
  }))
}

function requestOf(queue: MergeCoordinator, actor: ActorContext, scope: ScopeRef, requestId: string): MergeRequest {
  const request = queue.requests(actor, scope).find((candidate) => candidate.id === requestId)
  if (!request) throw new HiveError('MERGE_NOT_FOUND', `Merge request ${requestId} not found`)
  return request
}

/** Gate output for one request: bounded already by the runner, shown verbatim. */
function gatesOf(queue: MergeCoordinator, actor: ActorContext, scope: ScopeRef, requestId: string): MergeGateResult[] {
  return requestOf(queue, actor, scope, requestId).gateResults ?? []
}

/** Every request whose merge conflicted, with the paths that collided. */
function conflictsOf(queue: MergeCoordinator, actor: ActorContext, scope: ScopeRef): { requestId: string; sourceBranch: string; targetBranch: string; conflictFiles: string[] }[] {
  return queue.requests(actor, scope, ['conflicted']).map((request) => ({
    requestId: request.id,
    sourceBranch: request.sourceBranch,
    targetBranch: request.targetBranch,
    conflictFiles: request.conflictFiles ?? [],
  }))
}

/**
 * The recovery view: everything the queue could not finish on its own. A
 * preserved worktree is read from the event log rather than the filesystem, so
 * the view reports what was decided, not what a later scan happens to find.
 */
function recovery(queue: MergeCoordinator, ledger: Ledger, actor: ActorContext, scope: ScopeRef): MergeRecoveryView {
  const preservedWorktrees = ledger
    .readEvents(0, 1000)
    .filter((event) => event.idempotencyKey.startsWith('merge:worktree-preserved:'))
    .map((event) => {
      const payload = event.payload as { path?: string; reason?: string }
      return { path: payload.path ?? '', reason: payload.reason ?? '', occurredAt: event.occurredAt }
    })
  return {
    conflicted: queue.requests(actor, scope, ['conflicted']),
    failed: queue.requests(actor, scope, ['failed']),
    awaitingApproval: queue.requests(actor, scope, ['awaiting_approval']),
    preservedWorktrees,
  }
}

/** `asResult`, for handlers that may await: the envelope shape is identical. */
async function asResultAsync<T>(operation: () => T | Promise<T>): Promise<ResultEnvelope<T>> {
  const requestId = createId()
  try {
    return { version: 1, requestId, ok: true, data: await operation() }
  } catch (error) {
    return asResult(requestId, () => {
      throw error
    }) as ResultEnvelope<T>
  }
}

function payloadOf(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
}

function required(payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  if (typeof value !== 'string' || value === '') throw new HiveError('MISSING_ARGUMENT', `${field} is required`)
  return value
}

function optional(payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function strings(payload: Record<string, unknown>, field: string): string[] | undefined {
  const value = payload[field]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new HiveError('INVALID_ARGUMENT', `${field} must be a list of strings`)
  }
  return value as string[]
}
