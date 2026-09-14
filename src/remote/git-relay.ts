import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitRunner } from '../git.js'
import { branchAllowed } from './protocol.js'

/**
 * The remote Git smart relay (§7 Phase 9): certificate-to-branch authorization
 * over bundle transfers, and no generic shell or `git-upload-pack` endpoint.
 *
 * The relay never executes `git push` against a shared remote on the client's
 * behalf and never runs arbitrary commands. Instead, the client produces a Git
 * *bundle* locally; the relay validates it (parse, branch naming, compare-and-
 * swap on the expected head), and only then fast-forwards or creates the
 * permitted ref in the target repository. Authorization is the policy's branch
 * allowlist, checked before anything touches the target — the same
 * exact-or-prefix semantics as the merge queue's protected branches.
 */

export interface RelayOptions {
  /** The bare repository the relay lands refs into. */
  repositoryRoot: string
  /** Branches this relay may write: exact names or `prefix*` patterns. Empty refuses everything. */
  allowedBranches: readonly string[]
  /** Largest bundle the relay will accept, bytes. Larger inputs are refused before touching disk. */
  maxBundleBytes?: number
}

export interface PushBundleRequest {
  /** The branch the bundle's HEAD update targets. */
  branch: string
  /** The head the client believes the branch is at; `undefined` to create the branch. */
  expectedHead?: string
  /** The bundle bytes, produced by `git bundle create`. */
  bundle: Buffer
}

export interface PushBundleResult {
  branch: string
  head: string
  created: boolean
}

export class GitSmartRelay {
  private readonly repo: GitRunner
  private readonly maxBundleBytes: number

  constructor(private readonly options: RelayOptions) {
    this.repo = new GitRunner(options.repositoryRoot)
    this.maxBundleBytes = options.maxBundleBytes ?? 64 * 1024 * 1024
    // A bare repository has no `.git` marker — `isRepository()` is false for
    // exactly the layout this relay requires, so the check is `rev-parse`.
    if (this.repo.tryRun(['rev-parse', '--is-bare-repository']) !== 'true') {
      throw new Error(`Not a bare git repository: ${options.repositoryRoot}`)
    }
  }

  /** Branch authorization is checked first, before any bundle parsing or writes. */
  authorizePush(branch: string): { ok: true } | { ok: false; reason: string } {
    if (!branchAllowed(branch, this.options.allowedBranches)) {
      return { ok: false, reason: `branch ${branch} is not in this relay's allowlist` }
    }
    return { ok: true }
  }

  /**
   * Lands one bundle with compare-and-swap. The target ref moves only if it is
   * at `expectedHead` (or does not exist when the client said it would create);
   * otherwise the push is refused as stale rather than merged over.
   */
  async push(request: PushBundleRequest): Promise<PushBundleResult> {
    const authorized = this.authorizePush(request.branch)
    if (!authorized.ok) throw new Error(authorized.reason)
    if (request.bundle.length > this.maxBundleBytes) {
      throw new Error(`bundle of ${request.bundle.length} bytes exceeds this relay's ${this.maxBundleBytes} byte limit`)
    }

    const scratch = mkdtempSync(join(tmpdir(), 'hive-relay-'))
    try {
      const bundlePath = join(scratch, 'push.bundle')
      writeFileSync(bundlePath, request.bundle)

      // A bundle that does not parse is rejected before the repository is touched.
      this.verifyBundleHead(bundlePath, request.branch)

      const currentHead = this.repo.tryRun(['rev-parse', '--verify', `refs/heads/${request.branch}`])
      if (request.expectedHead === undefined) {
        if (currentHead !== undefined) throw new Error(`branch ${request.branch} already exists; expected-head is required to update it`)
      } else {
        if (currentHead === undefined) throw new Error(`branch ${request.branch} does not exist; push as a create instead`)
        if (currentHead !== request.expectedHead) throw new Error(`branch ${request.branch} moved: expected ${request.expectedHead}, found ${currentHead}`)
      }

      // Fetch from the bundle into a namespaced ref, then move the real ref with
      // a ref-level CAS (`update-ref <ref> <new> <old>`): the old-value form
      // fails if anything moved the branch between the check above and here,
      // so the compare-and-swap is atomic, not merely checked.
      this.repo.run(['fetch', '--quiet', bundlePath, `refs/heads/${request.branch}:refs/hive-relay/incoming`])
      const incoming = this.repo.run(['rev-parse', 'refs/hive-relay/incoming'])
      const absent = '0000000000000000000000000000000000000000'
      this.repo.run(request.expectedHead === undefined
        ? ['update-ref', `refs/heads/${request.branch}`, incoming, absent]
        : ['update-ref', `refs/heads/${request.branch}`, incoming, request.expectedHead])
      this.repo.run(['update-ref', '-d', 'refs/hive-relay/incoming'])
      return { branch: request.branch, head: incoming, created: request.expectedHead === undefined }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  /**
   * Produces a fetch bundle for the client: everything reachable from a branch
   * head, the mirror image of push. Read-only by construction.
   */
  async fetch(branch: string): Promise<{ bundle: Buffer; head: string }> {
    const head = this.repo.tryRun(['rev-parse', '--verify', `refs/heads/${branch}`])
    if (head === undefined) throw new Error(`no such branch: ${branch}`)
    const scratch = mkdtempSync(join(tmpdir(), 'hive-relay-'))
    try {
      const bundlePath = join(scratch, 'fetch.bundle')
      this.repo.run(['bundle', 'create', bundlePath, `refs/heads/${branch}`])
      return { bundle: readFileSync(bundlePath), head }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  /** The head of a branch, for a client preparing its compare-and-swap push. */
  headOf(branch: string): string | undefined {
    return this.repo.tryRun(['rev-parse', '--verify', `refs/heads/${branch}`])
  }

  /**
   * Verifies the bundle is well-formed, names the claimed branch as its ref,
   * and — the load-bearing check — that its prerequisites are satisfied by the
   * target repository as it stands, so the CAS promise in `push` is enforced by
   * the bundle's own history rather than only by the client's claim.
   */
  private verifyBundleHead(bundlePath: string, branch: string): void {
    const listing = execFileSync('git', ['bundle', 'list-heads', bundlePath], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    const refs = listing.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
    const carried = refs.map((ref) => ref.split(' ').slice(1).join(' '))
    if (!carried.includes(`refs/heads/${branch}`)) {
      throw new Error(`bundle does not carry refs/heads/${branch} (carries: ${carried.join(', ') || 'nothing'})`)
    }
    // `git bundle verify` exits non-zero when prerequisites are missing in this
    // repository, which is exactly the stale-head case the CAS check needs.
    try {
      execFileSync('git', ['bundle', 'verify', '--quiet', bundlePath], {
        cwd: this.options.repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 8 * 1024 * 1024,
      })
    } catch {
      throw new Error('bundle prerequisites are not satisfied by the target repository (branch moved or unknown base)')
    }
  }
}

/** Client-side helper: create a bundle for one branch update, suitable for `relay.push`. */
export function createBundleFor(repoRoot: string, branch: string, expectedHead: string | undefined, range: string): Buffer {
  const scratch = mkdtempSync(join(tmpdir(), 'hive-bundle-'))
  try {
    const bundlePath = join(scratch, 'out.bundle')
    const args = expectedHead === undefined
      ? ['bundle', 'create', bundlePath, branch]
      : ['bundle', 'create', bundlePath, `${expectedHead}..${branch}`]
    new GitRunner(repoRoot).run(args)
    return readFileSync(bundlePath)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Ensures the directories a relay's bare repository lives in exist. */
export function ensureBareRepository(path: string, branch = 'main'): GitRunner {
  mkdirSync(path, { recursive: true })
  const repo = new GitRunner(path)
  if (repo.tryRun(['rev-parse', '--is-bare-repository']) !== 'true') repo.run(['init', '--bare', '--quiet', `--initial-branch=${branch}`])
  return repo
}
