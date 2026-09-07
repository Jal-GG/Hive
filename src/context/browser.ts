import { ActorContext, ResultEnvelope, ScopeRef } from '../contracts.js'
import { ContextFilesystem } from './context-filesystem.js'
import { HiveError, asResult } from '../errors.js'
import { Ledger } from '../ledger.js'
import { parseResourceUri } from '../resource-uri.js'
import { createId } from '../shared.js'

export type ContextBrowseOperation =
  | 'ls'
  | 'tree'
  | 'stat'
  | 'read'
  | 'grep'
  | 'glob'
  | 'find'
  | 'history'
  | 'readAt'
  | 'tombstones'
  | 'snapshots'
  | 'pack'

export const contextBrowseOperations: readonly ContextBrowseOperation[] = [
  'ls', 'tree', 'stat', 'read', 'grep', 'glob', 'find', 'history', 'readAt', 'tombstones', 'snapshots', 'pack',
]

/**
 * One request shape for every surface. The target may be given either as a full
 * `viking://` URI or as `workspace` + `project` + an optional `path`; the two
 * spellings resolve identically.
 */
export interface ContextBrowseRequest {
  version: 1
  requestId?: string
  operation: ContextBrowseOperation
  uri?: string
  workspace?: string
  project?: string
  path?: string
  pattern?: string
  revision?: string
  depth?: number
  limit?: number
  ignoreCase?: boolean
}

/** Human-facing description of each operation, shared by `--help`, MCP tool lists, and HTTP discovery. */
export const contextBrowseHelp: Record<ContextBrowseOperation, string> = {
  ls: 'List one directory level under a context path',
  tree: 'List a context subtree, optionally limited by depth',
  stat: 'Metadata for one node, including whether disk, frontmatter, and index agree',
  read: 'Read one node with its frontmatter and body',
  grep: 'Search node bodies for a regular expression',
  glob: 'List canonical paths matching a glob pattern',
  find: 'List canonical paths containing a substring',
  history: 'Commits that touched one node, newest first',
  readAt: 'Read one node as it existed at a specific commit',
  tombstones: 'List deleted nodes that can be restored',
  snapshots: 'List content snapshots taken of this project',
  pack: 'Git object and pack statistics for the context root',
}

/**
 * The single read-only browsing service behind every surface (C4). It exposes no
 * mutation at all: CLI, MCP, HTTP, and the desktop main process each adapt a
 * transport onto this one contract, so none of them can invent an operation the
 * others do not have, and none of them can write.
 */
export class ContextBrowser {
  constructor(
    private readonly filesystem: ContextFilesystem,
    private readonly ledger: Ledger,
  ) {}

  /** Never throws: every failure comes back as a `ResultEnvelope` error, identically on all surfaces. */
  browse(actor: ActorContext, request: ContextBrowseRequest): ResultEnvelope<unknown> {
    const requestId = request.requestId ?? createId()
    return asResult(requestId, () => this.dispatch(actor, request))
  }

  private dispatch(actor: ActorContext, request: ContextBrowseRequest): unknown {
    const { scope, path } = this.target(request)
    switch (request.operation) {
      case 'ls':
        return this.filesystem.list(actor, scope, path)
      case 'tree':
        return this.filesystem.tree(actor, scope, path, request.depth)
      case 'stat':
        return this.filesystem.stat(actor, scope, this.requirePath(path))
      case 'read':
        return this.filesystem.read(actor, scope, this.requirePath(path))
      case 'grep':
        return this.filesystem.grep(actor, scope, this.require(request.pattern, 'pattern'), { path, limit: request.limit, ignoreCase: request.ignoreCase })
      case 'glob':
        return this.filesystem.glob(actor, scope, this.require(request.pattern, 'pattern'))
      case 'find':
        return this.filesystem.find(actor, scope, this.require(request.pattern, 'pattern'))
      case 'history':
        return this.filesystem.history(actor, scope, this.requirePath(path), request.limit)
      case 'readAt':
        return this.filesystem.readAt(actor, scope, this.requirePath(path), this.require(request.revision, 'revision'))
      case 'tombstones':
        return this.filesystem.tombstones(actor, scope)
      case 'snapshots':
        return this.filesystem.listSnapshots(actor, scope)
      case 'pack':
        return this.filesystem.packMetadata(actor)
      default:
        throw new HiveError('UNKNOWN_OPERATION', `Not a context browse operation: ${String(request.operation)}`)
    }
  }

  /** URIs are canonicalized before the scope is resolved, per §6.1. */
  private target(request: ContextBrowseRequest): { scope: ScopeRef; path?: string } {
    if (request.uri !== undefined) {
      const parts = parseResourceUri(request.uri)
      return { scope: this.ledger.resolveScope(parts.workspaceName, parts.projectName), path: parts.path }
    }
    const scope = this.ledger.resolveScope(this.require(request.workspace, 'workspace'), this.require(request.project, 'project'))
    return { scope, path: request.path === '' ? undefined : request.path }
  }

  private requirePath(path: string | undefined): string {
    return this.require(path, 'path')
  }

  private require<T>(value: T | undefined, field: string): T {
    if (value === undefined) throw new HiveError('MISSING_ARGUMENT', `${field} is required`)
    return value
  }
}
