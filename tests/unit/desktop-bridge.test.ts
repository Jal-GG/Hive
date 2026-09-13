import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ResultEnvelope } from '../../src/contracts.js'
import { fakeProfileId } from '../../src/runtime/provider-catalog.js'
import { resetFakeSessions } from '../../src/runtime/fake-backend.js'
import { gitRepository, tempDirectory } from '../fixtures.js'
import { allowedChannels, createHiveWindow, type IpcRendererLike } from '../../src/interfaces/desktop/preload-bridge.js'
import { desktopOperator, startDesktopHost } from '../../src/interfaces/desktop/desktop-host.js'
import { runtimeIpcPrefix, runtimeStreamChannels } from '../../src/interfaces/desktop/runtime-channels.js'
import { RuntimeViewModel } from '../../src/interfaces/desktop/runtime-view-model.js'
import { Ledger } from '../../src/ledger.js'
import { WorkflowService } from '../../src/workflow.js'
import { WorkBoard } from '../../src/work/board.js'

function ok<T>(result: ResultEnvelope<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`)
  return result.data
}

function failure(result: ResultEnvelope<unknown>): { code: string; message: string } {
  if (result.ok) throw new Error('expected a failure envelope')
  return result.error
}

/**
 * The desktop main process, tested as an object graph: register the channels on
 * a recorder, then drive them exactly as `ipcMain` would. No Electron import, no
 * window, no display — the assembly under test is the same one the Electron
 * entry builds.
 */
class IpcMainRecorder {
  readonly handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
  readonly sent: Array<{ channel: string; payload: unknown }> = []
  /** The renderer this "window" pushes to, standing in for Electron's delivery. */
  renderer?: IpcRendererRecorder

  handle(channel: string, handler: (event: unknown, payload: unknown) => unknown): void {
    this.handlers.set(channel, handler)
  }

  /** Delivers an invoke the way `ipcMain` does: the event carries the sender. */
  invoke(channel: string, payload?: unknown): Promise<ResultEnvelope<unknown>> {
    const handler = this.handlers.get(channel)
    if (!handler) return Promise.resolve({ version: 1, requestId: 'missing', ok: false, error: { code: 'UNKNOWN_CHANNEL', message: `No handler for ${channel}` } })
    const event = { sender: this.sender }
    return Promise.resolve(handler(event, payload) as ResultEnvelope<unknown>)
  }

  get sender(): { send: (channel: string, payload: unknown) => void } {
    return {
      send: (channel, payload) => {
        this.sent.push({ channel, payload })
        // `webContents.send` delivers to the renderer's `on` listeners.
        this.renderer?.push(channel, payload)
      },
    }
  }
}

/** An `ipcRenderer` shaped by what the preload actually calls, recording everything. */
class IpcRendererRecorder implements IpcRendererLike {
  readonly invocations: Array<{ channel: string; args: unknown[] }> = []
  readonly listeners = new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>()
  /** Set by a test to route an invoke back at a main recorder, standing in for Electron itself. */
  main?: IpcMainRecorder

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    this.invocations.push({ channel, args })
    return this.main ? this.main.invoke(channel, ...args) : Promise.resolve({ version: 1, requestId: 'none', ok: true, data: null })
  }

  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void {
    const existing = this.listeners.get(channel) ?? []
    existing.push(listener)
    this.listeners.set(channel, existing)
  }

  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void {
    const existing = this.listeners.get(channel) ?? []
    this.listeners.set(channel, existing.filter((candidate) => candidate !== listener))
  }

  /** Delivers a push exactly as Electron would: listener(event, ...args). */
  push(channel: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(channel) ?? []) listener(undefined, ...args)
  }
}

afterEach(() => resetFakeSessions())

describe('desktop host assembly', () => {
  it('registers every channel the preload allowlists, and only those', () => {
    const repoRoot = gitRepository('desktop-channels')
    const desktop = startDesktopHost({ repoRoot, hostEnv: {} })
    const main = new IpcMainRecorder()
    const registered = desktop.registerIpc(main)

    expect([...registered].sort()).toEqual(allowedChannels())
    desktop.close()
  })

  it('serves a browse request through the registered channel, like a renderer', async () => {
    const repoRoot = gitRepository('desktop-browse')
    const desktop = startDesktopHost({ repoRoot, hostEnv: {} })
    const main = new IpcMainRecorder()
    desktop.registerIpc(main)

    const profiles = ok(await main.invoke(`${runtimeIpcPrefix}profiles`)) as { id: string }[]
    expect(profiles.some((profile) => profile.id === fakeProfileId)).toBe(true)
    desktop.close()
  })

  it('launches, streams, and stops a fake run over the whole bridge', async () => {
    const repoRoot = gitRepository('desktop-launch')
    const desktop = startDesktopHost({ repoRoot, hostEnv: {} })
    const main = new IpcMainRecorder()
    desktop.registerIpc(main)

    const launched = await main.invoke(`${runtimeIpcPrefix}launch`, { profileId: fakeProfileId, workspace: 'main', project: 'hive' })
    const run = ok(launched) as { id: string }

    const attached = await main.invoke('hive:runtime:stream:attach', { runId: run.id })
    expect(attached.ok).toBe(true)

    await main.invoke(`${runtimeIpcPrefix}write`, { runId: run.id, data: 'hello from the renderer\n' })
    const pushed = main.sent.filter((entry) => entry.channel === runtimeStreamChannels.data)
    expect(pushed.some((entry) => String((entry.payload as { chunk: string }).chunk).includes('echo: hello from the renderer'))).toBe(true)

    const stopped = await main.invoke(`${runtimeIpcPrefix}stop`, { runId: run.id })
    expect((ok(stopped) as { run: { state: string } }).run.state).toBe('done')
    desktop.close()
  })

  it('recovers unfinished runs on the next start, as the Electron entry would', async () => {
    const repoRoot = gitRepository('desktop-restart')
    const ledgerFile = join(tempDirectory('desktop-ledger'), 'hive.db')
    const first = startDesktopHost({ repoRoot, ledgerFile, hostEnv: {} })
    const main = new IpcMainRecorder()
    first.registerIpc(main)
    const launched = await main.invoke(`${runtimeIpcPrefix}launch`, { profileId: fakeProfileId, workspace: 'main', project: 'hive' })
    expect(launched.ok).toBe(true)
    first.close()

    const second = startDesktopHost({ repoRoot, ledgerFile, hostEnv: {} })
    const secondMain = new IpcMainRecorder()
    second.registerIpc(secondMain)
    await second.recover()

    const rows = ok(await secondMain.invoke(`${runtimeIpcPrefix}runs`)) as { state: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('zombie')
    second.close()
  })
})

describe('preload bridge', () => {
  it('refuses a channel outside the allowlist', async () => {
    const ipc = new IpcRendererRecorder()
    const hive = createHiveWindow(ipc)

    // A renderer that guesses at a mutation path gets a refusal, not a forward.
    const result = await hive.runtime.invoke('shell-exec')
    expect(failure(result).code).toBe('UNKNOWN_CHANNEL')
    expect(ipc.invocations).toEqual([])
  })

  it('forwards an allowed operation and returns the envelope', async () => {
    const ipc = new IpcRendererRecorder()
    const hive = createHiveWindow(ipc)

    const result = await hive.runtime.invoke('profiles')
    expect(ipc.invocations).toEqual([{ channel: `${runtimeIpcPrefix}profiles`, args: [undefined] }])
    expect(result.ok).toBe(true)
  })

  it('round-trips a real launch through the recorder-backed main process', async () => {
    const repoRoot = gitRepository('desktop-preload-roundtrip')
    const desktop = startDesktopHost({ repoRoot, hostEnv: {} })
    const main = new IpcMainRecorder()
    desktop.registerIpc(main)

    const ipc = new IpcRendererRecorder()
    ipc.main = main
    main.renderer = ipc
    const hive = createHiveWindow(ipc)

    const launched = await hive.runtime.invoke('launch', { profileId: fakeProfileId, workspace: 'main', project: 'hive' })
    const run = ok(launched) as { id: string }

    const chunks: string[] = []
    hive.stream.onData((payload) => chunks.push(String((payload as { chunk: string }).chunk)))
    const attached = await hive.stream.attach(run.id)
    expect(attached.ok).toBe(true)
    // The stream control channel was forwarded with the run id and nothing else:
    // the destination is the main process's business, decided from the event.
    const attachInvocation = ipc.invocations.find((invocation) => invocation.channel === 'hive:runtime:stream:attach')
    expect(attachInvocation?.args[0]).toEqual({ runId: run.id })

    await hive.runtime.invoke('write', { runId: run.id, data: 'hello from the preload\n' })
    expect(chunks.some((chunk) => chunk.includes('echo: hello from the preload'))).toBe(true)

    const stopped = await hive.runtime.invoke('stop', { runId: run.id })
    expect(stopped.ok).toBe(true)
    desktop.close()
  })

  it('exposes the operator actor with every capability the desktop needs', () => {
    const actor = desktopOperator()
    expect(actor.source).toBe('desktop')
    expect(actor.capabilities).toContain('runtime:control')
    expect(actor.capabilities).toContain('runtime:read')
    expect(actor.capabilities).toContain('context:read')
    expect(actor.capabilities).toContain('work:mutate')
    expect(actor.capabilities).toContain('work:dispatch')
  })

  it('serves the task board over the work channels, like a renderer', async () => {
    const repoRoot = gitRepository('desktop-work-board')
    const desktop = startDesktopHost({ repoRoot, hostEnv: {} })
    const main = new IpcMainRecorder()
    desktop.registerIpc(main)

    const created = ok(await main.invoke('hive:work:create', { title: 'Desktop task', description: 'from the renderer' })) as { id: string; status: string }
    expect(created.status).toBe('open')

    const listed = ok(await main.invoke('hive:work:items')) as { id: string }[]
    expect(listed.some((item) => item.id === created.id)).toBe(true)

    const claimed = ok(await main.invoke('hive:work:claim', { workItemId: created.id })) as { item: { status: string; assigneeActorId: string } }
    expect(claimed.item.status).toBe('assigned')
    expect(claimed.item.assigneeActorId).toBe(desktop.actor.actorId)

    const compiled = ok(await main.invoke('hive:work:context', { taskId: created.id })) as { packet: { task: { title: string } }; prompt: string }
    expect(compiled.packet.task.title).toBe('Desktop task')
    expect(compiled.prompt).toContain('[Hive context packet]')

    const missing = await main.invoke('hive:work:item', { workItemId: 'no-such-task' })
    expect(failure(missing).code).toBe('WORK_ITEM_NOT_FOUND')
    desktop.close()
  })
})

describe('runtime view model over the preload bridge', () => {
  /**
   * The renderer's own code path. The smoke test bypasses it by invoking the
   * bridge directly, which is how a doubled channel — the view model prefixing
   * an operation the preload prefixes again, giving
   * `hive:runtime:hive:runtime:runs` — reached the UI as UNKNOWN_CHANNEL. This
   * asserts the channels that actually reach the main process.
   */
  it('reads through bare operation names, never a doubled channel', async () => {
    const repoRoot = gitRepository('desktop-view-model')
    const desktop = startDesktopHost({ repoRoot, hostEnv: {} })
    const main = new IpcMainRecorder()
    desktop.registerIpc(main)
    const ipc = new IpcRendererRecorder()
    ipc.main = main
    main.renderer = ipc
    const hive = createHiveWindow(ipc)

    const view = new RuntimeViewModel({ bridge: hive.runtime })
    await view.refresh()

    expect(ipc.invocations.map((invocation) => invocation.channel)).toEqual([
      `${runtimeIpcPrefix}profiles`,
      `${runtimeIpcPrefix}runs`,
    ])
    const state = view.state()
    expect(state.error).toBeUndefined()
    expect(state.profiles.some((profile) => profile.id === fakeProfileId)).toBe(true)
    view.dispose()
    desktop.close()
  })
})

describe('Phase 8 control plane over the desktop', () => {
  const definition = {
    id: 'pr-review', version: '1.0.0', name: 'PR review', description: 'review', enabled: true,
    steps: [{ id: 'review', type: 'create_work', title: 'Review the change' }],
  }

  /**
   * §7 Phase 8's exit gate asks for CLI/MCP/desktop state to be consistent. This
   * drives the desktop's own channels and then reads the same ledger through a
   * separate service — which is what the CLI is — so the two cannot be two truths.
   */
  it('serves workflows, runs, triggers, schedules, skills, metrics, and policy', async () => {
    const repoRoot = gitRepository('desktop-control')
    const desktop = startDesktopHost({ repoRoot, hostEnv: {}, triggers: { admission: { allowedKinds: ['manual'] } } })
    const main = new IpcMainRecorder()
    desktop.registerIpc(main)

    expect((ok(await main.invoke('hive:control:register', { definition })) as { id: string }).id).toBe('pr-review')
    const admitted = ok(await main.invoke('hive:control:trigger', { id: 'manual:1', workflowId: 'pr-review' })) as { duplicate: boolean; run: { state: string } }
    expect(admitted.duplicate).toBe(false)
    expect(admitted.run.state).toBe('completed')

    expect(ok(await main.invoke('hive:control:workflows')) as unknown[]).toHaveLength(1)
    expect(ok(await main.invoke('hive:control:runs')) as unknown[]).toHaveLength(1)
    expect(ok(await main.invoke('hive:control:triggers')) as unknown[]).toHaveLength(1)
    expect(ok(await main.invoke('hive:control:schedules')) as unknown[]).toEqual([])
    expect(ok(await main.invoke('hive:control:skills')) as unknown[]).toEqual([])
    expect(ok(await main.invoke('hive:control:metrics')) as unknown[]).toEqual([])
    expect(ok(await main.invoke('hive:control:admission'))).toMatchObject({ policy: { allowedKinds: ['manual'] } })

    // The gate the CLI enforces is the one the desktop enforces: a GitHub-kind
    // trigger is refused here for the same reason it would be there.
    const refused = await main.invoke('hive:control:trigger', { id: 'github:1', workflowId: 'pr-review', kind: 'github' })
    expect(failure(refused).code).toBe('TRIGGER_REFUSED')
    expect(ok(await main.invoke('hive:control:runs')) as unknown[]).toHaveLength(1)
    desktop.close()
  })

  it('carries an operator pause from the desktop to the CLI, and back', async () => {
    const repoRoot = gitRepository('desktop-control-pause')
    const ledgerFile = join(tempDirectory('desktop-control-pause-ledger'), 'hive.db')
    const desktop = startDesktopHost({ repoRoot, ledgerFile, hostEnv: {} })
    const main = new IpcMainRecorder()
    desktop.registerIpc(main)

    await main.invoke('hive:control:register', { definition })
    expect(ok(await main.invoke('hive:control:pause'))).toMatchObject({ policy: { paused: true } })

    // Read the same ledger the way the CLI does: a separate service over the file.
    const cliLedger = new Ledger(ledgerFile)
    const cli = new WorkflowService({ ledger: cliLedger, board: new WorkBoard(cliLedger) })
    expect(cli.admissionPolicy().paused).toBe(true)
    expect(() => cli.trigger(desktop.actor, desktop.workScope, { id: 'cli-after-pause', kind: 'manual', workflowId: 'pr-review' }))
      .toThrowError(/paused/)

    // And the reverse: a resume over the CLI's own path reopens the desktop.
    cli.setPaused(desktop.actor, desktop.workScope, false)
    expect((ok(await main.invoke('hive:control:admission')) as { policy: { paused?: boolean } }).policy.paused).toBe(false)
    expect((ok(await main.invoke('hive:control:trigger', { id: 'desktop-after-resume', workflowId: 'pr-review' })) as { duplicate: boolean }).duplicate).toBe(false)

    cliLedger.close()
    desktop.close()
  })

  it('serves watches, queues, voice, and version over the control channels', async () => {
    const repoRoot = gitRepository('desktop-control-extended')
    const desktop = startDesktopHost({ repoRoot, hostEnv: {} })
    const main = new IpcMainRecorder()
    desktop.registerIpc(main)

    expect(ok(await main.invoke('hive:control:register', { definition }))).toMatchObject({ id: 'pr-review' })
    expect(ok(await main.invoke('hive:control:watch', { id: 'context-watch', workflowId: 'pr-review', uriPrefix: 'viking://workspace/main/project/hive/memory/' }))).toMatchObject({ id: 'context-watch' })
    expect(ok(await main.invoke('hive:control:watches')) as unknown[]).toHaveLength(1)
    expect(ok(await main.invoke('hive:control:queues')) as unknown[]).toContainEqual(expect.objectContaining({ queue: 'supervisor' }))
    expect((ok(await main.invoke('hive:control:version')) as { version: string }).version).toMatch(/^\d+\.\d+\.\d+$/)

    // The voice operator is assembled by the host itself, and answers through the
    // same capability checks every other channel applies.
    const vocabulary = ok(await main.invoke('hive:control:voice', {})) as { vocabulary: unknown[] }
    expect(vocabulary.vocabulary.length).toBeGreaterThan(0)
    const turn = ok(await main.invoke('hive:control:voice', { utterance: 'status' })) as { outcome: { kind: string } }
    expect(turn.outcome.kind).toBe('answered')
    const refused = ok(await main.invoke('hive:control:voice', { utterance: 'make me a sandwich' })) as { outcome: { kind: string; reason?: string } }
    expect(refused.outcome).toMatchObject({ kind: 'refused', reason: 'unrecognized' })
    desktop.close()
  })
})

describe('channel-name drift guard', () => {
  // The browser-safe name lists in runtime-channels.ts duplicate the typed lists
  // the services own. This is the test that keeps them equal: if a new operation
  // is added to a service, the preload allowlist must learn it in the same change.
  it('matches the runtime and context service operation lists', async () => {
    const { runtimeBrowseOperations } = await import('../../src/runtime/runtime-browser.js')
    const { runtimeControlOperations } = await import('../../src/runtime/runtime-controller.js')
    const { contextBrowseOperations } = await import('../../src/context/browser.js')
    const { runtimeBrowseOperationNames, runtimeControlOperationNames, contextBrowseOperationNames } = await import('../../src/interfaces/desktop/runtime-channels.js')

    expect([...runtimeBrowseOperationNames].sort()).toEqual([...runtimeBrowseOperations].sort())
    expect([...runtimeControlOperationNames].sort()).toEqual([...runtimeControlOperations].sort())
    expect([...contextBrowseOperationNames].sort()).toEqual([...contextBrowseOperations].sort())
  })
})
