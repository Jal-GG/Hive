import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Capability, MergeGateResult, MergeRequest } from '../../src/contracts.js'
import { resetFakeSessions } from '../../src/runtime/fake-backend.js'
import { fakeProfileId } from '../../src/runtime/provider-catalog.js'
import { GitRunner } from '../../src/git.js'
import { runMergeCli } from '../../src/interfaces/cli/merge-cli.js'
import { mergeIpcHandlers } from '../../src/interfaces/desktop/merge-ipc.js'
import { mergeIpcPrefix } from '../../src/interfaces/desktop/runtime-channels.js'
import { allowedChannels } from '../../src/interfaces/desktop/preload-bridge.js'
import { mergeQueueHarness, tempDirectory, testActor, testAgent } from '../fixtures.js'

/**
 * The Phase 7 gate: two concurrent fake branches merge through gates; target
 * movement invalidates preparation; failing batches bisect; conflicts produce
 * rework; dirty worktrees remain; a convoy closes exactly once; and a protected
 * remote branch does not move until an approver releases it.
 */
const capabilities: Capability[] = ['workspace:read', 'work:mutate', 'work:dispatch', 'runtime:control', 'runtime:read', 'context:read', 'merge:execute']
/** The operator may run the queue and release protected targets; the agent may only run the queue. */
const operator = testActor('operator', [...capabilities, 'merge:approve'])
const agent = testAgent('worker-1', capabilities)

afterEach(() => resetFakeSessions())

describe('verified merge queue — the Phase 7 gate', () => {
  // Each test drives real git worktrees, gates, and pushes; the default 5s
  // budget is a unit-test budget and these are integration scenarios.
  const slow = { timeout: 60_000 }

  it('lands two concurrent branches through gates in one batch', slow, async () => {
    const harness = mergeQueueHarness([operator])
    harness.branchWithCommit('feature-a', 'feature-a.txt', 'from branch a\n')
    harness.branchWithCommit('feature-b', 'feature-b.txt', 'from branch b\n')
    harness.queue.enqueue(operator, { sourceBranch: 'feature-a', targetBranch: 'main' })
    harness.queue.enqueue(operator, { sourceBranch: 'feature-b', targetBranch: 'main' })

    const report = await harness.queue.process(operator)
    expect(report).toMatchObject({ landed: 2, failed: 0, conflicted: 0 })
    // One batch carried both: the remote's main now holds both files.
    const landed = harness.queue.requests(operator, harness.scope, ['landed'])
    expect(landed).toHaveLength(2)
    expect(new Set(landed.map((request) => request.batchId)).size).toBe(1)
    expect(remoteFile(harness, 'feature-a.txt')).toBe('from branch a\n')
    expect(remoteFile(harness, 'feature-b.txt')).toBe('from branch b\n')
    harness.close()
  })

  it('invalidates preparation when the target moves, then lands against the new head', slow, async () => {
    const harness = mergeQueueHarness([operator])
    harness.branchWithCommit('feature-a', 'feature-a.txt', 'from branch a\n')
    harness.queue.enqueue(operator, { sourceBranch: 'feature-a', targetBranch: 'main' })

    // Preparation happens against a recorded SHA; then another writer moves main.
    await harness.queue.prepare(operator)
    harness.moveTarget('moved-by-someone-else.txt', 'target moved\n')
    const stale = await harness.queue.land(operator)
    expect(stale).toMatchObject({ stale: 1, landed: 0 })
    expect(harness.queue.requests(operator, harness.scope, ['open'])).toHaveLength(1)

    // The next pass re-prepares against the new head and lands: the merge is
    // still what was asked for, just rebased in time onto the real world.
    const landed = await harness.queue.process(operator)
    expect(landed).toMatchObject({ landed: 1, stale: 0 })
    expect(remoteFile(harness, 'feature-a.txt')).toBe('from branch a\n')
    expect(remoteFile(harness, 'moved-by-someone-else.txt')).toBe('target moved\n')
    harness.close()
  })

  it('bisects a failing batch: the broken branch fails, the good ones still land', slow, async () => {
    const harness = mergeQueueHarness([operator])
    harness.branchWithCommit('good-1', 'good-1.txt', 'good one\n')
    harness.branchWithCommit('bad', 'broken.txt', 'this branch breaks the gate\n')
    harness.branchWithCommit('good-2', 'good-2.txt', 'good two\n')
    for (const branch of ['good-1', 'bad', 'good-2']) {
      harness.queue.enqueue(operator, { sourceBranch: branch, targetBranch: 'main' })
    }

    // The whole batch failed its gates and bisected. Which half held the
    // culprit decides the wave shape, so the test asserts the destination, not
    // the itinerary: process until the queue is quiet.
    for (let pass = 0; pass < 5; pass += 1) {
      const open = harness.queue.requests(operator, harness.scope, ['open'])
      if (open.length === 0) break
      await harness.queue.process(operator)
    }
    const failed = harness.queue.requests(operator, harness.scope, ['failed'])
    expect(failed).toHaveLength(1)
    expect(failed[0].sourceBranch).toBe('bad')
    expect(failed[0].failureKind).toBe('gate_failure')
    expect(failed[0].gateResults?.some((result) => !result.passed && result.output.includes('broken.txt'))).toBe(true)
    const landed = harness.queue.requests(operator, harness.scope, ['landed'])
    expect(landed.map((request) => request.sourceBranch).sort()).toEqual(['good-1', 'good-2'])
    // The good branches landed; the broken one never reached the target.
    expect(remoteFile(harness, 'good-1.txt')).toBe('good one\n')
    expect(remoteFile(harness, 'good-2.txt')).toBe('good two\n')
    expect(remoteFile(harness, 'broken.txt')).toBeUndefined()
    harness.close()
  })

  it('classifies conflicts, sends rework, and lands the rest', slow, async () => {
    const harness = mergeQueueHarness([operator])
    // Two branches editing the same line of the same file conflict with each other.
    harness.branchWithCommit('conflict-a', 'README.md', '# version a\n')
    harness.branchWithCommit('conflict-b', 'README.md', '# version b\n')
    harness.queue.enqueue(operator, { sourceBranch: 'conflict-a', targetBranch: 'main' })
    harness.queue.enqueue(operator, { sourceBranch: 'conflict-b', targetBranch: 'main' })

    const first = await harness.queue.process(operator)
    // One of the two conflicted; the other went back to open, unharmed.
    expect(first.conflicted).toBe(1)
    const conflicted = harness.queue.requests(operator, harness.scope, ['conflicted'])
    expect(conflicted).toHaveLength(1)
    expect(conflicted[0].conflictFiles).toEqual(['README.md'])
    // Rework was requested by mail, with the conflicting file named.
    const rework = harness.mail.inbox(operator, { queue: 'supervisor' }).find((message) => message.subject === 'REWORK_REQUEST')
    expect(rework?.body).toContain('README.md')
    expect(rework?.body).toContain(conflicted[0].sourceBranch)

    // The survivor lands on the next pass, alone.
    const second = await harness.queue.process(operator)
    expect(second).toMatchObject({ landed: 1, conflicted: 0 })
    const readme = remoteFile(harness, 'README.md')
    expect(readme === '# version a\n' || readme === '# version b\n').toBe(true)
    harness.close()
  })

  it('preserves a dirty integration worktree instead of force-deleting it', slow, async () => {
    const harness = mergeQueueHarness([operator])
    // The dirty gate leaves an artifact behind only when the marker exists.
    harness.branchWithCommit('messy', 'dirty-marker.txt', 'make the gate dirty\n')
    harness.queue.enqueue(operator, { sourceBranch: 'messy', targetBranch: 'main' })

    const report = await harness.queue.process(operator)
    expect(report.landed).toBe(1)
    // The preservation is on the record: an event names the path and the reason.
    const preserved = harness.ledger.readEvents(0, 500).find((event) => event.idempotencyKey.startsWith('merge:worktree-preserved:'))
    expect(preserved).toBeDefined()
    const path = (preserved?.payload as { path?: string }).path
    expect(path).toBeDefined()
    // The worktree is still on disk, artifact and all — inspection beats deletion.
    expect(existsSync(join(path!, 'gate-artifact.txt'))).toBe(true)
    expect(readFileSync(join(path!, 'gate-artifact.txt'), 'utf8')).toBe('left behind by the gate')
    harness.close()
  })

  it('closes a convoy exactly once, dispatches the next unblocked item, and counts stranded work', slow, async () => {
    const harness = mergeQueueHarness([operator, agent])
    harness.dispatcher.registerAgent(agent, { agentId: 'worker-1', profileId: fakeProfileId })

    // A convoy of three: a lands first, b was waiting on a, c is stranded behind a failure.
    const itemA = harness.board.create(operator, harness.scope, { title: 'Convoy A', convoyId: 'release-1' })
    const itemB = harness.board.create(operator, harness.scope, { title: 'Convoy B', convoyId: 'release-1' })
    const itemC = harness.board.create(operator, harness.scope, { title: 'Convoy C', convoyId: 'release-1' })
    harness.board.addDependency(operator, itemB.id, itemA.id, 'blocks')
    harness.board.addDependency(operator, itemC.id, itemB.id, 'blocks')
    harness.convoys.ensure(operator, 'release-1')

    harness.branchWithCommit('convoy-a', 'convoy-a.txt', 'convoy a\n')
    // The item rides its merge into merged: it must be in flight when it lands.
    harness.board.claim(operator, itemA.id)
    harness.board.transition(operator, itemA.id, 'in_progress')
    harness.queue.enqueue(operator, { sourceBranch: 'convoy-a', targetBranch: 'main', workItemId: itemA.id })
    const merged = await harness.queue.process(operator)
    expect(merged.landed).toBe(1)
    // The landed merge closed its linked item: a convoy converges through its items.
    expect(harness.board.item(operator, itemA.id).status).toBe('merged')

    // A lands: B unblocks and is dispatched by the scan; the convoy stays open.
    const firstScan = await harness.convoys.scan(operator)
    expect(firstScan.dispatched).toBe(1)
    expect(harness.board.item(operator, itemB.id).status).toBe('in_progress')
    expect(harness.convoys.convoys(operator, ['active'])).toHaveLength(1)

    // B fails terminally: C is now stranded behind a dependency that will never satisfy.
    harness.board.transition(agent, itemB.id, 'failed')
    const strandedScan = await harness.convoys.scan(operator)
    expect(strandedScan.stranded).toBe(1)
    // The operator force-closes what cannot converge; C's fate becomes explicit.
    const forced = harness.convoys.forceClose(operator, 'release-1')
    expect(forced.state).toBe('forced')
    const forceMail = harness.mail.inbox(operator, { queue: 'supervisor' }).filter((message) => message.subject === 'RECOVERY_NEEDED')
    expect(forceMail.length).toBeGreaterThan(0)
    // A forced convoy never re-closes as natural: exactly one closure, ever.
    const again = await harness.convoys.scan(operator)
    expect(again.closed).toBe(0)
    harness.close()

    // A natural convoy closes exactly once: two landed items, one closure, one letter.
    const natural = mergeQueueHarness([operator])
    const one = natural.board.create(operator, natural.scope, { title: 'Pair one', convoyId: 'release-2' })
    const two = natural.board.create(operator, natural.scope, { title: 'Pair two', convoyId: 'release-2' })
    natural.convoys.ensure(operator, 'release-2')
    natural.branchWithCommit('pair-one', 'pair-one.txt', 'one\n')
    natural.branchWithCommit('pair-two', 'pair-two.txt', 'two\n')
    natural.queue.enqueue(operator, { sourceBranch: 'pair-one', targetBranch: 'main', workItemId: one.id })
    natural.queue.enqueue(operator, { sourceBranch: 'pair-two', targetBranch: 'main', workItemId: two.id })
    for (const item of [one, two]) {
      natural.board.claim(operator, item.id)
      natural.board.transition(operator, item.id, 'in_progress')
    }
    await natural.queue.process(operator)
    const closure = await natural.convoys.scan(operator)
    expect(closure.closed).toBe(1)
    const resend = await natural.convoys.scan(operator)
    expect(resend.closed).toBe(0)
    // Exactly one convoy-closure letter, distinct from the per-request MERGED
    // letters each landing sends: the convoy converged once.
    const mergedMail = natural.mail.inbox(operator, { queue: 'supervisor' })
      .filter((message) => message.subject === 'MERGED' && message.body.includes('Convoy release-2'))
    expect(mergedMail).toHaveLength(1)
    expect(natural.convoys.convoys(operator, ['closed'])).toHaveLength(1)
    natural.close()
  })

  it('holds a protected target until an approver releases it, and never moves it before', slow, async () => {
    const harness = mergeQueueHarness([operator, agent])
    harness.branchWithCommit('hotfix', 'hotfix.txt', 'urgent fix\n')
    const before = harness.remoteHead(harness.protectedBranch)

    // Queued by the agent against the protected branch: held, not opened.
    const request = harness.queue.enqueue(agent, { sourceBranch: 'hotfix', targetBranch: harness.protectedBranch })
    expect(request.state).toBe('awaiting_approval')
    expect(request.protectedTarget).toBe(true)

    // A full pass integrates and lands nothing: the hold is before any git work.
    const held = await harness.queue.process(operator)
    expect(held).toMatchObject({ landed: 0, batches: 0, failed: 0, awaitingApproval: 1 })
    expect(harness.remoteHead(harness.protectedBranch)).toBe(before)
    expect(harness.queue.requests(operator, harness.scope, ['awaiting_approval'])).toHaveLength(1)
    // The approver was told, and told how.
    const notice = harness.mail.inbox(operator, { queue: 'supervisor' }).find((message) => message.subject === 'MERGE_READY')
    expect(notice?.body).toContain(harness.protectedBranch)
    expect(notice?.body).toContain(request.id)

    // The agent runs the queue but cannot open the gate it is waiting behind.
    expect(() => harness.queue.approve(agent, request.id)).toThrowError(/merge:approve/)
    expect(harness.remoteHead(harness.protectedBranch)).toBe(before)

    // The operator approves: the request opens, carrying who released it.
    const approved = harness.queue.approve(operator, request.id)
    expect(approved.state).toBe('open')
    expect(approved.approvedBy).toBe(operator.actorId)
    expect(approved.approvedAt).toBeDefined()

    // Only now does it go through the gates and land.
    const landed = await harness.queue.process(operator)
    expect(landed).toMatchObject({ landed: 1, awaitingApproval: 0 })
    expect(harness.remoteHead(harness.protectedBranch)).not.toBe(before)
    expect(remoteFile(harness, 'hotfix.txt', harness.protectedBranch)).toBe('urgent fix\n')
    // Approval is spent: the released request cannot be approved again.
    expect(() => harness.queue.approve(operator, request.id)).toThrowError(/not awaiting approval/)
    harness.close()
  })

  it('gates only protected targets, and a held request keeps its convoy open', slow, async () => {
    const harness = mergeQueueHarness([operator])
    // An unprotected target is unaffected: protection is opt-in, per branch.
    harness.branchWithCommit('plain', 'plain.txt', 'no approval needed\n')
    const plain = harness.queue.enqueue(operator, { sourceBranch: 'plain', targetBranch: 'main' })
    expect(plain.state).toBe('open')
    expect(plain.protectedTarget).toBeUndefined()

    // A convoy whose only item is held for approval has not converged, even
    // though the item itself reached a terminal state.
    const item = harness.board.create(operator, harness.scope, { title: 'Protected release', convoyId: 'release-3' })
    harness.convoys.ensure(operator, 'release-3')
    harness.branchWithCommit('convoy-protected', 'convoy-protected.txt', 'held\n')
    harness.board.claim(operator, item.id)
    harness.board.transition(operator, item.id, 'in_progress')
    harness.board.transition(operator, item.id, 'review')
    harness.board.transition(operator, item.id, 'merged')
    const held = harness.queue.enqueue(operator, {
      sourceBranch: 'convoy-protected', targetBranch: harness.protectedBranch, workItemId: item.id,
    })
    expect(held.state).toBe('awaiting_approval')

    const blocked = await harness.convoys.scan(operator)
    expect(blocked.closed).toBe(0)
    expect(harness.convoys.convoys(operator, ['active'])).toHaveLength(1)

    // Released and landed, the convoy converges.
    harness.queue.approve(operator, held.id)
    await harness.queue.process(operator)
    const closure = await harness.convoys.scan(operator)
    expect(closure.closed).toBe(1)
    harness.close()
  })

  it('claims its target with a fencing token, and a second coordinator does not race it', slow, async () => {
    const harness = mergeQueueHarness([operator])
    harness.branchWithCommit('claimed', 'claimed.txt', 'claimed work\n')
    const request = harness.queue.enqueue(operator, { sourceBranch: 'claimed', targetBranch: 'main' })
    // Enqueue records what was asked for: a commit, not just a branch name.
    expect(request.sourceCommit).toHaveLength(40)

    // Another coordinator already holds the target: this pass must not touch git.
    // Preparation contends, so nothing reaches the gates and landing has no batch.
    const held = harness.ledger.acquireLease(operator, 'merge', `${harness.scope.projectId}:main`, 60_000)
    const before = harness.remoteHead('main')
    const contended = await harness.queue.process(operator)
    expect(contended).toMatchObject({ contended: 1, landed: 0, batches: 0 })
    expect(harness.remoteHead('main')).toBe(before)
    expect(harness.queue.requests(operator, harness.scope, ['open'])).toHaveLength(1)

    // Released, the same pass lands and records the claim that authorized it.
    harness.ledger.releaseLease(operator, held.id)
    const landed = await harness.queue.process(operator)
    expect(landed).toMatchObject({ landed: 1, contended: 0 })
    const final = harness.queue.requests(operator, harness.scope, ['landed'])[0]
    expect(final.claimedBy).toBe(operator.actorId)
    // The token is monotonic, so a later claim always outranks the one it replaced.
    expect(final.fencingToken).toBeGreaterThan(held.fencingToken)
    // The merge commit is real and is what the target now points at.
    expect(final.mergeCommit).toHaveLength(40)
    expect(harness.remoteHead('main')).toBe(final.mergeCommit)
    // The claim is released once the pass ends: nothing is left holding the target.
    expect(harness.ledger.activeLease('merge', `${harness.scope.projectId}:main`)).toBeUndefined()
    harness.close()
  })

  it('reports a landing as MERGED and a gate failure as MERGE_FAILED', slow, async () => {
    const harness = mergeQueueHarness([operator])
    harness.branchWithCommit('good', 'good.txt', 'fine\n')
    harness.queue.enqueue(operator, { sourceBranch: 'good', targetBranch: 'main' })
    await harness.queue.process(operator)

    const merged = harness.mail.inbox(operator, { queue: 'supervisor' }).filter((message) => message.subject === 'MERGED')
    expect(merged).toHaveLength(1)
    expect(merged[0].body).toContain('good')
    expect(merged[0].body).toContain('main')

    // A branch that breaks the gate fails alone, and says so by mail.
    harness.branchWithCommit('bad', 'broken.txt', 'breaks the gate\n')
    harness.queue.enqueue(operator, { sourceBranch: 'bad', targetBranch: 'main' })
    const failed = await harness.queue.process(operator)
    expect(failed.failed).toBe(1)
    const failure = harness.mail.inbox(operator, { queue: 'supervisor' }).filter((message) => message.subject === 'MERGE_FAILED')
    expect(failure).toHaveLength(1)
    expect(failure[0].body).toContain('gate_failure')
    expect(failure[0].priority).toBe('high')
    // The failed request carries no merge commit: nothing shipped.
    expect(harness.queue.requests(operator, harness.scope, ['failed'])[0].mergeCommit).toBeUndefined()
    harness.close()
  })

  it('serves the queue, graph, gate output, conflicts, and recovery to the desktop', slow, async () => {
    const harness = mergeQueueHarness([operator])
    harness.branchWithCommit('ui-good', 'ui-good.txt', 'lands\n')
    harness.branchWithCommit('ui-bad', 'broken.txt', 'fails the gate\n')
    harness.queue.enqueue(operator, { sourceBranch: 'ui-good', targetBranch: 'main' })
    harness.queue.enqueue(operator, { sourceBranch: 'ui-bad', targetBranch: 'main' })
    for (let pass = 0; pass < 5; pass += 1) {
      if (harness.queue.requests(operator, harness.scope, ['open']).length === 0) break
      await harness.queue.process(operator)
    }

    const handlers = mergeIpcHandlers({
      scope: harness.scope, ledger: harness.ledger, queue: harness.queue, convoys: harness.convoys, configured: true,
    }, operator)
    const call = async (operation: string, payload?: unknown) => {
      const handler = handlers.get(`${mergeIpcPrefix}${operation}`)
      expect(handler, `no handler for ${operation}`).toBeDefined()
      const result = await handler!(undefined, payload)
      if (!result.ok) throw new Error(`${operation} failed: ${result.error.message}`)
      return result.data
    }

    // The queue view is the ledger's, not a second opinion.
    const requests = await call('requests') as MergeRequest[]
    expect(requests).toHaveLength(2)
    const failed = requests.find((request) => request.sourceBranch === 'ui-bad')!
    const landed = requests.find((request) => request.sourceBranch === 'ui-good')!
    expect(failed.state).toBe('failed')
    expect(landed.state).toBe('landed')

    // Gate output is inspectable for the branch that failed, and names the cause.
    const gates = await call('gates', { requestId: failed.id }) as MergeGateResult[]
    expect(gates.some((gate) => !gate.passed && gate.output.includes('broken.txt'))).toBe(true)

    // The branch graph carries batches with the branches that rode them, and the
    // isolation link that records the bisect.
    const graph = await call('graph') as Array<{ targetBranch: string; branches: unknown[]; isolationOf?: string }>
    expect(graph.length).toBeGreaterThan(0)
    expect(graph.every((node) => node.targetBranch === 'main')).toBe(true)
    expect(graph.some((node) => node.isolationOf !== undefined)).toBe(true)
    expect(graph.flatMap((node) => node.branches).length).toBeGreaterThan(0)

    // Recovery shows what the queue could not finish on its own.
    const recovery = await call('recovery') as { failed: MergeRequest[]; conflicted: MergeRequest[]; preservedWorktrees: unknown[] }
    expect(recovery.failed.map((request) => request.sourceBranch)).toEqual(['ui-bad'])
    expect(recovery.conflicted).toEqual([])
    expect(await call('conflicts')).toEqual([])

    // Every registered channel is on the preload allowlist, and nothing extra.
    const allowed = new Set(allowedChannels())
    for (const channel of handlers.keys()) expect(allowed.has(channel)).toBe(true)
    harness.close()
  })

  it('keeps the desktop merge queue read-only when no gates are configured', slow, async () => {
    const harness = mergeQueueHarness([operator])
    // An install with no remote or gates: reads work, anything that moves a branch does not.
    const handlers = mergeIpcHandlers({
      scope: harness.scope, ledger: harness.ledger, queue: harness.queue, convoys: harness.convoys, configured: false,
    }, operator)
    const read = await handlers.get(`${mergeIpcPrefix}requests`)!(undefined, {})
    expect(read.ok).toBe(true)

    for (const operation of ['process', 'land', 'enqueue', 'approve']) {
      const refused = await handlers.get(`${mergeIpcPrefix}${operation}`)!(undefined, {})
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.error.code).toBe('MERGE_NOT_CONFIGURED')
    }
    harness.close()
  })

  it('serves the queue through the CLI', slow, async () => {
    const harness = mergeQueueHarness([operator])
    harness.branchWithCommit('cli-branch', 'cli.txt', 'from the CLI\n')
    const surfaces = { ledger: harness.ledger, queue: harness.queue, convoys: harness.convoys }
    const cli = (argv: string[]) => runMergeCli(surfaces, operator, argv)

    const enqueued = JSON.parse(await cli(['enqueue', '--source', 'cli-branch', '--target', 'main'])) as { state: string; targetSha: string }
    expect(enqueued.state).toBe('open')
    expect(enqueued.targetSha).toHaveLength(40)

    const processed = JSON.parse(await cli(['process'])) as { landed: number }
    expect(processed.landed).toBe(1)

    const requests = JSON.parse(await cli(['requests', '--state', 'landed'])) as Array<{ state: string }>
    expect(requests).toHaveLength(1)

    // A protected target is held through the CLI too, and released by approve.
    harness.branchWithCommit('cli-protected', 'cli-protected.txt', 'needs approval\n')
    const held = JSON.parse(await cli(['enqueue', '--source', 'cli-protected', '--target', harness.protectedBranch])) as { id: string; state: string }
    expect(held.state).toBe('awaiting_approval')
    const released = JSON.parse(await cli(['approve', '--request', held.id])) as { state: string; approvedBy: string }
    expect(released).toMatchObject({ state: 'open', approvedBy: operator.actorId })
    await expect(cli(['approve'])).rejects.toThrowError(/--request is required/)
    await expect(cli(['explode'])).rejects.toThrowError(/Unknown merge operation/)
    harness.close()
  })
})

/** Reads one file from a branch on the remote — what actually shipped. Line endings normalized: checkout noise, not content. */
function remoteFile(harness: ReturnType<typeof mergeQueueHarness>, file: string, branch = 'main'): string | undefined {
  const git = new GitRunner(harness.repoRoot)
  git.run(['fetch', '--quiet', harness.remote, branch])
  const head = git.run(['rev-parse', 'FETCH_HEAD'])
  const dir = tempDirectory('remote-inspect')
  git.run(['worktree', 'add', '--quiet', '--detach', dir, head])
  try {
    const path = join(dir, file)
    return existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n') : undefined
  } finally {
    git.run(['worktree', 'remove', '--force', dir])
  }
}
