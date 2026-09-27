import { ActorContext, ScopeRef, WorkflowDefinition, WorkflowRun, WorkflowWatch } from '../../contracts.js'
import { HiveError } from '../../errors.js'
import { Ledger } from '../../ledger.js'
import { ObservabilityService } from '../../observability.js'
import { currentVersion } from '../../release.js'
import { WorkflowService, TriggerInput } from '../../workflow.js'
import { VoiceOperator } from '../../voice.js'

export interface WorkflowCliSurfaces {
  ledger: Ledger
  workflows: WorkflowService
  observability?: ObservabilityService
  voice?: VoiceOperator
  packageRoot?: string
}

const operations = ['list', 'register', 'trigger', 'runs', 'cancel', 'triggers', 'schedules', 'schedule', 'schedule-state', 'watches', 'watch', 'watch-state', 'watch-remove', 'queues', 'admission', 'tick', 'pause', 'resume', 'voice', 'version', 'otel'] as const
type WorkflowOperation = (typeof operations)[number]

export async function runWorkflowCli(surfaces: WorkflowCliSurfaces, actor: ActorContext, argv: readonly string[]): Promise<string> {
  const [operation, ...rest] = argv
  if (!operation || operation === 'help' || operation === '--help') return workflowUsage()
  if (!operations.includes(operation as WorkflowOperation)) throw new HiveError('UNKNOWN_OPERATION', `Unknown workflow operation: ${operation}\n\n${workflowUsage()}`)
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
    case 'watches': return render(surfaces.workflows.watches(scope))
    case 'watch': return render(surfaces.workflows.watch(actor, { id: requireValue('--id', flagValue(rest, '--id')), workflowId: requireValue('--workflow', flagValue(rest, '--workflow')), uriPrefix: requireValue('--uri-prefix', flagValue(rest, '--uri-prefix')), state: 'enabled', nextRunAt: flagValue(rest, '--next-run-at') ?? new Date().toISOString(), scope }))
    case 'watch-state': return render(surfaces.workflows.setWatchState(actor, requireValue('--id', flagValue(rest, '--id')), (flagValue(rest, '--state') ?? 'enabled') as WorkflowWatch['state']))
    case 'watch-remove': return render({ removed: surfaces.workflows.removeWatch(actor, requireValue('--id', flagValue(rest, '--id'))) })
    case 'queues': {
      if (!surfaces.observability) throw new HiveError('MISSING_ARGUMENT', 'Queue diagnostics need an observability service')
      return render(surfaces.observability.queueDiagnostics(actor, scope))
    }
    case 'admission': return render(surfaces.workflows.admissionState())
    case 'tick': return render({ triggered: surfaces.workflows.tick(actor, new Date(flagValue(rest, '--at') ?? new Date().toISOString())) })
    case 'pause': return render({ policy: surfaces.workflows.setPaused(actor, scope, true) })
    case 'resume': return render({ policy: surfaces.workflows.setPaused(actor, scope, false) })
    case 'voice': {
      if (!surfaces.voice) throw new HiveError('VOICE_UNAVAILABLE', 'The voice operator is not configured')
      const utterance = flagValue(rest, '--utterance')
      if (!utterance) return render({ vocabulary: surfaces.voice.vocabulary() })
      return render(surfaces.voice.turn(actor, utterance))
    }
    case 'version': return render({ version: currentVersion(surfaces.packageRoot ?? process.cwd()) })
    case 'otel': {
      if (!surfaces.observability) throw new HiveError('MISSING_ARGUMENT', 'OTel snapshot needs an observability service')
      return render(surfaces.observability.otlpSnapshot(actor, scope))
    }
  }
}

export function workflowUsage(): string {
  return [
    'Usage: hive workflow <operation> [options]',
    '',
    '  list                  List registered workflow versions',
    '  register              Register a JSON definition (--definition)',
    '  trigger               Queue a workflow (--id, --workflow, --version, --kind)',
    '  runs                  List workflow runs',
    '  cancel                Cancel a queued or running workflow (--run)',
    '  triggers              List idempotent trigger history, refusals included',
    '  schedules             List schedule state and next run',
    '  schedule              Add or replace a schedule (--id, --workflow, --interval-ms, --next-run-at)',
    '  schedule-state        Enable or disable a schedule (--id, --state enabled|disabled)',
    '  watches               List context watches and their next observation',
    '  watch                 Watch a context URI prefix for change (--id, --workflow, --uri-prefix, --next-run-at)',
    '  watch-state           Enable or disable a watch (--id, --state enabled|disabled)',
    '  watch-remove          Remove a watch (--id)',
    '  queues                Queue diagnostics: depth, states, oldest item',
    '  admission             Show the ingress policy and circuit-breaker state',
    '  tick                  Run due schedules and watches once (--at)',
    '  pause                 Refuse all trigger ingress (§5.7)',
    '  resume                Resume trigger ingress',
    '  voice                 Resolve a voice turn (--utterance), or list the vocabulary',
    '  version               The running Hive version',
    '  otel                  OTLP-shaped metrics snapshot (opt-in telemetry)',
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
