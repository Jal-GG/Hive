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
  /** Observing the roster, run state, and transcripts. Deliberately separate from `runtime:control`
   *  so a read-only viewer can watch a fleet it cannot start, steer, or stop. */
  | 'runtime:read'

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
  runId?: string
  workItemId?: string
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

// --- Runtime, worktree, and run (§6.3) ---

export type RuntimeProvider = 'claude' | 'codex' | 'grok' | 'qwen' | 'opencode' | 'crush' | 'pi' | 'copilot' | 'fake' | 'other'

/** C6: node-pty is the lifecycle contract; tmux and bare processes are alternative backends behind it. */
export type RuntimeBackend = 'node_pty' | 'tmux' | 'process' | 'fake'

/**
 * What a backend can actually do, declared rather than assumed. A caller that
 * needs `resize` must check for it instead of discovering at runtime that a
 * backend silently ignored the request.
 */
export type RuntimeCapability =
  | 'interactive'
  | 'resize'
  | 'transcript'
  | 'heartbeat'
  | 'process_tree_kill'
  /** Outlives the host process, so a restart can re-adopt the session instead of orphaning it. */
  | 'persistent_session'

export type RunState = 'spawning' | 'running' | 'idle' | 'completing' | 'done' | 'stalled' | 'zombie' | 'escalated' | 'cancelled'

/** Run states from which no further transition happens, so the row is final. */
export const terminalRunStates: readonly RunState[] = ['done', 'zombie', 'escalated', 'cancelled']

/** How a compiled context packet reaches the agent: on its command line, or written after readiness. */
export type PromptDelivery = 'stdin' | 'argument' | 'none'

/**
 * Which host environment variables a provider may inherit. Names are matched
 * case-insensitively (Windows treats them that way) and `PREFIX_*` wildcards are
 * allowed — but a wildcard never matches a secret-looking name, so inheriting a
 * credential is always a deliberate, auditable act of naming it exactly.
 */
export interface EnvironmentPolicy {
  allow: string[]
  deny: string[]
  set: Record<string, string>
}

export interface AgentProfile {
  id: string
  provider: RuntimeProvider
  executable: string
  argsTemplate: string[]
  environmentPolicy: EnvironmentPolicy
  capabilities: RuntimeCapability[]
  backend: RuntimeBackend
  transcriptAdapter?: string
  /** Regular-expression source matched against output to decide readiness; absent means ready on spawn. */
  readyPattern?: string
  promptDelivery: PromptDelivery
  /** Silence beyond this becomes the `idle` run state; supervision in Phase 5 acts on it. */
  idleAfterMs?: number
}

/**
 * Identity handed to the child explicitly (C16). Nothing about who a run belongs
 * to is inferred from the working directory or inherited from the parent
 * environment, so a child cannot mistake itself for another run.
 */
export interface RuntimeIdentity {
  runId: string
  actorId: string
  agentId?: string
  workspaceName: string
  projectName: string
  workItemId?: string
  branch: string
  originMarker: string
}

export interface WorktreeRef {
  runId: string
  path: string
  branch: string
  baseBranch: string
  baseCommit?: string
  /** Identity of the repository itself, stable across clones' paths where a root commit exists. */
  repoFingerprint: string
  /** Identity of this checkout, so two runs can never be mistaken for one another. */
  worktreeFingerprint: string
  createdAt: string
}

export interface WorktreeStatus {
  path: string
  branch: string
  headCommit?: string
  /** Files with uncommitted changes, from `status --porcelain`. */
  dirtyFiles: string[]
  clean: boolean
  /** Commits on the run branch that the base branch does not have. */
  aheadOfBase: number
  exists: boolean
}

/** The answer to "may this worktree be deleted now?", with the reasons attached. */
export interface WorktreeCleanupDecision {
  runId: string
  allowed: boolean
  /** Every gate that refused: unfinished run, uncommitted work, or unmerged commits. */
  blockedBy: string[]
  status?: WorktreeStatus
}

export interface Run {
  id: string
  workItemId?: string
  actorId: string
  /** The agent this run belongs to, when launched for one: how interrupt mail finds its session. */
  agentId?: string
  scope: ScopeRef
  runtimeProfile: string
  backend: RuntimeBackend
  sessionKey: string
  cwd: string
  repoFingerprint: string
  worktreeFingerprint: string
  branch: string
  state: RunState
  leaseId: string
  startedAt: string
  endedAt?: string
  exitCode?: number
  exitSignal?: string
  pid?: number
  transcriptCursor?: string
  importedEventCount: number
  lostEventCount: number
}

export interface RuntimeExit {
  code?: number
  signal?: string
  exitedAt: string
}

export interface RuntimeStatus {
  sessionKey: string
  backend: RuntimeBackend
  pid?: number
  alive: boolean
  ready: boolean
  cols: number
  rows: number
  /** Byte counts only: output volume is observable without any output text being retained (C16). */
  bytesOut: number
  bytesIn: number
  lastOutputAt?: string
  exit?: RuntimeExit
}

export interface RuntimeHeartbeat {
  sessionKey: string
  observedAt: string
  alive: boolean
  idleMs: number
}

// --- Read-only transcript import (C17) ---

export interface TranscriptEntry {
  /** Derived from file identity and content, so re-importing the same line is recognized, not duplicated. */
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system' | 'unknown'
  text: string
  occurredAt?: string
  tokensIn?: number
  tokensOut?: number
}

export interface TranscriptSlice {
  schema: string
  entries: TranscriptEntry[]
  /** Opaque resume position; pass it back to continue where this slice ended. */
  cursor?: string
  /** Lines the adapter could not decode. Reported rather than dropped, so loss is measurable. */
  lostCount: number
  /** False when the source ended mid-record, meaning more of the tail is still being written. */
  complete: boolean
}

export interface RunReconcileReport {
  scanned: number
  /** Persistent sessions still alive after a restart, re-adopted rather than orphaned. */
  readopted: number
  /** Runs whose process is gone but whose row never reached a terminal state. */
  zombies: number
  /** Leases released because the run behind them had already ended. */
  leasesReleased: number
  /** Worktrees left in place because a cleanup gate refused. */
  retainedWorktrees: WorktreeCleanupDecision[]
}

// --- Work items, dependencies, and convoys (§6.2, C8) ---

export type WorkItemStatus = 'open' | 'blocked' | 'assigned' | 'in_progress' | 'review' | 'merged' | 'done' | 'failed' | 'cancelled'

/** Work item states from which no further transition happens, so the row is final. */
export const terminalWorkItemStates: readonly WorkItemStatus[] = ['merged', 'done', 'failed', 'cancelled']

/**
 * The dependency states that release a blocker. Only success unblocks: a failed
 * dependency is a decision a human or a supervisor has to make, not a condition
 * the board resolves by itself.
 */
export const satisfiedDependencyStates: readonly WorkItemStatus[] = ['done', 'merged']

export type IssueType = 'task' | 'bug' | 'question' | 'escalation' | 'workflow_step'

export interface WorkItem {
  id: string
  scope: ScopeRef
  title: string
  description: string
  status: WorkItemStatus
  priority: number
  issueType: IssueType
  /** The actor that created the item; ownership of the record, not of the work. */
  ownerActorId: string
  /** The actor that claimed the item or was assigned to it. A claim is a lease, not a label. */
  assigneeActorId?: string
  convoyId?: string
  sourceTriggerId?: string
  metadata: Record<string, unknown>
  /** Bumped on every mutation, so event keys stay unique per applied change. */
  revision: number
  createdAt: string
  updatedAt: string
  closedAt?: string
}

export type WorkDependencyType = 'blocks' | 'tracks' | 'relates'

export interface WorkDependency {
  workItemId: string
  dependsOnId: string
  type: WorkDependencyType
}

/** A blackboard revision: append-only history, one writer at a time (C8, C19). */
export interface WorkPlanRevision {
  workItemId: string
  revision: number
  body: string
  updatedByActorId: string
  updatedAt: string
}

// --- Mail (§6.4, C13) ---

/**
 * Who a message is for, spelled `kind:id`: `actor:<id>`, `agent:<id>`, or
 * `queue:<name>`. A string with a parser rather than a union of objects, so an
 * address is storable, comparable, and addressable from any surface.
 */
export type Address = string

export type AddressKind = 'actor' | 'agent' | 'queue'
export type MessageType = 'task' | 'escalation' | 'notification' | 'reply' | 'handoff' | 'protocol'
export type MessagePriority = 'low' | 'normal' | 'high' | 'urgent'
export type DeliveryMode = 'queue' | 'interrupt'
export type MessageState = 'pending' | 'claimed' | 'delivered' | 'acked' | 'expired'

export interface Message {
  id: string
  scope: ScopeRef
  from: Address
  to?: Address
  queue?: string
  subject: string
  body: string
  type: MessageType
  priority: MessagePriority
  delivery: DeliveryMode
  threadId?: string
  replyTo?: string
  state: MessageState
  claimedBy?: string
  claimedAt?: string
  createdAt: string
  deliveredAt?: string
  ackedAt?: string
}

export interface MessageSummary {
  id: string
  from: Address
  subject: string
  priority: MessagePriority
  snippet: string
}

/**
 * The closed protocol vocabulary (§6.4). Handlers elsewhere are idempotent by
 * message ID and target state; here the set just makes a protocol subject a
 * validated fact rather than a free-text convention.
 */
export const protocolSubjects: readonly string[] = [
  'POLECAT_DONE', 'MERGE_READY', 'MERGED', 'MERGE_FAILED', 'REWORK_REQUEST', 'RECOVERY_NEEDED', 'HANDOFF',
]

// --- Handoffs (§6.5) ---

export type HandoffState = 'open' | 'accepted' | 'expired' | 'cancelled'

export interface Handoff {
  id: string
  scope: ScopeRef
  fromActorId: string
  /** The agent the handoff is offered to; absent means any agent working inside the cwd boundary. */
  toAgentId?: string
  /** Directory boundary: the session that accepts must be working inside it. */
  cwd: string
  summary: string
  openQuestions: string[]
  filesTouched: string[]
  nextSteps: string[]
  state: HandoffState
  /** Who holds the handoff once accepted. */
  ownerActorId?: string
  acceptedByActorId?: string
  createdAt: string
  acceptedAt?: string
}

/** A handoff as a receiving agent sees it in a packet: content and acceptance, no lifecycle noise. */
export interface HandoffView {
  id: string
  fromActorId: string
  cwd: string
  summary: string
  openQuestions: string[]
  filesTouched: string[]
  nextSteps: string[]
  acceptedAt: string
}

// --- Context packet (§6.5, C14) ---

export interface WorkItemSummary {
  id: string
  title: string
  description: string
  status: WorkItemStatus
  priority: number
  assigneeActorId?: string
}

export interface ContextReference {
  uri: string
  kind: ContextKind
  level: ContextLevel
  title: string
  /** Bounded excerpt: the abstract for L0, the overview for L1, a head slice of the body for L2. */
  excerpt?: string
}

export interface SkillReference {
  id: string
  name: string
}

/**
 * C14: the integration boundary between memory and execution. Section order is
 * fixed, stored content never outranks current instructions, and the whole thing
 * is bounded by `byteBudget` so a packet is a prompt, not a dump.
 */
export interface ContextPacket {
  version: 1
  originMarker: string
  runId?: string
  task: WorkItemSummary
  authorityNotice: string
  handoff?: HandoffView
  memory: ContextReference[]
  resources: ContextReference[]
  skills: SkillReference[]
  mail: MessageSummary[]
  operationalWarnings: string[]
  byteBudget: number
  generatedAt: string
}
