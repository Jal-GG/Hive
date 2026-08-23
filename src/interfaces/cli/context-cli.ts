import { ActorContext, ResultEnvelope } from '../../contracts.js'
import {
  ContextBrowseOperation,
  ContextBrowseRequest,
  ContextBrowser,
  contextBrowseHelp,
  contextBrowseOperations,
} from '../../context/browsing/context-browser.js'
import { HiveError } from '../../errors.js'

const operationSet = new Set<string>(contextBrowseOperations)

/**
 * `hive context <operation> [target] [--flag value]`, where the target is either a
 * `viking://` URI or `--workspace w --project p [--path p]`. The dispatcher is a
 * pure function of its argv so it can be tested without a process.
 */
export function runContextCli(browser: ContextBrowser, actor: ActorContext, argv: readonly string[]): string {
  const [operation, ...rest] = argv
  if (operation === undefined || operation === '--help' || operation === 'help') return usage()
  if (!operationSet.has(operation)) throw new HiveError('UNKNOWN_OPERATION', `Unknown context operation: ${operation}\n\n${usage()}`)
  const result = browser.browse(actor, parseArguments(operation as ContextBrowseOperation, rest))
  return render(result)
}

export function usage(): string {
  const lines = contextBrowseOperations.map((operation) => `  ${operation.padEnd(11)}${contextBrowseHelp[operation]}`)
  return [
    'Usage: hive context <operation> [viking://…] [options]',
    '',
    'Operations (all read-only):',
    ...lines,
    '',
    'Options:',
    '  --workspace <name>  Workspace name, when no URI is given',
    '  --project <name>    Project name, when no URI is given',
    '  --path <path>       Canonical path within the project',
    '  --pattern <value>   Regular expression (grep) or glob/substring (glob, find)',
    '  --revision <rev>    Git revision, for readAt',
    '  --depth <n>         Maximum tree depth',
    '  --limit <n>         Maximum results',
    '  --ignore-case       Case-insensitive grep',
  ].join('\n')
}

function parseArguments(operation: ContextBrowseOperation, argv: readonly string[]): ContextBrowseRequest {
  const request: ContextBrowseRequest = { version: 1, operation }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument.startsWith('viking://')) {
      request.uri = argument
      continue
    }
    if (argument === '--ignore-case') {
      request.ignoreCase = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new HiveError('MISSING_ARGUMENT', `${argument} needs a value`)
    index += 1
    switch (argument) {
      case '--workspace': request.workspace = value; break
      case '--project': request.project = value; break
      case '--path': request.path = value; break
      case '--pattern': request.pattern = value; break
      case '--revision': request.revision = value; break
      case '--depth': request.depth = wholeNumber(argument, value); break
      case '--limit': request.limit = wholeNumber(argument, value); break
      default: throw new HiveError('UNKNOWN_FLAG', `Unknown option: ${argument}`)
    }
  }
  return request
}

function wholeNumber(flag: string, value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new HiveError('INVALID_ARGUMENT', `${flag} must be a positive integer`)
  return parsed
}

/** JSON out, so the CLI composes with other tools instead of needing to be re-parsed. */
function render(result: ResultEnvelope<unknown>): string {
  if (!result.ok) throw new HiveError(result.error.code, result.error.message)
  return JSON.stringify(result.data, null, 2)
}
