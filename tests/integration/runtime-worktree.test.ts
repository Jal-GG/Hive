import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Run, RunState, WorktreeRef } from '../../src/contracts.js'
import { HiveError } from '../../src/errors.js'
import { GitWorktreeManager, branchName, slug } from '../../src/runtime/worktree-manager.js'
import { GitRunner, gitIdentityArgs } from '../../src/shared/git.js'
import { gitRepository, tempDirectory, testClock } from '../fixtures.js'

function manager(options: { commit?: boolean } = {}): GitWorktreeManager {
  return new GitWorktreeManager({ repoRoot: gitRepository('worktree-repo', options), now: testClock().now })
}

function runRow(ref: WorktreeRef, state: RunState): Run {
  return {
    id: ref.runId,
    actorId: 'operator',
    scope: { workspaceId: 'w', projectId: 'p', workspaceName: 'main', projectName: 'hive' },
    runtimeProfile: 'fake',
    backend: 'fake',
    sessionKey: 'hive-session',
    cwd: ref.path,
    repoFingerprint: ref.repoFingerprint,
    worktreeFingerprint: ref.worktreeFingerprint,
    branch: ref.branch,
    state,
    leaseId: 'lease-1',
    startedAt: ref.createdAt,
    importedEventCount: 0,
    lostEventCount: 0,
  }
}

function codeOf(operation: () => unknown): string {
  try {
    operation()
    return 'no error'
  } catch (error) {
    return error instanceof HiveError ? error.code : `unexpected: ${String(error)}`
  }
}

/** Commits inside a worktree, which is how a run's work becomes unmerged commits. */
function commitInside(path: string, file: string, body: string): void {
  writeFileSync(join(path, file), body, 'utf8')
  const git = new GitRunner(path)
  git.run(['add', '--all'])
  git.run([...gitIdentityArgs, 'commit', '--quiet', '-m', `add ${file}`])
}

describe('branch naming', () => {
  it('carries workspace, project, work item, and run so two runs never share a branch', () => {
    const request = { runId: 'abcd1234efgh', workspaceName: 'Main Workspace', projectName: 'Hive', workItemId: 'ITEM-42' }
    expect(branchName(request)).toBe('hive/main-workspace/hive/item-42-abcd1234')
    expect(branchName({ ...request, runId: 'zzzz9999ffff' })).toBe('hive/main-workspace/hive/item-42-zzzz9999')
  })

  it('falls back to `run` when there is no work item', () => {
    expect(branchName({ runId: 'abcd1234', workspaceName: 'main', projectName: 'hive' })).toBe('hive/main/hive/run-abcd1234')
  })

  it('produces names git will accept from names it would not', () => {
    expect(slug('feature/../weird**name  ')).toBe('feature-weird-name')
    expect(slug('   ')).toBe('unnamed')
    expect(slug('refs.lock')).toBe('refs-lock')
    expect(slug('a'.repeat(200))).toHaveLength(60)
    // Every produced name is a legal ref component, checked by git itself.
    const git = new GitRunner(gitRepository('slug-check'))
    for (const value of ['feature/../weird**name', 'Item #7: fix ~this^', 'trailing---']) {
      expect(git.succeeds(['check-ref-format', `refs/heads/hive/${slug(value)}`])).toBe(true)
    }
  })
})

describe('GitWorktreeManager.create', () => {
  it('checks out an isolated worktree on a new branch from the base commit', () => {
    const worktrees = manager()
    const ref = worktrees.create({ runId: 'run-aaaa1111', workspaceName: 'main', projectName: 'hive', workItemId: 'item-1' })
    expect(ref.branch).toBe('hive/main/hive/item-1-runaaaa1')
    expect(existsSync(join(ref.path, 'README.md'))).toBe(true)
    expect(ref.path.startsWith(worktrees.worktreeRoot)).toBe(true)
    expect(ref.baseBranch).toBe('main')
    expect(ref.baseCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(worktrees.list().some((entry) => entry.branch === ref.branch)).toBe(true)
    // The run's branch is checked out there, not in the operator's own checkout.
    expect(new GitRunner(worktrees.repoRoot).run(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
  })

  it('keeps its worktrees out of the operator’s git status', () => {
    const worktrees = manager()
    worktrees.create({ runId: 'run-bbbb2222', workspaceName: 'main', projectName: 'hive' })
    const exclude = readFileSync(join(worktrees.repoRoot, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n')).toContain('/.hive/')
    expect(new GitRunner(worktrees.repoRoot).run(['status', '--porcelain'])).toBe('')

    // Adding a second worktree does not append the entry twice.
    worktrees.create({ runId: 'run-cccc3333', workspaceName: 'main', projectName: 'hive' })
    const after = readFileSync(join(worktrees.repoRoot, '.git', 'info', 'exclude'), 'utf8')
    expect(after.split('\n').filter((line) => line === '/.hive/')).toHaveLength(1)
  })

  it('fingerprints the repository by its root commit and each worktree distinctly', () => {
    const worktrees = manager()
    const first = worktrees.create({ runId: 'run-dddd4444', workspaceName: 'main', projectName: 'hive' })
    const second = worktrees.create({ runId: 'run-eeee5555', workspaceName: 'main', projectName: 'hive' })
    expect(first.repoFingerprint).toBe(second.repoFingerprint)
    expect(first.worktreeFingerprint).not.toBe(second.worktreeFingerprint)
    // A second manager over the same repository agrees, so a restart recognises its own runs.
    expect(new GitWorktreeManager({ repoRoot: worktrees.repoRoot }).repoFingerprint()).toBe(first.repoFingerprint)
    expect(manager().repoFingerprint()).not.toBe(first.repoFingerprint)
  })

  it('refuses to isolate a run where git cannot, instead of half-starting one', () => {
    expect(codeOf(() => manager({ commit: false }).create({ runId: 'run-1', workspaceName: 'main', projectName: 'hive' }))).toBe('REPO_HAS_NO_COMMITS')
    expect(codeOf(() => new GitWorktreeManager({ repoRoot: tempDirectory('not-a-repo') }).repoFingerprint())).toBe('NOT_A_REPOSITORY')

    const worktrees = manager()
    const ref = worktrees.create({ runId: 'run-ffff6666', workspaceName: 'main', projectName: 'hive', workItemId: 'item-9' })
    // Same run id and work item, so the same branch name: reusing another run's branch is never right.
    expect(codeOf(() => worktrees.create({ runId: 'run-ffff6666', workspaceName: 'main', projectName: 'hive', workItemId: 'item-9' }))).toBe('BRANCH_EXISTS')
    expect(existsSync(ref.path)).toBe(true)
  })
})

describe('worktree status', () => {
  it('reports clean, dirty, and ahead-of-base separately', () => {
    const worktrees = manager()
    const ref = worktrees.create({ runId: 'run-1111aaaa', workspaceName: 'main', projectName: 'hive' })
    expect(worktrees.status(ref)).toMatchObject({ clean: true, dirtyFiles: [], aheadOfBase: 0, exists: true })

    writeFileSync(join(ref.path, 'scratch.txt'), 'work in progress', 'utf8')
    const dirty = worktrees.status(ref)
    expect(dirty.clean).toBe(false)
    expect(dirty.dirtyFiles).toContain('scratch.txt')
    expect(dirty.aheadOfBase).toBe(0)

    commitInside(ref.path, 'scratch.txt', 'work in progress')
    const committed = worktrees.status(ref)
    expect(committed.clean).toBe(true)
    expect(committed.aheadOfBase).toBe(1)
    expect(committed.headCommit).not.toBe(ref.baseCommit)
  })

  it('reports a deleted directory as gone rather than throwing', () => {
    const worktrees = manager()
    const ref = worktrees.create({ runId: 'run-2222bbbb', workspaceName: 'main', projectName: 'hive' })
    worktrees.remove({ ref })
    expect(worktrees.status(ref)).toMatchObject({ exists: false, clean: true, aheadOfBase: 0 })
  })
})

describe('cleanup gates', () => {
  it('blocks on an active run and names the state', () => {
    const worktrees = manager()
    const ref = worktrees.create({ runId: 'run-3333cccc', workspaceName: 'main', projectName: 'hive' })
    expect(worktrees.cleanupDecision({ ref, run: runRow(ref, 'running') }).blockedBy).toEqual(['run_active:running'])
    expect(worktrees.cleanupDecision({ ref, run: runRow(ref, 'idle') }).blockedBy).toEqual(['run_active:idle'])
    expect(worktrees.cleanupDecision({ ref, run: runRow(ref, 'done') }).allowed).toBe(true)
    expect(worktrees.cleanupDecision({ ref, run: runRow(ref, 'zombie') }).allowed).toBe(true)
  })

  it('blocks on uncommitted work and on unmerged commits, counting each', () => {
    const worktrees = manager()
    const ref = worktrees.create({ runId: 'run-4444dddd', workspaceName: 'main', projectName: 'hive' })
    writeFileSync(join(ref.path, 'a.txt'), 'one', 'utf8')
    writeFileSync(join(ref.path, 'b.txt'), 'two', 'utf8')
    expect(worktrees.cleanupDecision({ ref }).blockedBy).toEqual(['uncommitted_changes:2'])

    commitInside(ref.path, 'a.txt', 'one')
    // b.txt was committed alongside a.txt, so the only gate left is the commit itself.
    expect(worktrees.cleanupDecision({ ref }).blockedBy).toEqual(['unmerged_commits:1'])
  })

  it('reports every gate at once, so an operator is told the whole story', () => {
    const worktrees = manager()
    const ref = worktrees.create({ runId: 'run-5555eeee', workspaceName: 'main', projectName: 'hive' })
    commitInside(ref.path, 'a.txt', 'one')
    writeFileSync(join(ref.path, 'b.txt'), 'two', 'utf8')
    const decision = worktrees.cleanupDecision({ ref, run: runRow(ref, 'running') })
    expect(decision.blockedBy).toEqual(['run_active:running', 'uncommitted_changes:1', 'unmerged_commits:1'])
    expect(decision.allowed).toBe(false)
    expect(decision.runId).toBe('run-5555eeee')
  })

  it('throws only where a retained worktree is a hard error', () => {
    const worktrees = manager()
    const ref = worktrees.create({ runId: 'run-6666ffff', workspaceName: 'main', projectName: 'hive' })
    writeFileSync(join(ref.path, 'a.txt'), 'one', 'utf8')
    expect(codeOf(() => worktrees.assertRemovable({ ref }))).toBe('WORKTREE_RETAINED')
    expect(() => worktrees.assertRemovable({ ref })).toThrowError(/uncommitted_changes:1/)
  })
})

describe('worktree removal', () => {
  it('deletes a clean worktree and its now-empty branch', () => {
    const worktrees = manager()
    const ref = worktrees.create({ runId: 'run-7777aaaa', workspaceName: 'main', projectName: 'hive' })
    const decision = worktrees.remove({ ref, run: runRow(ref, 'done') })
    expect(decision.allowed).toBe(true)
    expect(decision.blockedBy).toEqual([])
    expect(existsSync(ref.path)).toBe(false)
    const git = new GitRunner(worktrees.repoRoot)
    expect(git.succeeds(['show-ref', '--verify', '--quiet', `refs/heads/${ref.branch}`])).toBe(false)
    expect(worktrees.list().some((entry) => entry.path === ref.path)).toBe(false)
  })

  it('leaves a blocked worktree exactly where it is', () => {
    const worktrees = manager()
    const ref = worktrees.create({ runId: 'run-8888bbbb', workspaceName: 'main', projectName: 'hive' })
    writeFileSync(join(ref.path, 'unsaved.txt'), 'agent work', 'utf8')
    const decision = worktrees.remove({ ref, run: runRow(ref, 'running') })
    expect(decision.allowed).toBe(false)
    expect(decision.blockedBy).toEqual(['run_active:running', 'uncommitted_changes:1'])
    expect(readFileSync(join(ref.path, 'unsaved.txt'), 'utf8')).toBe('agent work')
  })

  it('force removes the directory but never the branch, so commits stay reachable', () => {
    const worktrees = manager()
    const ref = worktrees.create({ runId: 'run-9999cccc', workspaceName: 'main', projectName: 'hive' })
    commitInside(ref.path, 'work.txt', 'agent work')
    const head = worktrees.status(ref).headCommit

    const decision = worktrees.remove({ ref, run: runRow(ref, 'running'), force: true })
    expect(existsSync(ref.path)).toBe(false)
    // The reasons are kept on a forced removal: the record has to say what was overridden.
    expect(decision.blockedBy).toEqual(['run_active:running', 'unmerged_commits:1'])
    const git = new GitRunner(worktrees.repoRoot)
    expect(git.succeeds(['show-ref', '--verify', '--quiet', `refs/heads/${ref.branch}`])).toBe(true)
    expect(git.run(['rev-parse', ref.branch])).toBe(head)
  })

  it('is idempotent, so a second reconciliation pass is harmless', () => {
    const worktrees = manager()
    const ref = worktrees.create({ runId: 'run-0000dddd', workspaceName: 'main', projectName: 'hive' })
    expect(worktrees.remove({ ref }).allowed).toBe(true)
    expect(worktrees.remove({ ref }).allowed).toBe(true)
    expect(existsSync(ref.path)).toBe(false)
  })

  it('clears a registration whose directory was deleted behind git’s back', () => {
    const worktrees = manager()
    const ref = worktrees.create({ runId: 'run-1234eeee', workspaceName: 'main', projectName: 'hive' })
    rmSync(ref.path, { recursive: true, force: true })
    expect(worktrees.list().some((entry) => entry.path === ref.path && entry.prunable)).toBe(true)
    worktrees.prune()
    expect(worktrees.list().some((entry) => entry.path === ref.path)).toBe(false)
  })
})
