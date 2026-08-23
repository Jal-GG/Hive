import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { ContextEntry, ScopeRef } from '../../contracts.js'
import { HiveError } from '../../errors.js'
import { createId } from '../../shared/ids.js'
import { createResourceUri, scopeSegments } from '../../scope/resource-uri.js'

/**
 * Paths accepted by this store are already canonical — `ContextFilesystem`
 * normalizes once at its boundary. The store does not re-validate them.
 */
export class ContextFileStore {
  private readonly createdDirectories = new Set<string>()

  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true })
    this.createdDirectories.add(root)
  }

  getRoot(): string {
    return this.root
  }

  /** Repo-relative POSIX path, for callers that address the same layout (e.g. Git). */
  relativePath(scope: ScopeRef, path?: string): string {
    const segments = scopeSegments(scope)
    if (path) segments.push(path)
    return segments.join('/')
  }

  read(scope: ScopeRef, path: string): string {
    const text = this.tryRead(scope, path)
    if (text === undefined) throw new HiveError('NOT_FOUND', 'Context file does not exist')
    return text
  }

  /** `undefined` when the file is absent; throws when the path exists but is not a file. */
  tryRead(scope: ScopeRef, path: string): string | undefined {
    const fileName = this.fileName(scope, path)
    const info = statSync(fileName, { throwIfNoEntry: false })
    if (!info) return undefined
    if (!info.isFile()) throw new HiveError('NOT_FILE', 'Context URI is not a file')
    return readFileSync(fileName, 'utf8')
  }

  write(scope: ScopeRef, path: string, text: string): void {
    const fileName = this.fileName(scope, path)
    this.ensureDirectory(dirname(fileName))
    const temporaryName = `${fileName}.${createId()}.tmp`
    writeFileSync(temporaryName, text, 'utf8')
    renameSync(temporaryName, fileName)
  }

  remove(scope: ScopeRef, path: string): void {
    const fileName = this.fileName(scope, path)
    const info = statSync(fileName, { throwIfNoEntry: false })
    if (!info) throw new HiveError('NOT_FOUND', 'Context file does not exist')
    unlinkSync(fileName)
  }

  list(scope: ScopeRef, path?: string): ContextEntry[] {
    const directoryName = this.directoryName(scope, path)
    const info = statSync(directoryName, { throwIfNoEntry: false })
    if (!info) throw new HiveError('NOT_FOUND', 'Context directory does not exist')
    if (!info.isDirectory()) throw new HiveError('NOT_DIRECTORY', 'Context URI is not a directory')
    return readdirSync(directoryName, { withFileTypes: true })
      .filter((entry) => entry.name !== '.git')
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        const file = statSync(join(directoryName, entry.name))
        return {
          uri: createResourceUri(scope, path ? `${path}/${entry.name}` : entry.name),
          name: entry.name,
          kind: entry.isDirectory() ? 'directory' : 'file',
          size: entry.isFile() ? file.size : undefined,
          updatedAt: file.mtime.toISOString(),
        }
      })
  }

  markdownFiles(scope: ScopeRef): string[] {
    const root = this.directoryName(scope)
    const paths: string[] = []
    const visit = (directoryName: string) => {
      for (const entry of readdirSync(directoryName, { withFileTypes: true })) {
        const fullName = join(directoryName, entry.name)
        if (entry.isDirectory()) visit(fullName)
        else if (entry.name.endsWith('.md')) paths.push(relative(root, fullName).split(sep).join('/'))
      }
    }
    if (!statSync(root, { throwIfNoEntry: false })) return []
    visit(root)
    return paths.sort()
  }

  private ensureDirectory(directoryName: string): void {
    if (this.createdDirectories.has(directoryName)) return
    mkdirSync(directoryName, { recursive: true })
    this.createdDirectories.add(directoryName)
  }

  private directoryName(scope: ScopeRef, path?: string): string {
    return join(this.root, ...scopeSegments(scope), ...(path ? [path] : []))
  }

  private fileName(scope: ScopeRef, path: string): string {
    return this.directoryName(scope, path)
  }
}
