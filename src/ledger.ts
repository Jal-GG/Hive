import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { ActorContext, EventEnvelope, Lease, ScopeRef } from './contracts.js'
import { HiveError } from './errors.js'
import { migrations, SCHEMA_VERSION } from './schema.js'
import { id, requireCapability, requireScope, validateName } from './validation.js'

export interface LedgerOptions {
  now?: () => Date
}

export class Ledger {
  readonly db: Database.Database
  private readonly now: () => Date

  constructor(file: string, options: LedgerOptions = {}) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new Database(file)
    this.now = options.now ?? (() => new Date())
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    const applied = this.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>
    const versions = new Set(applied.map((row) => row.version))
    const apply = this.db.transaction(() => {
      for (let version = 1; version <= SCHEMA_VERSION; version += 1) {
        if (versions.has(version)) continue
        this.db.exec(migrations[version])
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(version, this.now().toISOString())
      }
    })
    apply()
  }

  createWorkspace(name: string): string {
    validateName(name, 'workspace name')
    const workspaceId = id()
    this.db.prepare('INSERT INTO workspaces(id, name, created_at) VALUES (?, ?, ?)').run(workspaceId, name, this.now().toISOString())
    return workspaceId
  }

  createProject(workspaceId: string, name: string): string {
    validateName(name, 'project name')
    const projectId = id()
    this.db.prepare('INSERT INTO projects(id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)').run(projectId, workspaceId, name, this.now().toISOString())
    return projectId
  }

  createActor(actor: ActorContext): void {
    this.db.prepare(`INSERT INTO actors(id, type, display_name, source, capabilities, workspace_id, project_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      actor.actorId,
      actor.actorType,
      actor.displayName,
      actor.source,
      JSON.stringify(actor.capabilities),
      actor.workspaceId ?? null,
      actor.projectId ?? null,
      this.now().toISOString(),
    )
  }

  appendEvent(event: EventEnvelope): boolean {
    const append = this.db.transaction(() => {
      const duplicate = this.db.prepare('SELECT 1 FROM events WHERE event_id = ? OR idempotency_key = ?').get(event.eventId, event.idempotencyKey)
      if (duplicate) return false
      const cursor = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM events').get() as { sequence: number }
      this.db.prepare(`INSERT INTO events
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
    return append()
  }

  readEvents(afterSequence = 0, limit = 100): EventEnvelope[] {
    if (limit < 1 || limit > 1000) throw new HiveError('INVALID_LIMIT', 'Event limit must be between 1 and 1000')
    const rows = this.db.prepare('SELECT * FROM events WHERE COALESCE(sequence, 0) > ? ORDER BY COALESCE(sequence, 0), event_id LIMIT ?').all(afterSequence, limit) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      version: 1,
      eventId: String(row.event_id),
      idempotencyKey: String(row.idempotency_key),
      eventType: row.event_type as EventEnvelope['eventType'],
      source: String(row.source),
      actor: this.actor(String(row.actor_id)),
      scope: row.workspace_id && row.project_id ? this.scope(String(row.workspace_id), String(row.project_id)) : undefined,
      occurredAt: String(row.occurred_at),
      sequence: row.sequence === null ? undefined : Number(row.sequence),
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
      parentEventId: row.parent_event_id ? String(row.parent_event_id) : undefined,
      originMarker: String(row.origin_marker),
    }))
  }

  acquireLease(actor: ActorContext, resourceType: Lease['resourceType'], resourceId: string, ttlMs: number): Lease {
    requireCapability(actor.capabilities, 'work:dispatch')
    if (ttlMs <= 0 || ttlMs > 24 * 60 * 60 * 1000) throw new HiveError('INVALID_TTL', 'Lease TTL must be positive and no longer than 24 hours')
    const now = this.now()
    const expiresAt = new Date(now.getTime() + ttlMs)
    const transaction = this.db.transaction(() => {
      this.db.prepare("UPDATE leases SET state = 'expired' WHERE resource_type = ? AND resource_id = ? AND state = 'active' AND expires_at <= ?").run(resourceType, resourceId, now.toISOString())
      const existing = this.db.prepare("SELECT * FROM leases WHERE resource_type = ? AND resource_id = ? AND state = 'active'").get(resourceType, resourceId) as Record<string, unknown> | undefined
      if (existing) throw new HiveError('LEASE_CONFLICT', 'Resource already has an active lease')
      const previous = this.db.prepare('SELECT MAX(fencing_token) AS token FROM leases WHERE resource_type = ? AND resource_id = ?').get(resourceType, resourceId) as { token: number | null }
      const lease: Lease = {
        id: id(), resourceType, resourceId, ownerActorId: actor.actorId,
        fencingToken: (previous.token ?? 0) + 1, acquiredAt: now.toISOString(), expiresAt: expiresAt.toISOString(), state: 'active',
      }
      this.db.prepare(`INSERT INTO leases(id, resource_type, resource_id, owner_actor_id, fencing_token, acquired_at, expires_at, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(lease.id, lease.resourceType, lease.resourceId, lease.ownerActorId, lease.fencingToken, lease.acquiredAt, lease.expiresAt, lease.state)
      return lease
    })
    return transaction()
  }

  releaseLease(actor: ActorContext, leaseId: string): void {
    const result = this.db.prepare("UPDATE leases SET state = 'released' WHERE id = ? AND owner_actor_id = ? AND state = 'active'").run(leaseId, actor.actorId)
    if (result.changes !== 1) throw new HiveError('LEASE_NOT_OWNED', 'Active lease not found for actor')
  }

  activeLeaseCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM leases WHERE state = 'active'").get() as { count: number }).count)
  }

  private actor(actorId: string): ActorContext {
    const row = this.db.prepare('SELECT * FROM actors WHERE id = ?').get(actorId) as Record<string, unknown> | undefined
    if (!row) throw new HiveError('ACTOR_NOT_FOUND', `Actor ${actorId} not found`)
    return {
      actorId, actorType: row.type as ActorContext['actorType'], displayName: String(row.display_name),
      capabilities: JSON.parse(String(row.capabilities)) as ActorContext['capabilities'], source: row.source as ActorContext['source'],
      workspaceId: row.workspace_id ? String(row.workspace_id) : undefined, projectId: row.project_id ? String(row.project_id) : undefined,
    }
  }

  private scope(workspaceId: string, projectId: string): ScopeRef {
    const row = this.db.prepare(`SELECT w.id AS workspace_id, p.id AS project_id, w.name AS workspace_name, p.name AS project_name
      FROM projects p JOIN workspaces w ON w.id = p.workspace_id WHERE w.id = ? AND p.id = ?`).get(workspaceId, projectId) as Record<string, unknown> | undefined
    if (!row) throw new HiveError('SCOPE_NOT_FOUND', 'Event scope not found')
    return requireScope({ workspaceId: String(row.workspace_id), projectId: String(row.project_id), workspaceName: String(row.workspace_name), projectName: String(row.project_name) })
  }
}
