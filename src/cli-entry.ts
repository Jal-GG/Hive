import { ContextBrowser } from './context/browser.js'
import { ContextFilesystem } from './context/context-filesystem.js'
import { ObservabilityService, SignedWebhookAdapter } from './observability.js'
import { Ledger } from './ledger.js'
import { LedgerWatchSource } from './watch-source.js'
import { VoiceOperator } from './voice.js'
import { ContextMcpServer } from './interfaces/mcp/context-mcp-server.js'
import { ControlMcpServer } from './interfaces/mcp/control-mcp-server.js'
import { HiveMcpServer } from './interfaces/mcp/hive-mcp-server.js'
import { WebhookIngressServer, type WebhookKind } from './interfaces/http/webhook-ingress.js'
import { ControlHttpServer } from './interfaces/http/control-http-server.js'
import { runWorkflowCli } from './interfaces/cli/workflow-cli.js'
import { WorkflowService } from './workflow.js'
import { WorkBoard } from './work/board.js'
import type { TriggerAdmissionPolicy } from './admission.js'
import type { ActorContext, Capability, ScopeRef, TriggerRecord } from './contracts.js'

const capabilities: Capability[] = ['workspace:read', 'workspace:write', 'work:dispatch', 'work:mutate', 'runtime:read', 'context:read']
const operator: ActorContext = { actorId: process.env.HIVE_ACTOR ?? 'cli-operator', actorType: 'operator', displayName: 'Hive CLI', source: 'cli', capabilities }

const ingressKinds: readonly WebhookKind[] = ['webhook', 'github', 'slack', 'feed']

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

function ensureActor(db: Ledger, actor: ActorContext): void {
  try {
    db.createActor(actor)
  } catch {
    // Created once per ledger; an existing row is the expected case.
  }
}

/**
 * Bootstraps the scope a first command runs against, so `hive workflow list` works
 * on a fresh ledger. Idempotent: an existing workspace or project is reused rather
 * than re-created, which is what keeps a second invocation from failing on a
 * UNIQUE constraint instead of showing the state it already has.
 */
function ensureScope(db: Ledger, argv: readonly string[], actor: ActorContext = operator): ScopeRef {
  const workspace = flag(argv, '--workspace') ?? process.env.HIVE_WORKSPACE ?? 'main'
  const project = flag(argv, '--project') ?? process.env.HIVE_PROJECT ?? 'hive'
  ensureActor(db, actor)
  try {
    return db.resolveScope(workspace, project)
  } catch {
    // Bootstrap below: the scope is absent, not an error.
  }
  const workspaceId = db.workspaceByName(workspace) ?? db.createWorkspace(workspace)
  const projectId = db.projectByName(workspaceId, project) ?? db.createProject(workspaceId, project)
  return { workspaceId, projectId, workspaceName: workspace, projectName: project }
}

/**
 * The services every command shares, over one ledger. Telemetry is opt-in
 * (§7.0), and it is also the spend source a trigger cap reads.
 */
function buildPlane(db: Ledger, actor: ActorContext, argv: readonly string[] = []): {
  workflows: WorkflowService
  observability: ObservabilityService
  voice: VoiceOperator
  scope: ScopeRef
} {
  const board = new WorkBoard(db)
  const observability = new ObservabilityService({ ledger: db, enabled: envFlag('HIVE_TELEMETRY') === true })
  const workflows = new WorkflowService({
    ledger: db,
    board,
    admission: policyFromEnv(),
    spend: (scope) => observability.costUsd(actor, scope),
    watchSource: new LedgerWatchSource(db),
  })
  const scope = ensureScope(db, argv, actor)
  const voice = new VoiceOperator({
    ledger: db,
    workflows,
    observability,
    scope,
    spend: (target) => observability.costUsd(actor, target),
    spendCapUsd: envNumber('HIVE_VOICE_SPEND_CAP_USD'),
  })
  return { workflows, observability, voice, scope }
}

export function usage(): string {
  return [
    'Usage: hive <command> [options]',
    '',
    '  workflow <operation>   Workflows, triggers, schedules, watches, ingress control',
    '                         (`hive workflow --help` lists the operations)',
    '  mcp                    Serve the read-only MCP tool surface over stdio',
    '  ingress                Serve the signed webhook ingress on loopback',
    '  dashboard              Serve the read-only web dashboard on loopback',
    '  release                Assemble a release directory (--channel, --out)',
    '',
    'Env:',
    '  HIVE_LEDGER            Ledger file (default .hive/hive.db)',
    '  HIVE_WORKSPACE         Workspace name (default main)',
    '  HIVE_PROJECT           Project name (default hive)',
    '  HIVE_CONTEXT_ROOT      Context store root (default .hive/context)',
    '  HIVE_TELEMETRY=1       Opt in to usage and metric recording',
    '  HIVE_VOICE_SPEND_CAP_USD  Voice action spend cap (§7 Phase 8 spend controls)',
    '  HIVE_DASHBOARD_PORT    Dashboard port (default 8788)',
    '  HIVE_TRIGGER_*         §5.7 ingress policy (pause, allowlists, quota, spend)',
    '  HIVE_WEBHOOK_SECRET    Required by `ingress`: the shared HMAC secret',
    '  HIVE_WEBHOOK_WORKFLOW  Required by `ingress`: the workflow to enqueue',
    '  HIVE_WEBHOOK_KIND      webhook | github | slack | feed (default webhook)',
    '  HIVE_WEBHOOK_PORT      Ingress port (default 8787)',
  ].join('\n')
}

async function runWorkflow(argv: readonly string[]): Promise<void> {
  const db = ledger()
  const { workflows, observability, voice } = buildPlane(db, operator, argv)
  process.stdout.write(`${await runWorkflowCli({ ledger: db, workflows, observability, voice, packageRoot: process.cwd() }, operator, argv.slice(1))}\n`)
}

async function runMcp(argv: readonly string[]): Promise<void> {
  const db = ledger()
  const scope = ensureScope(db, argv)
  const { workflows, observability } = buildPlane(db, operator, argv)
  const filesystem = new ContextFilesystem(process.env.HIVE_CONTEXT_ROOT ?? '.hive/context', db)
  const server = new HiveMcpServer(
    new ContextMcpServer(new ContextBrowser(filesystem, db), operator),
    new ControlMcpServer({ ledger: db, workflows, observability, scope }, operator),
  )
  // stdin closing is the client hanging up; the server then returns and exits.
  await server.serve(process.stdin, process.stdout)
}

/**
 * The read-only web dashboard (§7 Phase 8): one loopback HTTP process an
 * operator starts deliberately, serving the control JSON every surface shares
 * and an HTML page that renders it. GET only, loopback only — C4's rule that
 * the browser-facing surface mutates nothing.
 */
async function runDashboard(argv: readonly string[]): Promise<void> {
  const db = ledger()
  const scope = ensureScope(db, argv)
  const { workflows, observability } = buildPlane(db, operator, argv)
  const filesystem = new ContextFilesystem(process.env.HIVE_CONTEXT_ROOT ?? '.hive/context', db)
  const server = new ControlHttpServer({
    browser: new ContextBrowser(filesystem, db),
    control: { ledger: db, workflows, observability, scope },
    actor: operator,
  })
  const port = await server.listen(Number(process.env.HIVE_DASHBOARD_PORT ?? 8788))
  process.stdout.write(`hive dashboard on http://127.0.0.1:${port} (read-only)\n`)

  await new Promise<void>((resolve) => {
    const stop = () => {
      void server.close().then(() => resolve())
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}

/**
 * The signed ingress, as a process an operator starts deliberately. It refuses to
 * start without a secret and a target workflow, because an unsigned or untargeted
 * door is exactly what §7.0's "integrations disabled by default" rules out.
 */
async function runIngress(argv: readonly string[]): Promise<void> {
  const secret = process.env.HIVE_WEBHOOK_SECRET
  if (!secret) throw new Error('HIVE_WEBHOOK_SECRET is required: refusing to start an ingress that cannot verify signatures')
  const workflowId = process.env.HIVE_WEBHOOK_WORKFLOW
  if (!workflowId) throw new Error('HIVE_WEBHOOK_WORKFLOW is required: verified events need a workflow to enqueue')
  const requested = process.env.HIVE_WEBHOOK_KIND ?? 'webhook'
  const kind = ingressKinds.find((candidate) => candidate === requested)
  if (!kind) throw new Error(`HIVE_WEBHOOK_KIND must be one of ${ingressKinds.join(', ')}`)

  // The ingress is its own actor with its own source, so a source allowlist can
  // admit webhook deliveries without also admitting an operator's shell (§5.7).
  // It needs `work:mutate` as well as `work:dispatch`: enqueueing the work items
  // a workflow describes is the whole point of admitting the event.
  const ingressActor: ActorContext = {
    actorId: `integration:${kind}`,
    actorType: 'integration',
    displayName: `Ingress ${kind}`,
    source: kind as ActorContext['source'],
    capabilities: ['work:dispatch', 'work:mutate'],
  }
  const db = ledger()
  const scope = ensureScope(db, argv, ingressActor)
  const { workflows } = buildPlane(db, ingressActor, argv)

  const server = new WebhookIngressServer({
    adapter: new SignedWebhookAdapter({ workflow: workflows, secret }),
    actor: ingressActor,
    scope,
    workflowId,
    kind,
  })
  const port = await server.listen(Number(process.env.HIVE_WEBHOOK_PORT ?? 8787))
  process.stdout.write(`hive ingress on http://127.0.0.1:${port} -> workflow ${workflowId} (${kind})\n`)

  await new Promise<void>((resolve) => {
    const stop = () => {
      void server.close().then(() => resolve())
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}

/**
 * §7.10's "release packaging" as a CLI command: assemble the distributable
 * directory from the current build. Read-only with respect to the ledger — it
 * never opens one — so packaging cannot touch operator data.
 */
async function runRelease(argv: readonly string[]): Promise<void> {
  const channel = flag(argv, '--channel') as 'stable' | 'beta' | 'nightly' | undefined
  const out = flag(argv, '--out') ?? 'release'
  const { assembleRelease } = await import('./release.js')
  const assembled = assembleRelease({ packageRoot: process.cwd(), outRoot: out, channel })
  process.stdout.write(`${JSON.stringify({ directory: assembled.directory, manifest: assembled.manifest, files: assembled.files }, null, 2)}\n`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv[0]
  if (!command || command === '--help' || command === 'help') {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (command === 'workflow') return runWorkflow(argv)
  if (command === 'mcp') return runMcp(argv)
  if (command === 'ingress') return runIngress(argv)
  if (command === 'dashboard') return runDashboard(argv)
  if (command === 'release') return runRelease(argv)
  throw new Error(`Unsupported command: ${command}`)
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
  .finally(() => opened?.close())
