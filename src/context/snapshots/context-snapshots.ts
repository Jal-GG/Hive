import {
  ActorContext,
  ContextPackMetadata,
  ContextSnapshotEntry,
  ContextSnapshotManifest,
  ScopeRef,
} from '../../contracts.js'
import { HiveError } from '../../errors.js'
import { Ledger } from '../../ledger.js'
import { assertCapability } from '../../identity/capabilities.js'
import { createResourceUri, validateScopeName } from '../../scope/resource-uri.js'
import { Clock } from '../../shared/clock.js'
import { createId } from '../../shared/ids.js'
import { ContextGitRepository } from '../git/context-git-repository.js'
import { ContextMarkdownCodec } from '../markdown/context-markdown-codec.js'
import { ContextFileStore } from '../storage/context-file-store.js'

const snapshotRefPrefix = 'context/'

/**
 * Content snapshots (C22). A snapshot is an annotated Git tag over the context
 * root plus a manifest listing exactly which nodes it covers — it is never a code
 * commit, and it never implies an application update. The manifest is stored in
 * both places on purpose: in the tag so a bare clone of the context repo is
 * self-describing, and in the ledger so listing snapshots costs no subprocesses.
 */
export class ContextSnapshots {
  constructor(
    private readonly fileStore: ContextFileStore,
    private readonly markdown: ContextMarkdownCodec,
    private readonly ledger: Ledger,
    private readonly now: Clock,
    private readonly git?: ContextGitRepository,
  ) {}

  create(actor: ActorContext, scope: ScopeRef, label: string): ContextSnapshotManifest {
    assertCapability(actor.capabilities, 'backup:create')
    validateScopeName(label, 'snapshot label')
    if (!this.git) throw new HiveError('GIT_DISABLED', 'Snapshots require the context Git repository')
    const commit = this.git.head()
    if (!commit) throw new HiveError('NOTHING_TO_SNAPSHOT', 'The context root has no commits yet')

    const nodes = this.entries(scope)
    const manifest: ContextSnapshotManifest = {
      version: 1,
      snapshotId: createId(),
      label,
      scope,
      createdAt: this.now().toISOString(),
      createdBy: actor.actorId,
      commit,
      ref: `${snapshotRefPrefix}${label}`,
      nodeCount: nodes.length,
      totalBytes: nodes.reduce((total, node) => total + node.bytes, 0),
      nodes,
    }
    // The tag is the durable artifact, so it is written before the index row.
    this.git.tag(manifest.ref, commit, JSON.stringify(manifest))
    this.ledger.insertSnapshot(manifest)
    this.ledger.recordAudit(actor.actorId, 'context.snapshot', { scope, snapshotId: manifest.snapshotId, label, commit })
    return manifest
  }

  list(scope: ScopeRef): ContextSnapshotManifest[] {
    return this.ledger.listSnapshots(scope)
  }

  /** Recovers manifests straight from tags, for a context root whose ledger was rebuilt. */
  listFromTags(): ContextSnapshotManifest[] {
    if (!this.git) return []
    const manifests: ContextSnapshotManifest[] = []
    for (const ref of this.git.tags(snapshotRefPrefix)) {
      const message = this.git.tagMessage(ref)
      if (!message) continue
      try {
        manifests.push(JSON.parse(message) as ContextSnapshotManifest)
      } catch {
        // A tag written by hand is not a manifest; skip rather than fail the listing.
      }
    }
    return manifests
  }

  packMetadata(): ContextPackMetadata {
    return this.git?.packMetadata() ?? { looseObjects: 0, looseSizeKib: 0, packedObjects: 0, packCount: 0, packSizeKib: 0 }
  }

  private entries(scope: ScopeRef): ContextSnapshotEntry[] {
    const entries: ContextSnapshotEntry[] = []
    for (const path of this.fileStore.markdownFiles(scope)) {
      const text = this.fileStore.tryRead(scope, path)
      if (text === undefined) continue
      // Strict on purpose: a snapshot that silently omitted an undecodable file
      // would be a manifest that lies. Reconcile first, then snapshot.
      const node = this.markdown.decode(scope, path, text).node
      entries.push({
        uri: createResourceUri(scope, path),
        path,
        sha256: node.sha256,
        version: node.version,
        bytes: Buffer.byteLength(text, 'utf8'),
      })
    }
    return entries
  }
}
