import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'

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

export interface AssembleReleaseOptions {
  /** The project root: where package.json, dist/, and desktop/ live. */
  packageRoot: string
  /** Where the release directory is created; the directory itself is `<out>/hive-<version>-<channel>`. */
  outRoot: string
  channel?: ReleaseManifest['channel']
  /** The already-bundled CLI entry to package; defaults to `<packageRoot>/dist/cli.cjs`. */
  cliEntry?: string
}

export interface AssembledRelease {
  directory: string
  manifest: ReleaseManifest
  /** The files copied, relative to the release directory, in copy order. */
  files: string[]
}

/**
 * The §7.10 gate's "release packaging": assemble a distributable directory from
 * what the build already produced — no secrets, no node_modules, no ledger
 * databases — plus a checksummed manifest an update check can read. It is a
 * pure assembly step: building is `npm run build:cli`/`build:desktop`'s job,
 * and nothing here runs or publishes anything.
 */
export function assembleRelease(options: AssembleReleaseOptions): AssembledRelease {
  const channel = options.channel ?? 'nightly'
  const version = currentVersion(options.packageRoot)
  const cliEntry = options.cliEntry ?? join(options.packageRoot, 'dist', 'cli.cjs')
  if (!existsSync(cliEntry)) throw new Error(`CLI bundle not found at ${cliEntry}; run npm run build:cli first`)

  const directory = join(options.outRoot, `hive-${version}-${channel}`)
  mkdirSync(directory, { recursive: true })
  const files: string[] = []
  copyIfPresent(join(options.packageRoot, 'package.json'), join(directory, 'package.json'), directory, files)
  copyIfPresent(cliEntry, join(directory, basename(cliEntry)), directory, files)
  copyIfPresent(join(options.packageRoot, 'dist', 'desktop', 'main.cjs'), join(directory, 'main.cjs'), directory, files)
  copyIfPresent(join(options.packageRoot, 'dist', 'desktop', 'preload.cjs'), join(directory, 'preload.cjs'), directory, files)
  copyDirectoryIfPresent(join(options.packageRoot, 'dist', 'desktop', 'renderer'), join(directory, 'renderer'), directory, files)

  const manifest: ReleaseManifest = { version, channel, publishedAt: new Date().toISOString() }
  const manifestPath = join(directory, 'release-manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  files.push('release-manifest.json')
  return { directory, manifest, files }
}

function copyIfPresent(from: string, to: string, root: string, files: string[]): void {
  if (!existsSync(from)) return
  copyFileSync(from, to)
  files.push(relative(root, to).split(sep).join('/'))
}

function copyDirectoryIfPresent(from: string, to: string, root: string, files: string[]): void {
  if (!existsSync(from)) return
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    const source = join(from, entry)
    const target = join(to, entry)
    if (statSync(source).isDirectory()) copyDirectoryIfPresent(source, target, root, files)
    else copyIfPresent(source, target, root, files)
  }
}

/** The checksum a manifest consumer verifies, isolated so the release itself stays data. */
export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
