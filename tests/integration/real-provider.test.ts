import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ActorContext } from '../../src/contracts.js'
import { ProviderCatalog } from '../../src/runtime/provider-catalog.js'
import { NodePtyRuntimeAdapter } from '../../src/runtime/node-pty-backend.js'
import { RunManager } from '../../src/runtime/run-manager.js'
import { RuntimeRegistry } from '../../src/runtime/runtime-registry.js'
import { GitWorktreeManager } from '../../src/runtime/worktree-manager.js'
import { Ledger } from '../../src/ledger.js'
import { testActor, gitRepository, tempDirectory } from '../fixtures.js'
import { join } from 'node:path'

/**
 * The Phase 3 gate's real-provider check: one actual agent CLI, launched through
 * node-pty in an isolated worktree, streaming, resizing, and stopping safely.
 *
 * Opt-in because it needs the provider installed and spends real process
 * startup time (and, if the CLI chooses to, network):
 *
 *   HIVE_REAL_PROVIDER=claude npx vitest run tests/integration/real-provider.test.ts
 *
 * Any profile id from the catalog works; `claude` and `codex` are native
 * executables on Windows, which ConPTY spawns most directly.
 */
const provider = process.env.HIVE_REAL_PROVIDER
const describeReal = provider ? describe : describe.skip

const operator: ActorContext = testActor('real-op', ['runtime:control', 'runtime:read', 'work:dispatch'])

describeReal(`real provider: ${provider ?? '(unset)'}`, () => {
  it('launches, streams, resizes, and stops the real CLI', { timeout: 60_000 }, async () => {
    const repoRoot = gitRepository('real-provider-repo')
    const ledger = new Ledger(join(tempDirectory('real-provider-ledger'), 'hive.db'))
    ledger.createActor(operator)
    const workspaceId = ledger.createWorkspace('main')
    ledger.createProject(workspaceId, 'hive')
    const catalog = new ProviderCatalog()
    const profile = catalog.get(provider!)

    const registry = new RuntimeRegistry([new NodePtyRuntimeAdapter({})])
    const worktrees = new GitWorktreeManager({ repoRoot })
    // The operator's real environment, deliberately: this test is about the real
    // PATH, the real credentials, and the real CLI on this machine.
    const manager = new RunManager({ ledger, registry, catalog, worktrees, host: process.env })

    const run = await manager.launch(operator, { profileId: provider!, workspace: 'main', project: 'hive' })
    expect(run.state).toBe('running')
    expect(existsSync(join(run.cwd, '.git'))).toBe(true)

    // A real CLI under a real PTY writes something — a banner, a welcome, an
    // auth complaint; which one depends on the machine, so the assertion is
    // "output arrived", not "a specific line arrived".
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if ((manager.scrollback(run.id) ?? '').length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    expect((manager.scrollback(run.id) ?? '').length).toBeGreaterThan(0)

    manager.resize(operator, run.id, 100, 40)
    const status = manager.status(run.id)
    expect(status?.cols).toBe(100)
    expect(status?.rows).toBe(40)

    const stopped = await manager.stop(operator, { runId: run.id })
    expect(stopped.run.state).toBe('done')
    // The child's own report: a signal when killed, or a code if it exited
    // first; either is the truth, and both are recorded.
    expect(stopped.exit.signal !== undefined || stopped.exit.code !== undefined).toBe(true)
    expect(manager.liveRunIds()).toEqual([])
    ledger.close()
  })
})
