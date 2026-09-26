export type ActorType = 'operator' | 'agent' | 'supervisor' | 'merge_coordinator' | 'context_worker' | 'integration' | 'system' | 'viewer'
export type Source = 'desktop' | 'cli' | 'mcp' | 'http' | 'hook' | 'webhook' | 'internal'
export type Capability =
  | 'workspace:read'
  | 'workspace:write'
  | 'work:dispatch'
  | 'work:mutate'
  | 'runtime:control'
  | 'merge:execute'
  /** Releasing a merge onto a protected branch. Separate from `merge:execute` so an agent
   *  that may queue and run the queue still cannot approve its own way onto a protected target. */
  | 'merge:approve'
  | 'context:read'
  | 'context:write'
  | 'event:ingest'
  | 'backup:create'
  /** Reviewing federation imports and deciding quarantined peer records. Separate from `context:read`
   *  so a viewer can watch federation evidence without being able to adopt or reject it. */
  | 'federation:review'
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

// --- Agents, dispatch, supervision, and scheduling (§6.2, §7 Phase 5) ---

/** A dispatchable fleet member: an identity with a profile, skills, and energy. */
export interface Agent {
  id: string
  name: string
  /** The runtime profile the dispatcher launches this agent under. */
  profileId: string
  /** Where the agent works; the packet compiler uses it for handoff eligibility. */
  cwd?: string
  /** Skill tags; dispatch scores candidates by overlap with the task's needs. */
  skills: string[]
  /** Current energy; dispatch prefers higher-energy agents and spends one unit per task. */
  energy: number
  maxEnergy: number
  createdAt: string
  updatedAt: string
}

/** Why a dispatch did not launch: every refusal names its gate. */
export type DispatchRejection =
  | { reason: 'no_eligible_agent'; candidates: number }
  | { reason: 'energy_exhausted'; agentId: string }
  | { reason: 'launch_failed'; agentId: string; error: string }

/** The record of one dispatch attempt: what was routed, to whom, and what happened. */
export interface DispatchOutcome {
  taskId: string
  agent?: Agent
  runId?: string
  rejection?: DispatchRejection
  occurredAt: string
}

/** What one supervision pass found and did. */
export interface SupervisionReport {
  /** Runs seen as live during this pass. */
  inspected: number
  /** Runs marked idle: alive, but silent past the profile's threshold. */
  idled: number
  /** Runs marked stalled: idle past the stall threshold. */
  stalled: number
  /** Runs escalated: stalled past the escalation threshold, or exited with work unfinished. */
  escalated: number
  /** POLECAT_DONE reports processed into work item transitions. */
  completions: number
  /** The event sequence this pass is caught up to. */
  cursor: number
}

/** The weekly digest a scheduled task mails to the operator: counts, not contents. */
export interface FleetDigest {
  generatedAt: string
  liveRuns: number
  openTasks: number
  blockedTasks: number
  inFlightTasks: number
  completedTasks: number
  escalations: number
}

// --- Ingestion, lexical search, and sessions (§7 Phase 6, C12) ---

/** One ingested file: the change-detection record behind the lexical index. */
export interface IngestSource {
  uri: string
  path: string
  scope: ScopeRef
  sha256: string
  sizeBytes: number
  mtimeMs: number
  /** Which parser produced the chunks — provenance survives the index (C12). */
  parser: string
  chunkCount: number
  ingestedAt: string
}

/** What one ingestion pass found and did. */
export interface IngestReport {
  added: number
  updated: number
  unchanged: number
  removed: number
  chunks: number
}

/** A parsed, searchable piece of a source at a fixed tier. */
export interface IngestChunk {
  uri: string
  chunkId: string
  tier: ContextLevel
  title: string
  body: string
}

/** One lexical search result, after fusion. */
export interface SearchHit {
  uri: string
  chunkId: string
  tier: ContextLevel
  title: string
  snippet: string
  /** Fused RRF score; higher is better. Comparable within one query only. */
  score: number
}

/** The durable record of one agent session: a run, distilled. */
export interface SessionRecord {
  id: string
  scope: ScopeRef
  runId?: string
  agentId?: string
  workItemId?: string
  runtimeProfile: string
  branch: string
  startedAt: string
  endedAt?: string
  exitCode?: number
  exitSignal?: string
  /** L0: one line, what this session was. */
  summary?: string
  /** L1: a paragraph, what happened and how it ended. */
  overview?: string
  capturedAt?: string
}

// --- Verified merge queue and convoys (§7 Phase 7, C10, C15, C19, C22) ---

export type MergeRequestState =
  | 'open'
  /** Queued against a protected target: held before any integration until an approver releases it. */
  | 'awaiting_approval'
  | 'preparing'
  | 'gated'
  | 'landing'
  | 'landed'
  | 'failed'
  | 'conflicted'

/** States a merge request never leaves: the record of what shipped, or why it did not. */
export const terminalMergeRequestStates: readonly MergeRequestState[] = ['landed', 'failed', 'conflicted']

/** Every way a merge attempt can die, named — classification drives the reaction (§7 Phase 7). */
export type MergeFailureKind = 'conflict' | 'gate_failure' | 'infrastructure' | 'push_failure' | 'target_moved'

export interface MergeGateResult {
  gate: string
  passed: boolean
  /** Bounded but inspectable: enough to diagnose, never enough to drown the ledger. */
  output: string
}

export interface MergeRequest {
  id: string
  scope: ScopeRef
  workItemId?: string
  runId?: string
  sourceBranch: string
  targetBranch: string
  /** The source head this request was queued at — what was actually asked for. */
  sourceCommit?: string
  /** The target head this request was prepared against; movement invalidates preparation. */
  targetSha: string
  /** The commit that landed on the target, recorded only after the push succeeded (§5.5). */
  mergeCommit?: string
  batchId?: string
  /** The actor that claimed this request under a merge lease, and the token it fenced with (C19). */
  claimedBy?: string
  fencingToken?: number
  claimExpiresAt?: string
  state: MergeRequestState
  failureKind?: MergeFailureKind
  failureDetail?: string
  /** Conflicting paths, captured before the merge is aborted. */
  conflictFiles?: string[]
  gateResults?: MergeGateResult[]
  /** True when the target was protected at enqueue time, so the hold is part of the record. */
  protectedTarget?: boolean
  /** Who released this request onto a protected target, and when. */
  approvedBy?: string
  approvedAt?: string
  createdBy: string
  createdAt: string
  updatedAt: string
  closedAt?: string
}

export type MergeBatchState = 'pending' | 'integrating' | 'landed' | 'isolated'

/** A batch is the queue's atomic unit: it lands together or it bisects (§7 Phase 7). */
export interface MergeBatch {
  id: string
  scope: ScopeRef
  targetBranch: string
  targetSha: string
  mergeRequestIds: string[]
  state: MergeBatchState
  /** When bisecting, the batch this one is narrowing down. */
  isolationOf?: string
  createdAt: string
  updatedAt: string
}

export type ConvoyState = 'active' | 'closed' | 'forced'

/**
 * A convoy is a group of work items that must land together. Closure is a
 * guarded transition — it happens exactly once, no matter how many scanners
 * race to be the one that noticed.
 */
export interface ConvoyRecord {
  id: string
  scope: ScopeRef
  state: ConvoyState
  closedBy?: string
  closedAt?: string
  createdAt: string
}

/** What one convoy scan found and did. */
export interface ConvoyScanReport {
  scanned: number
  /** Convoys closed by this scan (a convoy closed by a concurrent scan counts zero here). */
  closed: number
  /** Items dispatched because their convoy unblocked them. */
  dispatched: number
  /** Items blocked behind work that can no longer proceed. */
  stranded: number
}

// --- Skills (§7 Phase 8) ---

export type SkillState = 'installed' | 'disabled'

/**
 * What a skill declares about itself: the installable unit, before it has a
 * home. `id` doubles as the directory name, so it is validated to a strict
 * charset — a skill can never name a path it should not occupy.
 */
export interface SkillManifest {
  id: string
  name: string
  version: string
  description: string
  /** Match tags; a task that needs one of these gets the skill in its packet. */
  tags: string[]
  /** The instructions handed to an agent that receives this skill. */
  body: string
}

/** An installed skill: its manifest, where it landed, and who put it there. */
export interface SkillRecord extends SkillManifest {
  scope: ScopeRef
  state: SkillState
  /** Path to the skill's directory, always inside the registry root. */
  path: string
  sha256: string
  /** Where it came from: a directory scan, an operator, an integration. */
  source: string
  installedBy: string
  installedAt: string
  updatedAt: string
}

/** What one discovery pass found on disk, and why it rejected what it rejected. */
export interface SkillDiscoveryReport {
  found: SkillManifest[]
  rejected: { path: string; reason: string }[]
}

// --- Declarative workflows and trigger history (§7 Phase 8, C20) ---

export type WorkflowRunState = 'queued' | 'running' | 'cancelled' | 'completed' | 'failed'

export interface WorkflowStep {
  id: string
  type: 'create_work'
  title: string
  description?: string
  priority?: number
  issueType?: IssueType
  requiredSkills?: string[]
}

export interface WorkflowDefinition {
  id: string
  version: string
  name: string
  description: string
  steps: WorkflowStep[]
  enabled: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface WorkflowRun {
  id: string
  scope: ScopeRef
  workflowId: string
  workflowVersion: string
  triggerId: string
  state: WorkflowRunState
  workItemIds: string[]
  createdAt: string
  updatedAt: string
  cancelledAt?: string
  completedAt?: string
}

export interface TriggerRecord {
  id: string
  scope: ScopeRef
  kind: 'manual' | 'webhook' | 'github' | 'slack' | 'feed' | 'schedule' | 'watch'
  workflowId: string
  payload: Record<string, unknown>
  state: 'accepted' | 'duplicate' | 'rejected'
  workflowRunId?: string
  createdAt: string
}

export type ObservationMetricKind = 'provider_health' | 'usage' | 'queue' | 'retrieval'

export interface ObservationMetric {
  id: string
  scope: ScopeRef
  kind: ObservationMetricKind
  name: string
  value: number
  unit: string
  labels: Record<string, string>
  recordedAt: string
}

export type WorkflowScheduleState = 'enabled' | 'disabled'

export interface WorkflowSchedule {
  id: string
  scope: ScopeRef
  workflowId: string
  intervalMs: number
  state: WorkflowScheduleState
  nextRunAt: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

/**
 * A context watch (§7 Phase 8 "watches"): a URI prefix observed for change, so
 * external edits to the canonical context become trigger input rather than
 * something an operator must notice. The `uriPrefix` is canonicalized at
 * registration; `lastObserved` is the content fingerprint at the last pass.
 */
export interface WorkflowWatch {
  id: string
  scope: ScopeRef
  workflowId: string
  /** Canonical `viking://` prefix watched, scope-inclusive. */
  uriPrefix: string
  state: WorkflowScheduleState
  /** Content fingerprint at the last observation; change means due. */
  lastObserved?: string
  nextRunAt: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

/**
 * Queue diagnostics (§7 Phase 8 "queue diagnostics"): one row per durable
 * queue, from the ledger state the queues themselves are built on.
 */
export interface QueueDiagnostic {
  queue: string
  depth: number
  oldestAt?: string
  states: Record<string, number>
}

/** The read-only status snapshot a dashboard, SDK, or operator asks for. */
export interface HiveStatusSnapshot {
  version: string
  scope: { workspace: string; project: string }
  runs: { live: number; total: number }
  work: { open: number; inFlight: number; total: number }
  queues: QueueDiagnostic[]
  triggerIngress: { paused: boolean; breakerFailures: number; recentAccepted: number }
  telemetryEnabled: boolean
}

/** One recorded retrieval trajectory (§7 Phase 8 observability). */
export interface RetrievalTrajectory {
  id: string
  scope: ScopeRef
  query: string
  tiers: string[]
  hitCount: number
  topHitUri?: string
  durationMs: number
  occurredAt: string
}

/** What one voice turn asked for, and how it was answered. */
export type VoiceOutcome =
  | { kind: 'answered'; operation: string; data: unknown }
  | { kind: 'refused'; reason: string; detail: string }

export interface VoiceTurnResult {
  utterance: string
  parsedOperation?: string
  outcome: VoiceOutcome
  occurredAt: string
}
