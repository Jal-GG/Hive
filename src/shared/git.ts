import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { HiveError } from '../errors.js'

/**
 * Commits Hive makes are attributed to Hive, never to whoever's shell happens to
 * be running. Passed per invocation rather than written into config, so nothing in
 * the operator's own repository is modified.
 */
export const gitIdentityArgs: readonly string[] = ['-c', 'user.name=Hive', '-c', 'user.email=hive@localhost']

export interface GitRunOptions {
  trim?: boolean
}

/**
 * One place that shells out to git.
 *
 * Both the context store and the worktree manager need the same three things —
 * a bounded buffer, stdin closed so git can never wait on a prompt, and failures
 * that arrive as `HiveError` with git's own stderr attached. Building that twice
 * is how the two drift into disagreeing about what a failure looks like.
 */
export class GitRunner {
  constructor(readonly cwd: string) {}

  run(argv: readonly string[], options: GitRunOptions = {}): string {
    const trim = options.trim ?? true
    try {
      const output = execFileSync('git', [...argv], {
        cwd: this.cwd,
        encoding: 'utf8',
        // stdin closed: git must fail rather than block forever on a credential or editor prompt.
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      })
      return trim ? output.trim() : output
    } catch (error) {
      const detail = error as { stdout?: string; stderr?: string }
      const reason = `${detail.stderr ?? ''}${detail.stdout ?? ''}`.trim() || String(error)
      throw new HiveError('GIT_FAILED', `git ${argv.filter((argument) => argument !== '-c').join(' ')} failed: ${reason}`)
    }
  }

  /** For questions where "git said no" is itself the answer, such as an unborn HEAD. */
  tryRun(argv: readonly string[], options: GitRunOptions = {}): string | undefined {
    try {
      return this.run(argv, options)
    } catch {
      return undefined
    }
  }

  succeeds(argv: readonly string[]): boolean {
    return this.tryRun(argv) !== undefined
  }

  isRepository(): boolean {
    // A worktree's `.git` is a file, not a directory, so existence is the test — not its type.
    return existsSync(join(this.cwd, '.git'))
  }

  init(branch = 'main'): void {
    this.run(['init', '--quiet', `--initial-branch=${branch}`])
  }

  /** A runner for another directory, sharing nothing but the behaviour. */
  at(cwd: string): GitRunner {
    return new GitRunner(cwd)
  }
}
