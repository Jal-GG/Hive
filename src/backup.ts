import { copyFileSync } from 'node:fs'
import { HiveError } from './errors.js'
import { Ledger } from './ledger.js'
import { ensureParentDirectory } from './shared/fs.js'
import { schemaVersion } from './infrastructure/sqlite/migrations.js'

export interface BackupManifest {
  version: 1
  createdAt: string
  schemaVersion: number
  source: string
  destination: string
}

export async function createBackup(ledger: Ledger, source: string, destination: string): Promise<BackupManifest> {
  assertQuiesced(ledger, 'create')
  ensureParentDirectory(destination)
  await ledger.backup(destination)
  return { version: 1, createdAt: new Date().toISOString(), schemaVersion, source, destination }
}

export function restoreBackup(ledger: Ledger, source: string, destination: string): void {
  assertQuiesced(ledger, 'restore')
  ensureParentDirectory(destination)
  copyFileSync(source, destination)
}

/** Both directions require a quiet ledger: a lease in flight means work is mid-write. */
function assertQuiesced(ledger: Ledger, operation: 'create' | 'restore'): void {
  if (ledger.activeLeaseCount() > 0) throw new HiveError('ACTIVE_LEASES', `Cannot ${operation} a backup while active leases exist`)
}
