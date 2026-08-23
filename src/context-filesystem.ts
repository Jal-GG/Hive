import {
  ActorContext,
  ContextEntry,
  ContextGrepMatch,
  ContextLevel,
  ContextLinkRef,
  ContextNode,
  ContextPackMetadata,
  ContextProvenance,
  ContextReconcileReport,
  ContextSnapshotManifest,
  ContextStat,
  ContextTombstone,
  ContextTreeEntry,
  ContextVersionRef,
  ScopeRef,
} from './contracts.js'
import { HiveError } from './errors.js'
import { Ledger } from './ledger.js'
import { assertCapability } from './identity/capabilities.js'
import { createResourceUri, normalizeResourcePath } from './scope/resource-uri.js'
import { Clock, ClockOptions, resolveClock } from './shared/clock.js'
import { ContextAction, contextEvent } from './context/context-events.js'
import { classifyLinks } from './context/context-links.js'
import { assertNamespacedPath, kindOf } from './context/context-namespace.js'
import { ContextGitRepository } from './context/git/context-git-repository.js'
import { ContextMarkdownCodec } from './context/markdown/context-markdown-codec.js'
import { ContextNavigator, GrepOptions } from './context/navigation/context-navigator.js'
import { ContextSnapshots } from './context/snapshots/context-snapshots.js'
import { ContextFileStore } from './context/storage/context-file-store.js'

export interface ContextFilesystemOptions extends ClockOptions {
  /** When false, no Git repository is created; history, restore, and snapshots are then unavailable. */
  initializeGit?: boolean
}

export interface WriteContextInput {
  path: string
  body: string
  title?: string
  level?: ContextLevel
  abstract?: string
  overview?: string
  tags?: string[]
  links?: string[]
  sourceUri?: string
  provenance?: ContextProvenance
  pinned?: boolean
  expiresAt?: string
}

/**
 * The canonical context filesystem (C2): Git-versioned Markdown under
 * `viking://` URIs, with SQLite holding only derived rows.
 *
 * Every mutation follows the C15 write order — canonical content and its Git
 * commit first, derived index rows second, audit and event records last — and
 * every intermediate state is one `reconcile` away from converging, because no
 * storage can commit filesystem, database, and Git atomically. Reads are
 * delegated to `ContextNavigator`, which cannot mutate anything.
 */
export class ContextFilesystem {
  private readonly now: Clock
  private readonly fileStore: ContextFileStore
  private readonly markdown = new ContextMarkdownCodec()
  private readonly git?: ContextGitRepository
  private readonly navigator: ContextNavigator
  private readonly snapshots: ContextSnapshots

  constructor(root: string, private readonly ledger: Ledger, options: ContextFilesystemOptions = {}) {
    this.now = resolveClock(options)
    this.fileStore = new ContextFileStore(root)
    if (options.initializeGit !== false) this.git = new ContextGitRepository(root)
    this.navigator = new ContextNavigator(this.fileStore, this.markdown, ledger, this.now, this.git)
    this.snapshots = new ContextSnapshots(this.fileStore, this.markdown, ledger, this.now, this.git)
  }

  getRoot(): string {
    return this.fileStore.getRoot()
  }

  // --- Navigation (capability-gated, then delegated) ---

  list(actor: ActorContext, scope: ScopeRef, path?: string): ContextEntry[] {
    return this.reading(actor).ls(scope, path)
  }

  tree(actor: ActorContext, scope: ScopeRef, path?: string, depth?: number): ContextTreeEntry[] {
    return this.reading(actor).tree(scope, path, depth)
  }

  read(actor: ActorContext, scope: ScopeRef, path: string): ContextNode {
    return this.reading(actor).read(scope, path)
  }

  stat(actor: ActorContext, scope: ScopeRef, path: string): ContextStat {
    return this.reading(actor).stat(scope, path)
  }

  glob(actor: ActorContext, scope: ScopeRef, pattern: string): string[] {
    return this.reading(actor).glob(scope, pattern)
  }

  find(actor: ActorContext, scope: ScopeRef, fragment: string): string[] {
    return this.reading(actor).find(scope, fragment)
  }

  grep(actor: ActorContext, scope: ScopeRef, pattern: string, options?: GrepOptions): ContextGrepMatch[] {
    return this.reading(actor).grep(scope, pattern, options)
  }

  history(actor: ActorContext, scope: ScopeRef, path: string, limit?: number): ContextVersionRef[] {
    return this.reading(actor).history(scope, path, limit)
  }

  readAt(actor: ActorContext, scope: ScopeRef, path: string, revision: string): ContextNode | undefined {
    return this.reading(actor).readAt(scope, path, revision)
  }

  tombstones(actor: ActorContext, scope: ScopeRef): ContextTombstone[] {
    assertCapability(actor.capabilities, 'context:read')
    return this.ledger.listTombstones(scope)
  }

  // --- Snapshots and pack metadata (C22) ---

  createSnapshot(actor: ActorContext, scope: ScopeRef, label: string): ContextSnapshotManifest {
    const manifest = this.snapshots.create(actor, scope, label)
    this.ledger.appendEvent(contextEvent(actor, scope, 'snapshot', `${manifest.snapshotId}`, manifest.createdAt, {
      snapshotId: manifest.snapshotId, label: manifest.label, ref: manifest.ref, commit: manifest.commit, nodeCount: manifest.nodeCount,
    }))
    return manifest
  }

  listSnapshots(actor: ActorContext, scope: ScopeRef): ContextSnapshotManifest[] {
    assertCapability(actor.capabilities, 'context:read')
    return this.snapshots.list(scope)
  }

  packMetadata(actor: ActorContext): ContextPackMetadata {
    assertCapability(actor.capabilities, 'context:read')
    return this.snapshots.packMetadata()
  }

  // --- Mutations ---

  write(actor: ActorContext, scope: ScopeRef, input: WriteContextInput): ContextNode {
    assertCapability(actor.capabilities, 'context:write')
    const canonicalPath = this.canonical(input.path)
    const existing = this.tryDecode(scope, canonicalPath)
    const createdAt = this.now().toISOString()
    const node: ContextNode = {
      uri: createResourceUri(scope, canonicalPath),
      scope,
      kind: kindOf(canonicalPath),
      level: input.level ?? existing?.level ?? 'L2',
      title: input.title ?? existing?.title ?? defaultTitle(canonicalPath),
      abstract: input.abstract ?? existing?.abstract,
      overview: input.overview ?? existing?.overview,
      body: input.body,
      tags: input.tags ?? existing?.tags ?? [],
      links: input.links ?? existing?.links ?? [],
      sourceUri: input.sourceUri ?? existing?.sourceUri,
      provenance: input.provenance ?? existing?.provenance ?? {
        sourceType: 'user', sourceId: actor.actorId, actorId: actor.actorId, createdAt, transformationChain: [], trust: 'approved',
      },
      pinned: input.pinned ?? existing?.pinned ?? false,
      expiresAt: input.expiresAt ?? existing?.expiresAt,
      sha256: this.markdown.hash(input.body),
      version: (existing?.version ?? 0) + 1,
    }
    // Links are validated before anything is written, so a scope violation never lands on disk.
    const links = classifyLinks(scope, canonicalPath, node.links)
    this.fileStore.write(scope, canonicalPath, this.markdown.encode(node))
    this.commit(scope, [canonicalPath], 'write', node.uri)
    this.index(scope, node, links)
    this.record(actor, scope, 'write', node.uri, node.version, { uri: node.uri, version: node.version, sha256: node.sha256, links: links.length })
    return node
  }

  rename(actor: ActorContext, scope: ScopeRef, fromPath: string, toPath: string): ContextNode {
    assertCapability(actor.capabilities, 'context:write')
    const from = this.canonical(fromPath)
    const to = this.canonical(toPath)
    if (from === to) throw new HiveError('INVALID_RENAME', 'Rename source and destination are the same')
    const existing = this.tryDecode(scope, from)
    if (!existing) throw new HiveError('NOT_FOUND', 'Context file does not exist')
    const fromUri = createResourceUri(scope, from)
    const node: ContextNode = { ...existing, uri: createResourceUri(scope, to), kind: kindOf(to), version: existing.version + 1 }
    const links = classifyLinks(scope, to, node.links)

    // Move first so the bytes are never duplicated, then re-stamp the frontmatter
    // the move carried over. A crash between the two leaves the old version at
    // the new path, which reconcile adopts rather than discards.
    this.fileStore.rename(scope, from, to)
    this.fileStore.write(scope, to, this.markdown.encode(node))
    this.commit(scope, [from, to], 'rename', node.uri)
    this.forget(fromUri)
    this.index(scope, node, links)
    this.record(actor, scope, 'rename', `${fromUri}>${node.uri}`, node.version, { fromUri, toUri: node.uri, version: node.version })
    return node
  }

  /** Deletes a node and records a tombstone, so a later absence is provably a deletion. */
  remove(actor: ActorContext, scope: ScopeRef, path: string): ContextTombstone {
    assertCapability(actor.capabilities, 'context:write')
    const canonicalPath = this.canonical(path)
    const existing = this.tryDecode(scope, canonicalPath)
    if (!existing) throw new HiveError('NOT_FOUND', 'Context file does not exist')
    const uri = createResourceUri(scope, canonicalPath)
    const tombstone: ContextTombstone = {
      uri, path: canonicalPath, scope, version: existing.version, sha256: existing.sha256,
      deletedAt: this.now().toISOString(), deletedBy: actor.actorId,
    }

    // The tombstone is written before the unlink: if the process dies in between,
    // the file is still there and reconcile resurrects it, which is the honest
    // reading of "the delete did not finish".
    this.ledger.insertTombstone(tombstone)
    this.fileStore.remove(scope, canonicalPath)
    const commit = this.commit(scope, [canonicalPath], 'delete', uri)
    if (commit) this.ledger.setTombstoneCommit(uri, commit)
    this.forget(uri)
    this.record(actor, scope, 'delete', uri, tombstone.version, { uri, version: tombstone.version, commit })
    return { ...tombstone, commit }
  }

  /**
   * Brings a deleted node back from the commit that preceded its deletion. The
   * restored bytes are the old ones; the version moves forward, because history
   * only ever grows.
   */
  restore(actor: ActorContext, scope: ScopeRef, path: string): ContextNode {
    assertCapability(actor.capabilities, 'context:write')
    const canonicalPath = this.canonical(path)
    const uri = createResourceUri(scope, canonicalPath)
    const tombstone = this.ledger.tombstone(uri)
    if (!tombstone) throw new HiveError('NOT_DELETED', 'No tombstone exists for this URI')
    if (this.fileStore.exists(scope, canonicalPath)) throw new HiveError('ALREADY_EXISTS', 'Context file already exists')

    const relativePath = this.fileStore.relativePath(scope, canonicalPath)
    const deletion = tombstone.commit ?? this.git?.lastCommitFor(relativePath)
    const text = deletion === undefined ? undefined : this.git?.show(`${deletion}^`, relativePath)
    if (text === undefined) throw new HiveError('RESTORE_UNAVAILABLE', 'No committed version of this node is available to restore')

    const recovered = this.markdown.decode(scope, canonicalPath, text).node
    const node: ContextNode = { ...recovered, version: Math.max(recovered.version, tombstone.version) + 1 }
    const links = classifyLinks(scope, canonicalPath, node.links)
    this.fileStore.write(scope, canonicalPath, this.markdown.encode(node))
    this.commit(scope, [canonicalPath], 'restore', uri)
    this.index(scope, node, links)
    this.record(actor, scope, 'restore', uri, node.version, { uri, version: node.version, restoredFrom: `${deletion}^` })
    return node
  }

  /**
   * Converges the derived index onto whatever the filesystem actually holds.
   *
   * The disk always wins: a Markdown file edited outside Hive is adopted as a new
   * version with its frontmatter re-stamped, a file that vanished without a
   * tombstone loses its row, and a tombstoned file that reappeared is resurrected.
   * Running this twice in a row produces no changes the second time.
   */
  reconcile(actor: ActorContext, scope: ScopeRef): ContextReconcileReport {
    assertCapability(actor.capabilities, 'context:write')
    const report: ContextReconcileReport = { scanned: 0, indexed: 0, reindexed: 0, removed: 0, resurrected: 0, unreadable: [], danglingLinks: [] }
    const indexed = new Map(this.ledger.listContextNodes(scope).map((entry) => [entry.uri, entry]))
    const present = new Set<string>()
    const adopted: string[] = []

    for (const path of this.fileStore.markdownFiles(scope)) {
      report.scanned += 1
      const uri = createResourceUri(scope, path)
      present.add(uri)
      let decoded
      try {
        decoded = this.markdown.decode(scope, path, this.fileStore.read(scope, path))
      } catch (error) {
        // One malformed file must not abort the sweep; it is reported instead.
        report.unreadable.push({ path, reason: error instanceof Error ? error.message : String(error) })
        continue
      }
      if (this.ledger.tombstone(uri)) {
        this.ledger.removeTombstone(uri)
        report.resurrected += 1
      }

      const known = indexed.get(uri)
      // Three independent kinds of drift, because each has a different remedy.
      const externalEdit = decoded.bodyModified || (known !== undefined && known.sha256 !== decoded.node.sha256)
      const needsStamp = decoded.recordedSha256 !== decoded.node.sha256
      const needsIndex = known === undefined || known.sha256 !== decoded.node.sha256
      if (!externalEdit && !needsStamp && !needsIndex) continue
      if (known === undefined) report.indexed += 1
      else report.reindexed += 1

      // An edit that arrived outside Hive becomes a real new version. Provenance
      // is preserved and the chain records how the change arrived, rather than
      // silently re-grading the content's trust.
      const node: ContextNode = externalEdit
        ? {
            ...decoded.node,
            version: Math.max(decoded.node.version, known?.version ?? 0) + 1,
            provenance: { ...decoded.node.provenance, transformationChain: [...decoded.node.provenance.transformationChain, 'external-edit'] },
          }
        : decoded.node
      if (externalEdit || needsStamp) {
        // Re-stamp so the recorded hash matches the surviving bytes.
        this.fileStore.write(scope, path, this.markdown.encode(node))
        adopted.push(path)
      }
      this.index(scope, node, classifyLinks(scope, path, node.links))
    }

    for (const uri of indexed.keys()) {
      if (present.has(uri)) continue
      // Gone from disk with no tombstone: an external delete, or a rename whose
      // index update never landed. Either way the filesystem is authoritative.
      if (!this.ledger.tombstone(uri)) report.removed += 1
      this.forget(uri)
    }

    for (const link of this.ledger.listContextLinks(scope)) {
      if (this.ledger.contextNode(link.toUri)) continue
      report.danglingLinks.push(link)
    }

    if (adopted.length > 0) this.commit(scope, adopted, 'reconcile', `${adopted.length} adopted`)
    const occurredAt = this.now().toISOString()
    this.ledger.recordAudit(actor.actorId, 'context.reconcile', { scope, ...report })
    // Reconciliation is a sweep, not a file operation, so its key is per-run.
    this.ledger.appendEvent(contextEvent(actor, scope, 'reconcile', `${this.fileStore.relativePath(scope)}:${occurredAt}`, occurredAt, { ...report }))
    return report
  }

  private reading(actor: ActorContext): ContextNavigator {
    assertCapability(actor.capabilities, 'context:read')
    return this.navigator
  }

  private canonical(path: string): string {
    return assertNamespacedPath(normalizeResourcePath(path))
  }

  /** Derived rows always move together, so index and links are updated as one step. */
  private index(scope: ScopeRef, node: ContextNode, links: readonly ContextLinkRef[]): void {
    // Writing a URI supersedes any earlier deletion of it.
    this.ledger.removeTombstone(node.uri)
    this.ledger.upsertContextNode(node)
    this.ledger.replaceContextLinks(node.uri, scope, links)
  }

  private forget(uri: string): void {
    this.ledger.removeContextNode(uri)
    this.ledger.removeContextLinks(uri)
  }

  private commit(scope: ScopeRef, paths: readonly string[], action: ContextAction, subject: string): string | undefined {
    if (!this.git) return undefined
    const relativePaths = paths.map((path) => this.fileStore.relativePath(scope, path))
    return this.git.commit(relativePaths, `context: ${action} ${subject}`)
  }

  /** Audit records who acted; the event record makes the operation replayable (C13). */
  private record(actor: ActorContext, scope: ScopeRef, action: ContextAction, key: string, version: number, payload: Record<string, unknown>): void {
    this.ledger.recordAudit(actor.actorId, `context.${action}`, { scope, ...payload })
    this.ledger.appendEvent(contextEvent(actor, scope, action, `${key}:${version}`, this.now().toISOString(), payload))
  }

  private tryDecode(scope: ScopeRef, canonicalPath: string): ContextNode | undefined {
    const text = this.fileStore.tryRead(scope, canonicalPath)
    return text === undefined ? undefined : this.markdown.decode(scope, canonicalPath, text).node
  }
}

function defaultTitle(canonicalPath: string): string {
  return canonicalPath.split('/').pop()!.replace(/\.md$/i, '')
}
