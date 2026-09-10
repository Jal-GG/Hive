import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActorContext, ActorType, Capability, ScopeRef } from '../src/contracts.js'
import { ContextFilesystem, ContextFilesystemOptions } from '../src/context/context-filesystem.js'
import { ContextBrowser } from '../src/context/browser.js'
import { Ledger } from '../src/ledger.js'
import { RuntimeBrowser } from '../src/runtime/runtime-browser.js'
import { RuntimeController } from '../src/runtime/runtime-controller.js'
import { FakeRuntimeAdapter } from '../src/runtime/fake-backend.js'
import { ProviderCatalog } from '../src/runtime/provider-catalog.js'
import { RunManager } from '../src/runtime/run-manager.js'
import { RuntimeRegistry } from '../src/runtime/runtime-registry.js'
import { FakeTranscriptAdapter } from '../src/runtime/transcript/fake-transcript.js'
import { GitWorktreeManager } from '../src/runtime/worktree-manager.js'
import { createResourceUri } from '../src/resource-uri.js'
import { Clock } from '../src/shared.js'
import { GitRunner, gitIdentityArgs } from '../src/git.js'
import { Dispatcher } from '../src/dispatch/dispatcher.js'
import { Supervisor } from '../src/dispatch/supervisor.js'
import { IngestionPipeline } from '../src/ingest/pipeline.js'
import { Searcher } from '../src/search/searcher.js'
import { SessionStore } from '../src/session/store.js'
import { MergeCoordinator } from '../src/merge/coordinator.js'
import { ConvoyService } from '../src/merge/convoy.js'
import { commandGateRunner } from '../src/merge/gates.js'
import { HandoffService } from '../src/work/handoffs.js'
import { MailService } from '../src/work/mail.js'
import { PacketCompiler } from '../src/work/packet.js'
import { WorkBoard } from '../src/work/board.js'

/** Builds a CLI actor; tests vary only the id, capabilities, and occasionally the type. */
export function testActor(actorId: string, capabilities: Capability[], actorType: ActorType = 'operator'): ActorContext {
  return { actorId, actorType, displayName: actorId, source: 'cli', capabilities }
}

/** An agent actor: the `agentId` is what mail addresses and handoff eligibility resolve against. */
export function testAgent(agentId: string, capabilities: Capability[], actorId = agentId): ActorContext {
  return { actorId, actorType: 'agent', displayName: agentId, source: 'cli', capabilities, agentId }
}

/** A fresh temporary directory, removed with the OS temp dir rather than per test. */
export function tempDirectory(suffix: string): string {
  return mkdtempSync(join(tmpdir(), `hive-${suffix}-`))
}

export function ledgerWithActors(...actors: ActorContext[]): Ledger {
  const ledger = new Ledger(':memory:')
  for (const actor of actors) ledger.createActor(actor)
  return ledger
}

export interface ContextHarness {
  ledger: Ledger
  scope: ScopeRef
  fs: ContextFilesystem
  /** Adds a sibling project in the same workspace, for cross-project link tests. */
  addProject(name: string): ScopeRef
  close(): void
}

/** A ledger, a workspace/project scope, and a context filesystem rooted in a temp directory. */
export function contextHarness(actors: ActorContext[], options: ContextFilesystemOptions = {}): ContextHarness {
  const ledger = ledgerWithActors(...actors)
  const workspaceId = ledger.createWorkspace('main')
  const addProject = (name: string): ScopeRef => ({
    workspaceId,
    projectId: ledger.createProject(workspaceId, name),
    workspaceName: 'main',
    projectName: name,
  })
  const scope = addProject('hive')
  const fs = new ContextFilesystem(tempDirectory('context'), ledger, options)
  return { ledger, scope, fs, addProject, close: () => ledger.close() }
}

export function contextFileName(fs: ContextFilesystem, scope: ScopeRef, path: string): string {
  return join(fs.getRoot(), 'workspace', scope.workspaceName, 'project', scope.projectName, ...path.split('/'))
}

export interface BrowserHarness extends ContextHarness {
  browser: ContextBrowser
  /** URI for a resource path. The project root has no URI: a `viking://` URI always names a resource. */
  uri(path: string): string
  /** Scope-name spelling of the project root, which is the only way to address it. */
  root: { workspace: string; project: string }
}

/**
 * A populated context filesystem behind a `ContextBrowser`. Every browsing
 * surface is read-only, so one fixture can be shared across a whole file
 * instead of paying for a Git repository per test.
 */
export function browserHarness(actors: ActorContext[], writer: ActorContext, options: ContextFilesystemOptions = {}): BrowserHarness {
  const harness = contextHarness(actors, options)
  harness.fs.write(writer, harness.scope, { path: 'page/readme.md', body: '# Hive\nalpha line', tags: ['docs'] })
  harness.fs.write(writer, harness.scope, { path: 'page/guides/setup.md', body: 'beta line' })
  harness.fs.write(writer, harness.scope, { path: 'memory/note.md', body: 'gamma line' })
  return {
    ...harness,
    browser: new ContextBrowser(harness.fs, harness.ledger),
    uri: (path: string) => createResourceUri(harness.scope, path),
    root: { workspace: harness.scope.workspaceName, project: harness.scope.projectName },
  }
}

/**
 * Replaces a node's body on disk while leaving its frontmatter — including the
 * now-stale recorded hash — untouched. That is exactly what an editor outside
 * Hive does, and it is the signal reconciliation keys off.
 */
export function editBodyOutsideHive(fs: ContextFilesystem, scope: ScopeRef, path: string, body: string): void {
  const fileName = contextFileName(fs, scope, path)
  const match = /^(---\n[\s\S]*?\n---\n)[\s\S]*$/.exec(readFileSync(fileName, 'utf8'))
  if (!match) throw new Error(`${path} has no frontmatter to preserve`)
  writeFileSync(fileName, `${match[1]}${body}`, 'utf8')
}

/** A clock a test can move by hand, for idle thresholds and anything else time-dependent. */
export interface TestClock {
  now: Clock
  advance(ms: number): void
}

export function testClock(startedAt = '2026-01-01T00:00:00.000Z'): TestClock {
  let current = new Date(startedAt).getTime()
  return { now: () => new Date(current), advance: (ms: number) => { current += ms } }
}

/** A real repository with one commit, which is the minimum `git worktree add` will work from. */
export function gitRepository(suffix: string, options: { commit?: boolean } = {}): string {
  const root = tempDirectory(suffix)
  const git = new GitRunner(root)
  git.init('main')
  if (options.commit === false) return root
  writeFileSync(join(root, 'README.md'), '# fixture\n', 'utf8')
  git.run(['add', '--all'])
  git.run([...gitIdentityArgs, 'commit', '--quiet', '-m', 'initial'])
  return root
}

export interface RuntimeHarness {
  ledger: Ledger
  scope: ScopeRef
  repoRoot: string
  ledgerFile: string
  catalog: ProviderCatalog
  registry: RuntimeRegistry
  worktrees: GitWorktreeManager
  manager: RunManager
  browser: RuntimeBrowser
  controller: RuntimeController
  clock: TestClock
  close(): void
}

export interface RuntimeHarnessOptions {
  /** Registers a fake backend that declares `persistent_session`, so `adopt` can succeed. */
  persistent?: boolean
  /** Reuses an existing repository and ledger file, standing in for a host restart. */
  repoRoot?: string
  ledgerFile?: string
  usageIntervalBytes?: number
  clock?: TestClock
}

/**
 * The whole runtime plane over a real repository and a file-backed ledger.
 *
 * File-backed rather than in-memory on purpose: a restart test has to be able to
 * throw the harness away and open the same ledger again, which is the only way to
 * prove state is reconstructed rather than remembered.
 */
export function runtimeHarness(actors: ActorContext[], options: RuntimeHarnessOptions = {}): RuntimeHarness {
  const repoRoot = options.repoRoot ?? gitRepository('runtime-repo')
  const ledgerFile = options.ledgerFile ?? join(tempDirectory('runtime-ledger'), 'hive.db')
  const clock = options.clock ?? testClock()
  const ledger = new Ledger(ledgerFile, { now: clock.now })
  let scope: ScopeRef
  if (options.ledgerFile) {
    scope = ledger.resolveScope('main', 'hive')
  } else {
    for (const actor of actors) ledger.createActor(actor)
    const workspaceId = ledger.createWorkspace('main')
    scope = { workspaceId, projectId: ledger.createProject(workspaceId, 'hive'), workspaceName: 'main', projectName: 'hive' }
  }

  const catalog = new ProviderCatalog()
  const registry = new RuntimeRegistry(
    [new FakeRuntimeAdapter({ persistent: options.persistent, now: clock.now })],
    [new FakeTranscriptAdapter()],
  )
  const worktrees = new GitWorktreeManager({ repoRoot, now: clock.now })
  const manager = new RunManager({
    ledger,
    registry,
    catalog,
    worktrees,
    now: clock.now,
    usageIntervalBytes: options.usageIntervalBytes,
    // An empty host keeps a developer's own environment out of the assertions.
    host: {},
  })
  return {
    ledger,
    scope,
    repoRoot,
    ledgerFile,
    catalog,
    registry,
    worktrees,
    manager,
    browser: new RuntimeBrowser({ ledger, manager, catalog, registry, worktrees }),
    controller: new RuntimeController(manager),
    clock,
    close: () => {
      manager.detach()
      ledger.close()
    },
  }
}

export interface WorkHarness {
  ledger: Ledger
  scope: ScopeRef
  fs: ContextFilesystem
  board: WorkBoard
  mail: MailService
  handoffs: HandoffService
  packets: PacketCompiler
  clock: TestClock
  close(): void
}

/**
 * The work plane over one ledger and one context store: board, mail, handoffs,
 * and the packet compiler sharing a clock a test can advance. The ledger is
 * in-memory — a work test never needs restart durability, only determinism.
 */
export function workHarness(actors: ActorContext[]): WorkHarness {
  const clock = testClock()
  const ledger = new Ledger(':memory:', { now: clock.now })
  for (const actor of actors) ledger.createActor(actor)
  const workspaceId = ledger.createWorkspace('main')
  const scope: ScopeRef = {
    workspaceId,
    projectId: ledger.createProject(workspaceId, 'hive'),
    workspaceName: 'main',
    projectName: 'hive',
  }
  const fs = new ContextFilesystem(tempDirectory('work-context'), ledger)
  const board = new WorkBoard(ledger, { now: clock.now })
  const mail = new MailService(ledger, { now: clock.now })
  const handoffs = new HandoffService(ledger, { now: clock.now })
  const packets = new PacketCompiler({ ledger, board, mail, handoffs, filesystem: fs }, { now: clock.now })
  return { ledger, scope, fs, board, mail, handoffs, packets, clock, close: () => ledger.close() }
}

export interface DispatchHarness extends RuntimeHarness {
  board: WorkBoard
  mail: MailService
  handoffs: HandoffService
  packets: PacketCompiler
  dispatcher: Dispatcher
  supervisor: Supervisor
  fs: ContextFilesystem
}

/**
 * The whole Phase 5 plane over one runtime harness: the work services, the
 * dispatcher, and the supervisor, all sharing the runtime's ledger, clock, and
 * fake backend. Persistent by default because dispatch tests restart things.
 */
export function dispatchHarness(actors: ActorContext[], options: RuntimeHarnessOptions = {}): DispatchHarness {
  const runtime = runtimeHarness(actors, { persistent: true, ...options })
  const fs = new ContextFilesystem(tempDirectory('dispatch-context'), runtime.ledger)
  const board = new WorkBoard(runtime.ledger, { now: runtime.clock.now })
  const mail = new MailService(runtime.ledger, { now: runtime.clock.now })
  const handoffs = new HandoffService(runtime.ledger, { now: runtime.clock.now })
  const packets = new PacketCompiler({ ledger: runtime.ledger, board, mail, handoffs, filesystem: fs }, { now: runtime.clock.now })
  const dispatcher = new Dispatcher(runtime.ledger, board, packets, runtime.manager, { scope: runtime.scope, now: runtime.clock.now })
  const supervisor = new Supervisor({ ledger: runtime.ledger, board, mail, manager: runtime.manager, scope: runtime.scope, now: runtime.clock.now })
  return { ...runtime, board, mail, handoffs, packets, dispatcher, supervisor, fs }
}

export interface KnowledgeHarness extends WorkHarness {
  ingest: IngestionPipeline
  search: Searcher
  sessions: SessionStore
  /** The packet compiler with the lexical index wired in, as the desktop and dispatcher would. */
  searchingPackets: PacketCompiler
}

/**
 * The Phase 6 plane over one in-memory ledger: the ingestion pipeline, the
 * searcher, the session store, and a second packet compiler with search wired
 * in — the integration the exit gate exercises.
 */
export function knowledgeHarness(actors: ActorContext[]): KnowledgeHarness {
  const harness = workHarness(actors)
  const ingest = new IngestionPipeline(harness.ledger, { now: harness.clock.now })
  const search = new Searcher(harness.ledger)
  const sessions = new SessionStore(harness.ledger, { now: harness.clock.now })
  const searchingPackets = new PacketCompiler(
    {
      ledger: harness.ledger,
      board: harness.board,
      mail: harness.mail,
      handoffs: harness.handoffs,
      filesystem: harness.fs,
      search: { search: (actor, scope, query, options) => search.search(actor, scope, query, options) },
    },
    { now: harness.clock.now },
  )
  return { ...harness, ingest, search, sessions, searchingPackets }
}

export interface MergeHarness extends DispatchHarness {
  queue: MergeCoordinator
  convoys: ConvoyService
  /** The bare repository the queue lands against — the way real targets are. */
  remote: string
  /** Creates a branch off main with one commit, the way an agent worktree would leave it. */
  branchWithCommit(branch: string, file: string, content: string): void
  /** Moves the remote's main by one commit, the way another writer would. */
  moveTarget(file: string, content: string): void
  /** The protected branch on the remote, for the approval-gate tests. */
  protectedBranch: string
  /** The head of any branch on the remote right now — proof a push did or did not happen. */
  remoteHead(branch: string): string
}

/**
 * The Phase 7 plane: the dispatch harness's repo and work services, plus a bare
 * remote, a real command gate committed on main, and the merge coordinator and
 * convoy service over both. The gates are honest — `check.mjs` fails when
 * `broken.txt` exists — so bisect and conflict behavior are exercised by real
 * git and a real process, not by scripted verdicts.
 */
export function mergeQueueHarness(actors: ActorContext[]): MergeHarness {
  const harness = dispatchHarness(actors)
  // The gate scripts are committed on main so every integration worktree has them.
  writeFileSync(join(harness.repoRoot, 'check.mjs'), [
    "import { existsSync } from 'node:fs'",
    "if (existsSync('broken.txt')) { console.error('broken.txt present — gate failed'); process.exit(1) }",
    "console.log('gate ok')",
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(harness.repoRoot, 'dirty.mjs'), [
    "import { existsSync, writeFileSync } from 'node:fs'",
    "if (existsSync('dirty-marker.txt')) writeFileSync('gate-artifact.txt', 'left behind by the gate', 'utf8')",
    "console.log('dirty gate ok')",
    '',
  ].join('\n'), 'utf8')
  const git = new GitRunner(harness.repoRoot)
  git.run(['add', '--all'])
  git.run([...gitIdentityArgs, 'commit', '--quiet', '-m', 'gate scripts'])

  const remote = `${tempDirectory('merge-remote')}.git`
  git.run(['clone', '--quiet', '--bare', harness.repoRoot, remote])
  // A second target on the remote, declared protected below: landing on it
  // requires an approval, landing on main does not.
  const protectedBranch = 'release'
  git.run(['push', '--quiet', remote, `main:${protectedBranch}`])

  const queue = new MergeCoordinator({
    ledger: harness.ledger,
    repoRoot: harness.repoRoot,
    remote,
    gates: [
      { name: 'check', command: ['node', 'check.mjs'] },
      { name: 'dirty', command: ['node', 'dirty.mjs'] },
    ],
    runner: commandGateRunner(),
    scope: harness.scope,
    protectedBranches: [protectedBranch],
    mail: harness.mail,
    board: harness.board,
    now: harness.clock.now,
  })
  const convoys = new ConvoyService({
    ledger: harness.ledger,
    board: harness.board,
    mail: harness.mail,
    scope: harness.scope,
    dispatcher: harness.dispatcher,
    now: harness.clock.now,
  })

  const branchWithCommit = (branch: string, file: string, content: string): void => {
    const dir = tempDirectory(`branch-${branch}`)
    git.run(['worktree', 'add', '--quiet', dir, '-b', branch, 'main'])
    writeFileSync(join(dir, file), content, 'utf8')
    const branchGit = new GitRunner(dir)
    branchGit.run(['add', '--all'])
    branchGit.run([...gitIdentityArgs, 'commit', '--quiet', '-m', `add ${file}`])
    git.run(['worktree', 'remove', dir])
  }
  const moveTarget = (file: string, content: string): void => {
    const head = git.run(['ls-remote', remote, 'refs/heads/main']).split('\t')[0]
    const dir = tempDirectory('merge-move')
    git.run(['worktree', 'add', '--quiet', '--detach', dir, head])
    writeFileSync(join(dir, file), content, 'utf8')
    const moveGit = new GitRunner(dir)
    moveGit.run(['add', '--all'])
    moveGit.run([...gitIdentityArgs, 'commit', '--quiet', '-m', `move target: ${file}`])
    moveGit.run(['push', '--quiet', remote, 'HEAD:main'])
    git.run(['worktree', 'remove', dir])
  }

  const remoteHead = (branch: string): string => git.run(['ls-remote', remote, `refs/heads/${branch}`]).split('\t')[0]

  return { ...harness, queue, convoys, remote, branchWithCommit, moveTarget, protectedBranch, remoteHead }
}
