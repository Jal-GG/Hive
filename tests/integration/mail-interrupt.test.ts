import { afterEach, describe, expect, it } from 'vitest'
import { Capability } from '../../src/contracts.js'
import { resetFakeSessions } from '../../src/runtime/fake-backend.js'
import { fakeProfileId } from '../../src/runtime/provider-catalog.js'
import { MailService } from '../../src/work/mail.js'
import { runManagerMailInterrupt } from '../../src/work/mail-interrupts.js'
import { runtimeHarness, testAgent, testActor } from '../fixtures.js'

/**
 * Interrupt mail over the real runtime plane: an addressed agent's live session
 * receives the message as terminal input, and the fallback is the queue when no
 * session is live.
 */
const capabilities: Capability[] = ['workspace:read', 'work:mutate', 'work:dispatch', 'runtime:control', 'runtime:read']
const operator = testActor('operator', capabilities)
const agentA = testAgent('agent-a', capabilities)
const agentB = testAgent('agent-b', capabilities)

afterEach(() => resetFakeSessions())

describe('interrupt mail into live sessions', () => {
  it('writes the message into the recipient agent’s live session', async () => {
    const runtime = runtimeHarness([operator, agentA, agentB])
    const mail = new MailService(runtime.ledger, { now: runtime.clock.now, interrupt: runManagerMailInterrupt(runtime.manager, operator) })

    const run = await runtime.manager.launch(agentB, {
      profileId: fakeProfileId, workspace: 'main', project: 'hive', agentId: 'agent-b',
    })
    expect(run.agentId).toBe('agent-b')

    const message = mail.send(agentA, runtime.scope, { to: 'agent:agent-b', subject: 'Pivot', body: 'use the other approach', delivery: 'interrupt' })
    expect(message.state).toBe('delivered')
    expect(message.claimedBy).toBe(agentB.actorId)

    const scrollback = runtime.manager.scrollback(run.id)
    expect(scrollback).toContain('[hive mail from actor:agent-a] Pivot')
    expect(scrollback).toContain('use the other approach')

    // The recipient closes the loop with an acknowledgement, straight from delivered.
    expect(mail.ack(agentB, message.id).state).toBe('acked')
    await runtime.manager.stop(agentB, { runId: run.id })
    runtime.close()
  })

  it('falls back to the queue when the agent has no live session', () => {
    const runtime = runtimeHarness([operator, agentA, agentB])
    const mail = new MailService(runtime.ledger, { now: runtime.clock.now, interrupt: runManagerMailInterrupt(runtime.manager, operator) })

    const message = mail.send(agentA, runtime.scope, { to: 'agent:agent-b', subject: 'Are you there', body: 'hello', delivery: 'interrupt' })
    expect(message.state).toBe('pending')
    expect(message.queue).toBe('agent:agent-b')
    runtime.close()
  })

  it('does not deliver to a run that belongs to a different agent', async () => {
    const runtime = runtimeHarness([operator, agentA, agentB])
    const mail = new MailService(runtime.ledger, { now: runtime.clock.now, interrupt: runManagerMailInterrupt(runtime.manager, operator) })

    await runtime.manager.launch(agentA, {
      profileId: fakeProfileId, workspace: 'main', project: 'hive', agentId: 'agent-a',
    })
    const message = mail.send(agentA, runtime.scope, { to: 'agent:agent-b', subject: 'Wrong session', body: 'nope', delivery: 'interrupt' })
    expect(message.state).toBe('pending')
    runtime.close()
  })
})
