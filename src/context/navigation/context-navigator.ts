import {
  ContextEntry,
  ContextGrepMatch,
  ContextNode,
  ContextStat,
  ContextTreeEntry,
  ContextVersionRef,
  ScopeRef,
} from '../../contracts.js'
import { HiveError } from '../../errors.js'
import { Ledger } from '../../ledger.js'
import { createResourceUri, normalizeResourcePath } from '../../scope/resource-uri.js'
import { Clock } from '../../shared/clock.js'
import { ContextGitRepository } from '../git/context-git-repository.js'
import { ContextMarkdownCodec } from '../markdown/context-markdown-codec.js'
import { ContextFileStore } from '../storage/context-file-store.js'
import { assertNamespacedPath, namespaceOf } from '../context-namespace.js'
import { compileGlob } from '../matching/context-glob.js'

export interface GrepOptions {
  /** Restrict the search to a subtree. */
  path?: string
  ignoreCase?: boolean
  /** Cap on returned matches, so a broad pattern cannot exhaust memory. */
  limit?: number
}

/**
 * Every read-only view of the context root. Results are deterministic: paths are
 * sorted the same way on every platform, matching is case-sensitive regardless
 * of what the host filesystem does, and nothing here mutates files, index rows,
 * or Git state.
 */
export class ContextNavigator {
  constructor(
    private readonly fileStore: ContextFileStore,
    private readonly markdown: ContextMarkdownCodec,
    private readonly ledger: Ledger,
    private readonly now: Clock,
    private readonly git?: ContextGitRepository,
  ) {}

  /** One directory level, directories before files, then by name. */
  ls(scope: ScopeRef, path?: string): ContextEntry[] {
    const entries = this.fileStore.list(scope, optionalPath(path))
    return [...entries].sort(byKindThenName)
  }

  /** The whole subtree as a nested structure. `depth` counts levels below `path`. */
  tree(scope: ScopeRef, path?: string, depth = Number.MAX_SAFE_INTEGER): ContextTreeEntry[] {
    if (depth < 1) return []
    const prefix = optionalPath(path)
    return this.ls(scope, prefix).map((entry) => {
      const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name
      return {
        ...entry,
        path: entryPath,
        children: entry.kind === 'directory' ? this.tree(scope, entryPath, depth - 1) : undefined,
      }
    })
  }

  read(scope: ScopeRef, path: string): ContextNode {
    const canonicalPath = this.canonical(path)
    return this.markdown.decode(scope, canonicalPath, this.fileStore.read(scope, canonicalPath)).node
  }

  /** Metadata for one node, including whether disk, frontmatter, and index agree. */
  stat(scope: ScopeRef, path: string): ContextStat {
    const canonicalPath = this.canonical(path)
    const info = this.fileStore.stat(scope, canonicalPath)
    if (!info) throw new HiveError('NOT_FOUND', 'Context file does not exist')
    const decoded = this.markdown.decode(scope, canonicalPath, this.fileStore.read(scope, canonicalPath))
    const node = decoded.node
    return {
      uri: node.uri,
      path: canonicalPath,
      namespace: namespaceOf(canonicalPath),
      kind: node.kind,
      level: node.level,
      title: node.title,
      bytes: info.bytes,
      sha256: node.sha256,
      recordedSha256: decoded.recordedSha256,
      bodyModified: decoded.bodyModified,
      indexInSync: this.ledger.contextNode(node.uri)?.sha256 === node.sha256,
      version: node.version,
      pinned: node.pinned,
      expiresAt: node.expiresAt,
      expired: node.expiresAt !== undefined && Date.parse(node.expiresAt) <= this.now().getTime(),
      tags: node.tags,
      links: node.links,
      sourceUri: node.sourceUri,
      provenance: node.provenance,
      updatedAt: info.updatedAt,
    }
  }

  /** Canonical paths matching a glob. `*` and `?` stay inside a segment; `**` crosses them. */
  glob(scope: ScopeRef, pattern: string): string[] {
    // Compiled once for the whole sweep rather than per candidate path.
    const expression = compileGlob(pattern)
    return this.fileStore.markdownFiles(scope).filter((path) => expression.test(path))
  }

  /** Substring search over canonical paths — `find`, not a content search. */
  find(scope: ScopeRef, fragment: string): string[] {
    const needle = fragment.toLowerCase()
    return this.fileStore.markdownFiles(scope).filter((path) => path.toLowerCase().includes(needle))
  }

  /** Line-oriented content search over node bodies. Frontmatter is not searched. */
  grep(scope: ScopeRef, pattern: string, options: GrepOptions = {}): ContextGrepMatch[] {
    const limit = options.limit ?? 200
    if (limit < 1 || limit > 5000) throw new HiveError('INVALID_LIMIT', 'Grep limit must be between 1 and 5000')
    const expression = compilePattern(pattern, options.ignoreCase === true)
    const matches: ContextGrepMatch[] = []
    for (const path of this.fileStore.markdownFiles(scope, optionalPath(options.path))) {
      const text = this.fileStore.tryRead(scope, path)
      if (text === undefined) continue
      const lines = bodyOf(text).split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        if (!expression.test(lines[index])) continue
        matches.push({ uri: createResourceUri(scope, path), path, line: index + 1, text: lines[index] })
        if (matches.length >= limit) return matches
      }
    }
    return matches
  }

  /** Commits that touched the node, newest first. Empty when Git is disabled. */
  history(scope: ScopeRef, path: string, limit = 20): ContextVersionRef[] {
    const canonicalPath = this.canonical(path)
    return this.git?.history(this.fileStore.relativePath(scope, canonicalPath), limit) ?? []
  }

  /** The node's body as of a specific commit, for diffing an external edit against history. */
  readAt(scope: ScopeRef, path: string, revision: string): ContextNode | undefined {
    const canonicalPath = this.canonical(path)
    const text = this.git?.show(revision, this.fileStore.relativePath(scope, canonicalPath))
    return text === undefined ? undefined : this.markdown.decode(scope, canonicalPath, text).node
  }

  private canonical(path: string): string {
    return assertNamespacedPath(normalizeResourcePath(path))
  }
}

function optionalPath(path?: string): string | undefined {
  return path === undefined || path === '' ? undefined : normalizeResourcePath(path)
}

function byKindThenName(left: ContextEntry, right: ContextEntry): number {
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
  return left.name.localeCompare(right.name, 'en')
}

/** The body is everything after the frontmatter block; a file without one is searched whole. */
function bodyOf(text: string): string {
  const match = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(text)
  return match ? match[1] : text
}

function compilePattern(pattern: string, ignoreCase: boolean): RegExp {
  try {
    return new RegExp(pattern, ignoreCase ? 'iu' : 'u')
  } catch {
    throw new HiveError('INVALID_PATTERN', `Not a valid regular expression: ${pattern}`)
  }
}
