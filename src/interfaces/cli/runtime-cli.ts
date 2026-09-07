import { ActorContext, ResultEnvelope, RunState } from '../../contracts.js'
import { HiveError } from '../../errors.js'
import {
  RuntimeBrowseOperation,
  RuntimeBrowseRequest,
  RuntimeBrowser,
  runtimeBrowseHelp,
  runtimeBrowseOperations,
} from '../../runtime/runtime-browser.js'
import {
  RuntimeControlOperation,
  RuntimeControlRequest,
  RuntimeController,
  runtimeControlHelp,
  runtimeControlOperations,
} from '../../runtime/runtime-controller.js'

const browseSet = new Set<string>(runtimeBrowseOperations)
const controlSet = new Set<string>(runtimeControlOperations)
const runStates: readonly RunState[] = ['spawning', 'running', 'idle', 'completing', 'done', 'stalled', 'zombie', 'escalated', 'cancelled']

export interface RuntimeCliSurfaces {
  browser: RuntimeBrowser
  /** Omitted for a read-only CLI, which then reports control operations as unavailable rather than unknown. */
  controller?: RuntimeController
}

/**
 * `hive runtime <operation> [runId] [--flag value]`.
 *
 * The dispatcher is a pure function of its argv and returns a string, so the whole
 * surface is testable without a process, a terminal, or a signal. Read and write
 * operations share one command word but are routed to the two separate services,
 * which is what keeps `hive runtime runs` from needing `runtime:control`.
 */
export async function runRuntimeCli(surfaces: RuntimeCliSurfaces, actor: ActorContext, argv: readonly string[]): Promise<string> {
  const [operation, ...rest] = argv
  if (operation === undefined || operation === '--help' || operation === 'help') return usage()
  if (browseSet.has(operation)) {
    return render(surfaces.browser.browse(actor, parseBrowse(operation as RuntimeBrowseOperation, rest)))
  }
  if (controlSet.has(operation)) {
    if (!surfaces.controller) throw new HiveError('OPERATION_UNAVAILABLE', `${operation} needs a runtime controller, which this surface does not expose`)
    return render(await surfaces.controller.control(actor, parseControl(operation as RuntimeControlOperation, rest)))
  }
  throw new HiveError('UNKNOWN_OPERATION', `Unknown runtime operation: ${operation}\n\n${usage()}`)
}

export function usage(): string {
  const reads = runtimeBrowseOperations.map((operation) => `  ${operation.padEnd(11)}${runtimeBrowseHelp[operation]}`)
  const writes = runtimeControlOperations.map((operation) => `  ${operation.padEnd(11)}${runtimeControlHelp[operation]}`)
  return [
    'Usage: hive runtime <operation> [runId] [options]',
    '',
    'Read operations (runtime:read):',
    ...reads,
    '',
    'Control operations (runtime:control):',
    ...writes,
    '',
    'Options:',
    '  --run <id>            Run id, when not given positionally',
    '  --profile <id>        Agent profile to launch',
    '  --workspace <name>    Workspace name',
    '  --project <name>      Project name',
    '  --work-item <id>      Work item the run belongs to',
    '  --agent <id>          Agent identity to inject',
    '  --prompt <text>       Context packet, delivered as the profile declares',
    '  --model <name>        Model override for profiles that take one',
    '  --base <branch>       Branch to base the run\'s worktree on',
    '  --data <text>         Input to send (write)',
    '  --cols <n> --rows <n> Terminal size',
    '  --signal <name>       Signal to stop with (default SIGTERM)',
    '  --grace <ms>          Time before a stubborn process tree is force-killed',
    '  --state <name>        Filter runs by state; repeatable',
    '  --after <n>           Event sequence cursor',
    '  --limit <n>           Maximum results',
    '  --cleanup             Remove the worktree after stopping, if the gates allow',
  ].join('\n')
}

function parseBrowse(operation: RuntimeBrowseOperation, argv: readonly string[]): RuntimeBrowseRequest {
  const request: RuntimeBrowseRequest = { version: 1, operation }
  for (const [flag, value] of parseFlags(argv, request)) {
    switch (flag) {
      case '--workspace': request.workspace = value; break
      case '--project': request.project = value; break
      case '--provider': request.provider = value; break
      case '--backend': request.backend = value; break
      case '--state': (request.states ??= []).push(runState(value)); break
      case '--after': request.afterSequence = wholeNumber(flag, value, 0); break
      case '--limit': request.limit = wholeNumber(flag, value); break
      default: throw new HiveError('UNKNOWN_FLAG', `Unknown option for ${operation}: ${flag}`)
    }
  }
  return request
}

function parseControl(operation: RuntimeControlOperation, argv: readonly string[]): RuntimeControlRequest {
  const request: RuntimeControlRequest = { version: 1, operation }
  for (const [flag, value] of parseFlags(argv, request)) {
    switch (flag) {
      case '--profile': request.profileId = value; break
      case '--workspace': request.workspace = value; break
      case '--project': request.project = value; break
      case '--work-item': request.workItemId = value; break
      case '--agent': request.agentId = value; break
      case '--prompt': request.prompt = value; break
      case '--model': request.model = value; break
      case '--base': request.baseBranch = value; break
      case '--data': request.data = value; break
      case '--cols': request.cols = wholeNumber(flag, value); break
      case '--rows': request.rows = wholeNumber(flag, value); break
      case '--signal': request.signal = value; break
      case '--grace': request.graceMs = wholeNumber(flag, value, 0); break
      case '--ready-timeout': request.readyTimeoutMs = wholeNumber(flag, value, 0); break
      case '--limit': request.limit = wholeNumber(flag, value); break
      default: throw new HiveError('UNKNOWN_FLAG', `Unknown option for ${operation}: ${flag}`)
    }
  }
  return request
}

/**
 * Splits argv into flag/value pairs, folding the two positional-ish forms into the
 * request as it goes: a bare token is the run id, and `--cleanup` is a bare switch.
 */
function parseFlags(argv: readonly string[], request: { runId?: string; cleanup?: boolean }): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) {
      request.runId = argument
      continue
    }
    if (argument === '--cleanup') {
      request.cleanup = true
      continue
    }
    if (argument === '--run') {
      request.runId = requireValue(argument, argv[index + 1])
      index += 1
      continue
    }
    pairs.push([argument, requireValue(argument, argv[index + 1])])
    index += 1
  }
  return pairs
}

function requireValue(flag: string, value: string | undefined): string {
  // A value that looks like another flag is a missing value, not a value: `--data --cleanup`
  // silently sending the text "--cleanup" to an agent is worse than refusing.
  if (value === undefined || value.startsWith('--')) throw new HiveError('MISSING_ARGUMENT', `${flag} needs a value`)
  return value
}

function runState(value: string): RunState {
  if (!runStates.includes(value as RunState)) throw new HiveError('INVALID_ARGUMENT', `Unknown run state: ${value}`)
  return value as RunState
}

function wholeNumber(flag: string, value: string, minimum = 1): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum) throw new HiveError('INVALID_ARGUMENT', `${flag} must be an integer of at least ${minimum}`)
  return parsed
}

/** JSON out, so the CLI composes with other tools instead of needing to be re-parsed. */
function render(result: ResultEnvelope<unknown>): string {
  if (!result.ok) throw new HiveError(result.error.code, result.error.message)
  return JSON.stringify(result.data, null, 2)
}
