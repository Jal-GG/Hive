import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { runWorkflowCli } from '../../src/interfaces/cli/workflow-cli.js'
import { controlIpcHandlers } from '../../src/interfaces/desktop/control-ipc.js'
import { ControlHttpServer } from '../../src/interfaces/http/control-http-server.js'
import { ContextBrowser } from '../../src/context/browser.js'
import { GitHubEventAdapter, ObservabilityService, SignedWebhookAdapter } from '../../src/observability.js'
import { Searcher } from '../../src/search/searcher.js'
import { HiveSdk } from '../../src/sdk.js'
import { LedgerWatchSource } from '../../src/watch-source.js'
import { VoiceOperator } from '../../src/voice.js'
import { WorkflowService } from '../../src/workflow.js'
import { assembleRelease, checkUpdate } from '../../src/release.js'
import { testActor, workHarness } from '../fixtures.js'
import type { Capability, WorkflowDefinition } from '../../src/contracts.js'

const capabilities: Capability[] = ['workspace:read', 'work:mutate', 'work:dispatch', 'context:read', 'context:write', 'runtime:read']

function definition(): Omit<WorkflowDefinition, 'createdBy' | 'createdAt' | 'updatedAt'> {
  return {
    id: 'watch-flow', version: '1.0.0', name: 'Watch flow', description: 'Creates work from observed change', enabled: true,
    steps: [{ id: 'react', type: 'create_work', title: 'React to the change' }],
  }
}

/** A watch-capable plane: workflow service wired to a context filesystem over one ledger. */
function watchHarness(actor: ReturnType<typeof testActor>) {
  const harness = workHarness([actor])
  const watchSource = new LedgerWatchSource(harness.ledger)
  const workflows = new WorkflowService({ ledger: harness.ledger, board: harness.board, now: harness.clock.now, watchSource })
  return { ...harness, workflows, watchSource }
}

describe('Phase 8 completion: watches, diagnostics, voice, dashboard, SDK, packaging', () => {
  it('watches a context URI prefix: baselines first, fires only on change, and deduplicates the same content', () => {
    const actor = testActor('operator', capabilities)
    const harness = watchHarness(actor)
    harness.workflows.register(actor, definition())
    harness.fs.write(actor, harness.scope, { path: 'memory/watched.md', body: 'first body' })

    harness.workflows.watch(actor, { id: 'memory-watch', workflowId: 'watch-flow', uriPrefix: `viking://workspace/main/project/hive/memory/`, state: 'enabled', nextRunAt: '2026-01-01T00:00:00.000Z', scope: harness.scope })

    // First tick is the baseline: existing content is learned, not fired on.
    expect(harness.workflows.tick(actor, new Date('2026-01-01T00:00:01.000Z'))).toBe(0)
    expect(harness.board.list(actor, harness.scope)).toHaveLength(0)

    // A canonical rewrite moves the fingerprint (new sha and version); the next
    // due tick fires once. Raw external edits are a reconciliation concern and
    // reconcile into the same index before the next pass observes them.
    harness.fs.write(actor, harness.scope, { path: 'memory/watched.md', body: 'second body' })
    expect(harness.workflows.tick(actor, new Date('2026-01-01T00:01:01.000Z'))).toBe(1)
    // Same content again: no second run, the observation just advances.
    expect(harness.workflows.tick(actor, new Date('2026-01-01T00:02:01.000Z'))).toBe(0)
    expect(harness.board.list(actor, harness.scope)).toHaveLength(1)
    const kinds = harness.ledger.listTriggers(harness.scope).map((trigger) => trigger.kind)
    expect(kinds).toContain('watch')
    harness.close()
  })

  it('serves watches through the CLI: register, list, disable, remove', async () => {
    const actor = testActor('operator', capabilities)
    const harness = watchHarness(actor)
    harness.workflows.register(actor, definition())
    const cli = (argv: string[]) => runWorkflowCli({ ledger: harness.ledger, workflows: harness.workflows }, actor, argv)
    await cli(['watch', '--id', 'cli-watch', '--workflow', 'watch-flow', '--uri-prefix', 'viking://workspace/main/project/hive/', '--next-run-at', '2026-01-01T00:00:00.000Z'])
    const listed = JSON.parse(await cli(['watches'])) as Array<{ id: string; state: string }>
    expect(listed).toHaveLength(1)
    expect(listed[0].id).toBe('cli-watch')
    await cli(['watch-state', '--id', 'cli-watch', '--state', 'disabled'])
    expect(JSON.parse(await cli(['watches']))[0].state).toBe('disabled')
    expect(JSON.parse(await cli(['watch-remove', '--id', 'cli-watch'])).removed).toBe(true)
    expect(JSON.parse(await cli(['watches']))).toHaveLength(0)
    harness.close()
  })

  it('reports queue diagnostics from ledger state and mirrors depth into opt-in metrics', () => {
    const actor = testActor('operator', capabilities)
    const harness = workHarness([actor])
    const observability = new ObservabilityService({ ledger: harness.ledger, enabled: true, now: harness.clock.now })
    const queues = observability.queueDiagnostics(actor, harness.scope)
    const names = queues.map((queue) => queue.queue)
    expect(names).toContain('supervisor')
    expect(queues.find((queue) => queue.queue === 'supervisor')?.depth).toBe(0)

    // A pending mail message lands in its queue and the next read sees it.
    harness.mail.send(actor, harness.scope, { queue: 'supervisor', subject: 'POLECAT_DONE', body: 'run finished', type: 'protocol', priority: 'normal', delivery: 'queue' })
    const after = observability.queueDiagnostics(actor, harness.scope)
    expect(after.find((queue) => queue.queue === 'supervisor')?.depth).toBe(1)
    const metrics = observability.metrics(actor, harness.scope, 'queue')
    expect(metrics.some((metric) => metric.labels.queue === 'supervisor' && metric.value === 1)).toBe(true)
    harness.close()
  })

  it('exports an OTLP-shaped snapshot with one gauge per series', () => {
    const actor = testActor('operator', capabilities)
    const harness = workHarness([actor])
    const observability = new ObservabilityService({ ledger: harness.ledger, enabled: true, now: harness.clock.now })
    observability.providerHealth(actor, harness.scope, 'fake', true)
    observability.usage(actor, harness.scope, 'fake', 10, 5, 0.02)
    const snapshot = observability.otlpSnapshot(actor, harness.scope)
    expect(snapshot.resourceMetrics.scope.name).toBe('hive')
    const names = snapshot.resourceMetrics.metrics.map((metric) => metric.name)
    expect(names).toContain('hive_provider_health_available')
    expect(names).toContain('hive_usage_cost')
    // Two writes to the same series collapse to the last value, not two gauges.
    // The clock advances first so "last" is a property of the data, not of id ties.
    harness.clock.advance(1000)
    observability.usage(actor, harness.scope, 'fake', 10, 5, 0.05)
    const second = observability.otlpSnapshot(actor, harness.scope)
    const costGauges = second.resourceMetrics.metrics.filter((metric) => metric.name === 'hive_usage_cost')
    expect(costGauges).toHaveLength(1)
    expect(costGauges[0].gauge.value).toBe(0.05)
    harness.close()
  })

  it('voice: reads answer from the real services, unknown phrases refuse, spend caps block actions', () => {
    const actor = testActor('operator', capabilities)
    const harness = watchHarness(actor)
    harness.workflows.register(actor, definition())
    harness.workflows.trigger(actor, harness.scope, { id: 'voice-seed:1', kind: 'manual', workflowId: 'watch-flow' })

    const observability = new ObservabilityService({ ledger: harness.ledger, enabled: true, now: harness.clock.now })
    observability.usage(actor, harness.scope, 'fake', 1, 1, 1.5)
    const voice = new VoiceOperator({
      ledger: harness.ledger, workflows: harness.workflows, observability, scope: harness.scope,
      spend: () => 1.5, spendCapUsd: 1.0,
    })

    const status = voice.turn(actor, 'status')
    expect(status.outcome.kind).toBe('answered')
    if (status.outcome.kind === 'answered') {
      const data = status.outcome.data as { runs: { total: number }; work: { open: number } }
      expect(data.work.open).toBeGreaterThanOrEqual(1)
    }

    // An action under a spent cap is refused; a read never is.
    const refused = voice.turn(actor, 'trigger workflow watch-flow')
    expect(refused.outcome.kind).toBe('refused')
    if (refused.outcome.kind === 'refused') expect(refused.outcome.reason).toBe('spend_exceeded')
    const readsStillWork = voice.turn(actor, 'show the runs')
    expect(readsStillWork.outcome.kind).toBe('answered')

    const gibberish = voice.turn(actor, 'make me a sandwich')
    expect(gibberish.outcome.kind).toBe('refused')
    if (gibberish.outcome.kind === 'refused') expect(gibberish.outcome.reason).toBe('unrecognized')

    // Without a cap the action goes through — to the same service the CLI uses.
    const uncapped = new VoiceOperator({ ledger: harness.ledger, workflows: harness.workflows, observability, scope: harness.scope })
    const paused = uncapped.turn(actor, 'pause')
    expect(paused.outcome.kind).toBe('answered')
    expect(harness.workflows.admissionState().policy.paused).toBe(true)
    harness.close()
  })

  it('voice is capability-checked like every other surface: a viewer cannot pause', () => {
    const actor = testActor('operator', capabilities)
    const harness = watchHarness(actor)
    const viewer = testActor('viewer', ['workspace:read', 'runtime:read'])
    harness.ledger.createActor(viewer)
    const observability = new ObservabilityService({ ledger: harness.ledger })
    const voice = new VoiceOperator({ ledger: harness.ledger, workflows: harness.workflows, observability, scope: harness.scope })
    const read = voice.turn(viewer, 'status')
    expect(read.outcome.kind).toBe('answered')
    const action = voice.turn(viewer, 'pause')
    expect(action.outcome.kind).toBe('refused')
    if (action.outcome.kind === 'refused') expect(action.outcome.detail).toMatch(/capability/i)
    harness.close()
  })

  it('dashboard: serves read-only HTML and a /status snapshot over loopback GET only', async () => {
    const actor = testActor('operator', capabilities)
    const harness = watchHarness(actor)
    const observability = new ObservabilityService({ ledger: harness.ledger, now: harness.clock.now })
    const server = new ControlHttpServer({
      browser: new ContextBrowser(harness.fs, harness.ledger),
      control: { ledger: harness.ledger, workflows: harness.workflows, observability, scope: harness.scope },
      actor,
    })
    const port = await server.listen(0)

    const page = await fetch(`http://127.0.0.1:${port}/`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('read-only dashboard')
    expect(html).not.toContain('<form')

    const status = await fetch(`http://127.0.0.1:${port}/status`)
    const body = (await status.json()) as { ok: boolean; data?: { scope: { workspace: string } } }
    expect(body.ok).toBe(true)
    expect(body.data?.scope.workspace).toBe('main')

    const post = await fetch(`http://127.0.0.1:${port}/status`, { method: 'POST' })
    expect(post.status).toBe(405)
    await server.close()
    harness.close()
  })

  it('SDK client: reads status and context through the same read-only HTTP surface', async () => {
    const actor = testActor('operator', capabilities)
    const harness = watchHarness(actor)
    harness.fs.write(actor, harness.scope, { path: 'page/sdk.md', body: 'sdk readable page' })
    const observability = new ObservabilityService({ ledger: harness.ledger })
    const server = new ControlHttpServer({
      browser: new ContextBrowser(harness.fs, harness.ledger),
      control: { ledger: harness.ledger, workflows: harness.workflows, observability, scope: harness.scope },
      actor,
    })
    const port = await server.listen(0)
    const sdk = new HiveSdk({ baseUrl: `http://127.0.0.1:${port}` })

    const status = await sdk.status()
    expect(status.scope.workspace).toBe('main')
    // `ls` answers with the entry array directly, the same envelope data every surface serves.
    const listed = await sdk.context<unknown[]>('ls', { workspace: 'main', project: 'hive', path: 'page' })
    expect(listed).toHaveLength(1)
    const grep = await sdk.context<unknown[]>('grep', { workspace: 'main', project: 'hive', pattern: 'sdk readable' })
    expect(grep.length).toBeGreaterThanOrEqual(1)
    await server.close()
    harness.close()
  })

  it('assembles a release directory from the built CLI, manifest included', () => {
    const outRoot = mkdtempSync(join(tmpdir(), 'hive-release-test-'))
    const packageRoot = mkdtempSync(join(tmpdir(), 'hive-release-pkg-'))
    // The minimum a package root needs: a versioned package.json and a built CLI.
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'hive-agent-harness', version: '0.1.0' }), 'utf8')
    mkdirSync(join(packageRoot, 'dist'), { recursive: true })
    writeFileSync(join(packageRoot, 'dist', 'cli.cjs'), '#!/usr/bin/env node\n// bundled cli\n', 'utf8')

    const assembled = assembleRelease({ packageRoot, outRoot, channel: 'stable' })
    expect(assembled.manifest.version).toBe('0.1.0')
    expect(assembled.manifest.channel).toBe('stable')
    const manifest = JSON.parse(readFileSync(join(assembled.directory, 'release-manifest.json'), 'utf8')) as { version: string }
    expect(manifest.version).toBe('0.1.0')
    expect(existsSync(join(assembled.directory, 'cli.cjs'))).toBe(true)
    expect(existsSync(join(assembled.directory, 'package.json'))).toBe(true)
    // No secrets, no node_modules: the assembly copies only what was built.
    const entries = readdirSync(assembled.directory)
    expect(entries.some((entry) => entry === 'node_modules')).toBe(false)

    // An update check against the assembled manifest is the wiring §7 asks for.
    expect(checkUpdate('0.1.0', assembled.manifest).updateAvailable).toBe(false)
    expect(checkUpdate('0.0.9', assembled.manifest).updateAvailable).toBe(true)
  })

  it('release assembly fails closed without a built CLI', () => {
    const outRoot = mkdtempSync(join(tmpdir(), 'hive-release-test-'))
    const packageRoot = mkdtempSync(join(tmpdir(), 'hive-release-pkg-'))
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'hive-agent-harness', version: '0.1.0' }), 'utf8')
    expect(() => assembleRelease({ packageRoot, outRoot })).toThrowError(/build:cli/)
  })

  it('records retrieval trajectories: every search leaves its query, hits, and duration', () => {
    const actor = testActor('operator', capabilities)
    const harness = watchHarness(actor)
    harness.fs.write(actor, harness.scope, { path: 'memory/trajectory.md', body: 'the trajectory observable target page' })
    const search = new Searcher({
      ledger: harness.ledger,
      trajectory: {
        record: (scope, query, tiers, hitCount, topHitUri, durationMs) => {
          harness.ledger.insertRetrievalTrajectory({ id: `traj:${query}`, scope, query, tiers, hitCount, topHitUri, durationMs, occurredAt: new Date().toISOString() })
        },
      },
    })
    // The FTS index only knows ingested chunks, so a trajectory of zero hits is
    // still a recorded decision — that is the observable part.
    search.search(actor, harness.scope, 'trajectory observable')
    const trajectories = harness.ledger.listRetrievalTrajectories(harness.scope)
    expect(trajectories).toHaveLength(1)
    expect(trajectories[0].query).toBe('trajectory observable')
    expect(trajectories[0].hitCount).toBe(0)
    harness.close()
  })

  it('exposes watches, queues, version, and voice through the desktop control channels', () => {
    const actor = testActor('operator', capabilities)
    const harness = watchHarness(actor)
    const observability = new ObservabilityService({ ledger: harness.ledger, enabled: true, now: harness.clock.now })
    const voice = new VoiceOperator({ ledger: harness.ledger, workflows: harness.workflows, observability, scope: harness.scope })
    const handlers = controlIpcHandlers({ scope: harness.scope, ledger: harness.ledger, workflows: harness.workflows, observability, voice }, actor)

    const envelopes = (operation: string, payload?: unknown) =>
      handlers.get(`hive:control:${operation}`)!(undefined, payload) as { ok: boolean; data?: unknown }

    expect(envelopes('queues').ok).toBe(true)
    expect(envelopes('version').ok).toBe(true)
    const voiceTurn = envelopes('voice', { utterance: 'status' })
    expect(voiceTurn.ok).toBe(true)
    const vocabulary = envelopes('voice', {})
    expect(vocabulary.ok).toBe(true)
    harness.close()
  })

  it('webhook ingress still verifies after the watch kind joined the trigger family', () => {
    const actor = testActor('operator', capabilities)
    const harness = watchHarness(actor)
    harness.workflows.register(actor, definition())
    const adapter = new SignedWebhookAdapter({ workflow: harness.workflows, secret: 'phase8b' })
    const body = JSON.stringify({ action: 'opened' })
    const signature = createHmac('sha256', 'phase8b').update(body, 'utf8').digest('hex')
    const github = new GitHubEventAdapter(adapter)
    const result = github.receive(actor, harness.scope, { id: 'gh:phase8b', workflowId: 'watch-flow', body, signature })
    expect(result.duplicate).toBe(false)
    harness.close()
  })
})
