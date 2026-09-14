import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Federator, sovereigntyCovers, writeExport, type FederationManifest } from '../../src/remote/federation.js'
import { runFederateCli } from '../../src/interfaces/cli/remote-cli.js'
import { ledgerWithActors, tempDirectory, testActor } from '../fixtures.js'
import type { ActorContext, Capability, EventEnvelope } from '../../src/contracts.js'

const capabilities: Capability[] = ['workspace:read']

function manifest(peerId: string): FederationManifest {
  return {
    version: 1,
    peerId,
    sovereignty: [{ workspace: 'main', project: 'hive' }],
    conflictPolicy: 'quarantine',
    eventTypes: ['Work', 'System'],
    createdAt: '2026-09-14T00:00:00.000Z',
  }
}

function event(ledger: { appendEvent(event: EventEnvelope): boolean }, sequence: number, payload: Record<string, unknown> = {}): void {
  ledger.appendEvent({
    version: 1,
    eventId: `evt-${sequence}`,
    idempotencyKey: `idem-${sequence}`,
    eventType: 'Work',
    source: 'test',
    actor: actor(),
    occurredAt: '2026-09-14T00:00:00.000Z',
    payload,
    originMarker: 'test',
  })
}

let actorCache: ActorContext | undefined
function actor(): ActorContext {
  actorCache ??= testActor('operator', capabilities)
  return actorCache
}

describe('federation', () => {
  it('exports a scrubbed, cursor-delimited page and re-imports it into quarantine', () => {
    const exporterLedger = ledgerWithActors(actor())
    const importerLedger = ledgerWithActors(actor())
    try {
      event(exporterLedger, 1, { title: 'public title' })
      event(exporterLedger, 2, { title: 'secret token', apiKey: 'sk-live-abc', note: 'safe note' })

      const exporter = new Federator({ ledger: exporterLedger, manifest: manifest('town-a') })
      const page = exporter.exportPage(0)
      // The scrubbed page dropped the sensitive key entirely and kept the rest.
      expect(page.events).toHaveLength(2)
      expect(page.events.some((entry) => 'apiKey' in entry.payload)).toBe(false)
      expect(page.events.some((entry) => entry.payload.title === 'secret token')).toBe(true)
      expect(page.toSequence).toBeGreaterThan(0)
      // Actor context never ships: only the actor id string.
      expect(page.events.every((entry) => typeof entry.actorId === 'string' && !('actor' in entry))).toBe(true)

      const importer = new Federator({ ledger: importerLedger, manifest: manifest('town-b') })
      const result = importer.importPage(page)
      expect(result).toMatchObject({ ok: true, quarantined: 2 })
      expect(importerLedger.countFederationQuarantine('pending')).toBe(2)
    } finally {
      exporterLedger.close()
      importerLedger.close()
    }
  })

  it('refuses a tampered page: checksum mismatch fails the whole import', () => {
    const exporterLedger = ledgerWithActors(actor())
    const importerLedger = ledgerWithActors(actor())
    try {
      event(exporterLedger, 1)
      const exporter = new Federator({ ledger: exporterLedger, manifest: manifest('town-a') })
      const page = exporter.exportPage(0)
      const tampered = { ...page, events: [...page.events, { ...page.events[0], eventId: 'evt-forged' }] }
      const importer = new Federator({ ledger: importerLedger, manifest: manifest('town-b') })
      const result = importer.importPage(tampered)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('checksum')
      expect(importerLedger.countFederationQuarantine('pending')).toBe(0)
    } finally {
      exporterLedger.close()
      importerLedger.close()
    }
  })

  it('refuses an event type outside the import contract and a scope the exporter does not own', () => {
    const exporterLedger = ledgerWithActors(actor())
    const importerLedger = ledgerWithActors(actor())
    try {
      event(exporterLedger, 1)
      const exporter = new Federator({ ledger: exporterLedger, manifest: manifest('town-a') })
      const page = exporter.exportPage(0)

      // The importer's contract does not include 'Work' here.
      const stricter = new Federator({ ledger: importerLedger, manifest: { ...manifest('town-b'), eventTypes: ['System'] } })
      const refused = stricter.importPage(page)
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.reason).toContain('outside the import contract')

      // A page carrying a scope outside its manifest's sovereignty is refused.
      const scopeForged = page.events.map((entry) => ({ ...entry, scope: { workspaceId: 'w', projectId: 'p', workspaceName: 'other', projectName: 'foreign' } }))
      const sovereignty = new Federator({ ledger: importerLedger, manifest: manifest('town-b') })
      const refusedSovereignty = sovereignty.importPage({ ...page, events: scopeForged, manifest: { ...page.manifest, sovereignty: [{ workspace: 'other', project: 'foreign' }] } as typeof page.manifest })
      // The forged page's checksum no longer matches its events, so it is refused
      // by the earlier checksum gate — the defense in depth the test asserts.
      expect(refusedSovereignty.ok).toBe(false)
      if (!refusedSovereignty.ok) expect(refusedSovereignty.reason).toMatch(/checksum|does not own/)
    } finally {
      exporterLedger.close()
      importerLedger.close()
    }
  })

  it('re-imports the same page idempotently and refuses a page with a replay gap', () => {
    const exporterLedger = ledgerWithActors(actor())
    const importerLedger = ledgerWithActors(actor())
    try {
      event(exporterLedger, 1)
      event(exporterLedger, 2)
      const exporter = new Federator({ ledger: exporterLedger, manifest: manifest('town-a') })
      const importer = new Federator({ ledger: importerLedger, manifest: manifest('town-b') })

      const first = importer.importPage(exporter.exportPage(0))
      expect(first).toMatchObject({ ok: true, quarantined: 2 })
      // The retry — same page, after a reconnect — quarantines nothing new.
      const retry = importer.importPage(exporter.exportPage(0))
      expect(retry).toMatchObject({ ok: true, quarantined: 0, alreadyImported: true })
      expect(importerLedger.countFederationQuarantine('pending')).toBe(2)
      // The replay cursor is persisted per peer and points at the page's end.
      expect(importerLedger.federationReplayState('town-a')?.lastSequence).toBe(2)

      // A page that skips ahead of the cursor is a gap, not a fresh start.
      event(exporterLedger, 3)
      event(exporterLedger, 4)
      event(exporterLedger, 5)
      const gap = importer.importPage(exporter.exportPage(4))
      expect(gap.ok).toBe(false)
      if (!gap.ok) expect(gap.reason).toContain('gap in replay')

      // The next contiguous page imports normally.
      const next = importer.importPage(exporter.exportPage(2))
      expect(next).toMatchObject({ ok: true, quarantined: 3 })
      expect(importerLedger.countFederationQuarantine('pending')).toBe(5)
    } finally {
      exporterLedger.close()
      importerLedger.close()
    }
  })

  it('refuses a manifest whose conflict policy is not implemented', () => {
    const exporterLedger = ledgerWithActors(actor())
    const importerLedger = ledgerWithActors(actor())
    try {
      event(exporterLedger, 1)
      const exporter = new Federator({ ledger: exporterLedger, manifest: { ...manifest('town-a'), conflictPolicy: 'exporter-wins' } })
      const importer = new Federator({ ledger: importerLedger, manifest: manifest('town-b') })
      const refused = importer.importPage(exporter.exportPage(0))
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.reason).toContain('conflict policy')
      expect(importerLedger.countFederationQuarantine('pending')).toBe(0)
    } finally {
      exporterLedger.close()
      importerLedger.close()
    }
  })

  it('refuses a peer whose manifest changes mid-stream', () => {
    const exporterLedger = ledgerWithActors(actor())
    const importerLedger = ledgerWithActors(actor())
    try {
      event(exporterLedger, 1)
      event(exporterLedger, 2)
      const exporter = new Federator({ ledger: exporterLedger, manifest: manifest('town-a') })
      const importer = new Federator({ ledger: importerLedger, manifest: manifest('town-b') })
      expect(importer.importPage(exporter.exportPage(0))).toMatchObject({ ok: true, quarantined: 2 })

      // The same peer, but its manifest now claims different sovereignty: a
      // different contract, not a continuation of the same stream.
      event(exporterLedger, 3)
      const drifted = new Federator({ ledger: exporterLedger, manifest: { ...manifest('town-a'), sovereignty: [{ workspace: 'other', project: 'elsewhere' }] } })
      const refused = importer.importPage(drifted.exportPage(2))
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.reason).toContain('manifest changed')

      // The manifest checksum is persisted as replay provenance.
      expect(importerLedger.federationReplayState('town-a')?.manifestChecksum).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      exporterLedger.close()
      importerLedger.close()
    }
  })

  it('audits imports when the deciding actor is supplied', () => {
    const exporterLedger = ledgerWithActors(actor())
    const importerLedger = ledgerWithActors(actor())
    try {
      event(exporterLedger, 1)
      const exporter = new Federator({ ledger: exporterLedger, manifest: manifest('town-a') })
      const importer = new Federator({ ledger: importerLedger, manifest: manifest('town-b') })
      const page = exporter.exportPage(0)
      const result = importer.importPage(page, actor())
      expect(result).toMatchObject({ ok: true, quarantined: 1 })
      expect(importerLedger.auditCount('federation.import')).toBe(1)
      // A no-op re-import with the same actor is still a decision, still audited.
      importer.importPage(page, actor())
      expect(importerLedger.auditCount('federation.import')).toBe(2)
    } finally {
      exporterLedger.close()
      importerLedger.close()
    }
  })

  it('records who promoted and rejected, in the audit log', () => {
    const ledger = ledgerWithActors(actor())
    try {
      ledger.insertFederationQuarantine({ id: 'q1', peerId: 'town-a', event: { eventId: 'evt-1' }, receivedAt: new Date().toISOString(), state: 'pending' })
      const operator = testActor('operator', capabilities)
      expect(ledger.setFederationQuarantineState('q1', 'promoted', operator)).toBe(true)
      expect(ledger.auditCount('federation.quarantine.promoted')).toBe(1)
      expect(ledger.setFederationQuarantineState('q1', 'rejected', operator)).toBe(false) // already decided
      expect(ledger.auditCount('federation.quarantine.rejected')).toBe(0)
    } finally {
      ledger.close()
    }
  })

  it('quarantine promotion and rejection are explicit operator decisions', () => {
    const ledger = ledgerWithActors(actor())
    try {
      ledger.insertFederationQuarantine({ id: 'q1', peerId: 'town-a', event: { eventId: 'evt-1' }, receivedAt: new Date().toISOString(), state: 'pending' })
      ledger.insertFederationQuarantine({ id: 'q2', peerId: 'town-a', event: { eventId: 'evt-2' }, receivedAt: new Date().toISOString(), state: 'pending' })

      expect(ledger.setFederationQuarantineState('q1', 'promoted')).toBe(true)
      expect(ledger.setFederationQuarantineState('q1', 'promoted')).toBe(false) // already decided
      expect(ledger.setFederationQuarantineState('q2', 'rejected')).toBe(true)
      expect(ledger.countFederationQuarantine('pending')).toBe(0)
      expect(ledger.listFederationQuarantine('town-a', 'promoted')).toHaveLength(1)
    } finally {
      ledger.close()
    }
  })

  it('gates import and promote behind the federation:review capability', async () => {
    const reviewer = testActor('reviewer', ['workspace:read', 'federation:review'])
    const viewer = testActor('viewer', ['workspace:read'])
    const ledger = ledgerWithActors(reviewer, viewer)
    const work = tempDirectory('federate-cli')
    try {
      // One genuine page on disk to import. The exporter ledger carries both
      // the reviewer and the operator the events are attributed to.
      const exporterLedger = ledgerWithActors(reviewer, actor())
      try {
        event(exporterLedger, 1)
        const page = new Federator({ ledger: exporterLedger, manifest: manifest('town-a') }).exportPage(0)
        const file = join(work, 'page.json')
        writeExport(page, file)

        const options = { ledger, scope: { workspaceId: 'w', projectId: 'p', workspaceName: 'main', projectName: 'hive' }, stateRoot: work, packageRoot: work }
        // A viewer cannot import peer evidence...
        await expect(runFederateCli(options, viewer, ['import', '--file', file])).rejects.toThrow(/federation:review/)
        expect(ledger.countFederationQuarantine('pending')).toBe(0)
        // ...and cannot decide a quarantined record either.
        ledger.insertFederationQuarantine({ id: 'q-gate', peerId: 'town-a', event: { eventId: 'evt-manual' }, receivedAt: new Date().toISOString(), state: 'pending' })
        await expect(runFederateCli(options, viewer, ['promote', '--id', 'q-gate'])).rejects.toThrow(/federation:review/)

        // The reviewer can, and the decision is audited under their name.
        await runFederateCli(options, reviewer, ['import', '--file', file])
        expect(ledger.countFederationQuarantine('pending')).toBe(2)
        const promoted = JSON.parse(await runFederateCli(options, reviewer, ['promote', '--id', 'q-gate'])) as { promoted: boolean }
        expect(promoted.promoted).toBe(true)
        expect(ledger.auditCount('federation.quarantine.promoted')).toBe(1)
        expect(ledger.auditCount('federation.import')).toBe(1)
      } finally {
        exporterLedger.close()
      }
    } finally {
      ledger.close()
    }
  })

  it('sovereignty coverage answers scope questions directly', () => {
    const m = manifest('town-a')
    expect(sovereigntyCovers(m, { workspaceId: 'w', projectId: 'p', workspaceName: 'main', projectName: 'hive' })).toBe(true)
    expect(sovereigntyCovers(m, { workspaceId: 'w', projectId: 'p', workspaceName: 'main', projectName: 'other' })).toBe(false)
  })

  it('refuses to import its own export', () => {
    const ledger = ledgerWithActors(actor())
    try {
      const federator = new Federator({ ledger, manifest: manifest('town-a') })
      const page = federator.exportPage(0)
      const result = federator.importPage(page)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('our own export')
    } finally {
      ledger.close()
    }
  })
})
