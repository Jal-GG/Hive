import { describe, expect, it } from 'vitest'
import { Capability } from '../../src/contracts.js'
import { parseAddress, queueForAddress } from '../../src/work/mail.js'
import { workHarness, testActor, testAgent } from '../fixtures.js'

const capabilities: Capability[] = ['workspace:read', 'work:dispatch']
const sender = testActor('sender', capabilities)
const agentA = testAgent('agent-a', capabilities)
const agentB = testAgent('agent-b', capabilities)
const viewer = testActor('viewer', ['workspace:read'])

describe('addresses', () => {
  it('parses the three kinds and refuses everything else', () => {
    expect(parseAddress('actor:op-1')).toEqual({ kind: 'actor', id: 'op-1' })
    expect(parseAddress('agent:claude-7')).toEqual({ kind: 'agent', id: 'claude-7' })
    expect(parseAddress('queue:merge')).toEqual({ kind: 'queue', id: 'merge' })
    expect(() => parseAddress('phone:555')).toThrowError(/Unknown address kind/)
    expect(() => parseAddress('no-kind-here')).toThrowError(/must be kind:id/)
  })

  it('resolves an address to its delivery lane', () => {
    expect(queueForAddress('agent:agent-b')).toBe('agent:agent-b')
    expect(queueForAddress('actor:op-1')).toBe('actor:op-1')
    expect(queueForAddress('queue:merge')).toBe('merge')
  })
})

describe('mail', () => {
  it('resolves a to-address into a claimable queue at send time', () => {
    const harness = workHarness([sender, agentB])
    const message = harness.mail.send(sender, harness.scope, { to: 'agent:agent-b', subject: 'Half done', body: 'Part one landed' })
    expect(message.queue).toBe('agent:agent-b')
    expect(message.state).toBe('pending')
    expect(harness.mail.inbox(sender, { queue: 'agent:agent-b' }).map((entry) => entry.id)).toEqual([message.id])
    harness.close()
  })

  it('refuses a message with no destination, both destinations, or a queue spelled as an address', () => {
    const harness = workHarness([sender])
    expect(() => harness.mail.send(sender, harness.scope, { subject: 'Nowhere' })).toThrowError(/needs a to address or a queue/)
    expect(() => harness.mail.send(sender, harness.scope, { to: 'agent:agent-b', queue: 'merge', subject: 'Both' })).toThrowError(/not both/)
    expect(() => harness.mail.send(sender, harness.scope, { to: 'queue:merge', subject: 'Queue address' })).toThrowError(/Use the queue field/)
    harness.close()
  })

  it('validates protocol subjects against the closed vocabulary', () => {
    const harness = workHarness([sender])
    harness.mail.send(sender, harness.scope, { to: 'agent:agent-b', subject: 'MERGE_READY', body: 'branch is green', type: 'protocol' })
    expect(() => harness.mail.send(sender, harness.scope, { to: 'agent:agent-b', subject: 'MERGE_NOW', type: 'protocol' })).toThrowError(/Protocol subject must be one of/)
    harness.close()
  })

  it('claims in urgency-then-age order, and one claim wins', () => {
    const harness = workHarness([sender, agentA, agentB])
    harness.mail.send(sender, harness.scope, { to: 'agent:agent-b', subject: 'Old and normal', body: 'first' })
    harness.clock.advance(1_000)
    harness.mail.send(sender, harness.scope, { to: 'agent:agent-b', subject: 'New but urgent', body: 'second', priority: 'urgent' })
    harness.clock.advance(1_000)
    harness.mail.send(sender, harness.scope, { to: 'agent:agent-b', subject: 'Newest and normal', body: 'third' })

    const first = harness.mail.claimNext(agentB, 'agent:agent-b')
    expect(first?.subject).toBe('New but urgent')
    const second = harness.mail.claimNext(agentB, 'agent:agent-b')
    expect(second?.subject).toBe('Old and normal')
    // A second claimant sees the same remaining head but only the owner lands.
    expect(harness.mail.claim(agentA, second!)).toBeUndefined()
    expect(harness.mail.claimNext(agentB, 'agent:agent-b')?.subject).toBe('Newest and normal')
    expect(harness.mail.claimNext(agentB, 'agent:agent-b')).toBeUndefined()
    harness.close()
  })

  it('acknowledges only the claimant, from a claimed or delivered state', () => {
    const harness = workHarness([sender, agentA, agentB])
    const message = harness.mail.send(sender, harness.scope, { to: 'agent:agent-b', subject: 'For B', body: 'work' })
    expect(() => harness.mail.ack(agentB, message.id)).toThrowError(/claimed by nobody/)
    const claimed = harness.mail.claimNext(agentB, 'agent:agent-b')!
    expect(() => harness.mail.ack(agentA, claimed.id)).toThrowError(/not agent-a/)
    const acked = harness.mail.ack(agentB, claimed.id)
    expect(acked.state).toBe('acked')
    expect(() => harness.mail.ack(agentB, claimed.id)).toThrowError(/cannot be acknowledged/)
    harness.close()
  })

  it('delivers an interrupt-mode message at claim time', () => {
    const harness = workHarness([sender, agentB])
    harness.mail.send(sender, harness.scope, { to: 'agent:agent-b', subject: 'Stop the line', body: 'now', delivery: 'interrupt' })
    const claimed = harness.mail.claimNext(agentB, 'agent:agent-b')!
    expect(claimed.state).toBe('delivered')
    expect(claimed.deliveredAt).toBeDefined()
    harness.close()
  })

  it('requeues a claim whose worker vanished, as the retry fallback', () => {
    const harness = workHarness([sender, agentA, agentB])
    const message = harness.mail.send(sender, harness.scope, { to: 'agent:agent-b', subject: 'Abandoned', body: 'work' })
    harness.mail.claimNext(agentA, 'agent:agent-b')
    harness.clock.advance(10 * 60_000)

    expect(harness.mail.requeue(agentB, harness.scope, 60_000)).toBe(1)
    const reclaimed = harness.mail.claimNext(agentB, 'agent:agent-b')!
    expect(reclaimed.id).toBe(message.id)
    expect(reclaimed.claimedBy).toBe(agentB.actorId)
    harness.close()
  })

  it('requires work:dispatch to send or claim, workspace:read to view', () => {
    const harness = workHarness([sender, viewer])
    expect(() => harness.mail.send(viewer, harness.scope, { subject: 'No', to: 'agent:agent-b' })).toThrowError(/Missing capability: work:dispatch/)
    expect(() => harness.mail.inbox(viewer, {})).not.toThrow()
    harness.close()
  })
})
