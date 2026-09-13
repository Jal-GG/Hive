import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ReleaseManifest {
  version: string
  channel: 'stable' | 'beta' | 'nightly'
  packageUrl?: string
  publishedAt?: string
  sha256?: string
}

export interface UpdateCheckResult {
  currentVersion: string
  updateAvailable: boolean
  manifest?: ReleaseManifest
}

export function currentVersion(packageRoot: string): string {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof packageJson.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(packageJson.version)) throw new Error('package.json has no valid version')
  return packageJson.version
}

export function checkUpdate(current: string, manifest: ReleaseManifest | undefined): UpdateCheckResult {
  if (!/^\d+\.\d+\.\d+$/.test(current)) throw new Error('Current version is invalid')
  return { currentVersion: current, updateAvailable: manifest !== undefined && compareVersions(manifest.version, current) > 0, manifest }
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}
