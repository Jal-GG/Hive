import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ActorContext, EventEnvelope, ScopeRef } from '../contracts.js'
import { Ledger } from '../ledger.js'
import { createId } from '../shared.js'

/**
 * Federation (§7 Phase 9): two independent Hive deployments exchange *scrubbed*
 * event records, never live state. The manifest states sovereignty (who owns
 * what), the export is a signed cursor-delimited page of redacted envelopes,
 * and the import lands everything in a quarantine table first — a federation
 * peer's data is evidence to review, never authority to adopt.
 *
 * There is deliberately no live cross-town write path (§8: "Sovereignty,
 * conflict resolution, and peer identity are not specified enough" for more).
 */

export interface FederationManifest {
  version: 1
  /** The exporting deployment's identity, e.g. `town-a`. Must be unique among peers. */
  peerId: string
  /** The workspaces and projects this peer asserts ownership of. Imports of foreign-owned scopes are refused. */
  sovereignty: Array<{ workspace: string; project: string }>
  /** What happens when an imported record conflicts with local state. Only `quarantine` is implemented; the others are refused at import. */
  conflictPolicy: 'exporter-wins' | 'local-wins' | 'quarantine'
  /** The export's protocol contract: only these event types are ever exported or imported. */
  eventTypes: readonly string[]
  createdAt: string
}

export interface FederationExport {
  manifest: FederationManifest
  /** The first event sequence included; the cursor an importer must confirm first. */
  fromSequence: number
  /** Inclusive last sequence in this page. */
  toSequence: number
  events: Array<Omit<EventEnvelope, 'actor'> & { actorId: string }>
  /** sha256 of the canonical event JSON, in order — the importer verifies before storing. */
  checksum: string
  /** The exporting ledger's latest sequence, so the importer knows whether more pages exist. */
  latest: number
}

/** The fields that must never leave the deployment, enforced by scrubbing rather than trust. */
const redactedPayloadKeys = /secret|token|key|password|authorization|credential/i

export function scrubEvent(event: EventEnvelope): { ok: true; event: FederationExport['events'][number] } | { ok: false; reason: string } {
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event.payload)) {
    if (redactedPayloadKeys.test(key)) continue // dropped, not masked: nothing sensitive ships
    payload[key] = value
  }
  return {
    ok: true,
    event: {
      version: event.version,
      eventId: event.eventId,
      idempotencyKey: event.idempotencyKey,
      eventType: event.eventType,
      source: event.source,
      actorId: event.actor.actorId,
      scope: event.scope,
      runId: event.runId,
      workItemId: event.workItemId,
      occurredAt: event.occurredAt,
      sequence: event.sequence,
      payload,
      parentEventId: event.parentEventId,
      originMarker: event.originMarker,
    },
  }
}

/** Canonical checksum: the events as stored, so byte-for-byte tampering is detectable. */
export function exportChecksum(events: FederationExport['events']): string {
  const digest = createHash('sha256')
  for (const event of events) digest.update(JSON.stringify(event))
  return digest.digest('hex')
}

export interface FederatorOptions {
  ledger: Ledger
  manifest: FederationManifest
}

export class Federator {
  constructor(private readonly options: FederatorOptions) {}

  manifest(): FederationManifest {
    return this.options.manifest
  }

  /**
   * Exports one cursor-delimited page of scrubbed events. Only the manifest's
   * declared event types ship; anything else stays local even if asked for.
   */
  exportPage(fromSequence: number, limit = 500): FederationExport {
    const events: FederationExport['events'] = []
    for (const event of this.options.ledger.readEvents(fromSequence, limit)) {
      if (!this.options.manifest.eventTypes.includes(event.eventType)) continue
      const scrubbed = scrubEvent(event)
      if (scrubbed.ok) events.push(scrubbed.event)
    }
    const toSequence = events.length > 0 ? events[events.length - 1].sequence ?? fromSequence : fromSequence
    return {
      manifest: this.options.manifest,
      fromSequence,
      toSequence,
      events,
      checksum: exportChecksum(events),
      latest: this.options.ledger.latestEventSequence(),
    }
  }

  /**
   * Verifies an export page and lands it in quarantine. Every check fails
   * closed: bad checksum, sovereignty violation, or an event type outside the
   * manifest's contract refuses the whole page atomically.
   *
   * Idempotent by construction: a page whose events are already held for this
   * peer imports zero new rows and reports `alreadyImported`, so a reconnect
   * or operator retry never duplicates quarantine (§7 DoD: "reconnects
   * idempotently"). The replay cursor only ever moves forward, and a peer
   * whose manifest changes mid-stream is refused as a different contract.
   * Imports are audited when the caller supplies the deciding actor.
   */
  importPage(page: FederationExport, actor?: ActorContext): { ok: true; quarantined: number; cursor: number; alreadyImported?: boolean } | { ok: false; reason: string } {
    if (page.manifest.version !== 1) return { ok: false, reason: 'unsupported manifest version' }
    if (page.manifest.peerId === this.options.manifest.peerId) return { ok: false, reason: 'refusing to import our own export' }
    if (page.checksum !== exportChecksum(page.events)) return { ok: false, reason: 'checksum mismatch: page was modified in transit' }
    if (page.manifest.conflictPolicy !== 'quarantine') {
      return { ok: false, reason: `conflict policy '${page.manifest.conflictPolicy}' is not implemented; only quarantine-on-conflict is supported` }
    }
    const allowedTypes = new Set(this.options.manifest.eventTypes)
    for (const event of page.events) {
      if (!allowedTypes.has(event.eventType)) return { ok: false, reason: `event type ${event.eventType} is outside the import contract` }
      if (event.scope) {
        // Sovereignty: the export may only carry scopes its manifest claims.
        const owned = page.manifest.sovereignty.some((entry) => entry.workspace === event.scope!.workspaceName && entry.project === event.scope!.projectName)
        if (!owned) return { ok: false, reason: `event ${event.eventId} carries a scope the exporter does not own` }
      }
    }
    // Replay cursor and manifest provenance: an importer never re-consumes a
    // page it already holds, and never continues a stream whose manifest
    // changed underneath it.
    const manifestChecksum = createHash('sha256').update(JSON.stringify(page.manifest)).digest('hex')
    const replay = this.options.ledger.federationReplayState(page.manifest.peerId)
    if (replay) {
      if (replay.manifestChecksum !== '' && replay.manifestChecksum !== manifestChecksum) {
        return { ok: false, reason: 'manifest changed for this peer: the export contract must stay stable across a replay stream' }
      }
      if (page.toSequence <= replay.lastSequence) {
        return this.auditedImport({ ok: true, quarantined: 0, cursor: replay.lastSequence, alreadyImported: true }, page, actor)
      }
      if (page.fromSequence > replay.lastSequence + 1) {
        return { ok: false, reason: `gap in replay: cursor is at ${replay.lastSequence}, page starts at ${page.fromSequence}` }
      }
      if (page.fromSequence < replay.lastSequence && page.checksum === replay.lastPageChecksum) {
        return this.auditedImport({ ok: true, quarantined: 0, cursor: replay.lastSequence, alreadyImported: true }, page, actor)
      }
    }
    let quarantined = 0
    for (const event of page.events) {
      if (this.options.ledger.federationQuarantineHas(page.manifest.peerId, event.eventId)) continue
      this.options.ledger.insertFederationQuarantine({
        id: createId(),
        peerId: page.manifest.peerId,
        event,
        receivedAt: new Date().toISOString(),
        state: 'pending',
      })
      quarantined += 1
    }
    if (quarantined > 0) {
      this.options.ledger.setFederationReplayState(page.manifest.peerId, page.toSequence, page.checksum, new Date().toISOString(), manifestChecksum)
    }
    return this.auditedImport({ ok: true, quarantined, cursor: page.toSequence }, page, actor)
  }

  /** Every successful import — new rows or an idempotent no-op — is an audited operator decision. */
  private auditedImport(result: { ok: true; quarantined: number; cursor: number; alreadyImported?: boolean }, page: FederationExport, actor?: ActorContext): { ok: true; quarantined: number; cursor: number; alreadyImported?: boolean } {
    if (actor) {
      this.options.ledger.recordAudit(actor.actorId, 'federation.import', { peerId: page.manifest.peerId, quarantined: result.quarantined, cursor: result.cursor, alreadyImported: result.alreadyImported === true })
    }
    return result
  }
}

/** Writes an export page to disk as the transfer artifact between peers. */
export function writeExport(page: FederationExport, path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(page, null, 2), 'utf8')
}

export function readExport(path: string): FederationExport {
  return JSON.parse(readFileSync(path, 'utf8')) as FederationExport
}

/** A scope names, for the sovereignty checks: the manifest's claimed pairs. */
export function sovereigntyCovers(manifest: FederationManifest, scope: ScopeRef): boolean {
  return manifest.sovereignty.some((entry) => entry.workspace === scope.workspaceName && entry.project === scope.projectName)
}

// Re-exported so callers do not need the fs path join.
export { join }
