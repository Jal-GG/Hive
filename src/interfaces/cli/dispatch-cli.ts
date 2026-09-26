import { ActorContext, ResultEnvelope } from '../../contracts.js'
import { HiveError } from '../../errors.js'
import { Ledger } from '../../ledger.js'
import { weeklyDigest } from '../../dispatch/digest.js'
import { Dispatcher } from '../../dispatch/dispatcher.js'
import { Supervisor } from '../../dispatch/supervisor.js'
import { MailService } from '../../work/mail.js'

export interface DispatchCliSurfaces {
  ledger: Ledger
  dispatcher: Dispatcher
  supervisor: Supervisor
  mail: MailService
}

const operations = ['agents', 'register', 'route', 'dispatch', 'intake', 'rest', 'supervise', 'recover', 'digest'] as const
type DispatchOperation = (typeof operations)[number]

/**
 * `hive dispatch <operation> [id] [--flag value]` — the fleet surface: agent
 * registration, routing, dispatch, supervision passes, and the digest. JSON out
 * like every other CLI surface, so it composes the same way.
 */
export async function runDispatchCli(surfaces: DispatchCliSurfaces, actor: ActorContext, argv: readonly string[]): Promise<string> {
  const [operation, ...rest] = argv
  if (operation === undefined || operation === '--help' || operation === 'help') return usage()
  if (!operations.includes(operation as DispatchOperation)) {
    throw new HiveError('UNKNOWN_OPERATION', `Unknown dispatch operation: ${operation}\n\n${usage()}`)
  }
  const scope = surfaces.ledger.resolveScope(flagValue(rest, '--workspace') ?? 'main', flagValue(rest, '--project') ?? 'hive')
  const envelope = <T>(result: T | Promise<T>): Promise<ResultEnvelope<T>> =>
    Promise.resolve(result).then(
      (data) => ({ version: 1, requestId: `dispatch:${operation}`, ok: true as const, data }),
      (error) => failure(`dispatch:${operation}`, error),
    )

  switch (operation as DispatchOperation) {
    case 'agents':
      return render(await envelope(surfaces.dispatcher.agents(actor)))
    case 'register': {
      const agent = surfaces.dispatcher.registerAgent(actor, {
        agentId: requireValue('--agent', flagValue(rest, '--agent')),
        name: flagValue(rest, '--name'),
        profileId: requireValue('--profile', flagValue(rest, '--profile')),
        cwd: flagValue(rest, '--cwd'),
        skills: rest.filter((_, index) => rest[index - 1] === '--skill'),
        energy: optionalNumber(rest, '--energy'),
        maxEnergy: optionalNumber(rest, '--max-energy'),
      })
      return render({ version: 1, requestId: `dispatch:${operation}`, ok: true, data: agent })
    }
    case 'route': {
      const workItemId = positional(rest)
      const decision = surfaces.dispatcher.routeOf(actor, workItemId)
      return render({ version: 1, requestId: `dispatch:${operation}`, ok: true, data: decision ?? null })
    }
    case 'dispatch': {
      const workItemId = positional(rest)
      return render(await envelope(surfaces.dispatcher.dispatch(actor, scope, workItemId)))
    }
    case 'intake': {
      const input = {
        title: requireValue('--title', flagValue(rest, '--title')),
        description: flagValue(rest, '--description'),
        priority: optionalNumber(rest, '--priority'),
        requiredSkills: rest.filter((_, index) => rest[index - 1] === '--skill'),
        sourceTriggerId: flagValue(rest, '--trigger'),
      }
      return render(await envelope(surfaces.dispatcher.intake(actor, scope, input)))
    }
    case 'rest':
      return render({ version: 1, requestId: `dispatch:${operation}`, ok: true, data: { restored: surfaces.dispatcher.rest(actor) } })
    case 'supervise':
      return render({ version: 1, requestId: `dispatch:${operation}`, ok: true, data: surfaces.supervisor.supervise(actor) })
    case 'recover':
      return render(await envelope(surfaces.supervisor.recover(actor)))
    case 'digest': {
      // The scheduler mails this weekly; by hand it is the same computation,
      // run now, so an operator can see the fleet at any moment.
      const digest = weeklyDigest({ ledger: surfaces.ledger, mail: surfaces.mail })(actor, scope)
      return render({ version: 1, requestId: `dispatch:${operation}`, ok: true, data: digest })
    }
  }
}

export function usage(): string {
  return [
    'Usage: hive dispatch <operation> [id] [options]',
    '',
    'Fleet (work:dispatch):',
    '  agents             List the registered fleet with energy levels',
    '  register           Register an agent (--agent, --profile, --name, --cwd, --skill repeatable, --energy, --max-energy)',
    '  route <id>         The routing decision for a work item, without dispatching',
    '  dispatch <id>      Claim, compile, and launch one work item on its routed agent',
    '  intake             A trigger\'s entry point: create and dispatch (--title, --description, --priority, --skill, --trigger)',
    '  rest               The rest tick: every tired agent gains back one unit of energy',
    '',
    'Supervision (work:dispatch):',
    '  supervise          One supervision pass: heartbeats, escalation, POLECAT_DONE, exits',
    '  recover            Restart recovery: reconcile, requeue abandoned mail, one pass',
    '',
    'Options:',
    '  --workspace <name> Workspace name (default main)',
    '  --project <name>   Project name (default hive)',
  ].join('\n')
}

function positional(argv: readonly string[]): string {
  const first = argv.find((argument) => !argument.startsWith('--'))
  if (!first) throw new HiveError('MISSING_ARGUMENT', 'A work item id is required')
  return first
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

function optionalNumber(argv: readonly string[], flag: string): number | undefined {
  const value = flagValue(argv, flag)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new HiveError('INVALID_ARGUMENT', `${flag} must be a non-negative integer`)
  return parsed
}

function failure(requestId: string, error: unknown): ResultEnvelope<never> {
  const hiveError = error instanceof HiveError ? error : new HiveError('INTERNAL_ERROR', String(error))
  return { version: 1, requestId, ok: false, error: { code: hiveError.code, message: hiveError.message } }
}

function render(result: ResultEnvelope<unknown>): string {
  if (!result.ok) throw new HiveError(result.error.code, result.error.message)
  return JSON.stringify(result.data, null, 2)
}
