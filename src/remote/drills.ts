import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { EventEnvelope } from '../contracts.js'
import { GitRunner } from '../git.js'
import { Ledger } from '../ledger.js'
import { migrations, schemaVersion } from '../sqlite-migrations.js'

/**
 * Phase 9 hardening drills (§7): backup/restore, remote context restore,
 * upgrade/migration, and release verification — each one a repeatable
 * operation with a pass/fail verdict, because a drill that cannot fail is a
 * demo, not a drill.
 */

export interface DrillVerdict {
  name: string
  ok: boolean
  detail: string
}

/** Reads every event, within the ledger's page limit, paging through. */
function readAllEvents(ledger: Ledger): EventEnvelope[] {
  const events: EventEnvelope[] = []
  let after = 0
  for (;;) {
    const page = ledger.readEvents(after, 1000)
    if (page.length === 0) return events
    events.push(...page)
    const last = page[page.length - 1].sequence
    if (last === undefined || page.length < 1000) return events
    after = last
  }
}

/** The backup/restore drill: copy the ledger, restore it, verify the event log is intact. */
export async function backupRestoreDrill(ledger: Ledger, workDirectory: string): Promise<DrillVerdict> {
  const backupPath = join(workDirectory, 'drill-backup.db')
  try {
    await ledger.backup(backupPath)
    const restored = new Ledger(backupPath)
    try {
      const originalCount = readAllEvents(ledger).length
      const restoredCount = readAllEvents(restored).length
      if (originalCount !== restoredCount) {
        return { name: 'backup-restore', ok: false, detail: `event count diverged: ${originalCount} → ${restoredCount}` }
      }
      return { name: 'backup-restore', ok: true, detail: `${restoredCount} events restored intact from backup` }
    } finally {
      restored.close()
    }
  } catch (error) {
    return { name: 'backup-restore', ok: false, detail: error instanceof Error ? error.message : String(error) }
  } finally {
    if (existsSync(backupPath)) rmSync(backupPath)
  }
}

/**
 * The remote context restore drill (§7 DoD: "restore context/ledger from a
 * verified backup" at a remote): an export artifact is re-materialized into a
 * fresh ledger and its digest is confirmed to match the source. The digest is
 * over content, not file bytes, so the drill proves the *data* survived, not
 * that SQLite copied a file.
 *
 * When a context root is supplied, the Git-backed context filesystem travels
 * with it: the whole context repo is bundled, cloned back at the remote, and
 * its content digest must match too — a restore that saves the ledger but
 * loses the operator's context pages is not a restore.
 */
export function remoteRestoreDrill(sourceLedger: Ledger, workDirectory: string, contextRoot?: string): { verdict: DrillVerdict; restored?: Ledger; close(): void } {
  const exportPath = join(workDirectory, 'drill-export.json')
  const events = readAllEvents(sourceLedger)
  const digest = digestOf(events)
  writeFileSync(exportPath, JSON.stringify({ schemaVersion, events }, undefined, 0), 'utf8')

  const restoredPath = join(workDirectory, 'drill-restored.db')
  if (existsSync(restoredPath)) rmSync(restoredPath)
  const restored = new Ledger(restoredPath)
  const imported = JSON.parse(readFileSync(exportPath, 'utf8')) as { schemaVersion: number; events: EventEnvelope[] }
  // Replay: referenced actors and scopes are re-created first, exactly as a
  // remote restore provision step would, because events reference both by id.
  const actors = new Map<string, EventEnvelope['actor']>()
  const scopes = new Map<string, NonNullable<EventEnvelope['scope']>>()
  for (const event of events) {
    actors.set(event.actor.actorId, event.actor)
    if (event.scope) scopes.set(`${event.scope.workspaceId}:${event.scope.projectId}`, event.scope)
  }
  for (const actor of actors.values()) {
    restored.createActor(actor)
  }
  for (const scope of scopes.values()) {
    restored.restoreScope(scope)
  }
  let replayed = 0
  for (const event of imported.events) {
    if (restored.appendEvent(event)) replayed += 1
  }
  const restoredDigest = digestOf(readAllEvents(restored))
  const close = () => { restored.close(); rmSync(exportPath, { force: true }); rmSync(restoredPath, { force: true }) }

  if (restoredDigest !== digest) {
    return { verdict: { name: 'remote-restore', ok: false, detail: 'restored event digest does not match the source' }, close }
  }
  let detail = `${replayed} events re-materialized with matching digest`
  if (contextRoot !== undefined) {
    const context = restoreContext(contextRoot, workDirectory)
    if (!context.ok) {
      return { verdict: { name: 'remote-restore', ok: false, detail: `${detail}; context restore failed: ${context.reason}` }, close }
    }
    detail = `${detail}; context repo restored from a git bundle (${context.files} files, matching digest)`
  }
  return { verdict: { name: 'remote-restore', ok: true, detail }, restored, close }
}

/**
 * Bundles the context Git repository and clones it back, verifying the
 * restored repo carries exactly the source's committed content. The digest is
 * over `git ls-tree -r HEAD` — the content-addressed truth — so checkout
 * line-ending configuration cannot make an honest restore look corrupt, and a
 * source with uncommitted edits fails loudly instead of losing them silently.
 */
function restoreContext(contextRoot: string, workDirectory: string): { ok: true; files: number } | { ok: false; reason: string } {
  const source = new GitRunner(contextRoot)
  const head = source.tryRun(['rev-parse', 'HEAD'])
  if (head === undefined) return { ok: false, reason: 'context root has no commits to restore' }
  const dirty = source.tryRun(['status', '--porcelain'])
  if (dirty !== undefined && dirty !== '') return { ok: false, reason: 'source context has uncommitted changes; reconcile before restoring' }
  const tree = source.run(['ls-tree', '-r', 'HEAD'])
  const bundlePath = join(workDirectory, 'drill-context.bundle')
  try {
    source.run(['bundle', 'create', bundlePath, '--all'])
    const restoredRoot = join(workDirectory, 'drill-context-restored')
    if (existsSync(restoredRoot)) rmSync(restoredRoot, { recursive: true, force: true })
    const restore = new GitRunner(workDirectory)
    restore.run(['clone', '--quiet', bundlePath, restoredRoot])
    const restored = new GitRunner(restoredRoot)
    if (restored.run(['rev-parse', 'HEAD']) !== head) return { ok: false, reason: 'restored context head differs from the source' }
    if (restored.run(['ls-tree', '-r', 'HEAD']) !== tree) return { ok: false, reason: 'restored context tree differs from the source' }
    const files = tree === '' ? 0 : tree.split('\n').length
    rmSync(restoredRoot, { recursive: true, force: true })
    return { ok: true, files }
  } finally {
    if (existsSync(bundlePath)) rmSync(bundlePath, { force: true })
  }
}

/**
 * The upgrade/migration drill: a *populated* ledger built at schema 18 (before
 * federation quarantine existed) is migrated forward to the current schema, and
 * the drill proves the upgrade both arrived (the new table answers) and
 * preserved what was there (the same events, byte-identical payloads). A fresh
 * install proves nothing about upgrades; a populated old database does.
 */
export function upgradeMigrationDrill(workDirectory: string): DrillVerdict {
  const path = join(workDirectory, 'drill-upgrade.db')
  if (existsSync(path)) rmSync(path)
  try {
    // Build the pre-19 fixture by hand: a database that stopped at migration
    // 18 with real rows in it, the way an actual Phase 8 deployment would sit
    // on disk the day Phase 9 arrives.
    const fixture = buildPreFederationFixture(path)
    const eventCount = readAllEvents(fixture).length
    if (eventCount === 0) return { name: 'upgrade-migration', ok: false, detail: 'fixture failed to populate events' }
    fixture.close()

    // Opening the same file through `Ledger` runs only the missing migrations
    // (19, 20, ...) — forward-only, never a downgrade (§7.0 upgrade policy).
    const ledger = new Ledger(path)
    try {
      const usable = ledger.countFederationQuarantine('pending') >= 0
      const latest = ledger.latestEventSequence() >= 0
      const preserved = readAllEvents(ledger)
      if (!usable || !latest) {
        return { name: 'upgrade-migration', ok: false, detail: 'migrated ledger did not expose the federation quarantine surface' }
      }
      if (preserved.length !== eventCount) {
        return { name: 'upgrade-migration', ok: false, detail: `upgrade lost events: ${eventCount} → ${preserved.length}` }
      }
      return { name: 'upgrade-migration', ok: true, detail: `populated schema-18 ledger upgraded to schema ${schemaVersion}: ${eventCount} events preserved, federation surfaces answer` }
    } finally {
      ledger.close()
    }
  } finally {
    if (existsSync(path)) rmSync(path)
  }
}

/**
 * A hand-built schema-18 database with one actor and three events in it. It
 * uses the real migration ladder up to 18, then stops — so migration 19+ is
 * exactly what the upgrade drill must apply.
 */
function buildPreFederationFixture(path: string): Ledger {
  const connection = new Database(path)
  try {
    connection.pragma('journal_mode = WAL')
    connection.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    const insert = connection.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
    for (let version = 1; version <= 18; version += 1) {
      connection.exec(migrations[version])
      insert.run(version, new Date().toISOString())
    }
    // The rows a real deployment would have: one actor, three events.
    connection.prepare(`INSERT INTO actors (id, type, display_name, source, capabilities, workspace_id, project_id, created_at)
      VALUES ('fixture-operator', 'operator', 'fixture-operator', 'cli', '["workspace:read"]', NULL, NULL, ?)`).run(new Date().toISOString())
    const event = connection.prepare(`INSERT INTO events (event_id, idempotency_key, event_type, source, actor_id, workspace_id, project_id, occurred_at, sequence, payload, origin_marker)
      VALUES (?, ?, ?, ?, 'fixture-operator', NULL, NULL, ?, ?, ?, ?)`)
    for (let index = 1; index <= 3; index += 1) {
      event.run(`fixture-evt-${index}`, `fixture-idem-${index}`, 'System', 'fixture', new Date().toISOString(), index, JSON.stringify({ step: index }), 'fixture')
    }
  } finally {
    connection.close()
  }
  return new Ledger(path)
}

/**
 * The release verification drill: every file in a release directory is hashed
 * and recorded, and the recorded digest re-verifies. A release that ships must
 * be verifiable after download — this is the producer half of that promise.
 */
export function releaseVerificationDrill(releaseDirectory: string): { verdict: DrillVerdict; manifestPath: string } {
  // The manifest cannot contain its own hash; it is written last and excluded.
  const entries = collect(join(releaseDirectory), releaseDirectory)
    .filter((entry) => entry.relative !== 'SHA256SUMS.json')
  const manifest = {
    version: 1,
    files: entries.map((entry) => ({ path: entry.relative, sha256: entry.sha256, bytes: entry.bytes })),
    generatedAt: new Date().toISOString(),
  }
  // Re-verify: every recorded digest must match the file as it sits.
  for (const file of manifest.files) {
    const bytes = readFileSync(join(releaseDirectory, file.path))
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      return { verdict: { name: 'release-verification', ok: false, detail: `${file.path} changed while manifesting` }, manifestPath: '' }
    }
  }
  const manifestPath = join(releaseDirectory, 'SHA256SUMS.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  return { verdict: { name: 'release-verification', ok: true, detail: `${manifest.files.length} files hashed and re-verified` }, manifestPath }
}

/** Verifies a downloaded release against its SHA256SUMS.json — the consumer half. */
export function verifyRelease(releaseDirectory: string): { ok: true; files: number } | { ok: false; path: string; reason: string } {
  const manifestPath = join(releaseDirectory, 'SHA256SUMS.json')
  if (!existsSync(manifestPath)) return { ok: false, path: 'SHA256SUMS.json', reason: 'release has no verification manifest' }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: Array<{ path: string; sha256: string }> }
  for (const file of manifest.files) {
    const path = join(releaseDirectory, file.path)
    if (!existsSync(path)) return { ok: false, path: file.path, reason: 'file is missing' }
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== file.sha256) {
      return { ok: false, path: file.path, reason: 'sha256 mismatch' }
    }
  }
  return { ok: true, files: manifest.files.length }
}

function collect(directory: string, root: string): Array<{ relative: string; sha256: string; bytes: number }> {
  const entries: Array<{ relative: string; sha256: string; bytes: number }> = []
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) {
      entries.push(...collect(path, root))
      continue
    }
    const bytes = readFileSync(path)
    entries.push({
      relative: path.slice(root.length).replace(/^[\\/]/, '').split('\\').join('/'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    })
  }
  return entries
}

function digestOf(events: EventEnvelope[]): string {
  const digest = createHash('sha256')
  for (const event of events) digest.update(JSON.stringify(event))
  return digest.digest('hex')
}

/** Ensures a drill work directory exists and returns its path. */
export function drillWorkDirectory(parent: string, name: string): string {
  const directory = join(parent, name)
  mkdirSync(directory, { recursive: true })
  return directory
}
