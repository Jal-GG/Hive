import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ActorContext,
  Lease,
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
  /** Requests held because their target is protected and no approver has released them. */
  awaitingApproval: number
  /** Targets skipped because another coordinator holds the merge lease on them (C19). */
  contended: number
}

/**
 * Matches a branch against a protected-branch pattern. Exact names, or a single
 * trailing `*` for a namespace like `release/*` — enough for real protection
 * rules without pulling in a glob dependency for one comparison.
 */
export function isProtectedBranch(branch: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (!pattern.endsWith('*')) return pattern === branch
    return branch.startsWith(pattern.slice(0, -1))
  })
}

export interface MergeCoordinatorOptions extends ClockOptions {
  ledger: Ledger
  repoRoot: string
  /** The remote the queue lands against — a bare repository, the way real targets are. */
  remote: string
  gates: readonly GateDefinition[]
  runner: GateRunner
  scope: ScopeRef
  /**
   * Branches that may not be landed on without an explicit approval, as exact
   * names or `prefix*` patterns. Empty by default: protection is opt-in, and a
   * protected target is held before any integration happens.
   */
  protectedBranches?: readonly string[]
  /** How long a target-branch merge claim is held before it is considered abandoned (C19). */
  claimTtlMs?: number
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
    // A protected target is held before anything is integrated: no worktree, no
    // gates, no push until an approver releases it. Holding at enqueue rather
    // than at land means an unapproved request never touches the target at all.
    const isProtected = isProtectedBranch(input.targetBranch, this.options.protectedBranches ?? [])
    const request: MergeRequest = {
      id: createId(),
      scope: this.options.scope,
      workItemId: input.workItemId,
      runId: input.runId,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      sourceCommit: this.sourceHead(input.sourceBranch),
      targetSha: this.targetHead(input.targetBranch),
      state: isProtected ? 'awaiting_approval' : 'open',
      protectedTarget: isProtected ? true : undefined,
      createdBy: actor.actorId,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }
    this.ledger.insertMergeRequest(request)
    this.record(actor, 'enqueued', `enqueued:${request.id}`, occurredAt, {
      id: request.id, source: request.sourceBranch, target: request.targetBranch, targetSha: request.targetSha,
      protectedTarget: isProtected,
    }, request.workItemId)
    if (isProtected) {
      this.record(actor, 'approval-required', `approval-required:${request.id}`, occurredAt, {
        id: request.id, source: request.sourceBranch, target: request.targetBranch,
      }, request.workItemId)
      this.options.mail?.send(actor, this.options.scope, {
        queue: 'supervisor',
        subject: 'MERGE_READY',
        body: [
          `Branch ${request.sourceBranch} is queued for the protected branch ${request.targetBranch}.`,
          'It will not be integrated, gated, or pushed until an approver releases it.',
          `Approve with: hive merge approve --request ${request.id}`,
        ].join('\n'),
        type: 'protocol',
        priority: 'high',
      })
    }
    return request
  }

  /**
   * Releases a request held against a protected target. `merge:approve` is a
   * capability of its own, so holding `merge:execute` — which every queue
   * worker needs — is never enough to open a protected branch.
   */
  approve(actor: ActorContext, requestId: string): MergeRequest {
    assertCapability(actor.capabilities, 'merge:approve')
    const existing = this.ledger.mergeRequest(requestId)
    if (!existing) throw new HiveError('MERGE_NOT_FOUND', `Merge request ${requestId} not found`)
    const occurredAt = this.now().toISOString()
    const approved = this.ledger.approveMergeRequest(requestId, actor.actorId, occurredAt)
    if (!approved) {
      throw new HiveError('MERGE_STATE', `Merge request ${requestId} is ${existing.state}, not awaiting approval`)
    }
    this.record(actor, 'approved', `approved:${requestId}`, occurredAt, {
      id: requestId, target: approved.targetBranch, approvedBy: actor.actorId,
    }, approved.workItemId)
    return approved
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
      awaitingApproval: prepared.awaitingApproval,
      contended: prepared.contended + landed.contended,
    }
  }

  /** Integrates open requests into batches and runs the gates; nothing is pushed. */
  async prepare(actor: ActorContext): Promise<MergeQueueReport> {
    assertCapability(actor.capabilities, 'merge:execute')
    const report: MergeQueueReport = { enqueued: 0, batches: 0, landed: 0, failed: 0, conflicted: 0, stale: 0, awaitingApproval: 0, contended: 0 }
    const open = this.ledger.listMergeRequests(this.options.scope, ['open'])
    // Held requests are reported, never prepared: `open` is the only state this
    // pass claims, so a protected target waits without a special case below.
    report.awaitingApproval = this.ledger.listMergeRequests(this.options.scope, ['awaiting_approval']).length
    const byTarget = new Map<string, MergeRequest[]>()
    for (const request of open) {
      const group = byTarget.get(request.targetBranch) ?? []
      group.push(request)
      byTarget.set(request.targetBranch, group)
    }
    for (const [targetBranch, requests] of byTarget) {
      // C19: one coordinator integrates a given target at a time. The claim is a
      // real lease with a fencing token, so a second coordinator does not race
      // this one through git — it simply finds the target taken and moves on.
      const claim = this.claimTarget(actor, targetBranch)
      if (!claim) {
        report.contended += 1
        continue
      }
      try {
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
        await this.integrateBatch(actor, batch, requests, report, claim)
      } finally {
        this.releaseTarget(actor, claim)
      }
    }
    return report
  }

  /** Lands everything that passed its gates, after re-verifying the target never moved. */
  async land(actor: ActorContext): Promise<MergeQueueReport> {
    assertCapability(actor.capabilities, 'merge:execute')
    const report: MergeQueueReport = { enqueued: 0, batches: 0, landed: 0, failed: 0, conflicted: 0, stale: 0, awaitingApproval: 0, contended: 0 }
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
      const first = requests[0]
      // The same target claim landing takes as preparation did: the push is the
      // moment the target actually moves, so it is the one that most needs it.
      const claim = this.claimTarget(actor, first.targetBranch)
      if (!claim) {
        report.contended += 1
        continue
      }
      const occurredAt = this.now().toISOString()
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
        this.releaseTarget(actor, claim)
        continue
      }
      const integrationPath = this.integrationPath(batchKey)
      try {
        // Claim the landing first: from here a failure is a push failure, and
        // the requests are in the state that says so.
        for (const request of requests) {
          this.ledger.transitionMergeRequest(request.id, 'gated', {
            state: 'landing', claimedBy: actor.actorId, fencingToken: claim.fencingToken, claimExpiresAt: claim.expiresAt,
          }, occurredAt)
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
        // Only now is there a merge commit: the SHA is read after the push
        // succeeded, so a recorded merge_commit always means something shipped.
        const mergeCommit = integration.run(['rev-parse', 'HEAD'])
        for (const request of requests) {
          const landed = this.ledger.transitionMergeRequest(request.id, 'landing', { state: 'landed', mergeCommit, closedAt: occurredAt }, occurredAt)
          if (!landed) throw new HiveError('MERGE_STATE', `Merge request ${request.id} left landing before it landed`)
          report.landed += 1
          this.record(actor, 'landed', `landed:${request.id}`, occurredAt, {
            id: request.id, source: request.sourceBranch, target: request.targetBranch, targetSha: request.targetSha, mergeCommit,
          }, request.workItemId)
          this.notify(actor, 'MERGED', 'normal', [
            `Branch ${request.sourceBranch} landed on ${request.targetBranch} as ${mergeCommit.slice(0, 12)}.`,
            request.workItemId ? `Work item: ${request.workItemId}` : '',
          ].filter(Boolean).join('\n'))
          this.mergeLinkedItem(actor, request)
        }
        if (first.batchId) this.ledger.patchMergeBatch(first.batchId, { state: 'landed' }, occurredAt)
      } catch (error) {
        for (const request of requests) {
          this.finish(actor, request, 'landing', 'failed', 'push_failure', error instanceof Error ? error.message : String(error), report, occurredAt)
        }
      } finally {
        this.cleanupWorktree(actor, integrationPath, occurredAt)
        this.releaseTarget(actor, claim)
      }
    }
    return report
  }

  /** Integrates one batch: merge sources in order, classify conflicts, run gates, bisect failures. */
  private async integrateBatch(actor: ActorContext, batch: MergeBatch, requests: readonly MergeRequest[], report: MergeQueueReport, claim: Lease): Promise<void> {
    const occurredAt = this.now().toISOString()
    const integrationPath = this.integrationPath(batch.id)
    try {
      mkdirSync(integrationPath, { recursive: true })
      this.repo.run(['worktree', 'add', '--quiet', '--detach', integrationPath, batch.targetSha])
      const integration = this.repo.at(integrationPath)
      for (const request of requests) {
        this.ledger.transitionMergeRequest(request.id, 'open', {
          state: 'preparing', batchId: batch.id, targetSha: batch.targetSha,
          claimedBy: actor.actorId, fencingToken: claim.fencingToken, claimExpiresAt: claim.expiresAt,
        }, occurredAt)
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
        await this.integrateBatch(actor, sub, half, report, claim)
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
    // A conflict already gets its own REWORK_REQUEST; everything else that ends
    // a merge is reported as MERGE_FAILED, so no failure is silent (§6.4).
    if (state === 'failed') {
      this.notify(actor, 'MERGE_FAILED', 'high', [
        `Branch ${request.sourceBranch} failed to land on ${request.targetBranch}.`,
        `Cause: ${kind}.`,
        detail,
      ].join('\n'))
    }
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

  /** The source branch's head locally, so a request names a commit and not just a branch name (§6.3). */
  private sourceHead(sourceBranch: string): string | undefined {
    return this.repo.tryRun(['rev-parse', sourceBranch]) ?? undefined
  }

  /**
   * C19: claims the target branch for this pass with a real fencing token. A
   * lease conflict is not an error — another coordinator holds the target, and
   * this pass leaves it alone rather than racing it through git.
   */
  private claimTarget(actor: ActorContext, targetBranch: string): Lease | undefined {
    try {
      return this.ledger.acquireLease(actor, 'merge', `${this.options.scope.projectId}:${targetBranch}`, this.options.claimTtlMs ?? 10 * 60_000)
    } catch (error) {
      if (error instanceof HiveError && error.code === 'LEASE_CONFLICT') return undefined
      throw error
    }
  }

  /**
   * Releasing is best-effort — a lease that already expired is not ours to
   * release — but a refusal is recorded rather than swallowed: a release that
   * silently fails leaves the target claimed and every later pass contending.
   */
  private releaseTarget(actor: ActorContext, claim: Lease): void {
    try {
      this.ledger.releaseLease(actor, claim.id)
    } catch (error) {
      const occurredAt = this.now().toISOString()
      this.record(actor, 'claim-release-failed', `claim-release-failed:${claim.id}`, occurredAt, {
        leaseId: claim.id, resourceId: claim.resourceId, detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Protocol mail to the supervisor queue (§6.4), when a mail service is wired in. */
  private notify(actor: ActorContext, subject: string, priority: 'normal' | 'high' | 'urgent', body: string): void {
    this.options.mail?.send(actor, this.options.scope, { queue: 'supervisor', subject, body, type: 'protocol', priority })
  }

  private record(actor: ActorContext, action: string, key: string, occurredAt: string, payload: Record<string, unknown>, workItemId?: string): void {
    this.ledger.appendEvent(workEvent(actor, this.options.scope, 'Merge', action, key, occurredAt, payload, workItemId))
  }
}
