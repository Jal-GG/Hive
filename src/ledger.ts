import Database from 'better-sqlite3'
import {
  ActorContext,
  Agent,
  AgentProfile,
  ContextIndexEntry,
  ContextKind,
  ContextLevel,
  ContextLinkRef,
  ContextNode,
  ContextSnapshotManifest,
  ContextTombstone,
  EventEnvelope,
  Handoff,
  IngestChunk,
  IngestSource,
  Lease,
  MergeBatch,
  MergeGateResult,
  MergeRequest,
  MergeRequestState,
  Message,
  MessageState,
  Run,
  RunState,
  ScopeRef,
  SessionRecord,
  ConvoyRecord,
  SkillRecord,
  WorkflowDefinition,
  WorkflowRun,
  TriggerRecord,
  ObservationMetric,
  WorkflowSchedule,
  WorkflowWatch,
  QueueDiagnostic,
  RetrievalTrajectory,
  WorkDependency,
  WorkItem,
  WorkItemStatus,
  WorkPlanRevision,
  WorktreeRef,
  terminalRunStates,
} from './contracts.js'
import { HiveError } from './errors.js'
import { SqliteDatabase } from './sqlite-database.js'
import { createId } from './shared.js'
import { Clock, ClockOptions, resolveClock } from './shared.js'
import { assertCapability } from './capabilities.js'
import { validateScopeName } from './resource-uri.js'

export type LedgerOptions = ClockOptions

const INDEX_COLUMNS = 'SELECT uri, kind, level, title, sha256, version, updated_at FROM context_nodes'

/** Tombstones store scope ids; names are joined back so callers get a complete `ScopeRef`. */
const TOMBSTONE_COLUMNS = `SELECT t.uri, t.path, t.version, t.sha256, t.deleted_at, t.deleted_by, t.commit_hash,
    t.workspace_id, t.project_id, w.name AS workspace_name, p.name AS project_name
  FROM context_tombstones t
  JOIN workspaces w ON w.id = t.workspace_id
  JOIN projects p ON p.id = t.project_id
  WHERE 1 = 1`

/** Runs store scope ids; names are joined back so every `Run` carries a complete `ScopeRef`. */
const RUN_COLUMNS = `SELECT r.*, w.name AS workspace_name, p.name AS project_name
  FROM runs r
  JOIN workspaces w ON w.id = r.workspace_id
  JOIN projects p ON p.id = r.project_id
  WHERE 1 = 1`

/** Fields of a run that may change after insert. Everything else is fixed at launch. */
export interface RunPatch {
  state?: RunState
  sessionKey?: string
  pid?: number | null
  endedAt?: string | null
  exitCode?: number | null
  exitSignal?: string | null
  transcriptCursor?: string | null
  importedEventCount?: number
  lostEventCount?: number
}

const runPatchColumns: Record<keyof RunPatch, string> = {
  state: 'state',
  sessionKey: 'session_key',
  pid: 'pid',
  endedAt: 'ended_at',
  exitCode: 'exit_code',
  exitSignal: 'exit_signal',
  transcriptCursor: 'transcript_cursor',
  importedEventCount: 'imported_event_count',
  lostEventCount: 'lost_event_count',
}

interface EventRow {
  event_id: string
  idempotency_key: string
  event_type: EventEnvelope['eventType']
  source: string
  actor_id: string
  workspace_id: string | null
  project_id: string | null
  run_id: string | null
  work_item_id: string | null
  occurred_at: string
  sequence: number | null
  payload: string
  parent_event_id: string | null
  origin_marker: string
}

interface ActorRow {
  id: string
  type: ActorContext['actorType']
  display_name: string
  source: ActorContext['source']
  capabilities: string
  workspace_id: string | null
  project_id: string | null
}

interface IngestSourceRow {
  uri: string
  path: string
  workspace_id: string
  project_id: string
  sha256: string
  size_bytes: number
  mtime_ms: number
  parser: string
  chunk_count: number
  ingested_at: string
}

/** Sources and sessions store scope ids; names are joined back like every other scoped row. */
const INGEST_SOURCE_COLUMNS = `SELECT i.*, w.name AS workspace_name, p.name AS project_name
  FROM ingest_sources i
  JOIN workspaces w ON w.id = i.workspace_id
  JOIN projects p ON p.id = i.project_id
  WHERE 1 = 1`

const SESSION_COLUMNS = `SELECT s.*, w.name AS workspace_name, p.name AS project_name
  FROM sessions s
  JOIN workspaces w ON w.id = s.workspace_id
  JOIN projects p ON p.id = s.project_id
  WHERE 1 = 1`

const MERGE_REQUEST_COLUMNS = `SELECT m.*, w.name AS workspace_name, p.name AS project_name
  FROM merge_requests m
  JOIN workspaces w ON w.id = m.workspace_id
  JOIN projects p ON p.id = m.project_id
  WHERE 1 = 1`

const MERGE_BATCH_COLUMNS = `SELECT b.*, w.name AS workspace_name, p.name AS project_name
  FROM merge_batches b
  JOIN workspaces w ON w.id = b.workspace_id
  JOIN projects p ON p.id = b.project_id
  WHERE 1 = 1`

const CONVOY_COLUMNS = `SELECT c.*, w.name AS workspace_name, p.name AS project_name
  FROM convoys c
  JOIN workspaces w ON w.id = c.workspace_id
  JOIN projects p ON p.id = c.project_id
  WHERE 1 = 1`

const SKILL_COLUMNS = `SELECT s.*, w.name AS workspace_name, p.name AS project_name
  FROM skills s
  JOIN workspaces w ON w.id = s.workspace_id
  JOIN projects p ON p.id = s.project_id
  WHERE 1 = 1`

/** One ranked row from the FTS index: identity, tier, snippet, and the raw BM25 score. */
export interface RankedChunk {
  uri: string
  chunkId: string
  tier: ContextLevel
  title: string
  snippet: string
  /** FTS5's bm25(): negative, smaller (more negative) is better. */
  bm25: number
}

function toIngestSource(row: IngestSourceRow & ScopeRow): IngestSource {
  return {
    uri: row.uri,
    path: row.path,
    scope: toScope(row),
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    mtimeMs: row.mtime_ms,
    parser: row.parser,
    chunkCount: row.chunk_count,
    ingestedAt: row.ingested_at,
  }
}

interface SessionRow {
  id: string
  workspace_id: string
  project_id: string
  run_id: string | null
  agent_id: string | null
  work_item_id: string | null
  runtime_profile: string
  branch: string
  started_at: string
  ended_at: string | null
  exit_code: number | null
  exit_signal: string | null
  summary: string | null
  overview: string | null
  captured_at: string | null
}

interface MergeRequestRow extends ScopeRow {
  id: string
  work_item_id: string | null
  run_id: string | null
  source_branch: string
  target_branch: string
  source_commit: string | null
  target_sha: string
  merge_commit: string | null
  batch_id: string | null
  claimed_by: string | null
  fencing_token: number | null
  claim_expires_at: string | null
  state: MergeRequestState
  failure_kind: string | null
  failure_detail: string | null
  conflict_files: string | null
  gate_results: string | null
  protected_target: number
  approved_by: string | null
  approved_at: string | null
  created_by: string
  created_at: string
  updated_at: string
  closed_at: string | null
}

interface MergeBatchRow extends ScopeRow {
  id: string
  target_branch: string
  target_sha: string
  merge_request_ids: string
  state: MergeBatch['state']
  isolation_of: string | null
  created_at: string
  updated_at: string
}

interface ConvoyRow extends ScopeRow {
  id: string
  state: ConvoyRecord['state']
  closed_by: string | null
  closed_at: string | null
  created_at: string
}

interface SkillRow extends ScopeRow {
  id: string
  name: string
  version: string
  description: string
  tags: string
  body: string
  state: SkillRecord['state']
  path: string
  sha256: string
  source: string
  installed_by: string
  installed_at: string
  updated_at: string
}

interface WorkflowDefinitionRow {
  id: string
  version: string
  name: string
  description: string
  steps: string
  enabled: number
  created_by: string
  created_at: string
  updated_at: string
}

interface WorkflowRunRow extends ScopeRow {
  id: string
  workflow_id: string
  workflow_version: string
  trigger_id: string
  state: WorkflowRun['state']
  work_item_ids: string
  created_at: string
  updated_at: string
  cancelled_at: string | null
  completed_at: string | null
}

interface TriggerRecordRow extends ScopeRow {
  id: string
  kind: TriggerRecord['kind']
  workflow_id: string
  payload: string
  state: TriggerRecord['state']
  workflow_run_id: string | null
  created_at: string
}

function toSkill(row: SkillRow): SkillRecord {
  return {
    id: row.id,
    scope: toScope(row),
    name: row.name,
    version: row.version,
    description: row.description,
    tags: JSON.parse(row.tags) as string[],
    body: row.body,
    state: row.state,
    path: row.path,
    sha256: row.sha256,
    source: row.source,
    installedBy: row.installed_by,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  }
}

function toMergeRequest(row: MergeRequestRow): MergeRequest {
  return {
    id: row.id,
    scope: toScope(row),
    workItemId: row.work_item_id ?? undefined,
    runId: row.run_id ?? undefined,
    sourceBranch: row.source_branch,
    targetBranch: row.target_branch,
    sourceCommit: row.source_commit ?? undefined,
    targetSha: row.target_sha,
    mergeCommit: row.merge_commit ?? undefined,
    batchId: row.batch_id ?? undefined,
    claimedBy: row.claimed_by ?? undefined,
    fencingToken: row.fencing_token ?? undefined,
    claimExpiresAt: row.claim_expires_at ?? undefined,
    state: row.state,
    failureKind: (row.failure_kind as MergeRequest['failureKind']) ?? undefined,
    failureDetail: row.failure_detail ?? undefined,
    conflictFiles: row.conflict_files ? (JSON.parse(row.conflict_files) as string[]) : undefined,
    gateResults: row.gate_results ? (JSON.parse(row.gate_results) as MergeGateResult[]) : undefined,
    protectedTarget: row.protected_target === 1 ? true : undefined,
    approvedBy: row.approved_by ?? undefined,
    approvedAt: row.approved_at ?? undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at ?? undefined,
  }
}

function toMergeBatch(row: MergeBatchRow): MergeBatch {
  return {
    id: row.id,
    scope: toScope(row),
    targetBranch: row.target_branch,
    targetSha: row.target_sha,
    mergeRequestIds: JSON.parse(row.merge_request_ids) as string[],
    state: row.state,
    isolationOf: row.isolation_of ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toConvoy(row: ConvoyRow): ConvoyRecord {
  return {
    id: row.id,
    scope: toScope(row),
    state: row.state,
    closedBy: row.closed_by ?? undefined,
    closedAt: row.closed_at ?? undefined,
    createdAt: row.created_at,
  }
}

function toSession(row: SessionRow & ScopeRow): SessionRecord {
  return {
    id: row.id,
    scope: toScope(row),
    runId: row.run_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    workItemId: row.work_item_id ?? undefined,
    runtimeProfile: row.runtime_profile,
    branch: row.branch,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    exitCode: row.exit_code ?? undefined,
    exitSignal: row.exit_signal ?? undefined,
    summary: row.summary ?? undefined,
    overview: row.overview ?? undefined,
    capturedAt: row.captured_at ?? undefined,
  }
}

interface ScopeRow {
  workspace_id: string
  project_id: string
  workspace_name: string
  project_name: string
}

interface IndexRow {
  uri: string
  kind: ContextKind
  level: ContextLevel
  title: string
  sha256: string
  version: number
  updated_at: string
}

interface TombstoneRow extends ScopeRow {
  uri: string
  path: string
  version: number
  sha256: string
  deleted_at: string
  deleted_by: string
  commit_hash: string | null
}

interface LinkRow {
  from_uri: string
  to_uri: string
  cross_project: number
}

interface RunRow extends ScopeRow {
  id: string
  work_item_id: string | null
  actor_id: string
  agent_id: string | null
  runtime_profile: string
  backend: Run['backend']
  session_key: string
  cwd: string
  repo_fingerprint: string
  worktree_fingerprint: string
  branch: string
  state: RunState
  lease_id: string
  started_at: string
  ended_at: string | null
  exit_code: number | null
  exit_signal: string | null
  pid: number | null
  transcript_cursor: string | null
  imported_event_count: number
  lost_event_count: number
}

interface WorktreeRow {
  run_id: string
  path: string
  branch: string
  base_branch: string
  base_commit: string | null
  repo_fingerprint: string
  worktree_fingerprint: string
  created_at: string
}

function assertEventLimit(limit: number): void {
  if (limit < 1 || limit > 1000) throw new HiveError('INVALID_LIMIT', 'Event limit must be between 1 and 1000')
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    workItemId: row.work_item_id ?? undefined,
    actorId: row.actor_id,
    agentId: row.agent_id ?? undefined,
    scope: toScope(row),
    runtimeProfile: row.runtime_profile,
    backend: row.backend,
    sessionKey: row.session_key,
    cwd: row.cwd,
    repoFingerprint: row.repo_fingerprint,
    worktreeFingerprint: row.worktree_fingerprint,
    branch: row.branch,
    state: row.state,
    leaseId: row.lease_id,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    exitCode: row.exit_code ?? undefined,
    exitSignal: row.exit_signal ?? undefined,
    pid: row.pid ?? undefined,
    transcriptCursor: row.transcript_cursor ?? undefined,
    importedEventCount: row.imported_event_count,
    lostEventCount: row.lost_event_count,
  }
}

function toWorktree(row: WorktreeRow): WorktreeRef {
  return {
    runId: row.run_id, path: row.path, branch: row.branch, baseBranch: row.base_branch,
    baseCommit: row.base_commit ?? undefined, repoFingerprint: row.repo_fingerprint,
    worktreeFingerprint: row.worktree_fingerprint, createdAt: row.created_at,
  }
}

function toIndexEntry(row: IndexRow): ContextIndexEntry {
  return { uri: row.uri, kind: row.kind, level: row.level, title: row.title, sha256: row.sha256, version: row.version, updatedAt: row.updated_at }
}

function toScope(row: ScopeRow): ScopeRef {
  return { workspaceId: row.workspace_id, projectId: row.project_id, workspaceName: row.workspace_name, projectName: row.project_name }
}

function toTombstone(row: TombstoneRow): ContextTombstone {
  return {
    uri: row.uri, path: row.path, scope: toScope(row), version: row.version, sha256: row.sha256,
    deletedAt: row.deleted_at, deletedBy: row.deleted_by, commit: row.commit_hash ?? undefined,
  }
}

// --- Work plane rows (§6.2, §6.4, §6.5): names joined back like every other scope-carrying row ---

/** Work items store scope ids; names are joined back so every row carries a complete `ScopeRef`. */
const WORK_ITEM_COLUMNS = `SELECT i.*, w.name AS workspace_name, p.name AS project_name
  FROM work_items i
  JOIN workspaces w ON w.id = i.workspace_id
  JOIN projects p ON p.id = i.project_id
  WHERE 1 = 1`

const MESSAGE_COLUMNS = `SELECT m.*, w.name AS workspace_name, p.name AS project_name
  FROM messages m
  JOIN workspaces w ON w.id = m.workspace_id
  JOIN projects p ON p.id = m.project_id
  WHERE 1 = 1`

const HANDOFF_COLUMNS = `SELECT h.*, w.name AS workspace_name, p.name AS project_name
  FROM handoffs h
  JOIN workspaces w ON w.id = h.workspace_id
  JOIN projects p ON p.id = h.project_id
  WHERE 1 = 1`

interface WorkItemRow extends ScopeRow {
  id: string
  title: string
  description: string
  status: WorkItemStatus
  priority: number
  issue_type: WorkItem['issueType']
  owner_actor_id: string
  assignee_actor_id: string | null
  convoy_id: string | null
  source_trigger_id: string | null
  metadata: string
  revision: number
  created_at: string
  updated_at: string
  closed_at: string | null
}

interface DependencyRow {
  work_item_id: string
  depends_on_id: string
  type: WorkDependency['type']
}

interface MessageRow extends ScopeRow {
  id: string
  from_address: string
  to_address: string | null
  queue: string | null
  subject: string
  body: string
  type: Message['type']
  priority: Message['priority']
  delivery: Message['delivery']
  thread_id: string | null
  reply_to: string | null
  state: MessageState
  claimed_by: string | null
  claimed_at: string | null
  created_at: string
  delivered_at: string | null
  acked_at: string | null
}

interface HandoffRow extends ScopeRow {
  id: string
  from_actor: string
  to_agent: string | null
  cwd: string
  summary: string
  open_questions: string
  files_touched: string
  next_steps: string
  state: Handoff['state']
  owner_actor: string | null
  accepted_by: string | null
  created_at: string
  accepted_at: string | null
}

interface LeaseRow {
  id: string
  resource_type: Lease['resourceType']
  resource_id: string
  owner_actor_id: string
  fencing_token: number
  acquired_at: string
  expires_at: string
  state: Lease['state']
}

function toWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    scope: toScope(row),
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    issueType: row.issue_type,
    ownerActorId: row.owner_actor_id,
    assigneeActorId: row.assignee_actor_id ?? undefined,
    convoyId: row.convoy_id ?? undefined,
    sourceTriggerId: row.source_trigger_id ?? undefined,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at ?? undefined,
  }
}

function toDependency(row: DependencyRow): WorkDependency {
  return { workItemId: row.work_item_id, dependsOnId: row.depends_on_id, type: row.type }
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    scope: toScope(row),
    from: row.from_address,
    to: row.to_address ?? undefined,
    queue: row.queue ?? undefined,
    subject: row.subject,
    body: row.body,
    type: row.type,
    priority: row.priority,
    delivery: row.delivery,
    threadId: row.thread_id ?? undefined,
    replyTo: row.reply_to ?? undefined,
    state: row.state,
    claimedBy: row.claimed_by ?? undefined,
    claimedAt: row.claimed_at ?? undefined,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? undefined,
    ackedAt: row.acked_at ?? undefined,
  }
}

function toHandoff(row: HandoffRow): Handoff {
  return {
    id: row.id,
    scope: toScope(row),
    fromActorId: row.from_actor,
    toAgentId: row.to_agent ?? undefined,
    cwd: row.cwd,
    summary: row.summary,
    openQuestions: JSON.parse(row.open_questions) as string[],
    filesTouched: JSON.parse(row.files_touched) as string[],
    nextSteps: JSON.parse(row.next_steps) as string[],
    state: row.state,
    ownerActorId: row.owner_actor ?? undefined,
    acceptedByActorId: row.accepted_by ?? undefined,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at ?? undefined,
  }
}

function toLease(row: LeaseRow): Lease {
  return {
    id: row.id, resourceType: row.resource_type, resourceId: row.resource_id, ownerActorId: row.owner_actor_id,
    fencingToken: row.fencing_token, acquiredAt: row.acquired_at, expiresAt: row.expires_at, state: row.state,
  }
}

interface AgentRow {
  id: string
  name: string
  profile_id: string
  cwd: string | null
  skills: string
  energy: number
  max_energy: number
  created_at: string
  updated_at: string
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    profileId: row.profile_id,
    cwd: row.cwd ?? undefined,
    skills: JSON.parse(row.skills) as string[],
    energy: row.energy,
    maxEnergy: row.max_energy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Fields of a work item that may change after create. Everything else is fixed at creation. */
export interface WorkItemPatch {
  status?: WorkItemStatus
  assigneeActorId?: string | null
  closedAt?: string | null
}

const workItemPatchColumns: Record<keyof WorkItemPatch, string> = {
  status: 'status',
  assigneeActorId: 'assignee_actor_id',
  closedAt: 'closed_at',
}

/** The one message state change a sender can cause: an interrupt that reached a live session. */
export interface MessagePatch {
  state: MessageState
  deliveredAt?: string
}

const messagePatchColumns: Record<keyof MessagePatch, string> = {
  state: 'state',
  deliveredAt: 'delivered_at',
}

export class Ledger {
  private readonly sqlite: SqliteDatabase
  private readonly now: Clock
  private readonly statements = new Map<string, Database.Statement>()

  constructor(fileName: string, options: LedgerOptions = {}) {
    this.sqlite = new SqliteDatabase(fileName, options)
    this.now = resolveClock(options)
  }

  close(): void {
    this.statements.clear()
    this.sqlite.close()
  }

  /** Narrow accessor for health checks; the connection itself stays inside `SqliteDatabase`. */
  pragma(name: string): unknown {
    return this.sqlite.pragma(name)
  }

  createWorkspace(name: string): string {
    validateScopeName(name, 'workspace name')
    const workspaceId = createId()
    this.statement('INSERT INTO workspaces(id, name, created_at) VALUES (?, ?, ?)').run(workspaceId, name, this.timestamp())
    return workspaceId
  }

  /** Lookup by human name: bootstrap needs to tell "absent" from "already created" (§7 Phase 1). */
  workspaceByName(name: string): string | undefined {
    const row = this.statement('SELECT id FROM workspaces WHERE name = ?').get(name) as { id: string } | undefined
    return row?.id
  }

  createProject(workspaceId: string, name: string): string {
    validateScopeName(name, 'project name')
    const projectId = createId()
    this.statement('INSERT INTO projects(id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)').run(projectId, workspaceId, name, this.timestamp())
    return projectId
  }

  /**
   * Restore provisioning: re-create a scope carrying its *original* ids, so
   * replayed events' scope references resolve on the restored ledger. The
   * regular creators mint fresh ids, which is right for live use and wrong for
   * restore. No-op when the ids already exist; a name that collides with a
   * different id fails loudly rather than silently re-pointing the scope.
   */
  restoreScope(scope: ScopeRef): void {
    validateScopeName(scope.workspaceName, 'workspace name')
    validateScopeName(scope.projectName, 'project name')
    if (!this.statement('SELECT 1 FROM workspaces WHERE id = ?').get(scope.workspaceId)) {
      this.statement('INSERT INTO workspaces(id, name, created_at) VALUES (?, ?, ?)').run(scope.workspaceId, scope.workspaceName, this.timestamp())
    }
    if (!this.statement('SELECT 1 FROM projects WHERE id = ?').get(scope.projectId)) {
      this.statement('INSERT INTO projects(id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)').run(scope.projectId, scope.workspaceId, scope.projectName, this.timestamp())
    }
  }

  projectByName(workspaceId: string, name: string): string | undefined {
    const row = this.statement('SELECT id FROM projects WHERE workspace_id = ? AND name = ?').get(workspaceId, name) as { id: string } | undefined
    return row?.id
  }

  createActor(actor: ActorContext): void {
    this.statement(`INSERT INTO actors(id, type, display_name, source, capabilities, workspace_id, project_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      actor.actorId,
      actor.actorType,
      actor.displayName,
      actor.source,
      JSON.stringify(actor.capabilities),
      actor.workspaceId ?? null,
      actor.projectId ?? null,
      this.timestamp(),
    )
  }

  appendEvent(event: EventEnvelope): boolean {
    return this.sqlite.transaction(() => {
      const duplicate = this.statement('SELECT 1 FROM events WHERE event_id = ? OR idempotency_key = ?').get(event.eventId, event.idempotencyKey)
      if (duplicate) return false
      const cursor = this.statement('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM events').get() as { sequence: number }
      this.statement(`INSERT INTO events
        (event_id, idempotency_key, event_type, source, actor_id, workspace_id, project_id, run_id, work_item_id, occurred_at, sequence, payload, parent_event_id, origin_marker)
        VALUES (@eventId, @idempotencyKey, @eventType, @source, @actorId, @workspaceId, @projectId, @runId, @workItemId, @occurredAt, @sequence, @payload, @parentEventId, @originMarker)`).run({
        eventId: event.eventId,
        idempotencyKey: event.idempotencyKey,
        eventType: event.eventType,
        source: event.source,
        actorId: event.actor.actorId,
        workspaceId: event.scope?.workspaceId ?? null,
        projectId: event.scope?.projectId ?? null,
        runId: event.runId ?? null,
        workItemId: event.workItemId ?? null,
        occurredAt: event.occurredAt,
        sequence: cursor.sequence,
        payload: JSON.stringify(event.payload),
        parentEventId: event.parentEventId ?? null,
        originMarker: event.originMarker,
      })
      return true
    })
  }

  readEvents(afterSequence = 0, limit = 100): EventEnvelope[] {
    assertEventLimit(limit)
    // Plain `sequence` (never null on insert) so events_sequence_idx is usable.
    const rows = this.statement('SELECT * FROM events WHERE sequence > ? ORDER BY sequence, event_id LIMIT ?').all(afterSequence, limit) as EventRow[]
    return this.toEnvelopes(rows)
  }

  /** One run's history, for a terminal view or a post-mortem, without scanning the whole log. */
  readRunEvents(runId: string, afterSequence = 0, limit = 100): EventEnvelope[] {
    assertEventLimit(limit)
    const rows = this.statement('SELECT * FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence, event_id LIMIT ?').all(runId, afterSequence, limit) as EventRow[]
    return this.toEnvelopes(rows)
  }

  /** The newest assigned sequence, so a subscriber can start at "now" instead of replaying history. */
  latestEventSequence(): number {
    return (this.statement('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events').get() as { sequence: number }).sequence
  }

  private toEnvelopes(rows: readonly EventRow[]): EventEnvelope[] {
    const actors = new Map<string, ActorContext>()
    const scopes = new Map<string, ScopeRef>()
    return rows.map((row) => ({
      version: 1 as const,
      eventId: row.event_id,
      idempotencyKey: row.idempotency_key,
      eventType: row.event_type,
      source: row.source,
      actor: this.cached(actors, row.actor_id, () => this.actor(row.actor_id)),
      scope: row.workspace_id && row.project_id
        ? this.cached(scopes, `${row.workspace_id}:${row.project_id}`, () => this.scope(row.workspace_id!, row.project_id!))
        : undefined,
      runId: row.run_id ?? undefined,
      workItemId: row.work_item_id ?? undefined,
      occurredAt: row.occurred_at,
      sequence: row.sequence ?? undefined,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      parentEventId: row.parent_event_id ?? undefined,
      originMarker: row.origin_marker,
    }))
  }

  acquireLease(actor: ActorContext, resourceType: Lease['resourceType'], resourceId: string, ttlMs: number): Lease {
    assertCapability(actor.capabilities, 'work:dispatch')
    if (ttlMs <= 0 || ttlMs > 24 * 60 * 60 * 1000) throw new HiveError('INVALID_TTL', 'Lease TTL must be positive and no longer than 24 hours')
    const now = this.now()
    const expiresAt = new Date(now.getTime() + ttlMs)
    return this.sqlite.transaction(() => {
      this.statement("UPDATE leases SET state = 'expired' WHERE resource_type = ? AND resource_id = ? AND state = 'active' AND expires_at <= ?").run(resourceType, resourceId, now.toISOString())
      const existing = this.statement("SELECT 1 FROM leases WHERE resource_type = ? AND resource_id = ? AND state = 'active'").get(resourceType, resourceId)
      if (existing) throw new HiveError('LEASE_CONFLICT', 'Resource already has an active lease')
      const previous = this.statement('SELECT MAX(fencing_token) AS token FROM leases WHERE resource_type = ? AND resource_id = ?').get(resourceType, resourceId) as { token: number | null }
      const lease: Lease = {
        id: createId(), resourceType, resourceId, ownerActorId: actor.actorId,
        fencingToken: (previous.token ?? 0) + 1, acquiredAt: now.toISOString(), expiresAt: expiresAt.toISOString(), state: 'active',
      }
      this.statement(`INSERT INTO leases(id, resource_type, resource_id, owner_actor_id, fencing_token, acquired_at, expires_at, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(lease.id, lease.resourceType, lease.resourceId, lease.ownerActorId, lease.fencingToken, lease.acquiredAt, lease.expiresAt, lease.state)
      return lease
    })
  }

  releaseLease(actor: ActorContext, leaseId: string): void {
    const result = this.statement("UPDATE leases SET state = 'released' WHERE id = ? AND owner_actor_id = ? AND state = 'active'").run(leaseId, actor.actorId)
    if (result.changes !== 1) throw new HiveError('LEASE_NOT_OWNED', 'Active lease not found for actor')
  }

  activeLeaseCount(): number {
    return (this.statement("SELECT COUNT(*) AS count FROM leases WHERE state = 'active'").get() as { count: number }).count
  }

  backup(destination: string): Promise<void> {
    return this.sqlite.backup(destination)
  }

  /** Resolves the names in a `viking://` URI to the scope's ids. */
  resolveScope(workspaceName: string, projectName: string): ScopeRef {
    const row = this.statement(`SELECT w.id AS workspace_id, p.id AS project_id, w.name AS workspace_name, p.name AS project_name
      FROM projects p JOIN workspaces w ON w.id = p.workspace_id WHERE w.name = ? AND p.name = ?`).get(workspaceName, projectName) as ScopeRow | undefined
    if (!row) throw new HiveError('SCOPE_NOT_FOUND', `No project ${workspaceName}/${projectName}`)
    return toScope(row)
  }

  // --- Derived context index (C15: canonical files are the source of truth; these rows follow) ---

  upsertContextNode(node: ContextNode): void {
    this.statement(`INSERT INTO context_nodes(uri, workspace_id, project_id, kind, level, title, sha256, version, provenance, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uri) DO UPDATE SET kind=excluded.kind, level=excluded.level, title=excluded.title, sha256=excluded.sha256, version=excluded.version, provenance=excluded.provenance, updated_at=excluded.updated_at`).run(
      node.uri, node.scope.workspaceId, node.scope.projectId, node.kind, node.level, node.title, node.sha256, node.version, JSON.stringify(node.provenance), this.timestamp(),
    )
  }

  removeContextNode(uri: string): void {
    this.statement('DELETE FROM context_nodes WHERE uri = ?').run(uri)
  }

  contextNode(uri: string): ContextIndexEntry | undefined {
    const row = this.statement(`${INDEX_COLUMNS} WHERE uri = ?`).get(uri) as IndexRow | undefined
    return row ? toIndexEntry(row) : undefined
  }

  listContextNodes(scope: ScopeRef): ContextIndexEntry[] {
    const rows = this.statement(`${INDEX_COLUMNS} WHERE workspace_id = ? AND project_id = ? ORDER BY uri`).all(scope.workspaceId, scope.projectId) as IndexRow[]
    return rows.map(toIndexEntry)
  }

  // --- Tombstones (C18: a deletion is a durable record, not an absence) ---

  insertTombstone(tombstone: ContextTombstone): void {
    this.statement(`INSERT INTO context_tombstones(uri, workspace_id, project_id, path, version, sha256, deleted_at, deleted_by, commit_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uri) DO UPDATE SET path=excluded.path, version=excluded.version, sha256=excluded.sha256, deleted_at=excluded.deleted_at, deleted_by=excluded.deleted_by, commit_hash=excluded.commit_hash`).run(
      tombstone.uri, tombstone.scope.workspaceId, tombstone.scope.projectId, tombstone.path,
      tombstone.version, tombstone.sha256, tombstone.deletedAt, tombstone.deletedBy, tombstone.commit ?? null,
    )
  }

  /** Recorded after the fact: the deletion commit only exists once the delete has been committed. */
  setTombstoneCommit(uri: string, commit: string): void {
    this.statement('UPDATE context_tombstones SET commit_hash = ? WHERE uri = ?').run(commit, uri)
  }

  tombstone(uri: string): ContextTombstone | undefined {
    const row = this.statement(`${TOMBSTONE_COLUMNS} AND t.uri = ?`).get(uri) as TombstoneRow | undefined
    return row ? toTombstone(row) : undefined
  }

  listTombstones(scope: ScopeRef): ContextTombstone[] {
    const rows = this.statement(`${TOMBSTONE_COLUMNS} AND t.workspace_id = ? AND t.project_id = ? ORDER BY t.uri`).all(scope.workspaceId, scope.projectId) as TombstoneRow[]
    return rows.map(toTombstone)
  }

  removeTombstone(uri: string): void {
    this.statement('DELETE FROM context_tombstones WHERE uri = ?').run(uri)
  }

  // --- Links (C3: a link that leaves the project is recorded so it can be audited) ---

  /** Replaces the whole outbound link set for one node, so removed links disappear. */
  replaceContextLinks(fromUri: string, scope: ScopeRef, links: readonly ContextLinkRef[]): void {
    this.sqlite.transaction(() => {
      this.removeContextLinks(fromUri)
      const insert = this.statement('INSERT OR REPLACE INTO context_links(from_uri, to_uri, workspace_id, project_id, cross_project) VALUES (?, ?, ?, ?, ?)')
      for (const link of links) insert.run(fromUri, link.toUri, scope.workspaceId, scope.projectId, link.crossProject ? 1 : 0)
    })
  }

  listContextLinks(scope: ScopeRef): ContextLinkRef[] {
    const rows = this.statement('SELECT from_uri, to_uri, cross_project FROM context_links WHERE workspace_id = ? AND project_id = ? ORDER BY from_uri, to_uri').all(scope.workspaceId, scope.projectId) as LinkRow[]
    // `resolved` depends on the filesystem, so the caller decides it; the row only records intent.
    return rows.map((row) => ({ fromUri: row.from_uri, toUri: row.to_uri, crossProject: row.cross_project === 1, resolved: false }))
  }

  removeContextLinks(fromUri: string): void {
    this.statement('DELETE FROM context_links WHERE from_uri = ?').run(fromUri)
  }

  // --- Snapshots (C22: content snapshots carry their own manifests) ---

  insertSnapshot(manifest: ContextSnapshotManifest): void {
    this.statement(`INSERT INTO context_snapshots(id, workspace_id, project_id, label, ref, commit_hash, created_at, created_by, node_count, total_bytes, manifest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      manifest.snapshotId, manifest.scope.workspaceId, manifest.scope.projectId, manifest.label, manifest.ref,
      manifest.commit, manifest.createdAt, manifest.createdBy, manifest.nodeCount, manifest.totalBytes, JSON.stringify(manifest),
    )
  }

  listSnapshots(scope: ScopeRef): ContextSnapshotManifest[] {
    const rows = this.statement('SELECT manifest FROM context_snapshots WHERE workspace_id = ? AND project_id = ? ORDER BY created_at DESC, id').all(scope.workspaceId, scope.projectId) as { manifest: string }[]
    return rows.map((row) => JSON.parse(row.manifest) as ContextSnapshotManifest)
  }

  // --- Agent profiles, runs, and worktrees (§6.3) ---

  /** Profiles are content-addressed by id: re-registering the same id updates it in place. */
  upsertAgentProfile(profile: AgentProfile): void {
    this.statement(`INSERT INTO agent_profiles(id, provider, backend, executable, definition, registered_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, backend=excluded.backend, executable=excluded.executable, definition=excluded.definition, registered_at=excluded.registered_at`).run(
      profile.id, profile.provider, profile.backend, profile.executable, JSON.stringify(profile), this.timestamp(),
    )
  }

  agentProfile(id: string): AgentProfile | undefined {
    const row = this.statement('SELECT definition FROM agent_profiles WHERE id = ?').get(id) as { definition: string } | undefined
    return row ? (JSON.parse(row.definition) as AgentProfile) : undefined
  }

  listAgentProfiles(): AgentProfile[] {
    const rows = this.statement('SELECT definition FROM agent_profiles ORDER BY id').all() as { definition: string }[]
    return rows.map((row) => JSON.parse(row.definition) as AgentProfile)
  }

  insertRun(run: Run): void {
    this.statement(`INSERT INTO runs
      (id, work_item_id, actor_id, agent_id, workspace_id, project_id, runtime_profile, backend, session_key, cwd,
       repo_fingerprint, worktree_fingerprint, branch, state, lease_id, started_at, ended_at, exit_code, exit_signal,
       pid, transcript_cursor, imported_event_count, lost_event_count)
      VALUES (@id, @workItemId, @actorId, @agentId, @workspaceId, @projectId, @runtimeProfile, @backend, @sessionKey, @cwd,
       @repoFingerprint, @worktreeFingerprint, @branch, @state, @leaseId, @startedAt, @endedAt, @exitCode, @exitSignal,
       @pid, @transcriptCursor, @importedEventCount, @lostEventCount)`).run({
      id: run.id,
      workItemId: run.workItemId ?? null,
      actorId: run.actorId,
      agentId: run.agentId ?? null,
      workspaceId: run.scope.workspaceId,
      projectId: run.scope.projectId,
      runtimeProfile: run.runtimeProfile,
      backend: run.backend,
      sessionKey: run.sessionKey,
      cwd: run.cwd,
      repoFingerprint: run.repoFingerprint,
      worktreeFingerprint: run.worktreeFingerprint,
      branch: run.branch,
      state: run.state,
      leaseId: run.leaseId,
      startedAt: run.startedAt,
      endedAt: run.endedAt ?? null,
      exitCode: run.exitCode ?? null,
      exitSignal: run.exitSignal ?? null,
      pid: run.pid ?? null,
      transcriptCursor: run.transcriptCursor ?? null,
      importedEventCount: run.importedEventCount,
      lostEventCount: run.lostEventCount,
    })
  }

  /**
   * Patches only the fields present. Column names come from a fixed table rather
   * than from the patch's keys, so no caller can name a column.
   */
  updateRun(runId: string, patch: RunPatch): void {
    const assignments: string[] = []
    const values: unknown[] = []
    for (const [field, column] of Object.entries(runPatchColumns) as [keyof RunPatch, string][]) {
      const value = patch[field]
      if (value === undefined) continue
      assignments.push(`${column} = ?`)
      values.push(value)
    }
    if (assignments.length === 0) return
    const result = this.statement(`UPDATE runs SET ${assignments.join(', ')} WHERE id = ?`).run(...values, runId)
    if (result.changes !== 1) throw new HiveError('RUN_NOT_FOUND', `Run ${runId} not found`)
  }

  run(runId: string): Run | undefined {
    const row = this.statement(`${RUN_COLUMNS} AND r.id = ?`).get(runId) as RunRow | undefined
    return row ? toRun(row) : undefined
  }

  runBySession(backend: Run['backend'], sessionKey: string): Run | undefined {
    const row = this.statement(`${RUN_COLUMNS} AND r.backend = ? AND r.session_key = ?`).get(backend, sessionKey) as RunRow | undefined
    return row ? toRun(row) : undefined
  }

  listRuns(scope?: ScopeRef, states?: readonly RunState[]): Run[] {
    const clauses: string[] = []
    const values: unknown[] = []
    if (scope) {
      clauses.push('r.workspace_id = ? AND r.project_id = ?')
      values.push(scope.workspaceId, scope.projectId)
    }
    if (states && states.length > 0) {
      clauses.push(`r.state IN (${states.map(() => '?').join(', ')})`)
      values.push(...states)
    }
    const where = clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : ''
    const rows = this.statement(`${RUN_COLUMNS}${where} ORDER BY r.started_at DESC, r.id`).all(...values) as RunRow[]
    return rows.map(toRun)
  }

  /** Every run whose row claims it is still alive — the set a restart has to account for. */
  listUnfinishedRuns(): Run[] {
    const rows = this.statement(`${RUN_COLUMNS} AND r.state NOT IN (${terminalRunStates.map(() => '?').join(', ')}) ORDER BY r.started_at`).all(...terminalRunStates) as RunRow[]
    return rows.map(toRun)
  }

  insertWorktree(worktree: WorktreeRef): void {
    this.statement(`INSERT INTO run_worktrees(run_id, path, branch, base_branch, base_commit, repo_fingerprint, worktree_fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      worktree.runId, worktree.path, worktree.branch, worktree.baseBranch, worktree.baseCommit ?? null,
      worktree.repoFingerprint, worktree.worktreeFingerprint, worktree.createdAt,
    )
  }

  worktree(runId: string): WorktreeRef | undefined {
    const row = this.statement('SELECT * FROM run_worktrees WHERE run_id = ?').get(runId) as WorktreeRow | undefined
    return row ? toWorktree(row) : undefined
  }

  listWorktrees(repoFingerprint?: string): WorktreeRef[] {
    const rows = repoFingerprint === undefined
      ? this.statement('SELECT * FROM run_worktrees ORDER BY created_at, run_id').all() as WorktreeRow[]
      : this.statement('SELECT * FROM run_worktrees WHERE repo_fingerprint = ? ORDER BY created_at, run_id').all(repoFingerprint) as WorktreeRow[]
    return rows.map(toWorktree)
  }

  removeWorktree(runId: string): void {
    this.statement('DELETE FROM run_worktrees WHERE run_id = ?').run(runId)
  }

  // --- Work plane (§6.2, §6.4, §6.5): one work identity in one ledger (C8) ---

  insertWorkItem(item: WorkItem): void {
    this.statement(`INSERT INTO work_items
      (id, workspace_id, project_id, title, description, status, priority, issue_type, owner_actor_id, assignee_actor_id,
       convoy_id, source_trigger_id, metadata, revision, created_at, updated_at, closed_at)
      VALUES (@id, @workspaceId, @projectId, @title, @description, @status, @priority, @issueType, @ownerActorId, @assigneeActorId,
       @convoyId, @sourceTriggerId, @metadata, @revision, @createdAt, @updatedAt, @closedAt)`).run({
      id: item.id,
      workspaceId: item.scope.workspaceId,
      projectId: item.scope.projectId,
      title: item.title,
      description: item.description,
      status: item.status,
      priority: item.priority,
      issueType: item.issueType,
      ownerActorId: item.ownerActorId,
      assigneeActorId: item.assigneeActorId ?? null,
      convoyId: item.convoyId ?? null,
      sourceTriggerId: item.sourceTriggerId ?? null,
      metadata: JSON.stringify(item.metadata),
      revision: item.revision,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      closedAt: item.closedAt ?? null,
    })
  }

  workItem(id: string): WorkItem | undefined {
    const row = this.statement(`${WORK_ITEM_COLUMNS} AND i.id = ?`).get(id) as WorkItemRow | undefined
    return row ? toWorkItem(row) : undefined
  }

  /** A trigger's work item, if it already produced one: the dedupe point for trigger routing. */
  workItemByTrigger(sourceTriggerId: string): WorkItem | undefined {
    const row = this.statement(`${WORK_ITEM_COLUMNS} AND i.source_trigger_id = ? ORDER BY i.created_at LIMIT 1`).get(sourceTriggerId) as WorkItemRow | undefined
    return row ? toWorkItem(row) : undefined
  }

  listWorkItems(scope?: ScopeRef, statuses?: readonly WorkItemStatus[], assigneeActorId?: string): WorkItem[] {
    const clauses: string[] = []
    const values: unknown[] = []
    if (scope) {
      clauses.push('i.workspace_id = ? AND i.project_id = ?')
      values.push(scope.workspaceId, scope.projectId)
    }
    if (statuses && statuses.length > 0) {
      clauses.push(`i.status IN (${statuses.map(() => '?').join(', ')})`)
      values.push(...statuses)
    }
    if (assigneeActorId) {
      clauses.push('i.assignee_actor_id = ?')
      values.push(assigneeActorId)
    }
    const where = clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : ''
    const rows = this.statement(`${WORK_ITEM_COLUMNS}${where} ORDER BY i.created_at DESC, i.id`).all(...values) as WorkItemRow[]
    return rows.map(toWorkItem)
  }

  /**
   * Patches only the fields present and bumps the revision, so every applied
   * mutation has a number event keys can cite. Column names come from a fixed
   * table rather than the patch's keys, so no caller can name a column.
   */
  patchWorkItem(id: string, patch: WorkItemPatch): WorkItem {
    const assignments: string[] = ['revision = revision + 1', 'updated_at = ?']
    const values: unknown[] = [this.timestamp()]
    for (const [field, column] of Object.entries(workItemPatchColumns) as [keyof WorkItemPatch, string][]) {
      const value = patch[field]
      if (value === undefined) continue
      assignments.push(`${column} = ?`)
      values.push(value)
    }
    const result = this.statement(`UPDATE work_items SET ${assignments.join(', ')} WHERE id = ?`).run(...values, id)
    if (result.changes !== 1) throw new HiveError('WORK_ITEM_NOT_FOUND', `Work item ${id} not found`)
    return this.requireWorkItem(id)
  }

  /**
   * The claim itself: an open item to any claimant, or an already-assigned item
   * to its assignee. Guarded on current status, so two simultaneous claims
   * cannot both land — the loser gets `undefined` and reads why.
   */
  claimWorkItem(id: string, assigneeActorId: string, updatedAt: string): WorkItem | undefined {
    const result = this.statement(`UPDATE work_items SET status = 'assigned', assignee_actor_id = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND (status = 'open' OR (status = 'assigned' AND assignee_actor_id = ?))`).run(assigneeActorId, updatedAt, id, assigneeActorId)
    return result.changes === 1 ? this.workItem(id) : undefined
  }

  insertDependency(dependency: WorkDependency): void {
    this.statement('INSERT INTO work_dependencies (work_item_id, depends_on_id, type) VALUES (?, ?, ?)').run(
      dependency.workItemId, dependency.dependsOnId, dependency.type,
    )
  }

  listDependencies(workItemId: string): WorkDependency[] {
    const rows = this.statement('SELECT * FROM work_dependencies WHERE work_item_id = ?').all(workItemId) as DependencyRow[]
    return rows.map(toDependency)
  }

  /** The reverse edge: items that named this one, for unblocking when it completes. */
  listDependents(workItemId: string): WorkDependency[] {
    const rows = this.statement('SELECT * FROM work_dependencies WHERE depends_on_id = ?').all(workItemId) as DependencyRow[]
    return rows.map(toDependency)
  }

  insertMessage(message: Message): void {
    this.statement(`INSERT INTO messages
      (id, workspace_id, project_id, from_address, to_address, queue, subject, body, type, priority, delivery,
       thread_id, reply_to, state, claimed_by, claimed_at, created_at, delivered_at, acked_at)
      VALUES (@id, @workspaceId, @projectId, @from, @to, @queue, @subject, @body, @type, @priority, @delivery,
       @threadId, @replyTo, @state, @claimedBy, @claimedAt, @createdAt, @deliveredAt, @ackedAt)`).run({
      id: message.id,
      workspaceId: message.scope.workspaceId,
      projectId: message.scope.projectId,
      from: message.from,
      to: message.to ?? null,
      queue: message.queue ?? null,
      subject: message.subject,
      body: message.body,
      type: message.type,
      priority: message.priority,
      delivery: message.delivery,
      threadId: message.threadId ?? null,
      replyTo: message.replyTo ?? null,
      state: message.state,
      claimedBy: message.claimedBy ?? null,
      claimedAt: message.claimedAt ?? null,
      createdAt: message.createdAt,
      deliveredAt: message.deliveredAt ?? null,
      ackedAt: message.ackedAt ?? null,
    })
  }

  message(id: string): Message | undefined {
    const row = this.statement(`${MESSAGE_COLUMNS} AND m.id = ?`).get(id) as MessageRow | undefined
    return row ? toMessage(row) : undefined
  }

  listMessages(filter: { scope?: ScopeRef; queue?: string; to?: string; threadId?: string; states?: readonly MessageState[] }): Message[] {
    const clauses: string[] = []
    const values: unknown[] = []
    if (filter.scope) {
      clauses.push('m.workspace_id = ? AND m.project_id = ?')
      values.push(filter.scope.workspaceId, filter.scope.projectId)
    }
    if (filter.queue) {
      clauses.push('m.queue = ?')
      values.push(filter.queue)
    }
    if (filter.to) {
      clauses.push('m.to_address = ?')
      values.push(filter.to)
    }
    if (filter.threadId) {
      clauses.push('m.thread_id = ?')
      values.push(filter.threadId)
    }
    if (filter.states && filter.states.length > 0) {
      clauses.push(`m.state IN (${filter.states.map(() => '?').join(', ')})`)
      values.push(...filter.states)
    }
    const where = clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : ''
    const rows = this.statement(`${MESSAGE_COLUMNS}${where} ORDER BY m.created_at DESC, m.id`).all(...values) as MessageRow[]
    return rows.map(toMessage)
  }

  /** The next pending message in a queue: urgency first, then age, then id — a total, deterministic order. */
  nextPendingMessage(queue: string): Message | undefined {
    const row = this.statement(`${MESSAGE_COLUMNS} AND m.queue = ? AND m.state = 'pending'
      ORDER BY CASE m.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, m.created_at, m.id
      LIMIT 1`).get(queue) as MessageRow | undefined
    return row ? toMessage(row) : undefined
  }

  /** Claim-before-delivery (§6.4): the guarded update is the whole claim. */
  claimMessage(id: string, actorId: string, claimedAt: string): Message | undefined {
    const result = this.statement(`UPDATE messages SET state = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ? AND state = 'pending'`)
      .run(actorId, claimedAt, id)
    return result.changes === 1 ? this.message(id) : undefined
  }

  patchMessage(id: string, patch: MessagePatch): Message {
    const assignments: string[] = []
    const values: unknown[] = []
    for (const [field, column] of Object.entries(messagePatchColumns) as [keyof MessagePatch, string][]) {
      const value = patch[field]
      if (value === undefined) continue
      assignments.push(`${column} = ?`)
      values.push(value)
    }
    if (assignments.length === 0) throw new HiveError('INVALID_ARGUMENT', 'Message patch is empty')
    const result = this.statement(`UPDATE messages SET ${assignments.join(', ')} WHERE id = ?`).run(...values, id)
    if (result.changes !== 1) throw new HiveError('MESSAGE_NOT_FOUND', `Message ${id} not found`)
    const message = this.message(id)
    if (!message) throw new HiveError('MESSAGE_NOT_FOUND', `Message ${id} not found`)
    return message
  }

  /** Acknowledgement is ownership: only the recorded recipient, from `claimed` or `delivered`. */
  acknowledgeMessage(id: string, actorId: string, ackedAt: string): Message | undefined {
    const result = this.statement(`UPDATE messages SET state = 'acked', acked_at = ?
      WHERE id = ? AND state IN ('claimed', 'delivered') AND claimed_by = ?`)
      .run(ackedAt, id, actorId)
    return result.changes === 1 ? this.message(id) : undefined
  }

  /**
   * The retry fallback (§6.4): claims whose worker vanished return to pending.
   * Returns how many went back, so the caller can report the recovery.
   */
  requeueExpiredClaims(cutoffIso: string): number {
    const result = this.statement(`UPDATE messages SET state = 'pending', claimed_by = NULL, claimed_at = NULL
      WHERE state = 'claimed' AND claimed_at IS NOT NULL AND claimed_at <= ?`).run(cutoffIso)
    return result.changes
  }

  /**
   * An interrupt that reached a live session: delivered in one step, with the
   * receiving actor recorded as the claimant so their acknowledgement closes
   * the loop. Guarded on `pending` — a raced claim wins and this returns undefined.
   */
  deliverInterruptMessage(id: string, recipientActorId: string, deliveredAt: string): Message {
    const result = this.statement(`UPDATE messages SET state = 'delivered', claimed_by = ?, claimed_at = ?, delivered_at = ?
      WHERE id = ? AND state = 'pending'`).run(recipientActorId, deliveredAt, deliveredAt, id)
    if (result.changes !== 1) throw new HiveError('MESSAGE_STATE', `Message ${id} is no longer pending`)
    const message = this.message(id)
    if (!message) throw new HiveError('MESSAGE_NOT_FOUND', `Message ${id} not found`)
    return message
  }

  insertHandoff(handoff: Handoff): void {
    this.statement(`INSERT INTO handoffs
      (id, workspace_id, project_id, from_actor, to_agent, cwd, summary, open_questions, files_touched, next_steps,
       state, owner_actor, accepted_by, created_at, accepted_at)
      VALUES (@id, @workspaceId, @projectId, @fromActorId, @toAgentId, @cwd, @summary, @openQuestions, @filesTouched, @nextSteps,
       @state, @ownerActorId, @acceptedByActorId, @createdAt, @acceptedAt)`).run({
      id: handoff.id,
      workspaceId: handoff.scope.workspaceId,
      projectId: handoff.scope.projectId,
      fromActorId: handoff.fromActorId,
      toAgentId: handoff.toAgentId ?? null,
      cwd: handoff.cwd,
      summary: handoff.summary,
      openQuestions: JSON.stringify(handoff.openQuestions),
      filesTouched: JSON.stringify(handoff.filesTouched),
      nextSteps: JSON.stringify(handoff.nextSteps),
      state: handoff.state,
      ownerActorId: handoff.ownerActorId ?? null,
      acceptedByActorId: handoff.acceptedByActorId ?? null,
      createdAt: handoff.createdAt,
      acceptedAt: handoff.acceptedAt ?? null,
    })
  }

  handoff(id: string): Handoff | undefined {
    const row = this.statement(`${HANDOFF_COLUMNS} AND h.id = ?`).get(id) as HandoffRow | undefined
    return row ? toHandoff(row) : undefined
  }

  listHandoffs(scope?: ScopeRef, states?: readonly Handoff['state'][]): Handoff[] {
    const clauses: string[] = []
    const values: unknown[] = []
    if (scope) {
      clauses.push('h.workspace_id = ? AND h.project_id = ?')
      values.push(scope.workspaceId, scope.projectId)
    }
    if (states && states.length > 0) {
      clauses.push(`h.state IN (${states.map(() => '?').join(', ')})`)
      values.push(...states)
    }
    const where = clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : ''
    const rows = this.statement(`${HANDOFF_COLUMNS}${where} ORDER BY h.created_at, h.id`).all(...values) as HandoffRow[]
    return rows.map(toHandoff)
  }

  /** Acceptance is the claim: guarded on `open`, so two sessions cannot both take a handoff. */
  acceptHandoff(id: string, ownerActorId: string, acceptedByActorId: string, acceptedAt: string): Handoff | undefined {
    const result = this.statement(`UPDATE handoffs SET state = 'accepted', owner_actor = ?, accepted_by = ?, accepted_at = ?
      WHERE id = ? AND state = 'open'`).run(ownerActorId, acceptedByActorId, acceptedAt, id)
    return result.changes === 1 ? this.handoff(id) : undefined
  }

  cancelHandoff(id: string, fromActorId: string): Handoff | undefined {
    const result = this.statement(`UPDATE handoffs SET state = 'cancelled' WHERE id = ? AND state = 'open' AND from_actor = ?`)
      .run(id, fromActorId)
    return result.changes === 1 ? this.handoff(id) : undefined
  }

  expireHandoffs(cutoffIso: string): number {
    const result = this.statement(`UPDATE handoffs SET state = 'expired' WHERE state = 'open' AND created_at <= ?`).run(cutoffIso)
    return result.changes
  }

  /**
   * The plan is append-only history under one writer: the current body plus a
   * history row are written in one transaction, and the revision is the
   * serialization point.
   */
  upsertWorkPlan(workItemId: string, body: string, updatedByActorId: string, updatedAt: string): WorkPlanRevision {
    return this.sqlite.transaction(() => {
      const current = this.statement('SELECT revision FROM work_plans WHERE work_item_id = ?').get(workItemId) as { revision: number } | undefined
      const revision = (current?.revision ?? 0) + 1
      if (current) {
        this.statement('UPDATE work_plans SET body = ?, revision = ?, updated_by = ?, updated_at = ? WHERE work_item_id = ?')
          .run(body, revision, updatedByActorId, updatedAt, workItemId)
      } else {
        this.statement('INSERT INTO work_plans (work_item_id, body, revision, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(workItemId, body, revision, updatedByActorId, updatedAt)
      }
      this.statement('INSERT INTO work_plan_history (work_item_id, revision, body, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(workItemId, revision, body, updatedByActorId, updatedAt)
      return { workItemId, revision, body, updatedByActorId, updatedAt }
    })
  }

  workPlan(workItemId: string): WorkPlanRevision | undefined {
    const row = this.statement('SELECT * FROM work_plans WHERE work_item_id = ?').get(workItemId) as
      | { work_item_id: string; revision: number; body: string; updated_by: string; updated_at: string }
      | undefined
    return row ? { workItemId: row.work_item_id, revision: row.revision, body: row.body, updatedByActorId: row.updated_by, updatedAt: row.updated_at } : undefined
  }

  workPlanHistory(workItemId: string): WorkPlanRevision[] {
    const rows = this.statement('SELECT * FROM work_plan_history WHERE work_item_id = ? ORDER BY revision').all(workItemId) as
      Array<{ work_item_id: string; revision: number; body: string; updated_by: string; updated_at: string }>
    return rows.map((row) => ({ workItemId: row.work_item_id, revision: row.revision, body: row.body, updatedByActorId: row.updated_by, updatedAt: row.updated_at }))
  }

  /** The lease actually holding a resource right now, if any — expiry checked, not just the flag. */
  activeLease(resourceType: Lease['resourceType'], resourceId: string): Lease | undefined {
    const row = this.statement(`SELECT * FROM leases WHERE resource_type = ? AND resource_id = ? AND state = 'active' AND expires_at > ?
      ORDER BY fencing_token DESC LIMIT 1`).get(resourceType, resourceId, this.timestamp()) as LeaseRow | undefined
    return row ? toLease(row) : undefined
  }

  /** Ends whatever lease holds a resource, used when a terminal state makes it moot (C19). */
  cancelLeaseForResource(resourceType: Lease['resourceType'], resourceId: string): void {
    this.statement(`UPDATE leases SET state = 'cancelled' WHERE resource_type = ? AND resource_id = ? AND state = 'active'`)
      .run(resourceType, resourceId)
  }

  // --- Fleet, dispatch, and supervision (§6.2, §7 Phase 5) ---

  /** Registers or re-registers an agent; re-registration updates the fleet row, not the energy. */
  upsertAgent(agent: Agent): void {
    this.statement(`INSERT INTO agents (id, name, profile_id, cwd, skills, energy, max_energy, created_at, updated_at)
      VALUES (@id, @name, @profileId, @cwd, @skills, @energy, @maxEnergy, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, profile_id = excluded.profile_id, cwd = excluded.cwd,
        skills = excluded.skills, max_energy = excluded.max_energy, updated_at = excluded.updated_at`).run({
      id: agent.id,
      name: agent.name,
      profileId: agent.profileId,
      cwd: agent.cwd ?? null,
      skills: JSON.stringify(agent.skills),
      energy: agent.energy,
      maxEnergy: agent.maxEnergy,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    })
  }

  agent(agentId: string): Agent | undefined {
    const row = this.statement('SELECT * FROM agents WHERE id = ?').get(agentId) as AgentRow | undefined
    return row ? toAgent(row) : undefined
  }

  listAgents(): Agent[] {
    return (this.statement('SELECT * FROM agents ORDER BY id').all() as AgentRow[]).map(toAgent)
  }

  /** Energy is the dispatcher's to spend and the rest tick's to restore; nothing else writes it. */
  setAgentEnergy(agentId: string, energy: number, updatedAt: string): void {
    const result = this.statement('UPDATE agents SET energy = ?, updated_at = ? WHERE id = ?').run(energy, updatedAt, agentId)
    if (result.changes !== 1) throw new HiveError('AGENT_NOT_FOUND', `Agent ${agentId} not found`)
  }

  /**
   * Creates the actor row a dispatch acts through, if it is not there already.
   * A registered agent is dispatched as an actor of its own, so claims and runs
   * name the agent rather than whoever happened to be dispatching.
   */
  ensureActor(actor: ActorContext): void {
    this.statement(`INSERT INTO actors (id, type, display_name, source, capabilities, workspace_id, project_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`).run(
      actor.actorId,
      actor.actorType,
      actor.displayName,
      actor.source,
      JSON.stringify(actor.capabilities),
      actor.workspaceId ?? null,
      actor.projectId ?? null,
      this.timestamp(),
    )
  }

  /** Where a projection got to: the durable cursor a restarted supervisor resumes from. */
  projectionCursor(projection: string): number {
    const row = this.statement('SELECT version FROM projection_status WHERE projection = ?').get(projection) as { version: number } | undefined
    return row?.version ?? 0
  }

  /** Advances a projection cursor; never backwards — a late reader must not unsee events. */
  setProjectionCursor(projection: string, sequence: number): void {
    this.statement(`INSERT INTO projection_status (projection, version, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(projection) DO UPDATE SET version = MAX(version, excluded.version), updated_at = excluded.updated_at`)
      .run(projection, sequence, this.timestamp())
  }

  private requireWorkItem(id: string): WorkItem {
    const item = this.workItem(id)
    if (!item) throw new HiveError('WORK_ITEM_NOT_FOUND', `Work item ${id} not found`)
    return item
  }

  recordAudit(actorId: string, action: string, details: unknown): void {
    this.statement('INSERT INTO audit_log(actor_id, action, request_id, details, created_at) VALUES (?, ?, ?, ?, ?)').run(actorId, action, createId(), JSON.stringify(details), this.timestamp())
  }

  auditCount(action?: string): number {
    const row = action
      ? this.statement('SELECT COUNT(*) AS count FROM audit_log WHERE action = ?').get(action) as { count: number }
      : this.statement('SELECT COUNT(*) AS count FROM audit_log').get() as { count: number }
    return row.count
  }

  // --- Knowledge plane: ingestion, lexical search, sessions (§7 Phase 6, C12) ---

  upsertIngestSource(source: IngestSource): void {
    this.statement(`INSERT INTO ingest_sources
      (uri, path, workspace_id, project_id, sha256, size_bytes, mtime_ms, parser, chunk_count, ingested_at)
      VALUES (@uri, @path, @workspaceId, @projectId, @sha256, @sizeBytes, @mtimeMs, @parser, @chunkCount, @ingestedAt)
      ON CONFLICT(uri) DO UPDATE SET path = excluded.path, sha256 = excluded.sha256, size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms, parser = excluded.parser, chunk_count = excluded.chunk_count,
        ingested_at = excluded.ingested_at`).run({
      uri: source.uri,
      path: source.path,
      workspaceId: source.scope.workspaceId,
      projectId: source.scope.projectId,
      sha256: source.sha256,
      sizeBytes: source.sizeBytes,
      mtimeMs: source.mtimeMs,
      parser: source.parser,
      chunkCount: source.chunkCount,
      ingestedAt: source.ingestedAt,
    })
  }

  ingestSource(uri: string): IngestSource | undefined {
    const row = this.statement(`${INGEST_SOURCE_COLUMNS} AND i.uri = ?`).get(uri) as (IngestSourceRow & ScopeRow) | undefined
    return row ? toIngestSource(row) : undefined
  }

  listIngestSources(scope?: ScopeRef): IngestSource[] {
    const rows = scope
      ? (this.statement(`${INGEST_SOURCE_COLUMNS} AND i.workspace_id = ? AND i.project_id = ? ORDER BY i.uri`).all(scope.workspaceId, scope.projectId) as (IngestSourceRow & ScopeRow)[])
      : (this.statement(`${INGEST_SOURCE_COLUMNS} ORDER BY i.uri`).all() as (IngestSourceRow & ScopeRow)[])
    return rows.map(toIngestSource)
  }

  removeIngestSource(uri: string): void {
    this.sqlite.transaction(() => {
      this.statement('DELETE FROM ingest_chunks WHERE uri = ?').run(uri)
      this.statement('DELETE FROM ingest_sources WHERE uri = ?').run(uri)
    })
  }

  /** Replaces every chunk for one source in a single transaction: a reparse is atomic. */
  replaceIngestChunks(uri: string, chunks: readonly IngestChunk[]): void {
    this.sqlite.transaction(() => {
      this.statement('DELETE FROM ingest_chunks WHERE uri = ?').run(uri)
      const insert = this.statement('INSERT INTO ingest_chunks (uri, chunk_id, tier, title, body) VALUES (?, ?, ?, ?, ?)')
      for (const chunk of chunks) insert.run(chunk.uri, chunk.chunkId, chunk.tier, chunk.title, chunk.body)
    })
  }

  /**
   * The lexical query: BM25 over the FTS table, joined back to its scope so a
   * project never sees another project's sources. `match` is the raw FTS5
   * expression restricted to one column; the caller owns building and escaping it.
   */
  searchIngestChunks(match: string, scope: ScopeRef, tier: ContextLevel | undefined, limit: number): RankedChunk[] {
    const clauses = ['s.workspace_id = ?', 's.project_id = ?']
    const values: unknown[] = [scope.workspaceId, scope.projectId]
    if (tier) {
      clauses.push('c.tier = ?')
      values.push(tier)
    }
    return (this.statement(
      `SELECT c.uri, c.chunk_id AS chunkId, c.tier, c.title,
        snippet(ingest_chunks, 4, '«', '»', '…', 16) AS snippet, bm25(ingest_chunks) AS bm25
       FROM ingest_chunks c JOIN ingest_sources s ON s.uri = c.uri
       WHERE ingest_chunks MATCH ? AND ${clauses.join(' AND ')}
       ORDER BY bm25 LIMIT ?`,
    ).all(match, ...values, limit) as RankedChunk[])
  }

  upsertSession(session: SessionRecord): void {
    this.statement(`INSERT INTO sessions
      (id, workspace_id, project_id, run_id, agent_id, work_item_id, runtime_profile, branch,
       started_at, ended_at, exit_code, exit_signal, summary, overview, captured_at)
      VALUES (@id, @workspaceId, @projectId, @runId, @agentId, @workItemId, @runtimeProfile, @branch,
       @startedAt, @endedAt, @exitCode, @exitSignal, @summary, @overview, @capturedAt)
      ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, exit_code = excluded.exit_code,
        exit_signal = excluded.exit_signal, summary = excluded.summary, overview = excluded.overview,
        captured_at = excluded.captured_at`).run({
      id: session.id,
      workspaceId: session.scope.workspaceId,
      projectId: session.scope.projectId,
      runId: session.runId ?? null,
      agentId: session.agentId ?? null,
      workItemId: session.workItemId ?? null,
      runtimeProfile: session.runtimeProfile,
      branch: session.branch,
      startedAt: session.startedAt,
      endedAt: session.endedAt ?? null,
      exitCode: session.exitCode ?? null,
      exitSignal: session.exitSignal ?? null,
      summary: session.summary ?? null,
      overview: session.overview ?? null,
      capturedAt: session.capturedAt ?? null,
    })
  }

  session(id: string): SessionRecord | undefined {
    const row = this.statement(`${SESSION_COLUMNS} AND s.id = ?`).get(id) as (SessionRow & ScopeRow) | undefined
    return row ? toSession(row) : undefined
  }

  listSessions(scope?: ScopeRef): SessionRecord[] {
    const rows = scope
      ? (this.statement(`${SESSION_COLUMNS} AND s.workspace_id = ? AND s.project_id = ? ORDER BY s.started_at DESC, s.id`).all(scope.workspaceId, scope.projectId) as (SessionRow & ScopeRow)[])
      : (this.statement(`${SESSION_COLUMNS} ORDER BY s.started_at DESC, s.id`).all() as (SessionRow & ScopeRow)[])
    return rows.map(toSession)
  }

  // --- Merge queue and convoys (§7 Phase 7, C10, C15, C22) ---

  insertMergeRequest(request: MergeRequest): void {
    this.statement(`INSERT INTO merge_requests
      (id, workspace_id, project_id, work_item_id, run_id, source_branch, target_branch, source_commit, target_sha,
       merge_commit, batch_id, claimed_by, fencing_token, claim_expires_at, state,
       failure_kind, failure_detail, conflict_files, gate_results,
       protected_target, approved_by, approved_at, created_by, created_at, updated_at, closed_at)
      VALUES (@id, @workspaceId, @projectId, @workItemId, @runId, @sourceBranch, @targetBranch, @sourceCommit, @targetSha,
       @mergeCommit, @batchId, @claimedBy, @fencingToken, @claimExpiresAt, @state,
       @failureKind, @failureDetail, @conflictFiles, @gateResults,
       @protectedTarget, @approvedBy, @approvedAt, @createdBy, @createdAt, @updatedAt, @closedAt)`).run({
      id: request.id,
      workspaceId: request.scope.workspaceId,
      projectId: request.scope.projectId,
      workItemId: request.workItemId ?? null,
      runId: request.runId ?? null,
      sourceBranch: request.sourceBranch,
      targetBranch: request.targetBranch,
      sourceCommit: request.sourceCommit ?? null,
      targetSha: request.targetSha,
      mergeCommit: request.mergeCommit ?? null,
      batchId: request.batchId ?? null,
      claimedBy: request.claimedBy ?? null,
      fencingToken: request.fencingToken ?? null,
      claimExpiresAt: request.claimExpiresAt ?? null,
      state: request.state,
      failureKind: request.failureKind ?? null,
      failureDetail: request.failureDetail ?? null,
      conflictFiles: request.conflictFiles ? JSON.stringify(request.conflictFiles) : null,
      gateResults: request.gateResults ? JSON.stringify(request.gateResults) : null,
      protectedTarget: request.protectedTarget ? 1 : 0,
      approvedBy: request.approvedBy ?? null,
      approvedAt: request.approvedAt ?? null,
      createdBy: request.createdBy,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      closedAt: request.closedAt ?? null,
    })
  }

  mergeRequest(id: string): MergeRequest | undefined {
    const row = this.statement(`${MERGE_REQUEST_COLUMNS} AND m.id = ?`).get(id) as (MergeRequestRow & ScopeRow) | undefined
    return row ? toMergeRequest(row) : undefined
  }

  listMergeRequests(scope?: ScopeRef, states?: readonly MergeRequestState[]): MergeRequest[] {
    const clauses: string[] = []
    const values: unknown[] = []
    if (scope) {
      clauses.push('m.workspace_id = ? AND m.project_id = ?')
      values.push(scope.workspaceId, scope.projectId)
    }
    if (states && states.length > 0) {
      clauses.push(`m.state IN (${states.map(() => '?').join(', ')})`)
      values.push(...states)
    }
    const where = clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : ''
    const rows = this.statement(`${MERGE_REQUEST_COLUMNS}${where} ORDER BY m.created_at, m.id`).all(...values) as (MergeRequestRow & ScopeRow)[]
    return rows.map(toMergeRequest)
  }

  /**
   * A guarded state transition: it only lands from the expected current state,
   * so a second coordinator (or a stale one) cannot move a request that has
   * already moved. Terminal states refuse every transition — the record is
   * what happened, not a row to rewrite.
   */
  transitionMergeRequest(id: string, from: MergeRequestState, patch: Partial<MergeRequest> & { state: MergeRequestState }, updatedAt: string): MergeRequest | undefined {
    const result = this.statement(`UPDATE merge_requests SET state = ?, batch_id = COALESCE(?, batch_id),
      failure_kind = COALESCE(?, failure_kind), failure_detail = COALESCE(?, failure_detail),
      conflict_files = COALESCE(?, conflict_files), gate_results = COALESCE(?, gate_results),
      target_sha = COALESCE(?, target_sha), merge_commit = COALESCE(?, merge_commit),
      claimed_by = COALESCE(?, claimed_by), fencing_token = COALESCE(?, fencing_token),
      claim_expires_at = COALESCE(?, claim_expires_at), closed_at = COALESCE(?, closed_at), updated_at = ?
      WHERE id = ? AND state = ?`).run(
      patch.state,
      patch.batchId ?? null,
      patch.failureKind ?? null,
      patch.failureDetail ?? null,
      patch.conflictFiles ? JSON.stringify(patch.conflictFiles) : null,
      patch.gateResults ? JSON.stringify(patch.gateResults) : null,
      patch.targetSha ?? null,
      patch.mergeCommit ?? null,
      patch.claimedBy ?? null,
      patch.fencingToken ?? null,
      patch.claimExpiresAt ?? null,
      patch.closedAt ?? null,
      updatedAt,
      id,
      from,
    )
    return result.changes === 1 ? this.mergeRequest(id) : undefined
  }

  /**
   * Releases a request held against a protected target. Guarded on
   * `awaiting_approval`, so approving twice approves once and the second
   * approver finds it already released — the recorded approver is whoever
   * actually opened the gate.
   */
  approveMergeRequest(id: string, approvedBy: string, approvedAt: string): MergeRequest | undefined {
    const result = this.statement(`UPDATE merge_requests SET state = 'open', approved_by = ?, approved_at = ?, updated_at = ?
      WHERE id = ? AND state = 'awaiting_approval'`).run(approvedBy, approvedAt, approvedAt, id)
    return result.changes === 1 ? this.mergeRequest(id) : undefined
  }

  insertMergeBatch(batch: MergeBatch): void {
    this.statement(`INSERT INTO merge_batches
      (id, workspace_id, project_id, target_branch, target_sha, merge_request_ids, state, isolation_of, created_at, updated_at)
      VALUES (@id, @workspaceId, @projectId, @targetBranch, @targetSha, @mergeRequestIds, @state, @isolationOf, @createdAt, @updatedAt)`).run({
      id: batch.id,
      workspaceId: batch.scope.workspaceId,
      projectId: batch.scope.projectId,
      targetBranch: batch.targetBranch,
      targetSha: batch.targetSha,
      mergeRequestIds: JSON.stringify(batch.mergeRequestIds),
      state: batch.state,
      isolationOf: batch.isolationOf ?? null,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
    })
  }

  mergeBatch(id: string): MergeBatch | undefined {
    const row = this.statement(`${MERGE_BATCH_COLUMNS} AND b.id = ?`).get(id) as (MergeBatchRow & ScopeRow) | undefined
    return row ? toMergeBatch(row) : undefined
  }

  /** Every batch in scope, newest last — the queue's own history, and the branch graph's rows. */
  listMergeBatches(scope: ScopeRef, states?: readonly MergeBatch['state'][]): MergeBatch[] {
    const values: unknown[] = [scope.workspaceId, scope.projectId]
    let where = ' AND b.workspace_id = ? AND b.project_id = ?'
    if (states && states.length > 0) {
      where += ` AND b.state IN (${states.map(() => '?').join(', ')})`
      values.push(...states)
    }
    const rows = this.statement(`${MERGE_BATCH_COLUMNS}${where} ORDER BY b.created_at, b.id`).all(...values) as (MergeBatchRow & ScopeRow)[]
    return rows.map(toMergeBatch)
  }

  patchMergeBatch(id: string, patch: { state: MergeBatch['state'] }, updatedAt: string): MergeBatch | undefined {
    const result = this.statement('UPDATE merge_batches SET state = ?, updated_at = ? WHERE id = ?').run(patch.state, updatedAt, id)
    return result.changes === 1 ? this.mergeBatch(id) : undefined
  }

  /** Convoys are created idempotently: a work item naming one is enough to bring it into being. */
  upsertConvoy(convoy: ConvoyRecord): void {
    this.statement(`INSERT INTO convoys (id, workspace_id, project_id, state, closed_by, closed_at, created_at)
      VALUES (@id, @workspaceId, @projectId, @state, @closedBy, @closedAt, @createdAt)
      ON CONFLICT(id) DO NOTHING`).run({
      id: convoy.id,
      workspaceId: convoy.scope.workspaceId,
      projectId: convoy.scope.projectId,
      state: convoy.state,
      closedBy: convoy.closedBy ?? null,
      closedAt: convoy.closedAt ?? null,
      createdAt: convoy.createdAt,
    })
  }

  convoy(id: string): ConvoyRecord | undefined {
    const row = this.statement(`${CONVOY_COLUMNS} AND c.id = ?`).get(id) as (ConvoyRow & ScopeRow) | undefined
    return row ? toConvoy(row) : undefined
  }

  listConvoys(scope?: ScopeRef, states?: readonly ConvoyRecord['state'][]): ConvoyRecord[] {
    const clauses: string[] = []
    const values: unknown[] = []
    if (scope) {
      clauses.push('c.workspace_id = ? AND c.project_id = ?')
      values.push(scope.workspaceId, scope.projectId)
    }
    if (states && states.length > 0) {
      clauses.push(`c.state IN (${states.map(() => '?').join(', ')})`)
      values.push(...states)
    }
    const where = clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : ''
    const rows = this.statement(`${CONVOY_COLUMNS}${where} ORDER BY c.created_at, c.id`).all(...values) as (ConvoyRow & ScopeRow)[]
    return rows.map(toConvoy)
  }

  /** The guarded closure: only an active convoy closes, so the second scanner to arrive finds it already shut. */
  closeConvoy(id: string, closedBy: string, closedAt: string): ConvoyRecord | undefined {
    return this.transitionConvoy(id, 'closed', closedBy, closedAt)
  }

  /** The operator's forced closure: same guard, different terminal state — how it closed is part of the record. */
  forceCloseConvoy(id: string, closedBy: string, closedAt: string): ConvoyRecord | undefined {
    return this.transitionConvoy(id, 'forced', closedBy, closedAt)
  }

  private transitionConvoy(id: string, to: ConvoyRecord['state'], closedBy: string, closedAt: string): ConvoyRecord | undefined {
    const result = this.statement(`UPDATE convoys SET state = ?, closed_by = ?, closed_at = ?
      WHERE id = ? AND state = 'active'`).run(to, closedBy, closedAt, id)
    return result.changes === 1 ? this.convoy(id) : undefined
  }

  // --- Skills (§7 Phase 8) ---

  /** Install or upgrade in place: the row is the index, the files on disk are the content. */
  upsertSkill(skill: SkillRecord): void {
    this.statement(`INSERT INTO skills
      (id, workspace_id, project_id, name, version, description, tags, body, state, path, sha256, source, installed_by, installed_at, updated_at)
      VALUES (@id, @workspaceId, @projectId, @name, @version, @description, @tags, @body, @state, @path, @sha256, @source, @installedBy, @installedAt, @updatedAt)
      ON CONFLICT(workspace_id, project_id, id) DO UPDATE SET
        name = excluded.name, version = excluded.version, description = excluded.description,
        tags = excluded.tags, body = excluded.body, state = excluded.state, path = excluded.path,
        sha256 = excluded.sha256, source = excluded.source, updated_at = excluded.updated_at`).run({
      id: skill.id,
      workspaceId: skill.scope.workspaceId,
      projectId: skill.scope.projectId,
      name: skill.name,
      version: skill.version,
      description: skill.description,
      tags: JSON.stringify(skill.tags),
      body: skill.body,
      state: skill.state,
      path: skill.path,
      sha256: skill.sha256,
      source: skill.source,
      installedBy: skill.installedBy,
      installedAt: skill.installedAt,
      updatedAt: skill.updatedAt,
    })
  }

  skill(scope: ScopeRef, id: string): SkillRecord | undefined {
    const row = this.statement(`${SKILL_COLUMNS} AND s.workspace_id = ? AND s.project_id = ? AND s.id = ?`)
      .get(scope.workspaceId, scope.projectId, id) as (SkillRow & ScopeRow) | undefined
    return row ? toSkill(row) : undefined
  }

  listSkills(scope: ScopeRef, states?: readonly SkillRecord['state'][]): SkillRecord[] {
    const values: unknown[] = [scope.workspaceId, scope.projectId]
    let where = ' AND s.workspace_id = ? AND s.project_id = ?'
    if (states && states.length > 0) {
      where += ` AND s.state IN (${states.map(() => '?').join(', ')})`
      values.push(...states)
    }
    const rows = this.statement(`${SKILL_COLUMNS}${where} ORDER BY s.id`).all(...values) as (SkillRow & ScopeRow)[]
    return rows.map(toSkill)
  }

  setSkillState(scope: ScopeRef, id: string, state: SkillRecord['state'], updatedAt: string): SkillRecord | undefined {
    const result = this.statement('UPDATE skills SET state = ?, updated_at = ? WHERE workspace_id = ? AND project_id = ? AND id = ?')
      .run(state, updatedAt, scope.workspaceId, scope.projectId, id)
    return result.changes === 1 ? this.skill(scope, id) : undefined
  }

  deleteSkill(scope: ScopeRef, id: string): boolean {
    const result = this.statement('DELETE FROM skills WHERE workspace_id = ? AND project_id = ? AND id = ?')
      .run(scope.workspaceId, scope.projectId, id)
    return result.changes === 1
  }

  // --- Workflows and trigger history (§7 Phase 8, C20) ---

  upsertWorkflow(definition: WorkflowDefinition): void {
    this.statement(`INSERT INTO workflow_definitions
      (id, version, name, description, steps, enabled, created_by, created_at, updated_at)
      VALUES (@id, @version, @name, @description, @steps, @enabled, @createdBy, @createdAt, @updatedAt)
      ON CONFLICT(id, version) DO UPDATE SET name = excluded.name, description = excluded.description,
        steps = excluded.steps, enabled = excluded.enabled, updated_at = excluded.updated_at`).run({
      id: definition.id, version: definition.version, name: definition.name, description: definition.description,
      steps: JSON.stringify(definition.steps), enabled: definition.enabled ? 1 : 0, createdBy: definition.createdBy,
      createdAt: definition.createdAt, updatedAt: definition.updatedAt,
    })
  }

  workflow(id: string, version?: string): WorkflowDefinition | undefined {
    const row = (version === undefined
      ? this.statement('SELECT * FROM workflow_definitions WHERE id = ? ORDER BY version DESC LIMIT 1').get(id)
      : this.statement('SELECT * FROM workflow_definitions WHERE id = ? AND version = ?').get(id, version)) as WorkflowDefinitionRow | undefined
    return row ? { id: row.id, version: row.version, name: row.name, description: row.description,
      steps: JSON.parse(row.steps), enabled: row.enabled === 1, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at } : undefined
  }

  listWorkflows(): WorkflowDefinition[] {
    return (this.statement('SELECT * FROM workflow_definitions ORDER BY id, version').all() as WorkflowDefinitionRow[]).map((row) => ({
      id: row.id, version: row.version, name: row.name, description: row.description, steps: JSON.parse(row.steps),
      enabled: row.enabled === 1, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
    }))
  }

  insertWorkflowRun(run: WorkflowRun): boolean {
    const result = this.statement(`INSERT OR IGNORE INTO workflow_runs
      (id, workspace_id, project_id, workflow_id, workflow_version, trigger_id, state, work_item_ids, created_at, updated_at, cancelled_at, completed_at)
      VALUES (@id, @workspaceId, @projectId, @workflowId, @workflowVersion, @triggerId, @state, @workItemIds, @createdAt, @updatedAt, @cancelledAt, @completedAt)`).run({
      id: run.id, workspaceId: run.scope.workspaceId, projectId: run.scope.projectId, workflowId: run.workflowId,
      workflowVersion: run.workflowVersion, triggerId: run.triggerId, state: run.state, workItemIds: JSON.stringify(run.workItemIds),
      createdAt: run.createdAt, updatedAt: run.updatedAt, cancelledAt: run.cancelledAt ?? null, completedAt: run.completedAt ?? null,
    })
    return result.changes === 1
  }

  workflowRun(id: string): WorkflowRun | undefined {
    const row = this.statement(`SELECT r.*, w.name AS workspace_name, p.name AS project_name FROM workflow_runs r
      JOIN workspaces w ON w.id = r.workspace_id JOIN projects p ON p.id = r.project_id WHERE r.id = ?`).get(id) as (WorkflowRunRow & ScopeRow) | undefined
    return row ? { id: row.id, scope: toScope(row), workflowId: row.workflow_id, workflowVersion: row.workflow_version,
      triggerId: row.trigger_id, state: row.state, workItemIds: JSON.parse(row.work_item_ids), createdAt: row.created_at,
      updatedAt: row.updated_at, cancelledAt: row.cancelled_at ?? undefined, completedAt: row.completed_at ?? undefined } : undefined
  }

  workflowRunByTrigger(triggerId: string): WorkflowRun | undefined {
    const row = this.statement(`SELECT r.*, w.name AS workspace_name, p.name AS project_name FROM workflow_runs r
      JOIN workspaces w ON w.id = r.workspace_id JOIN projects p ON p.id = r.project_id WHERE r.trigger_id = ?`).get(triggerId) as (WorkflowRunRow & ScopeRow) | undefined
    return row ? { id: row.id, scope: toScope(row), workflowId: row.workflow_id, workflowVersion: row.workflow_version,
      triggerId: row.trigger_id, state: row.state, workItemIds: JSON.parse(row.work_item_ids), createdAt: row.created_at,
      updatedAt: row.updated_at, cancelledAt: row.cancelled_at ?? undefined, completedAt: row.completed_at ?? undefined } : undefined
  }

  listWorkflowRuns(scope: ScopeRef, states?: readonly WorkflowRun['state'][]): WorkflowRun[] {
    const values: unknown[] = [scope.workspaceId, scope.projectId]
    let sql = `SELECT r.*, w.name AS workspace_name, p.name AS project_name FROM workflow_runs r JOIN workspaces w ON w.id = r.workspace_id JOIN projects p ON p.id = r.project_id WHERE r.workspace_id = ? AND r.project_id = ?`
    if (states?.length) { sql += ` AND r.state IN (${states.map(() => '?').join(',')})`; values.push(...states) }
    sql += ' ORDER BY r.created_at, r.id'
    return (this.statement(sql).all(...values) as (WorkflowRunRow & ScopeRow)[]).map((row) => ({ id: row.id, scope: toScope(row), workflowId: row.workflow_id, workflowVersion: row.workflow_version, triggerId: row.trigger_id, state: row.state, workItemIds: JSON.parse(row.work_item_ids), createdAt: row.created_at, updatedAt: row.updated_at, cancelledAt: row.cancelled_at ?? undefined, completedAt: row.completed_at ?? undefined }))
  }

  updateWorkflowRun(id: string, state: WorkflowRun['state'], updatedAt: string, workItemIds: string[], completedAt?: string, cancelledAt?: string): WorkflowRun | undefined {
    const result = this.statement(`UPDATE workflow_runs SET state = ?, updated_at = ?, work_item_ids = ?, completed_at = ?, cancelled_at = ? WHERE id = ? AND state NOT IN ('cancelled', 'completed', 'failed')`).run(state, updatedAt, JSON.stringify(workItemIds), completedAt ?? null, cancelledAt ?? null, id)
    return result.changes === 1 ? this.workflowRun(id) : undefined
  }

  insertTrigger(record: TriggerRecord): boolean {
    const result = this.statement(`INSERT OR IGNORE INTO trigger_history (id, workspace_id, project_id, kind, workflow_id, payload, state, workflow_run_id, created_at)
      VALUES (@id, @workspaceId, @projectId, @kind, @workflowId, @payload, @state, @workflowRunId, @createdAt)`).run({
      id: record.id, workspaceId: record.scope.workspaceId, projectId: record.scope.projectId, kind: record.kind,
      workflowId: record.workflowId, payload: JSON.stringify(record.payload), state: record.state,
      workflowRunId: record.workflowRunId ?? null, createdAt: record.createdAt,
    })
    return result.changes === 1
  }

  listTriggers(scope: ScopeRef): TriggerRecord[] {
    return (this.statement(`SELECT t.*, w.name AS workspace_name, p.name AS project_name FROM trigger_history t JOIN workspaces w ON w.id = t.workspace_id JOIN projects p ON p.id = t.project_id WHERE t.workspace_id = ? AND t.project_id = ? ORDER BY t.created_at, t.id`).all(scope.workspaceId, scope.projectId) as (TriggerRecordRow & ScopeRow)[]).map((row) => ({ id: row.id, scope: toScope(row), kind: row.kind, workflowId: row.workflow_id, payload: JSON.parse(row.payload), state: row.state, workflowRunId: row.workflow_run_id ?? undefined, createdAt: row.created_at }))
  }

  insertObservationMetric(metric: ObservationMetric): void {
    this.statement(`INSERT INTO observation_metrics (id, workspace_id, project_id, kind, name, value, unit, labels, recorded_at)
      VALUES (@id, @workspaceId, @projectId, @kind, @name, @value, @unit, @labels, @recordedAt)`).run({
      id: metric.id, workspaceId: metric.scope.workspaceId, projectId: metric.scope.projectId, kind: metric.kind,
      name: metric.name, value: metric.value, unit: metric.unit, labels: JSON.stringify(metric.labels), recordedAt: metric.recordedAt,
    })
  }

  listObservationMetrics(scope: ScopeRef, kind?: ObservationMetric['kind']): ObservationMetric[] {
    const values: unknown[] = [scope.workspaceId, scope.projectId]
    let sql = `SELECT m.*, w.name AS workspace_name, p.name AS project_name FROM observation_metrics m JOIN workspaces w ON w.id = m.workspace_id JOIN projects p ON p.id = m.project_id WHERE m.workspace_id = ? AND m.project_id = ?`
    if (kind) { sql += ' AND m.kind = ?'; values.push(kind) }
    sql += ' ORDER BY m.recorded_at, m.id'
    return (this.statement(sql).all(...values) as Array<{ id: string; kind: ObservationMetric['kind']; name: string; value: number; unit: string; labels: string; recorded_at: string } & ScopeRow>).map((row) => ({ id: row.id, scope: toScope(row), kind: row.kind, name: row.name, value: row.value, unit: row.unit, labels: JSON.parse(row.labels), recordedAt: row.recorded_at }))
  }

  // --- Workflow schedules and watches (§7 Phase 8, C20) ---

  upsertWorkflowSchedule(schedule: WorkflowSchedule): void {
    this.statement(`INSERT INTO workflow_schedules
      (id, workspace_id, project_id, workflow_id, interval_ms, state, next_run_at, created_by, created_at, updated_at)
      VALUES (@id, @workspaceId, @projectId, @workflowId, @intervalMs, @state, @nextRunAt, @createdBy, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET interval_ms = excluded.interval_ms, state = excluded.state,
        next_run_at = excluded.next_run_at, updated_at = excluded.updated_at`).run({
      id: schedule.id, workspaceId: schedule.scope.workspaceId, projectId: schedule.scope.projectId, workflowId: schedule.workflowId,
      intervalMs: schedule.intervalMs, state: schedule.state, nextRunAt: schedule.nextRunAt, createdBy: schedule.createdBy,
      createdAt: schedule.createdAt, updatedAt: schedule.updatedAt,
    })
  }

  listWorkflowSchedules(scope: ScopeRef, state?: WorkflowSchedule['state']): WorkflowSchedule[] {
    const values: unknown[] = [scope.workspaceId, scope.projectId]
    let sql = `SELECT s.*, w.name AS workspace_name, p.name AS project_name FROM workflow_schedules s JOIN workspaces w ON w.id = s.workspace_id JOIN projects p ON p.id = s.project_id WHERE s.workspace_id = ? AND s.project_id = ?`
    if (state) { sql += ' AND s.state = ?'; values.push(state) }
    sql += ' ORDER BY s.next_run_at, s.id'
    return (this.statement(sql).all(...values) as Array<{ id: string; workflow_id: string; interval_ms: number; state: WorkflowSchedule['state']; next_run_at: string; created_by: string; created_at: string; updated_at: string } & ScopeRow>).map((row) => ({ id: row.id, scope: toScope(row), workflowId: row.workflow_id, intervalMs: row.interval_ms, state: row.state, nextRunAt: row.next_run_at, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at }))
  }

  workflowSchedule(id: string): WorkflowSchedule | undefined {
    return this.listAllWorkflowSchedules().find((schedule) => schedule.id === id)
  }

  dueWorkflowSchedules(at: string): WorkflowSchedule[] {
    return this.listAllWorkflowSchedules().filter((schedule) => schedule.state === 'enabled' && schedule.nextRunAt <= at)
  }

  private listAllWorkflowSchedules(): WorkflowSchedule[] {
    return (this.statement(`SELECT s.*, w.name AS workspace_name, p.name AS project_name FROM workflow_schedules s JOIN workspaces w ON w.id = s.workspace_id JOIN projects p ON p.id = s.project_id ORDER BY s.next_run_at, s.id`).all() as Array<{ id: string; workspace_id: string; project_id: string; workspace_name: string; project_name: string; workflow_id: string; interval_ms: number; state: WorkflowSchedule['state']; next_run_at: string; created_by: string; created_at: string; updated_at: string }>).map((row) => ({ id: row.id, scope: { workspaceId: row.workspace_id, projectId: row.project_id, workspaceName: row.workspace_name, projectName: row.project_name }, workflowId: row.workflow_id, intervalMs: row.interval_ms, state: row.state, nextRunAt: row.next_run_at, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at }))
  }

  updateWorkflowSchedule(id: string, state: WorkflowSchedule['state'], nextRunAt: string, updatedAt: string): WorkflowSchedule | undefined {
    const result = this.statement('UPDATE workflow_schedules SET state = ?, next_run_at = ?, updated_at = ? WHERE id = ?').run(state, nextRunAt, updatedAt, id)
    return result.changes === 1 ? this.listAllWorkflowSchedules().find((schedule) => schedule.id === id) : undefined
  }

  // --- Context watches (§7 Phase 8 "watches") ---

  upsertWorkflowWatch(watch: WorkflowWatch): void {
    this.statement(`INSERT INTO workflow_watches
      (id, workspace_id, project_id, workflow_id, uri_prefix, state, last_observed, next_run_at, created_by, created_at, updated_at)
      VALUES (@id, @workspaceId, @projectId, @workflowId, @uriPrefix, @state, @lastObserved, @nextRunAt, @createdBy, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET workflow_id = excluded.workflow_id, uri_prefix = excluded.uri_prefix,
        state = excluded.state, last_observed = excluded.last_observed, next_run_at = excluded.next_run_at, updated_at = excluded.updated_at`).run({
      id: watch.id, workspaceId: watch.scope.workspaceId, projectId: watch.scope.projectId, workflowId: watch.workflowId,
      uriPrefix: watch.uriPrefix, state: watch.state, lastObserved: watch.lastObserved ?? null, nextRunAt: watch.nextRunAt,
      createdBy: watch.createdBy, createdAt: watch.createdAt, updatedAt: watch.updatedAt,
    })
  }

  listWorkflowWatches(scope: ScopeRef, state?: WorkflowWatch['state']): WorkflowWatch[] {
    const values: unknown[] = [scope.workspaceId, scope.projectId]
    let sql = `SELECT w.*, ws.name AS workspace_name, p.name AS project_name FROM workflow_watches w JOIN workspaces ws ON ws.id = w.workspace_id JOIN projects p ON p.id = w.project_id WHERE w.workspace_id = ? AND w.project_id = ?`
    if (state) { sql += ' AND w.state = ?'; values.push(state) }
    sql += ' ORDER BY w.next_run_at, w.id'
    return (this.statement(sql).all(...values) as Array<{ id: string; project_id: string; workflow_id: string; uri_prefix: string; state: WorkflowWatch['state']; last_observed: string | null; next_run_at: string; created_by: string; created_at: string; updated_at: string } & ScopeRow>).map((row) => ({ id: row.id, scope: toScope(row), workflowId: row.workflow_id, uriPrefix: row.uri_prefix, state: row.state, lastObserved: row.last_observed ?? undefined, nextRunAt: row.next_run_at, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at }))
  }

  workflowWatch(id: string): WorkflowWatch | undefined {
    return this.listAllWorkflowWatches().find((watch) => watch.id === id)
  }

  dueWorkflowWatches(at: string): WorkflowWatch[] {
    return this.listAllWorkflowWatches().filter((watch) => watch.state === 'enabled' && watch.nextRunAt <= at)
  }

  private listAllWorkflowWatches(): WorkflowWatch[] {
    return (this.statement(`SELECT w.*, ws.name AS workspace_name, p.name AS project_name FROM workflow_watches w JOIN workspaces ws ON ws.id = w.workspace_id JOIN projects p ON p.id = w.project_id ORDER BY w.next_run_at, w.id`).all() as Array<{ id: string; project_id: string; workflow_id: string; uri_prefix: string; state: WorkflowWatch['state']; last_observed: string | null; next_run_at: string; created_by: string; created_at: string; updated_at: string } & ScopeRow>).map((row) => ({ id: row.id, scope: toScope(row), workflowId: row.workflow_id, uriPrefix: row.uri_prefix, state: row.state, lastObserved: row.last_observed ?? undefined, nextRunAt: row.next_run_at, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at }))
  }

  deleteWorkflowWatch(id: string): boolean {
    return this.statement('DELETE FROM workflow_watches WHERE id = ?').run(id).changes === 1
  }

  updateWorkflowWatchObservation(id: string, lastObserved: string, nextRunAt: string, updatedAt: string): WorkflowWatch | undefined {
    const result = this.statement('UPDATE workflow_watches SET last_observed = ?, next_run_at = ?, updated_at = ? WHERE id = ?').run(lastObserved, nextRunAt, updatedAt, id)
    return result.changes === 1 ? this.listAllWorkflowWatches().find((watch) => watch.id === id) : undefined
  }

  /** Advances only the next observation time, leaving the baseline fingerprint untouched. */
  deferWorkflowWatch(id: string, nextRunAt: string, updatedAt: string): WorkflowWatch | undefined {
    const result = this.statement('UPDATE workflow_watches SET next_run_at = ?, updated_at = ? WHERE id = ?').run(nextRunAt, updatedAt, id)
    return result.changes === 1 ? this.listAllWorkflowWatches().find((watch) => watch.id === id) : undefined
  }

  setWorkflowWatchState(id: string, state: WorkflowWatch['state'], updatedAt: string): WorkflowWatch | undefined {
    const result = this.statement('UPDATE workflow_watches SET state = ?, updated_at = ? WHERE id = ?').run(state, updatedAt, id)
    return result.changes === 1 ? this.listAllWorkflowWatches().find((watch) => watch.id === id) : undefined
  }

  // --- Retrieval trajectories (§7 Phase 8 observability) ---

  insertRetrievalTrajectory(trajectory: RetrievalTrajectory): void {
    this.statement(`INSERT INTO retrieval_trajectories
      (id, workspace_id, project_id, query, tiers, hit_count, top_hit_uri, duration_ms, occurred_at)
      VALUES (@id, @workspaceId, @projectId, @query, @tiers, @hitCount, @topHitUri, @durationMs, @occurredAt)`).run({
      id: trajectory.id, workspaceId: trajectory.scope.workspaceId, projectId: trajectory.scope.projectId,
      query: trajectory.query, tiers: JSON.stringify(trajectory.tiers), hitCount: trajectory.hitCount,
      topHitUri: trajectory.topHitUri ?? null, durationMs: trajectory.durationMs, occurredAt: trajectory.occurredAt,
    })
  }

  listRetrievalTrajectories(scope: ScopeRef, limit = 50): RetrievalTrajectory[] {
    return (this.statement(`SELECT t.*, ws.name AS workspace_name, p.name AS project_name
      FROM retrieval_trajectories t JOIN workspaces ws ON ws.id = t.workspace_id JOIN projects p ON p.id = t.project_id
      WHERE t.workspace_id = ? AND t.project_id = ? ORDER BY t.occurred_at DESC, t.id LIMIT ?`).all(scope.workspaceId, scope.projectId, limit) as Array<{ id: string; query: string; tiers: string; hit_count: number; top_hit_uri: string | null; duration_ms: number; occurred_at: string } & ScopeRow>).map((row) => ({ id: row.id, scope: toScope(row), query: row.query, tiers: JSON.parse(row.tiers), hitCount: row.hit_count, topHitUri: row.top_hit_uri ?? undefined, durationMs: row.duration_ms, occurredAt: row.occurred_at }))
  }

  // --- Queue diagnostics (§7 Phase 8 "queue diagnostics") ---

  /**
   * The durable queues are mail queues plus the task ledger's status classes;
   * each row is a count over ledger state, so diagnostics never hold state of
   * their own. `dispatch` and the named task queues appear with depth 0 when
   * empty rather than being omitted — an empty queue is a fact, not an absence.
   */
  queueDiagnostics(scope: ScopeRef): QueueDiagnostic[] {
    const mailStates = this.statement(`SELECT queue, state, COUNT(*) AS depth, MIN(created_at) AS oldest_at
      FROM messages WHERE workspace_id = ? AND project_id = ? GROUP BY queue, state ORDER BY queue, state`).all(scope.workspaceId, scope.projectId) as Array<{ queue: string; state: string; depth: number; oldest_at: string }>
    const queues = new Map<string, QueueDiagnostic>()
    for (const row of mailStates) {
      const queue = row.queue ?? 'unrouted'
      const entry = queues.get(queue) ?? { queue, depth: 0, states: {} }
      entry.depth += row.depth
      entry.states[row.state] = (entry.states[row.state] ?? 0) + row.depth
      if (!entry.oldestAt || row.oldest_at < entry.oldestAt) entry.oldestAt = row.oldest_at
      queues.set(queue, entry)
    }
    for (const queue of ['supervisor', 'unrouted']) {
      queues.get(queue) ?? queues.set(queue, { queue, depth: 0, states: {} })
    }
    return [...queues.values()].sort((a, b) => (a.queue < b.queue ? -1 : 1))
  }

  // --- Federation quarantine (§7 Phase 9): imported peer events, held for review ---

  insertFederationQuarantine(entry: { id: string; peerId: string; event: unknown; receivedAt: string; state: string }): void {
    this.statement('INSERT INTO federation_quarantine (id, peer_id, event_json, received_at, state) VALUES (?, ?, ?, ?, ?)')
      .run(entry.id, entry.peerId, JSON.stringify(entry.event), entry.receivedAt, entry.state)
  }

  /** True when this peer event is already held, so re-import is a no-op rather than a duplicate row. */
  federationQuarantineHas(peerId: string, eventId: string): boolean {
    const rows = this.statement(`SELECT id FROM federation_quarantine WHERE peer_id = ? AND json_extract(event_json, '$.eventId') = ? LIMIT 1`).all(peerId, eventId)
    return rows.length > 0
  }

  // --- Federation replay state (§7 Phase 9): the durable per-peer import cursor ---

  federationReplayState(peerId: string): { lastSequence: number; lastPageChecksum: string; manifestChecksum: string; updatedAt: string } | undefined {
    const row = this.statement('SELECT last_sequence, last_page_checksum, manifest_checksum, updated_at FROM federation_replay_state WHERE peer_id = ?').get(peerId) as
      | { last_sequence: number; last_page_checksum: string; manifest_checksum: string; updated_at: string }
      | undefined
    return row ? { lastSequence: row.last_sequence, lastPageChecksum: row.last_page_checksum, manifestChecksum: row.manifest_checksum, updatedAt: row.updated_at } : undefined
  }

  setFederationReplayState(peerId: string, lastSequence: number, lastPageChecksum: string, updatedAt: string, manifestChecksum = ''): void {
    this.statement(`INSERT INTO federation_replay_state (peer_id, last_sequence, last_page_checksum, manifest_checksum, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(peer_id) DO UPDATE SET last_sequence = excluded.last_sequence, last_page_checksum = excluded.last_page_checksum, manifest_checksum = excluded.manifest_checksum, updated_at = excluded.updated_at`).run(peerId, lastSequence, lastPageChecksum, manifestChecksum, updatedAt)
  }

  listFederationQuarantine(peerId?: string, state = 'pending'): Array<{ id: string; peerId: string; event: unknown; receivedAt: string; state: string }> {
    const rows = peerId === undefined
      ? this.statement('SELECT * FROM federation_quarantine WHERE state = ? ORDER BY received_at, id').all(state) as Array<{ id: string; peer_id: string; event_json: string; received_at: string; state: string }>
      : this.statement('SELECT * FROM federation_quarantine WHERE peer_id = ? AND state = ? ORDER BY received_at, id').all(peerId, state) as Array<{ id: string; peer_id: string; event_json: string; received_at: string; state: string }>
    return rows.map((row) => ({ id: row.id, peerId: row.peer_id, event: JSON.parse(row.event_json), receivedAt: row.received_at, state: row.state }))
  }

  countFederationQuarantine(state = 'pending'): number {
    return (this.statement('SELECT COUNT(*) AS count FROM federation_quarantine WHERE state = ?').get(state) as { count: number }).count
  }

  /**
   * An operator's explicit promotion decision: the only path out of quarantine.
   * The decision is audited — who decided, what record, and when — because a
   * promoted peer event is adopted evidence and must be traceable (§7 exit gate:
   * "an audit trail for recovery decisions").
   */
  setFederationQuarantineState(id: string, state: 'promoted' | 'rejected', actor?: ActorContext): boolean {
    const decided = this.statement('UPDATE federation_quarantine SET state = ? WHERE id = ? AND state = \'pending\'').run(state, id).changes === 1
    if (decided && actor) {
      const row = this.statement('SELECT peer_id, event_json FROM federation_quarantine WHERE id = ?').get(id) as { peer_id: string; event_json: string } | undefined
      const eventId = row ? (JSON.parse(row.event_json) as { eventId?: string }).eventId : undefined
      this.recordAudit(actor.actorId, `federation.quarantine.${state}`, { quarantineId: id, peerId: row?.peer_id, eventId })
    }
    return decided
  }

  // --- Durable control-plane settings (§7 Phase 8) ---

  setting(key: string): string | undefined {
    const row = this.statement('SELECT value FROM control_settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  }

  setSetting(key: string, value: string, updatedAt: string): void {
    this.statement(`INSERT INTO control_settings (key, value, updated_at) VALUES (@key, @value, @updatedAt)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run({ key, value, updatedAt })
  }

  /** Statements are compiled once and reused; re-preparing dominates the cost of small queries. */
  private statement(sql: string): Database.Statement {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.sqlite.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  private cached<T>(cache: Map<string, T>, key: string, resolve: () => T): T {
    let value = cache.get(key)
    if (value === undefined) {
      value = resolve()
      cache.set(key, value)
    }
    return value
  }

  private timestamp(): string {
    return this.now().toISOString()
  }

  private actor(actorId: string): ActorContext {
    const row = this.statement('SELECT * FROM actors WHERE id = ?').get(actorId) as ActorRow | undefined
    if (!row) throw new HiveError('ACTOR_NOT_FOUND', `Actor ${actorId} not found`)
    return {
      actorId, actorType: row.type, displayName: row.display_name,
      capabilities: JSON.parse(row.capabilities) as ActorContext['capabilities'], source: row.source,
      workspaceId: row.workspace_id ?? undefined, projectId: row.project_id ?? undefined,
    }
  }

  private scope(workspaceId: string, projectId: string): ScopeRef {
    const row = this.statement(`SELECT w.id AS workspace_id, p.id AS project_id, w.name AS workspace_name, p.name AS project_name
      FROM projects p JOIN workspaces w ON w.id = p.workspace_id WHERE w.id = ? AND p.id = ?`).get(workspaceId, projectId) as ScopeRow | undefined
    if (!row) throw new HiveError('SCOPE_NOT_FOUND', 'Event scope not found')
    return toScope(row)
  }
}
