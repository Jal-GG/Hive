import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Capability } from '../../src/contracts.js'
import { runSkillCli } from '../../src/interfaces/cli/skill-cli.js'
import { compareVersions, safeSkillPath, skillManifestFile, validateManifest } from '../../src/skills/registry.js'
import { skillHarness, tempDirectory, testActor } from '../fixtures.js'

/**
 * Phase 8, skills slice: discovery rejects what it cannot trust, installs are
 * versioned and confined to the registry root, and an installed skill reaches
 * the agent through the context packet.
 */
const capabilities: Capability[] = ['workspace:read', 'work:mutate', 'work:dispatch', 'context:read', 'context:write']
const operator = testActor('operator', capabilities)
/** Holds every capability a worker needs, but may not add skills to the registry. */
const reader = testActor('reader', ['workspace:read', 'work:mutate', 'work:dispatch', 'context:read'])

const manifest = (overrides: Record<string, unknown> = {}) => ({
  id: 'code-review',
  name: 'Code Review',
  version: '1.0.0',
  description: 'How this project reviews code.',
  tags: ['review'],
  body: 'Read the diff before the description.\n',
  ...overrides,
})

describe('skill registry — the Phase 8 skills slice', () => {
  it('installs a validated skill into the registry root and lists it', () => {
    const harness = skillHarness([operator])
    const installed = harness.skills.install(operator, manifest(), { source: 'test' })
    expect(installed).toMatchObject({ id: 'code-review', version: '1.0.0', state: 'installed', installedBy: operator.actorId })
    // The content is on disk, under the root, in the skill's own directory.
    expect(installed.path.startsWith(harness.skillsRoot)).toBe(true)
    expect(existsSync(join(installed.path, skillManifestFile))).toBe(true)
    expect(harness.skills.list(operator)).toHaveLength(1)
    expect(harness.skills.get(operator, 'code-review').body).toContain('Read the diff')
    harness.close()
  })

  it('refuses a manifest it cannot trust, and never writes one', () => {
    const harness = skillHarness([operator])
    // Every rejection is a manifest that would otherwise have become a directory.
    expect(() => harness.skills.install(operator, manifest({ id: '../escape' }))).toThrowError(/id must be lowercase/)
    expect(() => harness.skills.install(operator, manifest({ id: 'nested/skill' }))).toThrowError(/id must be lowercase/)
    expect(() => harness.skills.install(operator, manifest({ id: '..' }))).toThrowError(/id must be lowercase/)
    expect(() => harness.skills.install(operator, manifest({ version: 'latest' }))).toThrowError(/version must be major\.minor\.patch/)
    expect(() => harness.skills.install(operator, manifest({ body: '   ' }))).toThrowError(/body is required/)
    expect(() => harness.skills.install(operator, manifest({ tags: [1] }))).toThrowError(/tags must be an array of strings/)
    expect(() => harness.skills.install(operator, manifest({ name: '' }))).toThrowError(/name is required/)
    // Nothing was created by any of the refusals.
    expect(readdirSync(harness.skillsRoot)).toHaveLength(0)
    expect(harness.skills.list(operator)).toHaveLength(0)
    harness.close()
  })

  it('confines every install to the registry root, even for an id that slipped validation', () => {
    const root = tempDirectory('confine-root')
    // safeSkillPath is the second defense: it does not trust that the id was checked.
    for (const escape of ['../outside', '..', 'a/b', '/etc/passwd', 'C:\\Windows']) {
      expect(() => safeSkillPath(root, escape)).toThrowError(/inside the registry root/)
    }
    expect(safeSkillPath(root, 'fine').startsWith(root)).toBe(true)
  })

  it('upgrades to a newer version and refuses to silently downgrade', () => {
    const harness = skillHarness([operator])
    const first = harness.skills.install(operator, manifest())
    const upgraded = harness.skills.install(operator, manifest({ version: '1.2.0', body: 'Newer guidance.\n' }))
    expect(upgraded.version).toBe('1.2.0')
    // An upgrade keeps the original install date: the skill's history is one line.
    expect(upgraded.installedAt).toBe(first.installedAt)
    expect(harness.skills.list(operator)).toHaveLength(1)
    expect(harness.skills.get(operator, 'code-review').body).toContain('Newer guidance')

    // Same or older is refused, so a stale source cannot roll an agent back.
    expect(() => harness.skills.install(operator, manifest({ version: '1.2.0' }))).toThrowError(/is not newer/)
    expect(() => harness.skills.install(operator, manifest({ version: '1.1.9' }))).toThrowError(/is not newer/)
    // Unless the operator says so explicitly.
    expect(harness.skills.install(operator, manifest({ version: '1.1.9' }), { force: true }).version).toBe('1.1.9')
    harness.close()
  })

  it('orders versions numerically, not lexically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.2.3', '1.10.0')).toBe(-1)
  })

  it('discovers installable skills in a directory and reports what it rejected', () => {
    const harness = skillHarness([operator])
    const source = tempDirectory('skill-source')
    const write = (dir: string, header: unknown, body = 'Body.\n') => {
      mkdirSync(join(source, dir), { recursive: true })
      writeFileSync(join(source, dir, skillManifestFile), `---\n${JSON.stringify(header, null, 2)}\n---\n${body}`, 'utf8')
    }
    write('good-skill', { id: 'good-skill', name: 'Good', version: '2.0.0', description: 'ok', tags: ['x'] })
    // A manifest claiming an id other than its directory is trying to land elsewhere.
    write('liar', { id: 'somewhere-else', name: 'Liar', version: '1.0.0', description: 'no', tags: [] })
    write('broken', { id: 'broken', name: 'Broken', version: 'nope', description: 'no', tags: [] })
    mkdirSync(join(source, 'empty'), { recursive: true })

    const report = harness.skills.discover(operator, source)
    expect(report.found.map((entry) => entry.id)).toEqual(['good-skill'])
    expect(report.rejected).toHaveLength(3)
    expect(report.rejected.some((entry) => /does not match its directory/.test(entry.reason))).toBe(true)
    expect(report.rejected.some((entry) => /version must be/.test(entry.reason))).toBe(true)
    expect(report.rejected.some((entry) => /missing SKILL\.md/.test(entry.reason))).toBe(true)

    // Discovery does not install: finding is not trusting.
    expect(harness.skills.list(operator)).toHaveLength(0)
    harness.skills.install(operator, report.found[0], { source })
    expect(harness.skills.list(operator).map((skill) => skill.id)).toEqual(['good-skill'])
    harness.close()
  })

  it('carries installed skills into the packet by the tags the task asked for', () => {
    const harness = skillHarness([operator])
    harness.skills.install(operator, manifest({ id: 'code-review', tags: ['review'] }))
    harness.skills.install(operator, manifest({ id: 'deploy-runbook', name: 'Deploy Runbook', tags: ['deploy'] }))

    const task = harness.board.create(operator, harness.scope, {
      title: 'Review the merge queue',
      metadata: { requiredSkills: ['review'] },
    })
    const packet = harness.skillPackets.compile(operator, harness.scope, { taskId: task.id })
    // Only the skill the task asked for, and it renders into the prompt.
    expect(packet.skills.map((skill) => skill.id)).toEqual(['code-review'])
    expect(packet.skills[0].name).toBe('Code Review v1.0.0')
    expect(harness.skillPackets.render(packet)).toContain('## Skills')

    // A task that declares nothing gets nothing: a packet is what the work needs.
    const plain = harness.board.create(operator, harness.scope, { title: 'Unrelated' })
    expect(harness.skillPackets.compile(operator, harness.scope, { taskId: plain.id }).skills).toEqual([])

    // A disabled skill stays installed but leaves packets.
    harness.skills.setEnabled(operator, 'code-review', false)
    const afterDisable = harness.skillPackets.compile(operator, harness.scope, { taskId: task.id })
    expect(afterDisable.skills).toEqual([])
    expect(harness.skills.list(operator)).toHaveLength(2)
    harness.close()
  })

  it('uninstalls a skill and its directory, and separates reading from installing', () => {
    const harness = skillHarness([operator, reader])
    const installed = harness.skills.install(operator, manifest())
    // A reader can see the catalog but cannot change it.
    expect(harness.skills.list(reader)).toHaveLength(1)
    expect(() => harness.skills.install(reader, manifest({ id: 'sneaky' }))).toThrowError(/context:write/)
    expect(() => harness.skills.uninstall(reader, 'code-review')).toThrowError(/context:write/)

    expect(harness.skills.uninstall(operator, 'code-review')).toBe(true)
    expect(existsSync(installed.path)).toBe(false)
    expect(harness.skills.list(operator)).toHaveLength(0)
    // Uninstalling what is not there is a no-op, not an error.
    expect(harness.skills.uninstall(operator, 'code-review')).toBe(false)
    harness.close()
  })

  it('serves the registry through the CLI', async () => {
    const harness = skillHarness([operator])
    const cli = (argv: string[]) => runSkillCli({ skills: harness.skills }, operator, argv)
    const file = join(tempDirectory('manifest'), 'skill.json')
    writeFileSync(file, JSON.stringify(manifest()), 'utf8')

    const installed = JSON.parse(await cli(['install', '--manifest', file])) as { id: string; state: string }
    expect(installed).toMatchObject({ id: 'code-review', state: 'installed' })
    expect(JSON.parse(await cli(['list'])) as unknown[]).toHaveLength(1)
    expect(JSON.parse(await cli(['show', '--id', 'code-review'])).version).toBe('1.0.0')
    expect(JSON.parse(await cli(['disable', '--id', 'code-review'])).state).toBe('disabled')
    expect(JSON.parse(await cli(['enable', '--id', 'code-review'])).state).toBe('installed')
    expect(JSON.parse(await cli(['uninstall', '--id', 'code-review'])).removed).toBe(true)

    await expect(cli(['show'])).rejects.toThrowError(/--id is required/)
    await expect(cli(['explode'])).rejects.toThrowError(/Unknown skill operation/)
    expect(await cli(['--help'])).toContain('Usage: hive skill')
    harness.close()
  })

  it('validates a manifest the same way wherever it came from', () => {
    expect(validateManifest(manifest()).id).toBe('code-review')
    expect(() => validateManifest(null)).toThrowError(/manifest must be an object/)
    expect(() => validateManifest(manifest({ body: 'x'.repeat(70 * 1024) }))).toThrowError(/body exceeds/)
  })
})
