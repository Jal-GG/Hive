import { afterEach, describe, expect, it } from 'vitest'
import { Capability } from '../../src/contracts.js'
import { resetFakeSessions } from '../../src/runtime/fake-backend.js'
import { fakeProfileId } from '../../src/runtime/provider-catalog.js'
import { agentActor } from '../../src/dispatch/dispatcher.js'
import { weeklyDigest } from '../../src/dispatch/digest.js'
import { Scheduler } from '../../src/dispatch/scheduler.js'
import { runDispatchCli } from '../../src/interfaces/cli/dispatch-cli.js'
import { dispatchHarness, testActor } from '../fixtures.js'

/**
 * The Phase 5 exit gate: a trigger creates a task and routes to an agent, the
 * agent's POLECAT_DONE report completes the loop, idle agents escalate exactly
 * once, a restart recovers without duplicating work, and the scheduled digest
 * sees the fleet as it is.
 */
const capabilities: Capability[] = ['workspace:read', 'work:mutate', 'work:dispatch', 'runtime:control', 'runtime:read', 'context:read']
const operator = testActor('operator', capabilities)

afterEach(() => resetFakeSessions())

describe('dispatch — the Phase 5 gate', () => {
  it('routes a trigger to the best-rested agent, launches, and dedupes the trigger', async () => {
    const harness = dispatchHarness([operator])
    harness.dispatcher.registerAgent(operator, { agentId: 'tired', profileId: fakeProfileId, energy: 3 })
    harness.dispatcher.registerAgent(operator, { agentId: 'rested', profileId: fakeProfileId, energy: 9 })

    const first = await harness.dispatcher.intake(operator, harness.scope, { title: 'Triggered task', sourceTriggerId: 'trigger-1' })
    expect(first.duplicate).toBe(false)
    expect(first.outcome?.agent?.id).toBe('rested')
    expect(first.outcome?.runId).toBeDefined()
    // The routed agent is the one working: claimed, in progress, and running.
    expect(harness.board.item(operator, first.item.id).status).toBe('in_progress')
    expect(harness.board.item(operator, first.item.id).assigneeActorId).toBe('rested')
    expect(harness.manager.liveRunIds()).toHaveLength(1)
    expect(harness.manager.get(harness.manager.liveRunIds()[0])?.agentId).toBe('rested')
    // The packet reached the session: the task title is in its scrollback.
    expect(harness.manager.scrollback(harness.manager.liveRunIds()[0])).toContain('Triggered task')
    // Energy was spent by the dispatch.
    expect(harness.dispatcher.agents(operator).find((agent) => agent.id === 'rested')?.energy).toBe(8)

    // The same trigger again is a duplicate: one item, one dispatch, ever.
    const second = await harness.dispatcher.intake(operator, harness.scope, { title: 'Triggered task', sourceTriggerId: 'trigger-1' })
    expect(second.duplicate).toBe(true)
    expect(second.item.id).toBe(first.item.id)
    expect(harness.manager.liveRunIds()).toHaveLength(1)
    harness.close()
  })

  it('routes by worker, then by skills, and refuses what no agent can do', async () => {
    const harness = dispatchHarness([operator])
    harness.dispatcher.registerAgent(operator, { agentId: 'generalist', profileId: fakeProfileId, energy: 5 })
    harness.dispatcher.registerAgent(operator, { agentId: 'specialist', profileId: fakeProfileId, energy: 1, skills: ['parser'] })

    // Skill routing: a task that names skills goes to the agent that has them,
    // even when the other agent has more energy.
    const skilled = await harness.dispatcher.intake(operator, harness.scope, { title: 'Parse the grammar', requiredSkills: ['parser'], sourceTriggerId: 't-skill' })
    expect(skilled.outcome?.agent?.id).toBe('specialist')

    // A task nobody is qualified for is refused, with the count of candidates.
    const impossible = await harness.dispatcher.intake(operator, harness.scope, { title: 'Do the impossible', requiredSkills: ['telepathy'], sourceTriggerId: 't-none' })
    expect(impossible.outcome?.rejection).toMatchObject({ reason: 'no_eligible_agent', candidates: 2 })
    expect(impossible.item.status).toBe('open')
    harness.close()
  })

  it('spends energy to exhaustion, and the rest tick restores it', async () => {
    const harness = dispatchHarness([operator])
    harness.dispatcher.registerAgent(operator, { agentId: 'solo', profileId: fakeProfileId, energy: 2, maxEnergy: 2 })

    const first = await harness.dispatcher.dispatch(operator, harness.scope, taskOf(harness, 'one'))
    expect(first.agent?.id).toBe('solo')
    expect(harness.dispatcher.agents(operator)[0].energy).toBe(1)

    // Energy counts the run in flight: one unit stored, zero effective, so a
    // second concurrent task is refused rather than overdrafting the agent.
    const concurrent = await harness.dispatcher.dispatch(operator, harness.scope, taskOf(harness, 'two'))
    expect(concurrent.rejection).toMatchObject({ reason: 'energy_exhausted', agentId: 'solo' })

    // The first task finishing releases the load; the next dispatch spends the stored unit.
    await harness.manager.stop(operator, { runId: first.runId! })
    const second = await harness.dispatcher.dispatch(operator, harness.scope, taskOf(harness, 'two'))
    expect(second.runId).toBeDefined()
    expect(harness.dispatcher.agents(operator)[0].energy).toBe(0)

    // An empty tank refuses the next dispatch rather than overdrafting.
    await harness.manager.stop(operator, { runId: second.runId! })
    const third = await harness.dispatcher.dispatch(operator, harness.scope, taskOf(harness, 'three'))
    expect(third.rejection).toMatchObject({ reason: 'energy_exhausted', agentId: 'solo' })

    // The rest tick restores one unit; the previously refused task now dispatches.
    expect(harness.dispatcher.rest(operator)).toBe(1)
    expect(harness.dispatcher.agents(operator)[0].energy).toBe(1)
    const retried = await harness.dispatcher.dispatch(operator, harness.scope, taskOf(harness, 'four'))
    expect(retried.agent?.id).toBe('solo')
    harness.close()
  })

  it('turns a POLECAT_DONE report into a review transition, once', async () => {
    const harness = dispatchHarness([operator])
    harness.dispatcher.registerAgent(operator, { agentId: 'reporter', profileId: fakeProfileId })
    const dispatched = await harness.dispatcher.intake(operator, harness.scope, { title: 'Reported work', sourceTriggerId: 't-report' })
    const taskId = dispatched.item.id

    // The agent itself reports done: POLECAT_DONE lands in the supervisor's
    // queue from the agent's own address, which is how the report is attributed.
    const agent = harness.dispatcher.agents(operator).find((candidate) => candidate.id === 'reporter')!
    harness.mail.send(agentActor(agent), harness.scope, { queue: 'supervisor', subject: 'POLECAT_DONE', body: 'finished', type: 'protocol' })
    const report = harness.mail.inbox(operator, { queue: 'supervisor', states: ['pending'] })[0]
    expect(report?.from).toBe('actor:reporter')

    const pass = harness.supervisor.supervise(operator)
    expect(pass.completions).toBe(1)
    expect(harness.board.item(operator, taskId).status).toBe('review')
    // The mail loop closed with the acknowledgement.
    expect(harness.mail.inbox(operator, { queue: 'supervisor', states: ['acked'] })).toHaveLength(1)

    // A second pass is idempotent: the acked report is not processed again.
    const again = harness.supervisor.supervise(operator)
    expect(again.completions).toBe(0)
    expect(harness.board.item(operator, taskId).status).toBe('review')
    harness.close()
  })

  it('escalates a silent agent exactly once, with mail attached', async () => {
    const harness = dispatchHarness([operator])
    harness.dispatcher.registerAgent(operator, { agentId: 'silent', profileId: fakeProfileId })
    const dispatched = await harness.dispatcher.intake(operator, harness.scope, { title: 'Quiet work', sourceTriggerId: 't-quiet' })
    const runId = dispatched.outcome!.runId!

    // The fake profile idles after 5s: stall at 10s, escalate at 15s.
    harness.clock.advance(15_000)
    const pass = harness.supervisor.supervise(operator)
    expect(pass.escalated).toBe(1)
    expect(harness.manager.get(runId)?.state).toBe('escalated')
    const escalation = harness.mail.inbox(operator, { queue: 'supervisor' }).find((message) => message.subject === 'RECOVERY_NEEDED')
    expect(escalation).toBeDefined()
    expect(escalation?.body).toContain(runId)

    // Another pass, another silent minute: still exactly one escalation.
    harness.clock.advance(60_000)
    const second = harness.supervisor.supervise(operator)
    expect(second.escalated).toBe(0)
    expect(harness.mail.inbox(operator, { queue: 'supervisor' }).filter((message) => message.subject === 'RECOVERY_NEEDED')).toHaveLength(1)
    harness.close()
  })

  it('recovers after a restart without duplicating work or notifications', async () => {
    const harness = dispatchHarness([operator])
    harness.dispatcher.registerAgent(operator, { agentId: 'crashy', profileId: fakeProfileId })
    const dispatched = await harness.dispatcher.intake(operator, harness.scope, { title: 'Survives restarts', sourceTriggerId: 't-crash' })
    const taskId = dispatched.item!.id
    const runId = dispatched.outcome!.runId!
    const ledgerFile = harness.ledgerFile
    const repoRoot = harness.repoRoot

    // A crash, not a shutdown: the manager and ledger vanish, the persistent
    // session lives on exactly like a tmux server would.
    harness.close()

    // A restart: fresh runtime, dispatcher, and supervisor over the same ledger.
    const second = dispatchHarness([operator], { repoRoot, ledgerFile })
    const report = await second.supervisor.recover(operator)
    // The session was re-adopted, not duplicated.
    expect(report.inspected).toBe(1)
    expect(second.manager.liveRunIds()).toEqual([runId])

    // Recovery never dispatches: re-dispatching the in-flight task is refused,
    // and the fleet still holds exactly one run for it.
    const retry = await second.dispatcher.dispatch(operator, second.scope, taskId)
    expect(retry.rejection).toBeDefined()
    expect(second.manager.liveRunIds()).toEqual([runId])
    expect(second.ledger.listRuns().filter((run) => run.workItemId === taskId)).toHaveLength(1)

    // Now the agent exits with its work unfinished: the supervisor reacts once.
    await second.manager.stop(operator, { runId })
    const reacting = second.supervisor.supervise(operator)
    const notifications = second.mail.inbox(operator, { queue: 'supervisor' }).filter((message) => message.body.includes('Survives restarts'))
    expect(notifications).toHaveLength(1)
    void reacting

    // A second pass does not re-notify: the cursor already saw the exit.
    second.supervisor.supervise(operator)
    expect(second.mail.inbox(operator, { queue: 'supervisor' }).filter((message) => message.body.includes('Survives restarts'))).toHaveLength(1)
    second.close()
  })

  it('runs the scheduler on unref timers, and the digest counts the fleet', async () => {
    const harness = dispatchHarness([operator])
    harness.dispatcher.registerAgent(operator, { agentId: 'digger', profileId: fakeProfileId })
    await harness.dispatcher.intake(operator, harness.scope, { title: 'Digest fodder', sourceTriggerId: 't-digest' })

    let ticks = 0
    const scheduler = new Scheduler()
    scheduler.schedule({ name: 'fast-tick', intervalMs: 5, run: () => { ticks += 1 } })
    await new Promise((resolve) => setTimeout(resolve, 40))
    scheduler.stop()
    expect(ticks).toBeGreaterThan(0)
    expect(scheduler.names()).toEqual(['fast-tick'])

    const digest = weeklyDigest({ ledger: harness.ledger, mail: harness.mail })(operator, harness.scope)
    expect(digest.liveRuns).toBe(1)
    expect(digest.inFlightTasks).toBe(1)
    expect(harness.mail.inbox(operator, { queue: 'supervisor' }).some((message) => message.subject === 'Weekly status digest')).toBe(true)
    harness.close()
  })

  it('serves the fleet through the dispatch CLI', async () => {
    const harness = dispatchHarness([operator])
    const surfaces = { ledger: harness.ledger, dispatcher: harness.dispatcher, supervisor: harness.supervisor, mail: harness.mail }

    const registered = JSON.parse(await runDispatchCli(surfaces, operator, ['register', '--agent', 'cli-agent', '--profile', fakeProfileId, '--skill', 'cli'])) as { id: string; skills: string[] }
    expect(registered.id).toBe('cli-agent')
    expect(registered.skills).toEqual(['cli'])

    const listed = JSON.parse(await runDispatchCli(surfaces, operator, ['agents'])) as { id: string }[]
    expect(listed.map((agent) => agent.id)).toContain('cli-agent')

    const outcome = JSON.parse(await runDispatchCli(surfaces, operator, ['intake', '--title', 'CLI dispatch', '--trigger', 't-cli'])) as { item: { id: string }; outcome: { runId: string } }
    expect(outcome.outcome.runId).toBeDefined()
    expect(harness.manager.get(outcome.outcome.runId)?.agentId).toBe('cli-agent')

    const supervised = JSON.parse(await runDispatchCli(surfaces, operator, ['supervise'])) as { inspected: number; cursor: number }
    expect(supervised.inspected).toBe(1)
    expect(supervised.cursor).toBeGreaterThan(0)

    await expect(runDispatchCli(surfaces, operator, ['explode'])).rejects.toThrowError(/Unknown dispatch operation/)
    harness.close()
  })
})

function taskOf(harness: ReturnType<typeof dispatchHarness>, title: string): string {
  return harness.board.create(operator, harness.scope, { title }).id
}
