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

export interface ResultEnvelope<T> {
  version: 1
  requestId: string
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}
