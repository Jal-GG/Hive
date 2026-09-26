import { describe, expect, it } from 'vitest'
import { Capability } from '../../src/contracts.js'
import { runWorkCli, type WorkCliSurfaces } from '../../src/interfaces/cli/work-cli.js'
import { workHarness, testActor, testAgent } from '../fixtures.js'

const capabilities: Capability[] = ['workspace:read', 'work:mutate', 'work:dispatch', 'context:read']
const operator = testActor('operator', capabilities)
const agentB = testAgent('agent-b', capabilities)

function surfaces(harness: ReturnType<typeof workHarness>): WorkCliSurfaces {
  return { ledger: harness.ledger, board: harness.board, mail: harness.mail, handoffs: harness.handoffs, packets: harness.packets }
}

function parse<T>(output: string): T {
  return JSON.parse(output) as T
}

describe('work CLI', () => {
  it('creates, claims, and walks a task through JSON output', async () => {
    const harness = workHarness([operator, agentB])
    const cli = (argv: string[]) => runWorkCli(surfaces(harness), operator, argv)

    const created = parse<{ id: string; status: string }>(await cli(['create', '--title', 'CLI task', '--priority', '3']))
    expect(created.status).toBe('open')

    const listed = parse<{ id: string }[]>(await cli(['list']))
    expect(listed).toHaveLength(1)

    const claimed = parse<{ item: { id: string; assigneeActorId: string } }>(await cli(['claim', created.id]))
    expect(claimed.item.assigneeActorId).toBe(operator.actorId)

    const started = parse<{ status: string }>(await cli(['start', created.id]))
    expect(started.status).toBe('in_progress')

    const transitioned = parse<{ status: string }>(await cli(['status', created.id, '--to', 'review']))
    expect(transitioned.status).toBe('review')
    harness.close()
  })

  it('sends, claims, and acknowledges mail through the queue', async () => {
    const harness = workHarness([operator, agentB])
    const cli = (argv: string[]) => runWorkCli(surfaces(harness), operator, argv)

    const sent = parse<{ id: string; queue: string }>(await cli(['mail-send', '--to', 'agent:agent-b', '--subject', 'Over to you', '--body', 'details']))
    expect(sent.queue).toBe('agent:agent-b')

    const asAgent = (argv: string[]) => runWorkCli(surfaces(harness), agentB, argv)
    const claimed = parse<{ id: string; state: string } | null>(await asAgent(['mail-claim', '--queue', 'agent:agent-b']))
    expect(claimed?.id).toBe(sent.id)
    expect(claimed?.state).toBe('claimed')

    const acked = parse<{ state: string }>(await asAgent(['mail-ack', sent.id]))
    expect(acked.state).toBe('acked')
    harness.close()
  })

  it('compiles the agent context packet with its rendered prompt', async () => {
    const harness = workHarness([operator, agentB])
    const created = parse<{ id: string }>(await runWorkCli(surfaces(harness), operator, ['create', '--title', 'Packeted', '--description', 'Make context']))

    const output = await runWorkCli(surfaces(harness), operator, ['context', '--task', created.id, '--agent', 'agent-b', '--budget', '8192'])
    const compiled = parse<{ packet: { task: { title: string }; authorityNotice: string }; prompt: string }>(output)
    expect(compiled.packet.task.title).toBe('Packeted')
    expect(compiled.prompt).toContain('[Hive context packet]')
    expect(compiled.prompt).toContain('## Task')
    harness.close()
  })

  it('refuses unknown operations and operations missing their flags', async () => {
    const harness = workHarness([operator])
    await expect(runWorkCli(surfaces(harness), operator, ['explode'])).rejects.toThrowError(/Unknown work operation/)
    await expect(runWorkCli(surfaces(harness), operator, ['create'])).rejects.toThrowError(/--title is required/)
    await expect(runWorkCli(surfaces(harness), operator, ['context'])).rejects.toThrowError(/--task is required/)
    harness.close()
  })
})
