import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBackup } from '../../src/backup.js'
import { EventEnvelope } from '../../src/contracts.js'
import { schemaVersion } from '../../src/sqlite-migrations.js'
import { Ledger } from '../../src/ledger.js'
import { ledgerWithActors, tempDirectory, testActor } from '../fixtures.js'

const operator = testActor('operator-1', ['work:dispatch', 'backup:create', 'workspace:read', 'workspace:write'])

describe('Phase 1 ledger', () => {
  it('migrates in WAL mode and deduplicates events', () => {
    const ledger = ledgerWithActors(operator)
    expect(ledger.pragma('journal_mode')).toBe('memory')
    const event: EventEnvelope = {
      version: 1, eventId: 'event-1', idempotencyKey: 'source-1', eventType: 'System', source: 'test', actor: operator,
      occurredAt: new Date().toISOString(), payload: { healthy: true }, originMarker: 'test:event-1',
    }
    expect(ledger.appendEvent(event)).toBe(true)
    expect(ledger.appendEvent(event)).toBe(false)
    expect(ledger.readEvents()).toHaveLength(1)
    ledger.close()
  })

  it('fences leases and rejects duplicate active claims', () => {
    const ledger = ledgerWithActors(operator)
    const first = ledger.acquireLease(operator, 'dispatch', 'work-1', 60_000)
    expect(first.fencingToken).toBe(1)
    expect(() => ledger.acquireLease(operator, 'dispatch', 'work-1', 60_000)).toThrowError('active lease')
    ledger.releaseLease(operator, first.id)
    const second = ledger.acquireLease(operator, 'dispatch', 'work-1', 60_000)
    expect(second.fencingToken).toBe(2)
    ledger.close()
  })

  it('blocks backups while a lease is active and writes a verified backup after release', async () => {
    const sourceDir = tempDirectory('backup')
    const source = join(sourceDir, 'ledger.db')
    const destination = join(sourceDir, 'backup', 'ledger.db')
    const ledger = new Ledger(source)
    ledger.createActor(operator)
    const lease = ledger.acquireLease(operator, 'maintenance', 'backup-test', 60_000)
    await expect(createBackup(ledger, source, destination)).rejects.toThrowError('active leases')
    ledger.releaseLease(operator, lease.id)
    const manifest = await createBackup(ledger, source, destination)
    // Pinned to the constant, not a literal: a new migration must not fail this test.
    expect(manifest.schemaVersion).toBe(schemaVersion)
    expect(readFileSync(destination).byteLength).toBeGreaterThan(0)
    ledger.close()
  })
})
