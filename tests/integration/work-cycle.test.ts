import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { Capability } from '../../src/contracts.js'
import { resetFakeSessions } from '../../src/runtime/fake-backend.js'
import { fakeProfileId } from '../../src/runtime/provider-catalog.js'
import { ContextFilesystem } from '../../src/context/context-filesystem.js'
import { HandoffService } from '../../src/work/handoffs.js'
import { MailService } from '../../src/work/mail.js'
import { PacketCompiler } from '../../src/work/packet.js'
import { WorkBoard } from '../../src/work/board.js'
import { runtimeHarness, testAgent, testActor, tempDirectory } from '../fixtures.js'

/**
 * The Phase 4 exit gate: two fake agents receive one task, exchange a handoff
 * and a mail message, resume from a packet, and cannot claim the same work or
 * handoff concurrently. The runtime plane supplies the two agents' sessions;
 * the work plane supplies everything that coordinates them.
 */
const capabilities: Capability[] = ['workspace:read', 'work:mutate', 'work:dispatch', 'runtime:control', 'runtime:read', 'context:read', 'context:write']
const operator = testActor('operator', capabilities)
const agentA = testAgent('agent-a', capabilities)
const agentB = testAgent('agent-b', capabilities)

afterEach(() => resetFakeSessions())

describe('work cycle — the Phase 4 gate', () => {
  it('walks one task through two agents without a duplicate claim', async () => {
    const runtime = runtimeHarness([operator, agentA, agentB])
    const fs = new ContextFilesystem(tempDirectory('cycle-context'), runtime.ledger)
    const board = new WorkBoard(runtime.ledger, { now: runtime.clock.now })
    const mail = new MailService(runtime.ledger, { now: runtime.clock.now })
    const handoffs = new HandoffService(runtime.ledger, { now: runtime.clock.now })
    const packets = new PacketCompiler({ ledger: runtime.ledger, board, mail, handoffs, filesystem: fs }, { now: runtime.clock.now })

    // One task exists. Agent A claims it; agent B cannot.
    const task = board.create(operator, runtime.scope, { title: 'Ship the parser', description: 'Parse without crashing' })
    const claimA = board.claim(agentA, task.id)
    expect(claimA.item.assigneeActorId).toBe(agentA.actorId)
    expect(() => board.claim(agentB, task.id)).toThrowError(/is assigned to agent-a/)
    board.transition(agentA, task.id, 'in_progress')

    // Agent A works it: a run launched with the compiled packet as its prompt.
    const packetA = packets.compile(agentA, runtime.scope, { taskId: task.id, agentId: 'agent-a' })
    const runA = await runtime.manager.launch(agentA, {
      profileId: fakeProfileId, workspace: 'main', project: 'hive',
      workItemId: task.id, agentId: 'agent-a', prompt: packets.render(packetA),
    })
    expect(runA.state).toBe('running')
    expect(runtime.manager.scrollback(runA.id)).toContain('Ship the parser')

    // Agent A finishes its half and hands the rest to agent B — by handoff and by mail.
    const handoff = handoffs.create(agentA, runtime.scope, {
      toAgentId: 'agent-b', cwd: runA.cwd, summary: 'Parser core landed, errors remain',
      filesTouched: ['src/parser.ts'], nextSteps: ['finish error branches'],
    })
    mail.send(agentA, runtime.scope, { to: 'agent:agent-b', subject: 'Your turn on the parser', body: 'The AST is stable; error branches are stubs.', type: 'task' })

    // Agent B claims the mail; agent A cannot claim the same message.
    const messageForB = mail.claimNext(agentB, 'agent:agent-b')
    expect(messageForB?.subject).toBe('Your turn on the parser')
    expect(mail.claim(agentA, messageForB!)).toBeUndefined()

    // Agent B resumes from a packet: the compile claims A's handoff for B, deterministically.
    const packetB = packets.compile(agentB, runtime.scope, { taskId: task.id, agentId: 'agent-b', cwd: runA.cwd })
    expect(packetB.handoff?.summary).toBe('Parser core landed, errors remain')
    expect(packetB.mail).toHaveLength(1)
    expect(handoffs.handoff(operator, handoff.id).state).toBe('accepted')
    // The handoff was claimed at compile: not open, so nobody can accept it again.
    expect(() => handoffs.accept(agentA, handoff.id, { cwd: runA.cwd })).toThrowError(/is accepted/)

    // Agent B acknowledges the mail and takes over with its own run from the packet.
    const acked = mail.ack(agentB, messageForB!.id)
    expect(acked.state).toBe('acked')
    const runB = await runtime.manager.launch(agentB, {
      profileId: fakeProfileId, workspace: 'main', project: 'hive',
      workItemId: task.id, agentId: 'agent-b', prompt: packets.render(packetB),
    })
    expect(runB.state).toBe('running')
    // The packet, and therefore the handoff, is in the receiving session.
    const scrollbackB = runtime.manager.scrollback(runB.id)
    expect(scrollbackB).toContain('Parser core landed, errors remain')

    // One task, one lease: A's claim still holds it, and B's work continued under the same item.
    expect(runtime.ledger.activeLease('task', task.id)?.ownerActorId).toBe(agentA.actorId)
    expect(runtime.ledger.listRuns(runtime.scope).map((run) => run.workItemId)).toEqual([task.id, task.id])

    // The cycle is on the record: mail, handoff, packets, and the task itself.
    const keys = runtime.ledger.readEvents(0, 200).map((event) => event.idempotencyKey)
    expect(keys.some((key) => key.startsWith('mail:sent:'))).toBe(true)
    expect(keys.some((key) => key.startsWith('mail:claimed:'))).toBe(true)
    expect(keys.some((key) => key.startsWith('mail:acked:'))).toBe(true)
    expect(keys.some((key) => key.startsWith('work:handoff-created:'))).toBe(true)
    expect(keys.some((key) => key.startsWith('work:handoff-accepted:'))).toBe(true)
    expect(keys.filter((key) => key.startsWith('work:packet:')).length).toBeGreaterThanOrEqual(2)

    await runtime.manager.stop(agentA, { runId: runA.id })
    await runtime.manager.stop(agentB, { runId: runB.id })
    runtime.close()
  })
})
