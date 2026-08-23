import { ActorContext, EventEnvelope, ScopeRef } from '../contracts.js'
import { createId } from '../shared/ids.js'

/** Marks events Hive itself produced, so a filesystem watcher does not replay them as external edits. */
export const contextOriginMarker = 'hive:context'

export type ContextAction = 'write' | 'rename' | 'delete' | 'restore' | 'reconcile' | 'snapshot'

/**
 * Builds the `EventEnvelope` for one context mutation (C13). The idempotency key
 * is derived from the URI and version rather than a clock, so replaying the same
 * operation is recognized as the same event; the URI already carries the
 * workspace and project, which is what makes the key project-scoped.
 */
export function contextEvent(
  actor: ActorContext,
  scope: ScopeRef,
  action: ContextAction,
  key: string,
  occurredAt: string,
  payload: Record<string, unknown>,
): EventEnvelope {
  return {
    version: 1,
    eventId: createId(),
    idempotencyKey: `context:${action}:${key}`,
    eventType: 'Context',
    source: actor.source,
    actor,
    scope,
    occurredAt,
    payload,
    originMarker: contextOriginMarker,
  }
}
