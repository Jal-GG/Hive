import { ObservabilityService } from './observability.js'
import { Ledger } from './ledger.js'
import { runWorkflowCli, workflowUsage } from './interfaces/cli/workflow-cli.js'
import { WorkflowService } from './workflow.js'
import { WorkBoard } from './work/board.js'
import type { TriggerAdmissionPolicy } from './admission.js'
import type { ActorContext, Capability, ScopeRef, TriggerRecord } from './contracts.js'

const capabilities: Capability[] = ['workspace:read', 'workspace:write', 'work:dispatch', 'work:mutate', 'runtime:read', 'context:read']
const actor: ActorContext = { actorId: process.env.HIVE_ACTOR ?? 'cli-operator', actorType: 'operator', displayName: 'Hive CLI', source: 'cli', capabilities }

/**
 * Opened on first use, not at import: `hive --help` is a read of the usage text
 * and must not create a ledger file as a side effect.
 */
let opened: Ledger | undefined
function ledger(): Ledger {
  opened ??= new Ledger(process.env.HIVE_LEDGER ?? '.hive/hive.db')
  return opened
}

/** Reads a `--flag value` pair out of the raw argv, so bootstrap uses the scope the command resolves. */
function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

function envFlag(name: string): boolean | undefined {
  const value = process.env[name]
  if (value === undefined) return undefined
  return value === '1' || value.toLowerCase() === 'true'
}

function envList<T extends string>(name: string): readonly T[] | undefined {
  const value = process.env[name]
  if (!value) return undefined
  return value.split(',').map((entry) => entry.trim()).filter((entry): entry is T => entry.length > 0)
}

function envNumber(name: string): number | undefined {
  const value = process.env[name]
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** The deployment default (§5.7). Absent variables leave a dimension unchecked. */
function policyFromEnv(): TriggerAdmissionPolicy {
  return {
    paused: envFlag('HIVE_TRIGGER_PAUSED'),
    allowedKinds: envList<TriggerRecord['kind']>('HIVE_TRIGGER_ALLOWED_KINDS'),
    allowedSources: envList<ActorContext['source']>('HIVE_TRIGGER_ALLOWED_SOURCES'),
    maxRunsPerWindow: envNumber('HIVE_TRIGGER_MAX_RUNS_PER_WINDOW'),
    windowMs: envNumber('HIVE_TRIGGER_WINDOW_MS'),
    spendCapUsd: envNumber('HIVE_TRIGGER_SPEND_CAP_USD'),
    breakerThreshold: envNumber('HIVE_TRIGGER_BREAKER_THRESHOLD'),
    breakerCooldownMs: envNumber('HIVE_TRIGGER_BREAKER_COOLDOWN_MS'),
  }
}

/**
 * Bootstraps the scope a first command runs against, so `hive workflow list` works
 * on a fresh ledger. Idempotent: an existing workspace or project is reused rather
 * than re-created, which is what keeps a second invocation from failing on a
 * UNIQUE constraint instead of showing the state it already has.
 */
function ensureScope(db: Ledger, argv: readonly string[]): ScopeRef {
  const workspace = flag(argv, '--workspace') ?? process.env.HIVE_WORKSPACE ?? 'main'
  const project = flag(argv, '--project') ?? process.env.HIVE_PROJECT ?? 'hive'
  try {
    return db.resolveScope(workspace, project)
  } catch {
    // Bootstrap below: the scope is absent, not an error.
  }
  try {
    db.createActor(actor)
  } catch {
    // The actor is created once per ledger; an existing row is the expected case.
  }
  const workspaceId = db.workspaceByName(workspace) ?? db.createWorkspace(workspace)
  const projectId = db.projectByName(workspaceId, project) ?? db.createProject(workspaceId, project)
  return { workspaceId, projectId, workspaceName: workspace, projectName: project }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv[0]
  if (!command || command === '--help' || command === 'help') {
    process.stdout.write(`${workflowUsage()}\n`)
    return
  }
  if (command !== 'workflow') throw new Error(`Unsupported command: ${command}`)
  const db = ledger()
  ensureScope(db, argv)
  const board = new WorkBoard(db)
  // Telemetry is opt-in (§7.0), and it is also the spend source a cap reads.
  const observability = new ObservabilityService({ ledger: db, enabled: envFlag('HIVE_TELEMETRY') === true })
  const workflows = new WorkflowService({
    ledger: db,
    board,
    admission: policyFromEnv(),
    spend: (scope) => observability.costUsd(actor, scope),
  })
  process.stdout.write(`${await runWorkflowCli({ ledger: db, workflows }, actor, argv.slice(1))}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}).finally(() => opened?.close())
