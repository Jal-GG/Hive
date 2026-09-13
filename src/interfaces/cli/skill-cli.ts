import { readFileSync } from 'node:fs'
import { ActorContext } from '../../contracts.js'
import { HiveError } from '../../errors.js'
import { SkillRegistry } from '../../skills/registry.js'

export interface SkillCliSurfaces {
  skills: SkillRegistry
}

const operations = ['list', 'show', 'discover', 'install', 'uninstall', 'enable', 'disable'] as const
type SkillOperation = (typeof operations)[number]

/**
 * `hive skill <operation> [--flag value]` — the Phase 8 skill registry. JSON out
 * like every other surface.
 */
export async function runSkillCli(surfaces: SkillCliSurfaces, actor: ActorContext, argv: readonly string[]): Promise<string> {
  const [operation, ...rest] = argv
  if (operation === undefined || operation === '--help' || operation === 'help') return usage()
  if (!operations.includes(operation as SkillOperation)) {
    throw new HiveError('UNKNOWN_OPERATION', `Unknown skill operation: ${operation}\n\n${usage()}`)
  }

  switch (operation as SkillOperation) {
    case 'list': {
      const states = rest.filter((_, index) => rest[index - 1] === '--state')
      return render(surfaces.skills.list(actor, states.length > 0 ? (states as never) : undefined))
    }
    case 'show': {
      return render(surfaces.skills.get(actor, requireValue('--id', flagValue(rest, '--id'))))
    }
    case 'discover': {
      return render(surfaces.skills.discover(actor, requireValue('--from', flagValue(rest, '--from'))))
    }
    case 'install': {
      // A manifest file is the install unit: the CLI never invents one.
      const file = requireValue('--manifest', flagValue(rest, '--manifest'))
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      return render(surfaces.skills.install(actor, parsed, { source: file, force: rest.includes('--force') }))
    }
    case 'uninstall': {
      const id = requireValue('--id', flagValue(rest, '--id'))
      return render({ id, removed: surfaces.skills.uninstall(actor, id) })
    }
    case 'enable': {
      return render(surfaces.skills.setEnabled(actor, requireValue('--id', flagValue(rest, '--id')), true))
    }
    case 'disable': {
      return render(surfaces.skills.setEnabled(actor, requireValue('--id', flagValue(rest, '--id')), false))
    }
  }
}

export function usage(): string {
  return [
    'Usage: hive skill <operation> [options]',
    '',
    'Read (context:read):',
    '  list                  Installed skills (--state, repeatable)',
    '  show                  One skill in full (--id)',
    '  discover              Scan a directory for installable skills (--from)',
    '',
    'Write (context:write):',
    '  install               Install or upgrade from a JSON manifest (--manifest, --force)',
    '  uninstall             Remove a skill and its directory (--id)',
    '  enable                Return a disabled skill to packets (--id)',
    '  disable               Keep a skill installed but out of packets (--id)',
  ].join('\n')
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new HiveError('MISSING_ARGUMENT', `${flag} needs a value`)
  return value
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value === '') throw new HiveError('MISSING_ARGUMENT', `${flag} is required`)
  return value
}

function render(data: unknown): string {
  return JSON.stringify(data, null, 2)
}
