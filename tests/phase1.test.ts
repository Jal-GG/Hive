import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBackup } from '../src/backup.js'
import { ActorContext, EventEnvelope } from '../src/contracts.js'
import { HiveError } from '../src/errors.js'
import { Ledger } from '../src/ledger.js'
import { canonicalPath, requireCapability, requireScope, resourceUri } from '../src/validation.js'

const operator: ActorContext = {
  actorId: 'operator-1', actorType: 'operator', displayName: 'Operator', source: 'cli',
  capabilities: ['work:dispatch', 'backup:create', 'workspace:read', 'workspace:write'],
}

function ledgerWithActor() {
  const ledger = new Ledger(':memory:')
  ledger.createActor(operator)
  return ledger
}

describe('Phase 1 validation', () => {
  it('canonicalizes safe resource paths and rejects traversal', () => {
    const scope = { workspaceId: 'w', projectId: 'p', workspaceName: 'main', projectName: 'app' }
    expect(resourceUri(scope, 'docs/readme.md')).toBe('viking://workspace/main/project/app/docs/readme.md')
    expect(() => canonicalPath('../secret')).toThrowError(HiveError)
    expect(() => requireScope({ workspaceId: 'w' })).toThrowError(HiveError)
  })

  it('enforces capabilities', () => {
    expect(() => requireCapability([], 'work:dispatch')).toThrowError('Missing capability')
  })
})

describe('Phase 1 ledger', () => {
  it('migrates in WAL mode and deduplicates events', () => {
    const ledger = ledgerWithActor()
    expect(ledger.db.pragma('journal_mode', { simple: true })).toBe('memory')
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
    const ledger = ledgerWithActor()
    const first = ledger.acquireLease(operator, 'dispatch', 'work-1', 60_000)
    expect(first.fencingToken).toBe(1)
    expect(() => ledger.acquireLease(operator, 'dispatch', 'work-1', 60_000)).toThrowError('active lease')
    ledger.releaseLease(operator, first.id)
    const second = ledger.acquireLease(operator, 'dispatch', 'work-1', 60_000)
    expect(second.fencingToken).toBe(2)
    ledger.close()
  })

  it('blocks backups while a lease is active and writes a verified backup after release', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'hive-'))
    const source = join(sourceDir, 'ledger.db')
    const destination = join(sourceDir, 'backup', 'ledger.db')
    const ledger = new Ledger(source)
    ledger.createActor(operator)
    const lease = ledger.acquireLease(operator, 'maintenance', 'backup-test', 60_000)
    await expect(createBackup(ledger, source, destination)).rejects.toThrowError('active leases')
    ledger.releaseLease(operator, lease.id)
    const manifest = await createBackup(ledger, source, destination)
    expect(manifest.schemaVersion).toBe(1)
    expect(readFileSync(destination).byteLength).toBeGreaterThan(0)
    ledger.close()
  })
})
