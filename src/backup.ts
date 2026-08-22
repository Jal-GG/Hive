import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { HiveError } from './errors.js'
import { Ledger } from './ledger.js'

export interface BackupManifest {
  version: 1
  createdAt: string
  schemaVersion: number
  activeLeaseCount: number
  source: string
  destination: string
}

export async function createBackup(ledger: Ledger, source: string, destination: string): Promise<BackupManifest> {
  const activeLeaseCount = ledger.activeLeaseCount()
  if (activeLeaseCount > 0) throw new HiveError('ACTIVE_LEASES', 'Cannot create a backup while active leases exist')
  mkdirSync(dirname(destination), { recursive: true })
  await ledger.db.backup(destination)
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    schemaVersion: 1,
    activeLeaseCount,
    source,
    destination,
  }
}

export function restoreBackup(source: string, destination: string, activeLeaseCount: number): void {
  if (activeLeaseCount > 0) throw new HiveError('ACTIVE_LEASES', 'Cannot restore a backup while active leases exist')
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
}
