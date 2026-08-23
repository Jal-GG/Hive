export type ActorType = 'operator' | 'agent' | 'supervisor' | 'merge_coordinator' | 'context_worker' | 'integration' | 'system' | 'viewer'
export type Source = 'desktop' | 'cli' | 'mcp' | 'http' | 'hook' | 'webhook' | 'internal'
export type Capability =
  | 'workspace:read'
  | 'workspace:write'
  | 'work:dispatch'
  | 'work:mutate'
  | 'runtime:control'
  | 'merge:execute'
  | 'context:read'
  | 'context:write'
  | 'event:ingest'
  | 'backup:create'

export type EventType = 'Hook' | 'Pty' | 'Work' | 'Mail' | 'Merge' | 'Context' | 'Trigger' | 'UI' | 'System'

export interface ActorContext {
  actorId: string
  actorType: ActorType
  displayName: string
  capabilities: Capability[]
  workspaceId?: string
  projectId?: string
  agentId?: string
  sessionId?: string
  source: Source
}

export interface ScopeRef {
  workspaceId: string
  projectId: string
  workspaceName: string
  projectName: string
}

export interface EventEnvelope {
  version: 1
  eventId: string
  idempotencyKey: string
  eventType: EventType
  source: string
  actor: ActorContext
  scope?: ScopeRef
  occurredAt: string
  sequence?: number
  payload: Record<string, unknown>
  parentEventId?: string
  originMarker: string
}

export interface Lease {
  id: string
  resourceType: 'run' | 'dispatch' | 'merge' | 'handoff' | 'task' | 'maintenance'
  resourceId: string
  ownerActorId: string
  fencingToken: number
  acquiredAt: string
  expiresAt: string
  state: 'active' | 'released' | 'expired' | 'cancelled'
}

export interface ContextProvenance {
  sourceType: 'hook' | 'session' | 'file' | 'url' | 'git' | 'user' | 'model' | 'integration'
  sourceId: string
  actorId?: string
  createdAt: string
  transformationChain: string[]
  trust: 'observed' | 'imported' | 'derived' | 'proposed' | 'approved'
}

/**
 * The first segment of every canonical context path. The namespace fixes where a
 * node lives and which `ContextKind` it carries, so a URI alone determines both.
 */
export type ContextNamespace = 'resource' | 'memory' | 'skill' | 'session' | 'experience' | 'page'
export type ContextKind = ContextNamespace | 'directory'
export type ContextLevel = 'L0' | 'L1' | 'L2'

export interface ContextNode {
  uri: string
  scope: ScopeRef
  kind: ContextKind
  level: ContextLevel
  title: string
  abstract?: string
  overview?: string
  body?: string
  tags: string[]
  links: string[]
  sourceUri?: string
  provenance: ContextProvenance
  expiresAt?: string
  pinned: boolean
  sha256: string
  version: number
}

export interface ContextEntry {
  uri: string
  name: string
  kind: 'directory' | 'file'
  size?: number
  updatedAt?: string
}

export interface ContextTreeEntry extends ContextEntry {
  path: string
  children?: ContextTreeEntry[]
}

/** Everything `stat` can answer about one node without returning its body. */
export interface ContextStat {
  uri: string
  path: string
  namespace: ContextNamespace
  kind: ContextKind
  level: ContextLevel
  title: string
  bytes: number
  /** Hash of the body as it exists on disk right now. */
  sha256: string
  /** Hash recorded in frontmatter when Hive last wrote the file, if present. */
  recordedSha256?: string
  /** True when the on-disk body no longer matches the recorded hash. */
  bodyModified: boolean
  /** True when the on-disk body matches the hash in the derived ledger index. */
  indexInSync: boolean
  version: number
  pinned: boolean
  expiresAt?: string
  expired: boolean
  tags: string[]
  links: string[]
  sourceUri?: string
  provenance: ContextProvenance
  updatedAt: string
}

export interface ContextGrepMatch {
  uri: string
  path: string
  line: number
  text: string
}

/** A deletion recorded durably, so absence is distinguishable from loss. */
export interface ContextTombstone {
  uri: string
  path: string
  scope: ScopeRef
  version: number
  sha256: string
  deletedAt: string
  deletedBy: string
  commit?: string
}

export interface ContextLinkRef {
  fromUri: string
  toUri: string
  crossProject: boolean
  resolved: boolean
}

/** One row of the derived ledger index — enough to detect drift without reading bodies. */
export interface ContextIndexEntry {
  uri: string
  kind: ContextKind
  level: ContextLevel
  title: string
  sha256: string
  version: number
  updatedAt: string
}

export interface ContextVersionRef {
  commit: string
  committedAt: string
  message: string
}

export interface ContextSnapshotEntry {
  uri: string
  path: string
  sha256: string
  version: number
  bytes: number
}

/** C22: a content snapshot is its own manifest and never implies a code merge. */
export interface ContextSnapshotManifest {
  version: 1
  snapshotId: string
  label: string
  scope: ScopeRef
  createdAt: string
  createdBy: string
  commit: string
  ref: string
  nodeCount: number
  totalBytes: number
  nodes: ContextSnapshotEntry[]
}

export interface ContextPackMetadata {
  looseObjects: number
  looseSizeKib: number
  packedObjects: number
  packCount: number
  packSizeKib: number
}

export interface ContextReconcileReport {
  scanned: number
  /** Files on disk with no ledger row. */
  indexed: number
  /** Files whose bytes disagreed with the recorded hash; the disk copy wins and is re-stamped. */
  reindexed: number
  /** Ledger rows whose file is gone and that had no tombstone. */
  removed: number
  /** Tombstoned URIs whose file reappeared on disk. */
  resurrected: number
  /** Files that could not be decoded at all — reported rather than silently skipped. */
  unreadable: { path: string; reason: string }[]
  danglingLinks: ContextLinkRef[]
}

/** Discriminated on `ok` so a successful result narrows to a present `data`. */
export type ResultEnvelope<T> =
  | { version: 1; requestId: string; ok: true; data: T }
  | { version: 1; requestId: string; ok: false; error: { code: string; message: string } }
