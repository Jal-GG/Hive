import { ActorContext, EventEnvelope, EventType, ScopeRef } from '../contracts.js'
import { createId } from '../shared.js'

/** Marked on every work-plane event, so downstream consumers can trust its origin the way children trust `HIVE_*`. */
export const workOriginMarker = 'hive:work'

/**
 * Builds a work-plane event (C13). Keys are derived from the thing that
 * happened rather than from a clock, and the per-item revision keeps repeated
 * transitions (in_progress → review → in_progress) distinct without weakening
 * replay deduplication for any single applied change.
 */
export function workEvent(
  actor: ActorContext,
  scope: ScopeRef,
  eventType: EventType,
  action: string,
  key: string,
  occurredAt: string,
  payload: Record<string, unknown>,
  workItemId?: string,
): EventEnvelope {
  return {
    version: 1,
    eventId: createId(),
    idempotencyKey: `${eventType.toLowerCase()}:${action}:${key}`,
    eventType,
    source: actor.source,
    actor,
    scope,
    workItemId,
    occurredAt,
    payload,
    originMarker: workOriginMarker,
  }
}
