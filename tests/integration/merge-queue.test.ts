import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Capability } from '../../src/contracts.js'
import { resetFakeSessions } from '../../src/runtime/fake-backend.js'
import { fakeProfileId } from '../../src/runtime/provider-catalog.js'
import { GitRunner } from '../../src/git.js'
import { runMergeCli } from '../../src/interfaces/cli/merge-cli.js'
import { mergeQueueHarness, tempDirectory, testActor, testAgent } from '../fixtures.js'

/**
 * The Phase 7 gate: two concurrent fake branches merge through gates; target
 * movement invalidates preparation; failing batches bisect; conflicts produce
 * rework; dirty worktrees remain; a convoy closes exactly once.
 */
const capabilities: Capability[] = ['workspace:read', 'work:mutate', 'work:dispatch', 'runtime:control', 'runtime:read', 'context:read', 'merge:execute']
const operator = testActor('operator', capabilities)
const agent = testAgent('worker-1', capabilities)

afterEach(() => resetFakeSessions())

describe('verified merge queue — the Phase 7 gate', () => {
  it('lands two concurrent branches through gates in one batch', async () => {
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

  it('invalidates preparation when the target moves, then lands against the new head', async () => {
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

  it('bisects a failing batch: the broken branch fails, the good ones still land', async () => {
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

  it('classifies conflicts, sends rework, and lands the rest', async () => {
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

  it('preserves a dirty integration worktree instead of force-deleting it', async () => {
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

  it('closes a convoy exactly once, dispatches the next unblocked item, and counts stranded work', async () => {
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
    const mergedMail = natural.mail.inbox(operator, { queue: 'supervisor' }).filter((message) => message.subject === 'MERGED')
    expect(mergedMail).toHaveLength(1)
    expect(natural.convoys.convoys(operator, ['closed'])).toHaveLength(1)
    natural.close()
  })

  it('serves the queue through the CLI', async () => {
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
    await expect(cli(['explode'])).rejects.toThrowError(/Unknown merge operation/)
    harness.close()
  })
})

/** Reads one file from the remote's main branch — what actually shipped. Line endings normalized: checkout noise, not content. */
function remoteFile(harness: ReturnType<typeof mergeQueueHarness>, file: string): string | undefined {
  const git = new GitRunner(harness.repoRoot)
  git.run(['fetch', '--quiet', harness.remote, 'main'])
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
