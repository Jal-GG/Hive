import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export class ContextGitRepository {
  private initialized = false

  constructor(private readonly root: string) {}

  /** `relativePath` is repo-relative and POSIX-separated; see `ContextFileStore.relativePath`. */
  commit(relativePath: string, message: string): void {
    this.ensureRepository()
    execFileSync('git', ['add', '--', relativePath], { cwd: this.root, stdio: 'ignore' })
    execFileSync('git', ['-c', 'user.name=Hive', '-c', 'user.email=hive@localhost', 'commit', '--quiet', '-m', message], { cwd: this.root, stdio: 'ignore' })
  }

  private ensureRepository(): void {
    if (this.initialized) return
    if (!existsSync(join(this.root, '.git'))) execFileSync('git', ['init', '--quiet'], { cwd: this.root, stdio: 'ignore' })
    this.initialized = true
  }
}
