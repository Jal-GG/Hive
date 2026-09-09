import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ActorContext,
  MergeBatch,
  MergeBatchState,
  MergeFailureKind,
  MergeGateResult,
  MergeRequest,
  ScopeRef,
  WorkItem,
  terminalWorkItemStates,
} from '../contracts.js'
import { assertCapability } from '../capabilities.js'
import { HiveError } from '../errors.js'
import { Ledger } from '../ledger.js'
import { GitRunner, gitIdentityArgs } from '../git.js'
import { Clock, ClockOptions, createId, resolveClock } from '../shared.js'
import { MailService } from '../work/mail.js'
import { WorkBoard } from '../work/board.js'
import { workEvent } from '../work/events.js'
import { GateDefinition, GateRunner } from './gates.js'

/** What one queue pass did, in counts — the detail lives in the events and records. */
export interface MergeQueueReport {
  enqueued: number
  batches: number
  landed: number
  failed: number
  conflicted: number
  stale: number
}

export interface MergeCoordinatorOptions extends ClockOptions {
  ledger: Ledger
  repoRoot: string
  /** The remote the queue lands against — a bare repository, the way real targets are. */
  remote: string
  gates: readonly GateDefinition[]
  runner: GateRunner
  scope: ScopeRef
  mail?: MailService
  board?: WorkBoard
}

export interface EnqueueInput {
  sourceBranch: string
  targetBranch: string
  workItemId?: string
  runId?: string
}

/**
 * Phase 7's merge queue: integration only ever happens in a throwaway worktree
 * against a recorded target SHA, gates run before anything is pushed, the push
 * must be a fast-forward verified against that same SHA, and a request becomes
 * `landed` only after the push succeeds. Terminal records are immutable, and a
 * failing batch bisects so one bad branch cannot block the good ones.
 */
export class MergeCoordinator {
  private readonly ledger: Ledger
  private readonly repo: GitRunner
  private readonly now: Clock
  private readonly options: MergeCoordinatorOptions

  constructor(options: MergeCoordinatorOptions) {
    this.ledger = options.ledger
    this.repo = new GitRunner(options.repoRoot)
    this.now = resolveClock(options)
    this.options = options
  }

  /** Enqueues a branch for verified integration; the target head is recorded, not assumed. */
  enqueue(actor: ActorContext, input: EnqueueInput): MergeRequest {
    assertCapability(actor.capabilities, 'merge:execute')
    const occurredAt = this.now().toISOString()
    const request: MergeRequest = {
      id: createId(),
      scope: this.options.scope,
      workItemId: input.workItemId,
      runId: input.runId,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      targetSha: this.targetHead(input.targetBranch),
      state: 'open',
      createdBy: actor.actorId,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }
    this.ledger.insertMergeRequest(request)
    this.record(actor, 'enqueued', `enqueued:${request.id}`, occurredAt, {
      id: request.id, source: request.sourceBranch, target: request.targetBranch, targetSha: request.targetSha,
    }, request.workItemId)
    return request
  }

  requests(actor: ActorContext, scope?: ScopeRef, states?: readonly MergeRequest['state'][]): MergeRequest[] {
    assertCapability(actor.capabilities, 'workspace:read')
    return this.ledger.listMergeRequests(scope, states)
  }

  /**
   * One full pass: prepare every open batch (integrate + gates), then land what
   * passed. Split apart so a target that moves between the two is caught —
   * preparation is a fact about a SHA, and the SHA is re-verified at land time.
   */
  async process(actor: ActorContext): Promise<MergeQueueReport> {
    assertCapability(actor.capabilities, 'merge:execute')
    // Both halves report into one summary: conflicts and gate failures happen
    // in prepare, landings and staleness in land, and callers see the whole pass.
    const prepared = await this.prepare(actor)
    const landed = await this.land(actor)
    return {
      enqueued: 0,
      batches: prepared.batches,
      landed: landed.landed,
      failed: prepared.failed + landed.failed,
      conflicted: prepared.conflicted + landed.conflicted,
      stale: landed.stale,
    }
  }

  /** Integrates open requests into batches and runs the gates; nothing is pushed. */
  async prepare(actor: ActorContext): Promise<MergeQueueReport> {
    assertCapability(actor.capabilities, 'merge:execute')
    const report: MergeQueueReport = { enqueued: 0, batches: 0, landed: 0, failed: 0, conflicted: 0, stale: 0 }
    const open = this.ledger.listMergeRequests(this.options.scope, ['open'])
    const byTarget = new Map<string, MergeRequest[]>()
    for (const request of open) {
      const group = byTarget.get(request.targetBranch) ?? []
      group.push(request)
      byTarget.set(request.targetBranch, group)
    }
    for (const [targetBranch, requests] of byTarget) {
      const occurredAt = this.now().toISOString()
      // The remote's objects must be in the repo before a worktree can check
      // them out; ls-remote names the head, fetch makes it exist here.
      this.repo.run(['fetch', '--quiet', this.options.remote, targetBranch])
      const targetSha = this.targetHead(targetBranch)
      const batch: MergeBatch = {
        id: createId(),
        scope: this.options.scope,
        targetBranch,
        targetSha,
        mergeRequestIds: requests.map((request) => request.id),
        state: 'integrating',
        createdAt: occurredAt,
        updatedAt: occurredAt,
      }
      this.ledger.insertMergeBatch(batch)
      report.batches += 1
      await this.integrateBatch(actor, batch, requests, report)
    }
    return report
  }

  /** Lands everything that passed its gates, after re-verifying the target never moved. */
  async land(actor: ActorContext): Promise<MergeQueueReport> {
    assertCapability(actor.capabilities, 'merge:execute')
    const report: MergeQueueReport = { enqueued: 0, batches: 0, landed: 0, failed: 0, conflicted: 0, stale: 0 }
    const gated = this.ledger.listMergeRequests(this.options.scope, ['gated'])
    // Landing is per batch: one integration, one target check, one push — every
    // request in the batch rides the same commit.
    const byBatch = new Map<string, MergeRequest[]>()
    for (const request of gated) {
      const key = request.batchId ?? request.id
      const group = byBatch.get(key) ?? []
      group.push(request)
      byBatch.set(key, group)
    }
    for (const [batchKey, requests] of byBatch) {
      const occurredAt = this.now().toISOString()
      const first = requests[0]
      const currentSha = this.targetHead(first.targetBranch)
      // The one fact preparation depended on: the target is where it was. If it
      // moved, the integration is invalid — not failed, just no longer about
      // anything — and the requests go back to open against the new world.
      if (currentSha !== first.targetSha) {
        for (const request of requests) {
          this.ledger.transitionMergeRequest(request.id, 'gated', { state: 'open', targetSha: currentSha }, occurredAt)
          this.record(actor, 'stale', `stale:${request.id}:${occurredAt}`, occurredAt, {
            id: request.id, from: request.targetSha, to: currentSha,
          }, request.workItemId)
        }
        report.stale += requests.length
        continue
      }
      const integrationPath = this.integrationPath(batchKey)
      try {
        // Claim the landing first: from here a failure is a push failure, and
        // the requests are in the state that says so.
        for (const request of requests) {
          this.ledger.transitionMergeRequest(request.id, 'gated', { state: 'landing' }, occurredAt)
        }
        const integration = this.repo.at(integrationPath)
        // The push must be a fast-forward of the recorded SHA — never a rewrite.
        if (!integration.succeeds(['merge-base', '--is-ancestor', first.targetSha, 'HEAD'])) {
          for (const request of requests) {
            this.finish(actor, request, 'landing', 'failed', 'push_failure', 'integration is not a fast-forward of its target', report, occurredAt)
          }
          continue
        }
        integration.run(['push', this.options.remote, `HEAD:${first.targetBranch}`])
        for (const request of requests) {
          const landed = this.ledger.transitionMergeRequest(request.id, 'landing', { state: 'landed', closedAt: occurredAt }, occurredAt)
          if (!landed) throw new HiveError('MERGE_STATE', `Merge request ${request.id} left landing before it landed`)
          report.landed += 1
          this.record(actor, 'landed', `landed:${request.id}`, occurredAt, {
            id: request.id, source: request.sourceBranch, target: request.targetBranch, targetSha: request.targetSha,
          }, request.workItemId)
          this.mergeLinkedItem(actor, request)
        }
        if (first.batchId) this.ledger.patchMergeBatch(first.batchId, { state: 'landed' }, occurredAt)
      } catch (error) {
        for (const request of requests) {
          this.finish(actor, request, 'landing', 'failed', 'push_failure', error instanceof Error ? error.message : String(error), report, occurredAt)
        }
      } finally {
        this.cleanupWorktree(actor, integrationPath, occurredAt)
      }
    }
    return report
  }

  /** Integrates one batch: merge sources in order, classify conflicts, run gates, bisect failures. */
  private async integrateBatch(actor: ActorContext, batch: MergeBatch, requests: readonly MergeRequest[], report: MergeQueueReport): Promise<void> {
    const occurredAt = this.now().toISOString()
    const integrationPath = this.integrationPath(batch.id)
    try {
      mkdirSync(integrationPath, { recursive: true })
      this.repo.run(['worktree', 'add', '--quiet', '--detach', integrationPath, batch.targetSha])
      const integration = this.repo.at(integrationPath)
      for (const request of requests) {
        this.ledger.transitionMergeRequest(request.id, 'open', { state: 'preparing', batchId: batch.id, targetSha: batch.targetSha }, occurredAt)
        const mergeOk = integration.succeeds([...gitIdentityArgs, 'merge', '--no-ff', '--quiet', '-m', `merge ${request.sourceBranch} into ${batch.targetBranch}`, request.sourceBranch])
        if (mergeOk) continue
        // Conflict: capture the paths, abort, and send the branch back for rework.
        const conflictFiles = (integration.tryRun(['diff', '--name-only', '--diff-filter=U']) ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
        integration.run(['merge', '--abort'])
        this.finish(actor, request, 'preparing', 'conflicted', 'conflict', `conflicts with ${request.targetBranch}`, report, occurredAt, conflictFiles)
        this.requestRework(actor, request, conflictFiles, occurredAt)
        this.ledger.patchMergeBatch(batch.id, { state: 'isolated' }, occurredAt)
        // The rest of the batch returns to open: one conflict must not sink the others.
        for (const remaining of requests) {
          if (remaining.id === request.id) continue
          this.ledger.transitionMergeRequest(remaining.id, 'preparing', { state: 'open' }, occurredAt)
        }
        this.cleanupWorktree(actor, integrationPath, occurredAt)
        return
      }

      // All sources merged: run the gates in parallel, in the integration worktree.
      const results = await this.options.runner.run(this.options.gates, integrationPath)
      const failures = results.filter((result) => !result.passed)
      for (const request of requests) {
        this.ledger.transitionMergeRequest(request.id, 'preparing', { state: 'gated', gateResults: results }, occurredAt)
      }
      if (failures.length === 0) {
        this.ledger.patchMergeBatch(batch.id, { state: 'pending' }, occurredAt)
        return // landed by land(), which re-verifies the target
      }
      // Gates failed: a single request owns its failure; a batch bisects.
      if (requests.length === 1) {
        this.finish(actor, requests[0], 'gated', 'failed', 'gate_failure', failures.map((failure) => `${failure.gate}: ${failure.output}`).join(' | '), report, occurredAt, undefined, results)
        this.ledger.patchMergeBatch(batch.id, { state: 'isolated' }, occurredAt)
        this.cleanupWorktree(actor, integrationPath, occurredAt)
        return
      }
      // Bisect: the batch is isolated, its requests go back to open so the
      // sub-batches can claim them properly, and the halves are processed as
      // new batches.
      this.ledger.patchMergeBatch(batch.id, { state: 'isolated' }, occurredAt)
      for (const request of requests) {
        this.ledger.transitionMergeRequest(request.id, 'gated', { state: 'open' }, occurredAt)
      }
      this.record(actor, 'bisect', `bisect:${batch.id}`, occurredAt, {
        batchId: batch.id, requests: requests.map((request) => request.id),
      })
      this.cleanupWorktree(actor, integrationPath, occurredAt)
      const midpoint = Math.ceil(requests.length / 2)
      const halves: Array<readonly MergeRequest[]> = [requests.slice(0, midpoint), requests.slice(midpoint)]
      for (const half of halves) {
        if (half.length === 0) continue
        const sub: MergeBatch = {
          id: createId(),
          scope: batch.scope,
          targetBranch: batch.targetBranch,
          targetSha: batch.targetSha,
          mergeRequestIds: half.map((request) => request.id),
          state: 'integrating',
          isolationOf: batch.id,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        }
        this.ledger.insertMergeBatch(sub)
        report.batches += 1
        await this.integrateBatch(actor, sub, half, report)
      }
    } catch (error) {
      // Infrastructure: git itself refused something. The requests go back to
      // open — the queue is broken, not the branches.
      const detail = error instanceof Error ? error.message : String(error)
      for (const request of requests) {
        this.ledger.transitionMergeRequest(request.id, 'preparing', { state: 'open' }, occurredAt)
      }
      this.ledger.patchMergeBatch(batch.id, { state: 'isolated' }, occurredAt)
      this.record(actor, 'infrastructure', `infrastructure:${batch.id}`, occurredAt, { batchId: batch.id, detail })
      this.cleanupWorktree(actor, integrationPath, occurredAt)
    }
  }

  /** A landed merge closes its linked item when the item is far enough along; an open item is left to the operator. */
  private mergeLinkedItem(actor: ActorContext, request: MergeRequest): void {
    const board = this.options.board
    if (!board || !request.workItemId) return
    const item = this.ledger.workItem(request.workItemId)
    if (!item || terminalWorkItemStates.includes(item.status)) return
    // Only assigned, in-flight, or reviewing items can ride a landing into
    // merged; anything else (open, blocked) is a decision, not an automatism.
    if (item.status === 'assigned' || item.status === 'in_progress') {
      board.transition(actor, item.id, 'review')
      board.transition(actor, item.id, 'merged')
    } else if (item.status === 'review') {
      board.transition(actor, item.id, 'merged')
    }
  }

  /** Rework: the conflict is the author's to resolve — mail carries the files, the item goes back to review. */
  private requestRework(actor: ActorContext, request: MergeRequest, conflictFiles: readonly string[], occurredAt: string): void {
    this.options.mail?.send(actor, this.options.scope, {
      queue: 'supervisor',
      subject: 'REWORK_REQUEST',
      body: [
        `Branch ${request.sourceBranch} conflicts with ${request.targetBranch} at ${request.targetSha.slice(0, 12)}.`,
        conflictFiles.length > 0 ? `Conflicting files: ${conflictFiles.join(', ')}` : 'No conflicting paths recorded.',
        'Update the branch and enqueue it again.',
      ].join('\n'),
      type: 'protocol',
      priority: 'high',
    })
    const board = this.options.board
    if (board && request.workItemId) {
      const item = this.ledger.workItem(request.workItemId)
      if (item && item.status === 'in_progress') board.transition(actor, item.id, 'review')
    }
    this.record(actor, 'rework-requested', `rework:${request.id}`, occurredAt, {
      id: request.id, conflictFiles,
    }, request.workItemId)
  }

  private finish(
    actor: ActorContext,
    request: MergeRequest,
    from: MergeRequest['state'],
    state: 'failed' | 'conflicted',
    kind: MergeFailureKind,
    detail: string,
    report: MergeQueueReport,
    occurredAt: string,
    conflictFiles?: readonly string[],
    gateResults?: readonly MergeGateResult[],
  ): void {
    // The guarded transition is the claim: if it did not land, the request was
    // moved by someone else and this pass is not the one that decides it.
    const updated = this.ledger.transitionMergeRequest(request.id, from, {
      state,
      failureKind: kind,
      failureDetail: detail,
      closedAt: occurredAt,
      conflictFiles: conflictFiles ? [...conflictFiles] : undefined,
      gateResults: gateResults ? [...gateResults] : undefined,
    }, occurredAt)
    if (!updated) return
    if (state === 'failed') report.failed += 1
    else report.conflicted += 1
    this.record(actor, state, `${state}:${request.id}`, occurredAt, {
      id: request.id, kind, detail,
    }, request.workItemId)
  }

  /**
   * Cleanup only after verification: a worktree git refuses to remove — one the
   * gates left dirty — is preserved on disk and reported, never force-deleted.
   */
  private cleanupWorktree(actor: ActorContext, integrationPath: string, occurredAt: string): void {
    if (!existsSync(integrationPath)) return
    const clean = this.repo.at(integrationPath).tryRun(['status', '--porcelain'])
    if (clean !== undefined && clean.length > 0) {
      this.record(actor, 'worktree-preserved', `worktree-preserved:${integrationPath}:${occurredAt}`, occurredAt, {
        path: integrationPath, reason: 'integration worktree is dirty',
      })
      return
    }
    try {
      this.repo.run(['worktree', 'remove', integrationPath])
      rmSync(integrationPath, { recursive: true, force: true })
    } catch {
      this.record(actor, 'worktree-preserved', `worktree-preserved:${integrationPath}:${occurredAt}`, occurredAt, {
        path: integrationPath, reason: 'git refused to remove the worktree',
      })
    }
  }

  /** The target branch's head on the remote, as of right now. */
  private targetHead(targetBranch: string): string {
    const head = this.repo.tryRun(['ls-remote', this.options.remote, `refs/heads/${targetBranch}`])
    if (!head) throw new HiveError('MERGE_TARGET_MISSING', `Target branch ${targetBranch} does not exist on ${this.options.remote}`)
    return head.split('\t')[0]
  }

  private integrationPath(batchId: string): string {
    return join(tmpdir(), `hive-merge-${batchId}`)
  }

  private record(actor: ActorContext, action: string, key: string, occurredAt: string, payload: Record<string, unknown>, workItemId?: string): void {
    this.ledger.appendEvent(workEvent(actor, this.options.scope, 'Merge', action, key, occurredAt, payload, workItemId))
  }
}
