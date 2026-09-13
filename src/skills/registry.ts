import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  ActorContext,
  ScopeRef,
  SkillDiscoveryReport,
  SkillManifest,
  SkillRecord,
  SkillReference,
} from '../contracts.js'
import { assertCapability } from '../capabilities.js'
import { HiveError } from '../errors.js'
import { Ledger } from '../ledger.js'
import { Clock, ClockOptions, resolveClock } from '../shared.js'
import { workEvent } from '../work/events.js'

/** The file a skill directory must contain to be a skill at all. */
export const skillManifestFile = 'SKILL.md'

/**
 * A skill id is also a directory name, so the charset is strict: lowercase
 * alphanumerics with separators, never a dot segment, never a separator. This
 * is the first of two defenses — `safeSkillPath` is the second.
 */
const idPattern = /^[a-z0-9](?:[a-z0-9]|[._-](?![._-]))*[a-z0-9]$/
const versionPattern = /^\d+\.\d+\.\d+$/
const maxBodyBytes = 64 * 1024
const frontMatter = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/

/**
 * Resolves a skill directory inside the registry root and proves it stayed
 * there. Validating the id is not enough on its own: this is the check that
 * holds even if a future caller supplies an id from somewhere less careful.
 */
export function safeSkillPath(root: string, id: string): string {
  const rootPath = resolve(root)
  const target = resolve(rootPath, id)
  const rel = relative(rootPath, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep)) {
    throw new HiveError('SKILL_UNSAFE_PATH', `Skill id ${id} does not resolve to a directory inside the registry root`)
  }
  return target
}

/** Validates an untrusted manifest before any of it is written or believed. */
export function validateManifest(candidate: unknown): SkillManifest {
  if (typeof candidate !== 'object' || candidate === null) throw invalid('manifest must be an object')
  const value = candidate as Record<string, unknown>
  if (typeof value.id !== 'string' || !idPattern.test(value.id)) {
    throw invalid(`id must be lowercase alphanumeric with single . _ - separators, got ${JSON.stringify(value.id)}`)
  }
  if (typeof value.version !== 'string' || !versionPattern.test(value.version)) {
    throw invalid(`version must be major.minor.patch, got ${JSON.stringify(value.version)}`)
  }
  if (typeof value.name !== 'string' || value.name.trim().length === 0) throw invalid('name is required')
  if (typeof value.description !== 'string') throw invalid('description must be a string')
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === 'string')) {
    throw invalid('tags must be an array of strings')
  }
  if (typeof value.body !== 'string' || value.body.trim().length === 0) throw invalid('body is required')
  if (Buffer.byteLength(value.body, 'utf8') > maxBodyBytes) throw invalid(`body exceeds ${maxBodyBytes} bytes`)
  return {
    id: value.id,
    name: value.name,
    version: value.version,
    description: value.description,
    tags: [...(value.tags as string[])],
    body: value.body,
  }
}

/** Orders two `major.minor.patch` strings numerically, so 0.10.0 outranks 0.9.9. */
export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return 0
}

export interface SkillRegistryOptions extends ClockOptions {
  ledger: Ledger
  scope: ScopeRef
  /** Every installed skill lives under this directory, and nothing escapes it. */
  root: string
}

export interface InstallOptions {
  source?: string
  /** Allows replacing an installed skill with the same or an older version. */
  force?: boolean
}

/**
 * Phase 8's skill registry: discovery from a directory, validation of untrusted
 * manifests, versioned install/uninstall into a bounded root, and the reference
 * list a context packet carries. Installing is a context write; reading is a
 * context read — a worker can be given skills without being able to add them.
 */
export class SkillRegistry {
  private readonly ledger: Ledger
  private readonly scope: ScopeRef
  private readonly root: string
  private readonly now: Clock

  constructor(options: SkillRegistryOptions) {
    this.ledger = options.ledger
    this.scope = options.scope
    this.root = resolve(options.root)
    this.now = resolveClock(options)
    mkdirSync(this.root, { recursive: true })
  }

  /**
   * Scans a directory of candidate skills. A malformed skill is reported with
   * its reason rather than throwing, so one bad manifest cannot hide the rest.
   */
  discover(actor: ActorContext, directory: string): SkillDiscoveryReport {
    assertCapability(actor.capabilities, 'context:read')
    const report: SkillDiscoveryReport = { found: [], rejected: [] }
    if (!existsSync(directory)) return report
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifestPath = join(directory, entry.name, skillManifestFile)
      if (!existsSync(manifestPath)) {
        report.rejected.push({ path: join(directory, entry.name), reason: `missing ${skillManifestFile}` })
        continue
      }
      try {
        const manifest = this.decode(readFileSync(manifestPath, 'utf8'))
        // The directory name is part of the skill's identity: a manifest that
        // claims a different id is trying to be installed somewhere else.
        if (manifest.id !== entry.name) {
          throw invalid(`id ${manifest.id} does not match its directory ${entry.name}`)
        }
        report.found.push(manifest)
      } catch (error) {
        report.rejected.push({ path: manifestPath, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    report.found.sort((a, b) => (a.id < b.id ? -1 : 1))
    return report
  }

  /**
   * Installs or upgrades a skill. A newer version replaces an older one; the
   * same or an older version is refused unless forced, so an install can never
   * silently downgrade what an agent is running on.
   */
  install(actor: ActorContext, candidate: unknown, options: InstallOptions = {}): SkillRecord {
    assertCapability(actor.capabilities, 'context:write')
    const manifest = validateManifest(candidate)
    const existing = this.ledger.skill(this.scope, manifest.id)
    if (existing && !options.force && compareVersions(manifest.version, existing.version) <= 0) {
      throw new HiveError(
        'SKILL_NOT_NEWER',
        `Skill ${manifest.id} ${existing.version} is already installed; ${manifest.version} is not newer`,
      )
    }
    const path = safeSkillPath(this.root, manifest.id)
    const occurredAt = this.now().toISOString()
    const encoded = this.encode(manifest)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, skillManifestFile), encoded, 'utf8')
    const record: SkillRecord = {
      ...manifest,
      scope: this.scope,
      state: 'installed',
      path,
      sha256: createHash('sha256').update(encoded, 'utf8').digest('hex'),
      source: options.source ?? 'operator',
      installedBy: actor.actorId,
      installedAt: existing?.installedAt ?? occurredAt,
      updatedAt: occurredAt,
    }
    this.ledger.upsertSkill(record)
    this.record(actor, existing ? 'skill-upgraded' : 'skill-installed', `skill:${manifest.id}:${manifest.version}`, occurredAt, {
      id: manifest.id, version: manifest.version, from: existing?.version, source: record.source,
    })
    return record
  }

  /** Removes a skill and its directory; the directory is only ever the one inside the root. */
  uninstall(actor: ActorContext, id: string): boolean {
    assertCapability(actor.capabilities, 'context:write')
    const existing = this.ledger.skill(this.scope, id)
    if (!existing) return false
    rmSync(safeSkillPath(this.root, id), { recursive: true, force: true })
    this.ledger.deleteSkill(this.scope, id)
    const occurredAt = this.now().toISOString()
    this.record(actor, 'skill-uninstalled', `skill-uninstalled:${id}:${existing.version}`, occurredAt, {
      id, version: existing.version,
    })
    return true
  }

  /** Disabling keeps the skill installed but out of packets — reversible, unlike uninstalling. */
  setEnabled(actor: ActorContext, id: string, enabled: boolean): SkillRecord {
    assertCapability(actor.capabilities, 'context:write')
    const occurredAt = this.now().toISOString()
    const updated = this.ledger.setSkillState(this.scope, id, enabled ? 'installed' : 'disabled', occurredAt)
    if (!updated) throw new HiveError('SKILL_NOT_FOUND', `Skill ${id} is not installed`)
    this.record(actor, enabled ? 'skill-enabled' : 'skill-disabled', `skill-state:${id}:${occurredAt}`, occurredAt, {
      id, state: updated.state,
    })
    return updated
  }

  list(actor: ActorContext, states?: readonly SkillRecord['state'][]): SkillRecord[] {
    assertCapability(actor.capabilities, 'context:read')
    return this.ledger.listSkills(this.scope, states)
  }

  get(actor: ActorContext, id: string): SkillRecord {
    assertCapability(actor.capabilities, 'context:read')
    const skill = this.ledger.skill(this.scope, id)
    if (!skill) throw new HiveError('SKILL_NOT_FOUND', `Skill ${id} is not installed`)
    return skill
  }

  /**
   * The packet's skill section: installed skills whose tags the task asked for,
   * deterministically ordered. No tags means no skills — a packet carries what
   * the work needs, not the whole catalog.
   */
  forTags(actor: ActorContext, tags: readonly string[], limit = 8): SkillReference[] {
    assertCapability(actor.capabilities, 'context:read')
    if (tags.length === 0) return []
    const wanted = new Set(tags)
    return this.ledger
      .listSkills(this.scope, ['installed'])
      .filter((skill) => skill.tags.some((tag) => wanted.has(tag)))
      .slice(0, limit)
      .map((skill) => ({ id: skill.id, name: `${skill.name} v${skill.version}` }))
  }

  /** `---\n{json}\n---\nbody`, the same shape the context store uses, so skills read like every other page. */
  private encode(manifest: SkillManifest): string {
    const header = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      tags: manifest.tags,
    }
    return `---\n${JSON.stringify(header, null, 2)}\n---\n${manifest.body}`
  }

  private decode(text: string): SkillManifest {
    const match = frontMatter.exec(text)
    if (!match) throw invalid(`${skillManifestFile} must contain frontmatter`)
    let parsed: unknown
    try {
      parsed = JSON.parse(match[1])
    } catch {
      throw invalid(`${skillManifestFile} frontmatter must be valid JSON`)
    }
    return validateManifest({ ...(parsed as Record<string, unknown>), body: match[2] })
  }

  private record(actor: ActorContext, action: string, key: string, occurredAt: string, payload: Record<string, unknown>): void {
    this.ledger.appendEvent(workEvent(actor, this.scope, 'Context', action, key, occurredAt, payload))
  }
}

function invalid(reason: string): HiveError {
  return new HiveError('SKILL_INVALID', `Skill manifest is invalid: ${reason}`)
}
