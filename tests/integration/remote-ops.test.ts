import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { backupRestoreDrill, drillWorkDirectory, remoteRestoreDrill, releaseVerificationDrill, upgradeMigrationDrill, verifyRelease } from '../../src/remote/drills.js'
import { HealthServer, companionProfile, composeProfile, dockerProfile, materializeProfile, reverseProxyProfile, systemdProfile } from '../../src/remote/deployment.js'
import { contextHarness, ledgerWithActors, testActor } from '../fixtures.js'
import { runRemoteCli } from '../../src/interfaces/cli/remote-cli.js'
import type { Capability } from '../../src/contracts.js'

const capabilities: Capability[] = ['workspace:read']

/** One ledger with events in it, the thing every restore drill restores. */
function populatedLedger(directory: string) {
  const ledger = ledgerWithActors(testActor('operator', capabilities))
  ledger.appendEvent({
    version: 1, eventId: 'evt-1', idempotencyKey: 'idem-1', eventType: 'Work', source: 'test',
    actor: testActor('operator', capabilities), occurredAt: new Date().toISOString(),
    payload: { title: 'drill event' }, originMarker: 'test',
  })
  void directory
  return ledger
}

describe('remote hardening drills', () => {
  it('backup and restore preserve the event log exactly', async () => {
    const work = drillWorkDirectory(tmpdir(), 'hive-drill-backup')
    const ledger = populatedLedger(work)
    try {
      const verdict = await backupRestoreDrill(ledger, work)
      expect(verdict.ok).toBe(true)
      expect(verdict.detail).toContain('1 events restored intact')
    } finally {
      ledger.close()
    }
  })

  it('remote restore re-materializes the event log with a matching digest', () => {
    const work = drillWorkDirectory(tmpdir(), 'hive-drill-remote')
    const ledger = populatedLedger(work)
    try {
      const drill = remoteRestoreDrill(ledger, work)
      try {
        expect(drill.verdict.ok).toBe(true)
        expect(drill.verdict.detail).toContain('matching digest')
        // The restored ledger answers queries: the re-materialized events are readable.
        expect(drill.restored?.readEvents(0, 100)).toHaveLength(1)
      } finally {
        drill.close()
      }
    } finally {
      ledger.close()
    }
  })

  it('remote restore carries the Git-backed context filesystem with the ledger', () => {
    const writer = testActor('writer', ['context:write', 'workspace:read'])
    const harness = contextHarness([writer])
    try {
      harness.fs.write(writer, harness.scope, { path: 'page/runbook.md', body: '# Runbook\nrestore me', tags: ['ops'] })
      harness.fs.write(writer, harness.scope, { path: 'memory/note.md', body: 'durable note' })
      const work = drillWorkDirectory(tmpdir(), 'hive-drill-remote-context')

      const drill = remoteRestoreDrill(harness.ledger, work, harness.fs.getRoot())
      try {
        expect(drill.verdict.ok, drill.verdict.detail).toBe(true)
        expect(drill.verdict.detail).toContain('context repo restored from a git bundle')
        expect(drill.verdict.detail).toMatch(/matching digest/)
      } finally {
        drill.close()
      }

      // A context root with no commits cannot pretend to restore: the drill
      // fails loudly rather than passing an events-only restore as complete.
      const empty = join(work, 'empty-context')
      mkdirSync(empty, { recursive: true })
      const failed = remoteRestoreDrill(harness.ledger, work, empty)
      try {
        expect(failed.verdict.ok).toBe(false)
        expect(failed.verdict.detail).toContain('context restore failed')
      } finally {
        failed.close()
      }
    } finally {
      harness.close()
    }
  })

  it('the CLI drill run records its verdicts in the audit log', { timeout: 30_000 }, async () => {
    const operator = testActor('operator', ['workspace:read', 'federation:review'])
    const ledger = ledgerWithActors(operator)
    const work = drillWorkDirectory(tmpdir(), 'hive-drill-cli')
    try {
      const output = JSON.parse(await runRemoteCli(
        { ledger, scope: { workspaceId: 'w', projectId: 'p', workspaceName: 'main', projectName: 'hive' }, stateRoot: work, packageRoot: work },
        operator,
        ['drills'],
      )) as { ok: boolean; verdicts: Array<{ name: string; ok: boolean }> }
      expect(output.ok).toBe(true)
      expect(output.verdicts.map((verdict) => verdict.name)).toContain('remote-restore')
      // The recovery decision is auditable, not just printed.
      expect(ledger.auditCount('remote.drills')).toBe(1)
    } finally {
      ledger.close()
    }
  })

  it('a populated pre-federation ledger upgrades to the current schema with its events preserved', () => {
    const work = drillWorkDirectory(tmpdir(), 'hive-drill-upgrade')
    const verdict = upgradeMigrationDrill(work)
    expect(verdict.ok).toBe(true)
    expect(verdict.detail).toContain('schema 20')
    expect(verdict.detail).toContain('3 events preserved')
  })

  it('release verification produces and re-verifies a SHA256SUMS manifest', () => {
    const work = drillWorkDirectory(tmpdir(), `hive-drill-release-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    writeFileSync(join(work, 'cli.cjs'), '#!/usr/bin/env node\n', 'utf8')
    writeFileSync(join(work, 'package.json'), JSON.stringify({ version: '0.1.0' }), 'utf8')

    const drill = releaseVerificationDrill(work)
    expect(drill.verdict.ok).toBe(true)
    expect(existsSync(drill.manifestPath)).toBe(true)
    expect(verifyRelease(work)).toMatchObject({ ok: true, files: 2 })

    // Tampering with a file after manifesting is caught on verification.
    writeFileSync(join(work, 'cli.cjs'), '#!/usr/bin/env node\n// tampered\n', 'utf8')
    const caught = verifyRelease(work)
    expect(caught.ok).toBe(false)
    if (!caught.ok) {
      expect(caught.path).toBe('cli.cjs')
      expect(caught.reason).toContain('mismatch')
    }
  })
})

describe('deployment profiles and health endpoints', () => {
  it('materializes every profile kind with its unit file and health paths, referencing a release that exists', () => {
    const work = drillWorkDirectory(tmpdir(), 'hive-deploy-profiles')
    // A stand-in assembled release: the profiles point at these artifacts, so
    // the assertion is that every referenced path resolves, not just that the
    // text was written.
    const releaseDirectory = join(work, 'release')
    mkdirSync(releaseDirectory, { recursive: true })
    writeFileSync(join(releaseDirectory, 'cli.cjs'), '#!/usr/bin/env node\n', 'utf8')
    writeFileSync(join(releaseDirectory, 'package.json'), JSON.stringify({ version: '0.1.0' }), 'utf8')
    const options = { releaseDirectory, version: '0.1.0' }
    for (const [kind, profile] of [
      ['docker', dockerProfile(options)],
      ['compose', composeProfile(options)],
      ['systemd', systemdProfile(options)],
      ['companion', companionProfile(options)],
      ['reverse-proxy', reverseProxyProfile(options)],
    ] as const) {
      const out = join(work, kind)
      const files = materializeProfile(profile, out)
      expect(files.length).toBeGreaterThan(0)
      expect(existsSync(files[0])).toBe(true)
      expect(profile.healthPaths).toEqual({ liveness: '/healthz', readiness: '/readyz' })
      // The unit's entrypoint must name a file the release actually ships.
      if (kind === 'systemd' || kind === 'companion') {
        const execLine = profile.files[0].content.split('\n').find((line) => line.startsWith('ExecStart='))
        expect(execLine).toBeDefined()
        const entrypoint = execLine!.replace('ExecStart=node ', '').split(' ')[0]
        expect(existsSync(entrypoint)).toBe(true)
      }
    }
    // The docker profile copies the release — a directory that exists — never node_modules.
    const dockerfile = readFileSync(join(work, 'docker', 'Dockerfile'), 'utf8')
    expect(dockerfile).toContain('node:22-slim')
    expect(dockerfile).not.toContain('node_modules')
    expect(dockerfile).toContain(`COPY ${releaseDirectory} /opt/hive`)
    expect(existsSync(releaseDirectory)).toBe(true)
  })

  it('health server answers liveness and readiness separately, fail-closed', async () => {
    let state = { alive: true, ready: false, version: '0.1.0', detail: 'ledger opening' }
    const server = new HealthServer(() => state)
    const port = await server.listen(0)

    const starting = await fetch(`http://127.0.0.1:${port}/readyz`)
    expect(starting.status).toBe(503)
    const aliveWhileStarting = await fetch(`http://127.0.0.1:${port}/healthz`)
    expect(aliveWhileStarting.status).toBe(200)

    state = { alive: true, ready: true, version: '0.1.0', detail: 'ledger open, migrations current' }
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`)
    expect(ready.status).toBe(200)

    const unknown = await fetch(`http://127.0.0.1:${port}/nope`)
    expect(unknown.status).toBe(404)
    await server.close()
  })
})
