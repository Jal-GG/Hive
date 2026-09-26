import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { Capability } from '../../src/contracts.js'
import { authorityNotice } from '../../src/work/packet.js'
import { workHarness, testActor, testAgent } from '../fixtures.js'

const capabilities: Capability[] = ['workspace:read', 'work:mutate', 'work:dispatch', 'context:read', 'context:write']
const operator = testActor('operator', capabilities)
const agentB = testAgent('agent-b', capabilities)
const viewer = testActor('viewer', ['workspace:read', 'context:read'])

describe('context packet compiler', () => {
  it('is deterministic: same store, same inputs, same packet and prompt', () => {
    const harness = workHarness([operator, agentB])
    const task = harness.board.create(operator, harness.scope, { title: 'Stable', description: 'Never changes' })
    const first = harness.packets.compile(operator, harness.scope, { taskId: task.id, agentId: 'agent-b' })
    const second = harness.packets.compile(operator, harness.scope, { taskId: task.id, agentId: 'agent-b' })
    expect(second).toEqual(first)
    expect(harness.packets.render(second)).toBe(harness.packets.render(first))
    harness.close()
  })

  it('renders the authority notice first and the sections in fixed order', () => {
    const harness = workHarness([operator, agentB])
    harness.fs.write(operator, harness.scope, { path: 'memory/decisions.md', body: 'Use SQLite.' })
    harness.fs.write(operator, harness.scope, { path: 'resource/schema.md', body: 'events table' })
    const task = harness.board.create(operator, harness.scope, { title: 'Ordered', description: 'Sections line up' })
    harness.handoffs.create(operator, harness.scope, { toAgentId: 'agent-b', cwd: resolve('work-root'), summary: 'Take it from here' })
    harness.mail.send(operator, harness.scope, { to: 'agent:agent-b', subject: 'Heads up', body: 'context incoming' })

    const packet = harness.packets.compile(operator, harness.scope, { taskId: task.id, agentId: 'agent-b', cwd: resolve('work-root'), skills: [{ id: 'skill-1', name: 'merge-queue' }] })
    const prompt = harness.packets.render(packet)
    const positions = [
      prompt.indexOf(authorityNotice),
      prompt.indexOf('## Task'),
      prompt.indexOf('## Handoff'),
      prompt.indexOf('## Memory'),
      prompt.indexOf('## Resources'),
      prompt.indexOf('## Skills'),
      prompt.indexOf('## Mail'),
    ]
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(prompt.trim().startsWith('[Hive context packet]')).toBe(true)
    harness.close()
  })

  it('carries memory and resources as bounded references with excerpts', () => {
    const harness = workHarness([operator, agentB])
    harness.fs.write(operator, harness.scope, { path: 'memory/decision.md', body: 'Ship small packets.' })
    harness.fs.write(operator, harness.scope, { path: 'resource/guide.md', body: 'Read the ledger first.' })
    const task = harness.board.create(operator, harness.scope, { title: 'Referenced' })

    const packet = harness.packets.compile(operator, harness.scope, { taskId: task.id })
    expect(packet.memory.map((reference) => reference.uri)).toEqual([expect.stringContaining('memory/decision.md')])
    expect(packet.memory[0].excerpt).toBe('Ship small packets.')
    expect(packet.resources.map((reference) => reference.uri)).toEqual([expect.stringContaining('resource/guide.md')])
    harness.close()
  })

  it('drops whole references that do not fit the budget and says so in the warnings', () => {
    const harness = workHarness([operator, agentB])
    harness.fs.write(operator, harness.scope, { path: 'memory/huge.md', body: 'x'.repeat(4_096) })
    harness.fs.write(operator, harness.scope, { path: 'memory/small.md', body: 'fits' })
    const task = harness.board.create(operator, harness.scope, { title: 'Bounded' })

    const packet = harness.packets.compile(operator, harness.scope, { taskId: task.id, byteBudget: 2_048 })
    // Both are candidates; at least one whole reference survived and the drop is reported.
    expect(packet.memory.length).toBeLessThanOrEqual(2)
    expect(packet.operationalWarnings.some((warning) => warning.includes('dropped to fit'))).toBe(true)
    expect(packet.byteBudget).toBe(2_048)
    harness.close()
  })

  it('claims the oldest eligible handoff for the agent, exactly once', () => {
    const harness = workHarness([operator, agentB])
    const cwd = resolve('work-root', 'repo')
    const task = harness.board.create(operator, harness.scope, { title: 'Handing off' })
    const handoff = harness.handoffs.create(operator, harness.scope, { toAgentId: 'agent-b', cwd, summary: 'Finish the parser', nextSteps: ['errors'] })

    const packet = harness.packets.compile(operator, harness.scope, { taskId: task.id, agentId: 'agent-b', cwd })
    expect(packet.handoff?.summary).toBe('Finish the parser')
    expect(packet.handoff?.nextSteps).toEqual(['errors'])
    expect(harness.handoffs.handoff(operator, handoff.id).state).toBe('accepted')

    // The claim happened at compile: a second packet carries no handoff.
    const again = harness.packets.compile(operator, harness.scope, { taskId: task.id, agentId: 'agent-b', cwd })
    expect(again.handoff).toBeUndefined()
    harness.close()
  })

  it('snapshots the inbox: pending mail is context, acknowledged mail is not', () => {
    const harness = workHarness([operator, agentB])
    const task = harness.board.create(operator, harness.scope, { title: 'Mailed' })
    const message = harness.mail.send(operator, harness.scope, { to: 'agent:agent-b', subject: 'Do the thing', body: 'the details', priority: 'high' })

    const first = harness.packets.compile(operator, harness.scope, { taskId: task.id, agentId: 'agent-b' })
    expect(first.mail).toHaveLength(1)
    expect(first.mail[0]).toMatchObject({ id: message.id, subject: 'Do the thing', priority: 'high', snippet: 'the details' })

    harness.mail.ack(agentB, harness.mail.claimNext(agentB, 'agent:agent-b')!.id)
    const second = harness.packets.compile(operator, harness.scope, { taskId: task.id, agentId: 'agent-b' })
    expect(second.mail).toEqual([])
    harness.close()
  })

  it('requires dispatch authority: the packet claims resources on the recipient’s behalf', () => {
    const harness = workHarness([operator, viewer])
    const task = harness.board.create(operator, harness.scope, { title: 'Guarded' })
    expect(() => harness.packets.compile(viewer, harness.scope, { taskId: task.id })).toThrowError(/Missing capability: work:dispatch/)
    harness.close()
  })
})
