import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Run, WorktreeCleanupDecision, WorktreeRef, WorktreeStatus, terminalRunStates } from '../contracts.js'
import { HiveError } from '../errors.js'
import { Clock, ClockOptions, resolveClock } from '../shared.js'
import { GitRunner } from '../shared/git.js'

/** Local-only ignore entry, so Hive's worktrees never appear as untracked noise in the operator's `git status`. */
const excludeEntry = '/.hive/'

export interface GitWorktreeOptions extends ClockOptions {
  repoRoot: string
  /** Defaults to `<repoRoot>/.hive/worktrees`, kept out of the operator's status by a local exclude. */
  worktreeRoot?: string
}

export interface CreateWorktreeRequest {
  runId: string
  workspaceName: string
  projectName: string
  workItemId?: string
  /** Defaults to whatever the repository currently has checked out. */
  baseBranch?: string
  branch?: string
}

export interface WorktreeListEntry {
  path: string
  branch?: string
  headCommit?: string
  /** True for a registered worktree whose directory is gone, which `prune` exists to clear. */
  prunable: boolean
}

export interface CleanupGateInput {
  ref: WorktreeRef
  run?: Run
  force?: boolean
}

/**
 * Git isolation for a run (C7): every agent works in its own worktree on its own
 * branch, so two runs cannot fight over an index and a bad run is thrown away by
 * deleting a directory.
 *
 * The gates matter more than the creation. An agent's uncommitted work is
 * unrecoverable once its worktree is gone, so cleanup answers with reasons rather
 * than a boolean, and even a forced cleanup leaves the branch ref alone — the
 * commits stay reachable, and losing work always takes a second, explicit act.
 */
export class GitWorktreeManager {
  readonly repoRoot: string
  readonly worktreeRoot: string
  private readonly git: GitRunner
  private readonly now: Clock
  private cachedRepoFingerprint?: string

  constructor(options: GitWorktreeOptions) {
    this.repoRoot = options.repoRoot
    this.worktreeRoot = options.worktreeRoot ?? join(options.repoRoot, '.hive', 'worktrees')
    this.git = new GitRunner(options.repoRoot)
    this.now = resolveClock(options)
  }

  /**
   * Identity of the repository itself, taken from its root commit so two clones of
   * the same project agree and a moved checkout does not look like a new one.
   */
  repoFingerprint(): string {
    if (this.cachedRepoFingerprint) return this.cachedRepoFingerprint
    this.assertRepository()
    const roots = this.git.tryRun(['rev-list', '--max-parents=0', 'HEAD'])
    const lines = roots ? roots.split('\n').filter((line) => line.length > 0) : []
    // No commits yet: fall back to the path, which at least distinguishes two repositories on one machine.
    const seed = lines.length > 0 ? lines[lines.length - 1] : `path:${this.repoRoot}`
    this.cachedRepoFingerprint = fingerprint(seed)
    return this.cachedRepoFingerprint
  }

  currentBranch(): string {
    this.assertRepository()
    const branch = this.git.tryRun(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (!branch || branch === 'HEAD') {
      // Detached or unborn: the symbolic ref still names the branch a commit would land on.
      const symbolic = this.git.tryRun(['symbolic-ref', '--short', 'HEAD'])
      if (symbolic) return symbolic
      throw new HiveError('DETACHED_HEAD', 'The repository has no branch checked out to base a run on')
    }
    return branch
  }

  create(request: CreateWorktreeRequest): WorktreeRef {
    this.assertRepository()
    const baseBranch = request.baseBranch ?? this.currentBranch()
    const baseCommit = this.git.tryRun(['rev-parse', '--verify', `${baseBranch}^{commit}`])
    if (!baseCommit) {
      // `worktree add` cannot check out a branch that points at nothing, and creating
      // a commit here would mean writing to the operator's repository uninvited.
      throw new HiveError('REPO_HAS_NO_COMMITS', `Cannot isolate a run: ${baseBranch} has no commits yet`)
    }
    const branch = request.branch ?? branchName(request)
    if (this.git.succeeds(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
      throw new HiveError('BRANCH_EXISTS', `Branch ${branch} already exists; refusing to reuse another run's branch`)
    }
    const path = join(this.worktreeRoot, worktreeDirectoryName(request, branch))
    if (existsSync(path)) throw new HiveError('WORKTREE_EXISTS', `${path} already exists`)

    this.ensureExcluded()
    this.git.run(['worktree', 'add', '--quiet', '-b', branch, path, baseCommit])
    if (!existsSync(join(path, '.git'))) throw new HiveError('WORKTREE_FAILED', `git reported success but ${path} is not a worktree`)

    const repoFingerprint = this.repoFingerprint()
    return {
      runId: request.runId,
      path,
      branch,
      baseBranch,
      baseCommit,
      repoFingerprint,
      worktreeFingerprint: fingerprint(`${repoFingerprint}|${branch}|${path}`),
      createdAt: this.now().toISOString(),
    }
  }

  /** Every worktree git knows about, including ones whose directory has been deleted. */
  list(): WorktreeListEntry[] {
    this.assertRepository()
    const output = this.git.tryRun(['worktree', 'list', '--porcelain'])
    if (!output) return []
    const entries: WorktreeListEntry[] = []
    let current: WorktreeListEntry | undefined
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current) entries.push(current)
        current = { path: line.slice('worktree '.length).trim(), prunable: false }
        continue
      }
      if (!current) continue
      if (line.startsWith('HEAD ')) current.headCommit = line.slice('HEAD '.length).trim()
      if (line.startsWith('branch ')) current.branch = line.slice('branch refs/heads/'.length).trim()
      if (line.startsWith('prunable')) current.prunable = true
    }
    if (current) entries.push(current)
    return entries
  }

  status(ref: WorktreeRef): WorktreeStatus {
    const exists = existsSync(join(ref.path, '.git'))
    if (!exists) {
      return { path: ref.path, branch: ref.branch, dirtyFiles: [], clean: true, aheadOfBase: 0, exists: false }
    }
    const worktree = this.git.at(ref.path)
    const porcelain = worktree.tryRun(['status', '--porcelain', '--untracked-files=all'], { trim: false }) ?? ''
    const dirtyFiles = parsePorcelain(porcelain)
    const range = ref.baseCommit ? `${ref.baseCommit}..HEAD` : undefined
    const ahead = range ? worktree.tryRun(['rev-list', '--count', range]) : undefined
    return {
      path: ref.path,
      branch: ref.branch,
      headCommit: worktree.tryRun(['rev-parse', 'HEAD']),
      dirtyFiles,
      clean: dirtyFiles.length === 0,
      aheadOfBase: ahead ? Number.parseInt(ahead, 10) || 0 : 0,
      exists: true,
    }
  }

  /**
   * Answers "may this worktree be deleted now?" with every reason it may not.
   * Reasons rather than a boolean, because the caller has to tell an operator what
   * to do about it, and a reconciliation pass has to record what it left behind.
   */
  cleanupDecision(input: CleanupGateInput): WorktreeCleanupDecision {
    const status = this.status(input.ref)
    const blockedBy: string[] = []
    if (input.run && !terminalRunStates.includes(input.run.state)) blockedBy.push(`run_active:${input.run.state}`)
    if (status.exists && !status.clean) blockedBy.push(`uncommitted_changes:${status.dirtyFiles.length}`)
    if (status.exists && status.aheadOfBase > 0) blockedBy.push(`unmerged_commits:${status.aheadOfBase}`)
    return { runId: input.ref.runId, allowed: blockedBy.length === 0, blockedBy, status }
  }

  /**
   * Removes the worktree when the gates allow it, and reports the decision either
   * way rather than throwing: a blocked cleanup is a normal outcome that belongs in
   * a reconciliation report, not an exception.
   *
   * Forcing skips the gates but still keeps the branch. Deleting the ref as well
   * would make an agent's commits unreachable, which no cleanup should ever do as
   * a side effect.
   */
  remove(input: CleanupGateInput): WorktreeCleanupDecision {
    const decision = this.cleanupDecision(input)
    if (!decision.allowed && !input.force) return decision

    const exists = existsSync(input.ref.path)
    if (exists) {
      const argv = ['worktree', 'remove', input.ref.path]
      if (input.force || !decision.allowed) argv.splice(2, 0, '--force')
      if (this.git.tryRun(argv) === undefined) {
        // A locked or partially deleted worktree still has to go; the registry is fixed by prune.
        rmSync(input.ref.path, { recursive: true, force: true })
      }
    }
    this.git.tryRun(['worktree', 'prune'])

    // Only a branch with nothing of its own is deleted, so cleanup can never lose a commit.
    if (decision.status && decision.status.aheadOfBase === 0 && decision.allowed) {
      this.git.tryRun(['branch', '--delete', '--quiet', input.ref.branch])
    }
    return { ...decision, allowed: true, blockedBy: input.force ? decision.blockedBy : [] }
  }

  /** Throws instead of reporting, for callers where a retained worktree is a hard error. */
  assertRemovable(input: CleanupGateInput): WorktreeCleanupDecision {
    const decision = this.cleanupDecision(input)
    if (!decision.allowed) throw new HiveError('WORKTREE_RETAINED', `Worktree for run ${decision.runId} cannot be removed: ${decision.blockedBy.join(', ')}`)
    return decision
  }

  prune(): void {
    this.git.tryRun(['worktree', 'prune'])
  }

  private ensureExcluded(): void {
    const excludeFile = join(this.repoRoot, '.git', 'info', 'exclude')
    if (!existsSync(excludeFile)) return
    const current = readFileSync(excludeFile, 'utf8')
    if (current.split('\n').some((line) => line.trim() === excludeEntry)) return
    // `.git/info/exclude` is machine-local: nothing tracked in the operator's repository changes.
    writeFileSync(excludeFile, `${current.endsWith('\n') || current.length === 0 ? current : `${current}\n`}${excludeEntry}\n`)
  }

  private assertRepository(): void {
    if (!this.git.isRepository()) throw new HiveError('NOT_A_REPOSITORY', `${this.repoRoot} is not a git repository`)
  }
}

/**
 * Branch names carry their origin: `hive/<workspace>/<project>/<item>-<run>`.
 *
 * The run id suffix is what makes it safe — two runs on the same work item get
 * distinct branches instead of one silently checking out the other's work — and the
 * `hive/` prefix makes every branch a run created identifiable in one glob when it
 * comes time to clean up.
 */
export function branchName(request: CreateWorktreeRequest): string {
  const subject = slug(request.workItemId ?? 'run')
  return ['hive', slug(request.workspaceName), slug(request.projectName), `${subject}-${shortId(request.runId)}`].join('/')
}

function worktreeDirectoryName(request: CreateWorktreeRequest, branch: string): string {
  return `${slug(branch.replace(/^hive\//, '').replace(/\//g, '-'))}-${shortId(request.runId)}`
}

/**
 * Reduces a name to what git accepts in a ref and a filesystem accepts in a path:
 * lowercase, no runs of separators, no leading or trailing dash, and none of
 * `~^:?*[\` or `..` that `git check-ref-format` rejects.
 */
export function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.\.+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    // `.lock` is reserved by git for its own ref files.
    .replace(/\.lock$/, '-lock')
  return cleaned.length > 0 ? cleaned.slice(0, 60) : 'unnamed'
}

function shortId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase() || 'run'
}

function fingerprint(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 16)
}

/** `status --porcelain` prefixes two status columns and a space; renames read `old -> new`. */
function parsePorcelain(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 3)
    .map((line) => {
      const path = line.slice(3)
      const rename = path.split(' -> ')
      return (rename[1] ?? rename[0]).replace(/^"|"$/g, '')
    })
}
