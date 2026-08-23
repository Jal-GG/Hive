import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { ContextEntry, ScopeRef } from '../../contracts.js'
import { HiveError } from '../../errors.js'
import { createId } from '../../shared/ids.js'
import { createResourceUri, scopeSegments } from '../../scope/resource-uri.js'

export interface FileInfo {
  bytes: number
  updatedAt: string
}

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

  exists(scope: ScopeRef, path: string): boolean {
    return statSync(this.fileName(scope, path), { throwIfNoEntry: false })?.isFile() === true
  }

  stat(scope: ScopeRef, path: string): FileInfo | undefined {
    const info = statSync(this.fileName(scope, path), { throwIfNoEntry: false })
    if (!info?.isFile()) return undefined
    return { bytes: info.size, updatedAt: info.mtime.toISOString() }
  }

  /**
   * Writes through a temporary file in the destination directory, flushing it to
   * disk before the rename so a crash leaves either the old file or the new one
   * — never a half-written document. (The parent directory entry itself is not
   * flushed: Windows offers no portable directory fsync.)
   */
  write(scope: ScopeRef, path: string, text: string): void {
    const fileName = this.fileName(scope, path)
    this.ensureDirectory(dirname(fileName))
    const temporaryName = `${fileName}.${createId()}.tmp`
    const descriptor = openSync(temporaryName, 'w')
    try {
      writeSync(descriptor, text, null, 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporaryName, fileName)
  }

  rename(scope: ScopeRef, fromPath: string, toPath: string): void {
    const source = this.fileName(scope, fromPath)
    if (!statSync(source, { throwIfNoEntry: false })?.isFile()) throw new HiveError('NOT_FOUND', 'Context file does not exist')
    const destination = this.fileName(scope, toPath)
    if (statSync(destination, { throwIfNoEntry: false })) throw new HiveError('ALREADY_EXISTS', 'Rename destination already exists')
    this.ensureDirectory(dirname(destination))
    renameSync(source, destination)
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
      .filter((entry) => entry.name !== '.git' && !entry.name.endsWith('.tmp'))
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

  /** Every Markdown document under the scope, as sorted canonical paths. */
  markdownFiles(scope: ScopeRef, path?: string): string[] {
    const scopeRoot = this.directoryName(scope)
    const start = this.directoryName(scope, path)
    if (!statSync(start, { throwIfNoEntry: false })) return []
    const paths: string[] = []
    const visit = (directoryName: string) => {
      for (const entry of readdirSync(directoryName, { withFileTypes: true })) {
        if (entry.name === '.git') continue
        const fullName = join(directoryName, entry.name)
        if (entry.isDirectory()) visit(fullName)
        else if (entry.name.endsWith('.md')) paths.push(relative(scopeRoot, fullName).split(sep).join('/'))
      }
    }
    visit(start)
    return paths.sort()
  }

  private ensureDirectory(directoryName: string): void {
    if (this.createdDirectories.has(directoryName)) return
    mkdirSync(directoryName, { recursive: true })
    this.createdDirectories.add(directoryName)
  }

  private directoryName(scope: ScopeRef, path?: string): string {
    return join(this.root, ...scopeSegments(scope), ...(path ? path.split('/') : []))
  }

  private fileName(scope: ScopeRef, path: string): string {
    return this.directoryName(scope, path)
  }
}
