import { Ledger } from './ledger.js'
import { runWorkflowCli } from './interfaces/cli/workflow-cli.js'
import { WorkflowService } from './workflow.js'
import { WorkBoard } from './work/board.js'
import type { ActorContext, Capability, ScopeRef } from './contracts.js'

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
    process.stdout.write('Usage: hive workflow <list|register|trigger|runs|cancel|triggers|schedules|schedule|schedule-state|tick> [options]\n')
    return
  }
  if (command !== 'workflow') throw new Error(`Unsupported command: ${command}`)
  const db = ledger()
  ensureScope(db, argv)
  const board = new WorkBoard(db)
  const workflows = new WorkflowService({ ledger: db, board })
  process.stdout.write(`${await runWorkflowCli({ ledger: db, workflows }, actor, argv.slice(1))}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}).finally(() => opened?.close())
