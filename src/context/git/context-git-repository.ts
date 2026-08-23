import { ContextPackMetadata, ContextVersionRef } from '../../contracts.js'
import { HiveError } from '../../errors.js'
import { GitRunner, gitIdentityArgs } from '../../shared/git.js'

const IDENTITY = [...gitIdentityArgs]
/** Neither the hash nor the ISO committer date contains a space, so the subject is everything after the second one. */
const LOG_FORMAT = '--format=%H %cI %s'
const NOTHING_TO_COMMIT = /nothing to commit|no changes added|nothing added to commit/
const UNMATCHED_PATHSPEC = /did not match any files/

/**
 * The Git side of the canonical context root: checkpoints, version history, and
 * content snapshots (C22 — content snapshots are never code commits). Paths
 * handed in are already repo-relative and POSIX-separated; see
 * `ContextFileStore.relativePath`. Initialization is lazy, so read-only
 * consumers never pay for it.
 */
export class ContextGitRepository {
  private readonly git: GitRunner
  private initialized = false

  constructor(private readonly root: string) {
    this.git = new GitRunner(root)
  }

  /** Stages the given paths and commits them. Returns the new commit, or undefined when nothing changed. */
  commit(relativePaths: string[], message: string): string | undefined {
    this.ensureRepository()
    // One `add` per path: git stages nothing at all when any pathspec in a single
    // invocation is unmatched, which would silently drop the others with it.
    for (const relativePath of relativePaths) {
      try {
        this.run(['add', '--all', '--', relativePath])
      } catch (error) {
        // A path in neither the worktree nor the index leaves nothing to stage.
        if (!UNMATCHED_PATHSPEC.test(String(error))) throw error
      }
    }
    try {
      this.run([...IDENTITY, 'commit', '--quiet', '-m', message])
    } catch (error) {
      if (NOTHING_TO_COMMIT.test(String(error))) return undefined
      throw error
    }
    return this.head()
  }

  head(): string | undefined {
    this.ensureRepository()
    return this.tryRun(['rev-parse', 'HEAD'])
  }

  /** Content of `relativePath` as of `revision`; undefined when it did not exist there. */
  show(revision: string, relativePath: string): string | undefined {
    this.ensureRepository()
    return this.tryRun(['show', `${revision}:${relativePath}`], { trim: false })
  }

  /** Commits that touched the path, newest first. */
  history(relativePath: string, limit = 20): ContextVersionRef[] {
    this.ensureRepository()
    const output = this.tryRun(['log', `--max-count=${limit}`, LOG_FORMAT, '--', relativePath])
    if (!output) return []
    return output.split('\n').map((line) => {
      const [commit, committedAt, ...subject] = line.split(' ')
      return { commit, committedAt, message: subject.join(' ') }
    })
  }

  /** The most recent commit that touched the path — for a deleted file, its removal. */
  lastCommitFor(relativePath: string): string | undefined {
    return this.history(relativePath, 1)[0]?.commit
  }

  tag(ref: string, commit: string, message: string): void {
    this.ensureRepository()
    if (this.run(['tag', '--list', ref]).length > 0) throw new HiveError('SNAPSHOT_EXISTS', `Snapshot ${ref} already exists`)
    this.run([...IDENTITY, 'tag', '--annotate', '--message', message, ref, commit])
  }

  tags(prefix: string): string[] {
    this.ensureRepository()
    const output = this.tryRun(['tag', '--list', `${prefix}*`])
    return output ? output.split('\n').sort() : []
  }

  tagMessage(ref: string): string | undefined {
    this.ensureRepository()
    return this.tryRun(['for-each-ref', '--format=%(contents)', `refs/tags/${ref}`])
  }

  packMetadata(): ContextPackMetadata {
    this.ensureRepository()
    const fields = new Map<string, number>()
    for (const line of this.run(['count-objects', '-v']).split('\n')) {
      const [key, value] = line.split(': ')
      if (key && value !== undefined) fields.set(key.trim(), Number(value))
    }
    return {
      looseObjects: fields.get('count') ?? 0,
      looseSizeKib: fields.get('size') ?? 0,
      packedObjects: fields.get('in-pack') ?? 0,
      packCount: fields.get('packs') ?? 0,
      packSizeKib: fields.get('size-pack') ?? 0,
    }
  }

  private ensureRepository(): void {
    if (this.initialized) return
    if (!this.git.isRepository()) this.git.init()
    this.initialized = true
  }

  private tryRun(argv: string[], options?: { trim: boolean }): string | undefined {
    return this.git.tryRun(argv, options)
  }

  private run(argv: string[], options: { trim: boolean } = { trim: true }): string {
    return this.git.run(argv, options)
  }
}
