import { join } from 'node:path'
import { ActorContext } from '../contracts.js'
import { Ledger } from '../ledger.js'
import { ClockOptions, resolveClock } from '../shared/clock.js'
import { RuntimeBrowser } from './browsing/runtime-browser.js'
import { RuntimeController } from './control/runtime-controller.js'
import { FakeRuntimeAdapter } from './fake/fake-runtime.js'
import { NodePtyRuntimeAdapter } from './pty/node-pty-runtime.js'
import { ProviderCatalog } from './provider-catalog.js'
import { RunManager, RunManagerOptions } from './run-manager.js'
import { RuntimeAdapter, TranscriptAdapter } from './runtime-adapter.js'
import { RuntimeRegistry } from './runtime-registry.js'
import { ClaudeJsonlTranscriptAdapter } from './transcript/claude-jsonl-transcript.js'
import { FakeTranscriptAdapter } from './transcript/fake-transcript.js'
import { TmuxRuntimeAdapter } from './tmux/tmux-runtime.js'
import { GitWorktreeManager } from './worktree/git-worktree.js'

export interface RuntimeHostOptions extends ClockOptions {
  ledger: Ledger
  repoRoot: string
  worktreeRoot?: string
  /** Where a persistent backend keeps its per-session files. Defaults to `<repoRoot>/.hive/runtime`. */
  runtimeDir?: string
  catalog?: ProviderCatalog
  /** Replaces the auto-detected set entirely, for tests and for a host that wants one backend only. */
  adapters?: readonly RuntimeAdapter[]
  transcripts?: readonly TranscriptAdapter[]
  /** Registers the tmux backend. Off by default: it is the optional Unix backend, not the primary one (C6). */
  enableTmux?: boolean
  host?: Record<string, string | undefined>
  manager?: Partial<Pick<RunManagerOptions, 'leaseTtlMs' | 'cols' | 'rows' | 'readyTimeoutMs' | 'usageIntervalBytes'>>
}

/**
 * Everything the runtime plane needs, assembled once.
 *
 * Both the CLI and the Electron main process build this and then adapt a transport
 * onto `browser` and `controller`; neither constructs an adapter, a catalog, or a
 * worktree manager itself. That is what keeps the two surfaces from drifting into
 * having different sets of backends, and it is where a host decides what it can
 * run — a machine without tmux simply never registers it, and a profile naming it
 * fails at launch with `BACKEND_UNAVAILABLE` instead of half-starting.
 */
export interface RuntimeHost {
  ledger: Ledger
  catalog: ProviderCatalog
  registry: RuntimeRegistry
  worktrees: GitWorktreeManager
  manager: RunManager
  browser: RuntimeBrowser
  controller: RuntimeController
  /** Re-adopts or retires whatever the last host left behind. Call once at startup. */
  recover(actor: ActorContext): Promise<void>
  close(): void
}

export function createRuntimeHost(options: RuntimeHostOptions): RuntimeHost {
  const now = resolveClock(options)
  const catalog = options.catalog ?? new ProviderCatalog()
  const registry = new RuntimeRegistry(options.adapters ?? defaultAdapters(options), options.transcripts ?? defaultTranscripts())
  const worktrees = new GitWorktreeManager({ repoRoot: options.repoRoot, worktreeRoot: options.worktreeRoot, now })
  const manager = new RunManager({ ledger: options.ledger, registry, catalog, worktrees, host: options.host, now, ...options.manager })
  const browser = new RuntimeBrowser({ ledger: options.ledger, manager, catalog, registry, worktrees })
  return {
    ledger: options.ledger,
    catalog,
    registry,
    worktrees,
    manager,
    browser,
    controller: new RuntimeController(manager),
    recover: async (actor) => {
      await manager.reconcile(actor)
    },
    // Detach rather than kill: a persistent backend's sessions are meant to outlive
    // this process, and reconciliation on the next start is what re-adopts them.
    close: () => manager.detach(),
  }
}

/**
 * node-pty is always registered because loading it is deferred to the first spawn:
 * a host missing the native module still lists the backend and fails one launch
 * with `PTY_UNAVAILABLE`, rather than silently offering no backends at all.
 */
function defaultAdapters(options: RuntimeHostOptions): RuntimeAdapter[] {
  const now = resolveClock(options)
  const adapters: RuntimeAdapter[] = [new NodePtyRuntimeAdapter({ now }), new FakeRuntimeAdapter({ now })]
  if (options.enableTmux) adapters.push(new TmuxRuntimeAdapter({ runtimeDir: options.runtimeDir ?? join(options.repoRoot, '.hive', 'runtime'), now }))
  return adapters
}

function defaultTranscripts(): TranscriptAdapter[] {
  return [new ClaudeJsonlTranscriptAdapter(), new FakeTranscriptAdapter()]
}
