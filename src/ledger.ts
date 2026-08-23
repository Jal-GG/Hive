import Database from 'better-sqlite3'
import { ActorContext, ContextNode, EventEnvelope, Lease, ScopeRef } from './contracts.js'
import { HiveError } from './errors.js'
import { SqliteDatabase } from './infrastructure/sqlite/sqlite-database.js'
import { createId } from './shared/ids.js'
import { Clock, ClockOptions, resolveClock } from './shared/clock.js'
import { assertCapability } from './identity/capabilities.js'
import { validateScopeName } from './scope/resource-uri.js'

export type LedgerOptions = ClockOptions

interface EventRow {
  event_id: string
  idempotency_key: string
  event_type: EventEnvelope['eventType']
  source: string
  actor_id: string
  workspace_id: string | null
  project_id: string | null
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
        (event_id, idempotency_key, event_type, source, actor_id, workspace_id, project_id, occurred_at, sequence, payload, parent_event_id, origin_marker)
        VALUES (@eventId, @idempotencyKey, @eventType, @source, @actorId, @workspaceId, @projectId, @occurredAt, @sequence, @payload, @parentEventId, @originMarker)`).run({
        eventId: event.eventId,
        idempotencyKey: event.idempotencyKey,
        eventType: event.eventType,
        source: event.source,
        actorId: event.actor.actorId,
        workspaceId: event.scope?.workspaceId ?? null,
        projectId: event.scope?.projectId ?? null,
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
    if (limit < 1 || limit > 1000) throw new HiveError('INVALID_LIMIT', 'Event limit must be between 1 and 1000')
    // Plain `sequence` (never null on insert) so events_sequence_idx is usable.
    const rows = this.statement('SELECT * FROM events WHERE sequence > ? ORDER BY sequence, event_id LIMIT ?').all(afterSequence, limit) as EventRow[]
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

  contextNodeHash(uri: string): string | undefined {
    const row = this.statement('SELECT sha256 FROM context_nodes WHERE uri = ?').get(uri) as { sha256: string } | undefined
    return row?.sha256
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
    return { workspaceId: row.workspace_id, projectId: row.project_id, workspaceName: row.workspace_name, projectName: row.project_name }
  }
}
