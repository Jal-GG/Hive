import { ActorContext, ContextEntry, ContextNode, ContextProvenance, ScopeRef } from './contracts.js'
import { Ledger } from './ledger.js'
import { assertCapability } from './identity/capabilities.js'
import { createResourceUri, normalizeResourcePath } from './scope/resource-uri.js'
import { Clock, ClockOptions, resolveClock } from './shared/clock.js'
import { ContextGitRepository } from './context/git/context-git-repository.js'
import { ContextMarkdownCodec } from './context/markdown/context-markdown-codec.js'
import { ContextFileStore } from './context/storage/context-file-store.js'

export interface ContextFilesystemOptions extends ClockOptions {
  /** When false, no Git repository is created and mutations are not committed. */
  initializeGit?: boolean
}

export interface WriteContextInput {
  path: string
  body: string
  title?: string
  kind?: ContextNode['kind']
  level?: ContextNode['level']
  tags?: string[]
  links?: string[]
  provenance?: ContextProvenance
  pinned?: boolean
  expiresAt?: string
}

export class ContextFilesystem {
  private readonly now: Clock
  private readonly fileStore: ContextFileStore
  private readonly markdown = new ContextMarkdownCodec()
  private readonly git?: ContextGitRepository

  constructor(root: string, private readonly ledger: Ledger, options: ContextFilesystemOptions = {}) {
    this.now = resolveClock(options)
    this.fileStore = new ContextFileStore(root)
    if (options.initializeGit !== false) this.git = new ContextGitRepository(root)
  }

  getRoot(): string {
    return this.fileStore.getRoot()
  }

  list(actor: ActorContext, scope: ScopeRef, path?: string): ContextEntry[] {
    assertCapability(actor.capabilities, 'context:read')
    return this.fileStore.list(scope, path === undefined || path === '' ? undefined : normalizeResourcePath(path))
  }

  read(actor: ActorContext, scope: ScopeRef, path: string): ContextNode {
    assertCapability(actor.capabilities, 'context:read')
    const canonicalPath = normalizeResourcePath(path)
    return this.markdown.decode(scope, canonicalPath, this.fileStore.read(scope, canonicalPath))
  }

  write(actor: ActorContext, scope: ScopeRef, input: WriteContextInput): ContextNode {
    assertCapability(actor.capabilities, 'context:write')
    const canonicalPath = normalizeResourcePath(input.path)
    const existing = this.readExisting(scope, canonicalPath)
    const now = this.now().toISOString()
    const node: ContextNode = {
      uri: createResourceUri(scope, canonicalPath),
      scope,
      kind: input.kind ?? existing?.kind ?? 'page',
      level: input.level ?? existing?.level ?? 'L2',
      title: input.title ?? existing?.title ?? canonicalPath.split('/').pop()!.replace(/\.md$/i, ''),
      body: input.body,
      tags: input.tags ?? existing?.tags ?? [],
      links: input.links ?? existing?.links ?? [],
      provenance: input.provenance ?? existing?.provenance ?? { sourceType: 'user', sourceId: actor.actorId, actorId: actor.actorId, createdAt: now, transformationChain: [], trust: 'approved' },
      pinned: input.pinned ?? existing?.pinned ?? false,
      expiresAt: input.expiresAt ?? existing?.expiresAt,
      sha256: this.markdown.hash(input.body),
      version: (existing?.version ?? 0) + 1,
    }
    this.fileStore.write(scope, canonicalPath, this.markdown.encode(node))
    this.ledger.upsertContextNode(node)
    // Audit records identity, not content — Git holds the content history.
    this.recordMutation(actor, 'context.write', scope, canonicalPath, { scope, uri: node.uri, version: node.version, sha256: node.sha256 })
    return node
  }

  remove(actor: ActorContext, scope: ScopeRef, path: string): void {
    assertCapability(actor.capabilities, 'context:write')
    const canonicalPath = normalizeResourcePath(path)
    const uri = createResourceUri(scope, canonicalPath)
    this.fileStore.remove(scope, canonicalPath)
    this.ledger.removeContextNode(uri)
    this.recordMutation(actor, 'context.delete', scope, canonicalPath, { scope, uri })
  }

  /** Rebuilds the derived ledger index from the files on disk. Content is unchanged, so nothing is committed. */
  reconcile(actor: ActorContext, scope: ScopeRef): number {
    assertCapability(actor.capabilities, 'context:write')
    const paths = this.fileStore.markdownFiles(scope)
    for (const path of paths) {
      this.ledger.upsertContextNode(this.markdown.decode(scope, path, this.fileStore.read(scope, path)))
    }
    this.recordMutation(actor, 'context.reconcile', scope, undefined, { scope, count: paths.length })
    return paths.length
  }

  /**
   * The ordered tail every context mutation shares: record the audit entry, then
   * commit. `commitPath` is omitted for operations that do not change files.
   */
  private recordMutation(actor: ActorContext, action: string, scope: ScopeRef, commitPath: string | undefined, details: Record<string, unknown>): void {
    this.ledger.recordAudit(actor.actorId, action, details)
    if (commitPath === undefined) return
    this.git?.commit(this.fileStore.relativePath(scope, commitPath), `context: ${action.replace(/^context\./, '')} ${createResourceUri(scope, commitPath)}`)
  }

  private readExisting(scope: ScopeRef, canonicalPath: string): ContextNode | undefined {
    const text = this.fileStore.tryRead(scope, canonicalPath)
    return text === undefined ? undefined : this.markdown.decode(scope, canonicalPath, text)
  }
}
