import Database from 'better-sqlite3'
import {
  ActorContext,
  AgentProfile,
  ContextIndexEntry,
  ContextKind,
  ContextLevel,
  ContextLinkRef,
  ContextNode,
  ContextSnapshotManifest,
  ContextTombstone,
  EventEnvelope,
  Lease,
  Run,
  RunState,
  ScopeRef,
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

  createProject(workspaceId: string, name: string): string {
    validateScopeName(name, 'project name')
    const projectId = createId()
    this.statement('INSERT INTO projects(id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)').run(projectId, workspaceId, name, this.timestamp())
    return projectId
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
      (id, work_item_id, actor_id, workspace_id, project_id, runtime_profile, backend, session_key, cwd,
       repo_fingerprint, worktree_fingerprint, branch, state, lease_id, started_at, ended_at, exit_code, exit_signal,
       pid, transcript_cursor, imported_event_count, lost_event_count)
      VALUES (@id, @workItemId, @actorId, @workspaceId, @projectId, @runtimeProfile, @backend, @sessionKey, @cwd,
       @repoFingerprint, @worktreeFingerprint, @branch, @state, @leaseId, @startedAt, @endedAt, @exitCode, @exitSignal,
       @pid, @transcriptCursor, @importedEventCount, @lostEventCount)`).run({
      id: run.id,
      workItemId: run.workItemId ?? null,
      actorId: run.actorId,
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

  recordAudit(actorId: string, action: string, details: unknown): void {
    this.statement('INSERT INTO audit_log(actor_id, action, request_id, details, created_at) VALUES (?, ?, ?, ?, ?)').run(actorId, action, createId(), JSON.stringify(details), this.timestamp())
  }

  auditCount(action?: string): number {
    const row = action
      ? this.statement('SELECT COUNT(*) AS count FROM audit_log WHERE action = ?').get(action) as { count: number }
      : this.statement('SELECT COUNT(*) AS count FROM audit_log').get() as { count: number }
    return row.count
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
