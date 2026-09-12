import { ActorContext, ScopeRef, WorkflowDefinition, WorkflowRun } from '../../contracts.js'
import { HiveError } from '../../errors.js'
import { Ledger } from '../../ledger.js'
import { WorkflowService, TriggerInput } from '../../workflow.js'

export interface WorkflowCliSurfaces {
  ledger: Ledger
  workflows: WorkflowService
}

const operations = ['list', 'register', 'trigger', 'runs', 'cancel', 'triggers', 'schedules', 'schedule', 'schedule-state', 'tick'] as const
type WorkflowOperation = (typeof operations)[number]

export async function runWorkflowCli(surfaces: WorkflowCliSurfaces, actor: ActorContext, argv: readonly string[]): Promise<string> {
  const [operation, ...rest] = argv
  if (!operation || operation === 'help' || operation === '--help') return usage()
  if (!operations.includes(operation as WorkflowOperation)) throw new HiveError('UNKNOWN_OPERATION', `Unknown workflow operation: ${operation}\n\n${usage()}`)
  const scope = surfaces.ledger.resolveScope(flagValue(rest, '--workspace') ?? 'main', flagValue(rest, '--project') ?? 'hive')

  switch (operation as WorkflowOperation) {
    case 'list': return render(surfaces.ledger.listWorkflows())
    case 'register': {
      const definition = JSON.parse(requireValue('--definition', flagValue(rest, '--definition'))) as Omit<WorkflowDefinition, 'createdBy' | 'createdAt' | 'updatedAt'>
      return render(surfaces.workflows.register(actor, definition))
    }
    case 'trigger': {
      const input: TriggerInput = {
        id: requireValue('--id', flagValue(rest, '--id')),
        kind: (flagValue(rest, '--kind') ?? 'manual') as TriggerInput['kind'],
        workflowId: requireValue('--workflow', flagValue(rest, '--workflow')),
        version: flagValue(rest, '--version'),
      }
      return render(surfaces.workflows.trigger(actor, scope, input))
    }
    case 'runs': return render(surfaces.ledger.listWorkflowRuns(scope))
    case 'cancel': return render(surfaces.workflows.cancel(actor, requireValue('--run', flagValue(rest, '--run'))))
    case 'triggers': return render(surfaces.ledger.listTriggers(scope))
    case 'schedules': return render(surfaces.workflows.schedules(scope))
    case 'schedule': return render(surfaces.workflows.schedule(actor, { id: requireValue('--id', flagValue(rest, '--id')), workflowId: requireValue('--workflow', flagValue(rest, '--workflow')), intervalMs: Number(requireValue('--interval-ms', flagValue(rest, '--interval-ms'))), state: 'enabled', nextRunAt: requireValue('--next-run-at', flagValue(rest, '--next-run-at')), scope }))
    case 'schedule-state': return render(surfaces.workflows.setScheduleState(actor, requireValue('--id', flagValue(rest, '--id')), (flagValue(rest, '--state') ?? 'enabled') as 'enabled' | 'disabled'))
    case 'tick': return render({ triggered: surfaces.workflows.tick(actor, new Date(flagValue(rest, '--at') ?? new Date().toISOString())) })
  }
}

export function usage(): string {
  return [
    'Usage: hive workflow <operation> [options]',
    '',
    '  list                  List registered workflow versions',
    '  register              Register a JSON definition (--definition)',
    '  trigger               Queue a workflow (--id, --workflow, --version, --kind)',
    '  runs                  List workflow runs',
    '  cancel                Cancel a queued or running workflow (--run)',
    '  triggers              List idempotent trigger history',
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
  if (!value || value.startsWith('--')) throw new HiveError('MISSING_ARGUMENT', `${flag} needs a value`)
  return value
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value) throw new HiveError('MISSING_ARGUMENT', `${flag} is required`)
  return value
}

function render(data: WorkflowDefinition[] | WorkflowRun[] | unknown): string {
  return JSON.stringify(data, null, 2)
}
