import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ResultEnvelope } from '../../src/contracts.js'
import { resetFakeSessions } from '../../src/runtime/fake-backend.js'
import { fakeProfileId } from '../../src/runtime/provider-catalog.js'
import { testActor, runtimeHarness, type RuntimeHarness } from '../fixtures.js'

const operator = testActor('op', ['runtime:control', 'runtime:read', 'work:dispatch'])
const viewer = testActor('view', ['runtime:read'], 'viewer')

// The fake session store is the stand-in for a tmux server: it outlives a manager.
// Every test starts from an empty one so adoption state cannot leak between tests.
afterEach(() => resetFakeSessions())

function launch(harness: RuntimeHarness) {
  return harness.manager.launch(operator, {
    profileId: fakeProfileId,
    workspace: 'main',
    project: 'hive',
  })
}

describe('run lifecycle', () => {
  it('launches a run in its own worktree, ready and streaming', async () => {
    const harness = runtimeHarness([operator, viewer])
    const run = await launch(harness)

    expect(run.state).toBe('running')
    expect(run.backend).toBe('fake')
    expect(harness.manager.liveRunIds()).toEqual([run.id])
    expect(harness.worktrees.list().some((entry) => entry.path === run.cwd)).toBe(true)

    // The banner the fake adapter prints on spawn is the scrollback a late
    // subscriber replays, so a terminal attached mid-run sees the session.
    const scrollback = harness.manager.scrollback(run.id)
    expect(scrollback).toContain('HIVE_FAKE_READY')
  })

  it('streams output to a late subscriber and honors writes', async () => {
    const harness = runtimeHarness([operator, viewer])
    const run = await launch(harness)

    const chunks: string[] = []
    const unsubscribe = harness.manager.subscribe(viewer, run.id, (chunk) => chunks.push(chunk))
    harness.manager.write(operator, run.id, 'hello\n')
    unsubscribe()

    const replayed = chunks.join('')
    expect(replayed).toContain('echo: hello')
    // Re-subscribing replays the retained scrollback rather than only new output.
    const again: string[] = []
    const unsubscribe2 = harness.manager.subscribe(viewer, run.id, (chunk) => again.push(chunk))
    unsubscribe2()
    expect(again.join('')).toContain('echo: hello')
  })

  it('resizes a run and records the size change', async () => {
    const harness = runtimeHarness([operator, viewer])
    const run = await launch(harness)

    harness.manager.resize(operator, run.id, 100, 40)
    const status = ok(harness.browser.browse(viewer, { version: 1, operation: 'status', runId: run.id })) as { cols: number; rows: number }
    expect(status.cols).toBe(100)
    expect(status.rows).toBe(40)
  })

  it('stops a run with the child’s own exit status', async () => {
    const harness = runtimeHarness([operator, viewer])
    const run = await launch(harness)

    const result = await harness.manager.stop(operator, { runId: run.id })
    expect(result.run.state).toBe('done')
    expect(result.exit.signal).toBe('SIGTERM')
    expect(harness.manager.get(run.id)?.exitSignal).toBe('SIGTERM')
    expect(harness.manager.liveRunIds()).toEqual([])
  })

  it('records events a desktop view can follow by cursor', async () => {
    const harness = runtimeHarness([operator, viewer])
    const run = await launch(harness)
    harness.manager.write(operator, run.id, 'hello\n')
    await harness.manager.stop(operator, { runId: run.id })

    const first = ok(harness.browser.browse(viewer, { version: 1, operation: 'events', afterSequence: 0, limit: 200 })) as { events: { sequence: number; idempotencyKey: string }[]; cursor: number }
    expect(first.events.length).toBeGreaterThan(0)
    const keys = first.events.map((event) => event.idempotencyKey)
    // Launch through exit, in order, is the minimum a roster rebuild needs.
    expect(keys.some((key) => key.startsWith('runtime:launch:'))).toBe(true)
    expect(keys.some((key) => key.startsWith('runtime:ready:'))).toBe(true)
    expect(keys.some((key) => key.startsWith('runtime:exit:'))).toBe(true)

    // A second read from the cursor returns nothing new: the cursor is a resume
    // point, so a restarted window catches up instead of re-reading.
    const second = ok(harness.browser.browse(viewer, { version: 1, operation: 'events', afterSequence: first.cursor, limit: 200 })) as { events: unknown[] }
    expect(second.events).toEqual([])
  })

  it('cleans the worktree only when the gates allow it', async () => {
    const harness = runtimeHarness([operator, viewer])
    const run = await launch(harness)
    await harness.manager.stop(operator, { runId: run.id, cleanup: true })

    expect(harness.manager.get(run.id)?.state).toBe('done')
    expect(harness.worktrees.list().some((entry) => entry.path === run.cwd)).toBe(false)
  })
})

describe('restart recovery', () => {
  it('re-adopts a persistent session after a restart', async () => {
    const first = runtimeHarness([operator], { persistent: true })
    const run = await launch(first)
    const ledgerFile = first.ledgerFile

    // A "restart": the manager, adapters, and ledger connection all go away.
    first.close()

    const second = runtimeHarness([operator], { persistent: true, repoRoot: first.repoRoot, ledgerFile })
    expect(second.manager.liveRunIds()).toEqual([])

    const report = await second.manager.reconcile(operator)
    expect(report.scanned).toBe(1)
    expect(report.readopted).toBe(1)
    expect(report.zombies).toBe(0)
    expect(second.manager.liveRunIds()).toEqual([run.id])
    expect(second.manager.get(run.id)?.state).toBe('running')

    // The re-adopted session is interactive: the work continues, not just the row.
    second.manager.write(operator, run.id, 'still here\n')
    expect(second.manager.scrollback(run.id)).toContain('echo: still here')
    second.close()
  })

  it('marks a non-persistent orphan a zombie and retains its dirty worktree', async () => {
    const first = runtimeHarness([operator])
    const run = await launch(first)
    // Uncommitted agent work: the one thing a restart must never discard.
    writeFileSync(join(run.cwd, 'wip.txt'), 'agent work in flight', 'utf8')
    const ledgerFile = first.ledgerFile
    first.close()

    const second = runtimeHarness([operator], { repoRoot: first.repoRoot, ledgerFile })
    const report = await second.manager.reconcile(operator)

    expect(report.scanned).toBe(1)
    expect(report.readopted).toBe(0)
    expect(report.zombies).toBe(1)
    // The dirty directory is preserved with its reasons, not deleted sight unseen.
    expect(report.retainedWorktrees.length).toBe(1)
    expect(report.retainedWorktrees[0].blockedBy).toContain('uncommitted_changes:1')
    expect(second.manager.get(run.id)?.state).toBe('zombie')
    expect(second.ledger.worktree(run.id)).toBeDefined()
    expect(existsSync(join(run.cwd, 'wip.txt'))).toBe(true)
    expect(readFileSync(join(run.cwd, 'wip.txt'), 'utf8')).toBe('agent work in flight')
    second.close()
  })

  it('removes a clean zombie worktree during reconciliation', async () => {
    const first = runtimeHarness([operator])
    const run = await launch(first)
    const ledgerFile = first.ledgerFile
    first.close()

    const second = runtimeHarness([operator], { repoRoot: first.repoRoot, ledgerFile })
    const report = await second.manager.reconcile(operator)

    expect(report.zombies).toBe(1)
    expect(report.retainedWorktrees).toEqual([])
    // A terminal run over a clean worktree is exactly what the gates allow.
    expect(second.ledger.worktree(run.id)).toBeUndefined()
    expect(second.worktrees.list().some((entry) => entry.path === run.cwd)).toBe(false)
    second.close()
  })
})

function ok<T>(result: ResultEnvelope<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`)
  return result.data
}
