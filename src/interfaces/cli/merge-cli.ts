import { ActorContext } from '../../contracts.js'
import { HiveError } from '../../errors.js'
import { Ledger } from '../../ledger.js'
import { MergeCoordinator } from '../../merge/coordinator.js'
import { ConvoyService } from '../../merge/convoy.js'

export interface MergeCliSurfaces {
  ledger: Ledger
  queue: MergeCoordinator
  convoys: ConvoyService
}

const operations = ['enqueue', 'requests', 'process', 'prepare', 'land', 'convoy', 'convoy-scan', 'convoy-close'] as const
type MergeOperation = (typeof operations)[number]

/**
 * `hive merge <operation> [id] [--flag value]` — the verified merge queue and
 * its convoys. JSON out like every other surface.
 */
export async function runMergeCli(surfaces: MergeCliSurfaces, actor: ActorContext, argv: readonly string[]): Promise<string> {
  const [operation, ...rest] = argv
  if (operation === undefined || operation === '--help' || operation === 'help') return usage()
  if (!operations.includes(operation as MergeOperation)) {
    throw new HiveError('UNKNOWN_OPERATION', `Unknown merge operation: ${operation}\n\n${usage()}`)
  }
  const scope = surfaces.ledger.resolveScope(flagValue(rest, '--workspace') ?? 'main', flagValue(rest, '--project') ?? 'hive')

  switch (operation as MergeOperation) {
    case 'enqueue': {
      const request = surfaces.queue.enqueue(actor, {
        sourceBranch: requireValue('--source', flagValue(rest, '--source')),
        targetBranch: requireValue('--target', flagValue(rest, '--target')),
        workItemId: flagValue(rest, '--task'),
        runId: flagValue(rest, '--run'),
      })
      void scope
      return render(request)
    }
    case 'requests': {
      const states = rest.filter((_, index) => rest[index - 1] === '--state')
      return render(surfaces.queue.requests(actor, scope, states as never))
    }
    case 'process': {
      const report = await surfaces.queue.process(actor)
      return render(report)
    }
    case 'prepare': {
      return render(await surfaces.queue.prepare(actor))
    }
    case 'land': {
      return render(await surfaces.queue.land(actor))
    }
    case 'convoy': {
      const convoyId = requireValue('--convoy', flagValue(rest, '--convoy'))
      return render(surfaces.convoys.ensure(actor, convoyId))
    }
    case 'convoy-scan': {
      return render(await surfaces.convoys.scan(actor))
    }
    case 'convoy-close': {
      const convoyId = requireValue('--convoy', flagValue(rest, '--convoy'))
      return render(surfaces.convoys.forceClose(actor, convoyId))
    }
  }
}

export function usage(): string {
  return [
    'Usage: hive merge <operation> [options]',
    '',
    'Queue (merge:execute):',
    '  enqueue               Queue a branch for verified merge (--source, --target, --task, --run)',
    '  requests              Merge requests with state (--state, repeatable)',
    '  process               One full pass: prepare (integrate + gates) then land',
    '  prepare               Integrate and gate only — nothing is pushed',
    '  land                  Push what passed gates, after re-verifying the target',
    '',
    'Convoys (merge:execute):',
    '  convoy                Bring a convoy into being (--convoy)',
    '  convoy-scan           One convergence pass: close, dispatch, count stranded',
    '  convoy-close          Force-close a convoy that will not converge (--convoy)',
    '',
    'Options:',
    '  --workspace <name>    Workspace name (default main)',
    '  --project <name>      Project name (default hive)',
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
