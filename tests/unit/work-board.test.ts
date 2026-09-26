import { describe, expect, it } from 'vitest'
import { Capability } from '../../src/contracts.js'
import { workHarness, testActor, testAgent } from '../fixtures.js'

const capabilities: Capability[] = ['workspace:read', 'work:mutate', 'work:dispatch']
const operator = testActor('operator', capabilities)
const agentA = testAgent('agent-a', capabilities)
const agentB = testAgent('agent-b', capabilities)
const viewer = testActor('viewer', ['workspace:read'])

describe('work board', () => {
  it('creates an open item and lists it by scope', () => {
    const harness = workHarness([operator, agentA, agentB])
    const item = harness.board.create(operator, harness.scope, { title: 'Ship the parser', description: 'Make it parse' })
    expect(item.status).toBe('open')
    expect(item.ownerActorId).toBe(operator.actorId)
    expect(item.revision).toBe(0)
    expect(harness.board.list(operator, harness.scope).map((candidate) => candidate.id)).toEqual([item.id])
    harness.close()
  })

  it('refuses a titleless item and a mutation without work:mutate', () => {
    const harness = workHarness([operator, viewer])
    expect(() => harness.board.create(operator, harness.scope, { title: '   ' })).toThrowError(/needs a title/)
    expect(() => harness.board.create(viewer, harness.scope, { title: 'nope' })).toThrowError(/Missing capability: work:mutate/)
    harness.close()
  })

  it('walks the happy status path: claim, start, review, merged', () => {
    const harness = workHarness([operator, agentA])
    const item = harness.board.create(operator, harness.scope, { title: 'Task' })
    const claimed = harness.board.claim(agentA, item.id)
    expect(claimed.item.status).toBe('assigned')
    expect(claimed.item.assigneeActorId).toBe(agentA.actorId)
    expect(claimed.lease.resourceType).toBe('task')

    const started = harness.board.transition(agentA, item.id, 'in_progress')
    expect(started.status).toBe('in_progress')
    harness.board.transition(agentA, item.id, 'review')
    const merged = harness.board.transition(operator, item.id, 'merged')
    expect(merged.status).toBe('merged')
    expect(merged.closedAt).toBeDefined()
    harness.close()
  })

  it('rejects illegal transitions and terminal items', () => {
    const harness = workHarness([operator, agentA])
    const item = harness.board.create(operator, harness.scope, { title: 'Task' })
    expect(() => harness.board.transition(operator, item.id, 'done')).toThrowError(/from open to done/)
    harness.board.claim(agentA, item.id)
    harness.board.transition(agentA, item.id, 'in_progress')
    harness.board.transition(agentA, item.id, 'done')
    expect(() => harness.board.transition(agentA, item.id, 'in_progress')).toThrowError(/already done/)
    harness.close()
  })

  it('releases the task lease when the item reaches a terminal state', () => {
    const harness = workHarness([operator, agentA])
    const item = harness.board.create(operator, harness.scope, { title: 'Task' })
    harness.board.claim(agentA, item.id)
    expect(harness.ledger.activeLease('task', item.id)?.ownerActorId).toBe(agentA.actorId)
    harness.board.transition(agentA, item.id, 'cancelled')
    expect(harness.ledger.activeLease('task', item.id)).toBeUndefined()
    harness.close()
  })

  it('gives a claim to exactly one agent: the second claim is refused with the current owner', () => {
    const harness = workHarness([operator, agentA, agentB])
    const item = harness.board.create(operator, harness.scope, { title: 'Contested' })
    harness.board.claim(agentA, item.id)
    expect(() => harness.board.claim(agentB, item.id)).toThrowError(/is assigned to agent-a/)
    // The claimant re-claiming is idempotent: same owner, still assigned.
    expect(harness.board.claim(agentA, item.id).item.assigneeActorId).toBe(agentA.actorId)
    harness.close()
  })

  it('only the assignee can move an item to in_progress', () => {
    const harness = workHarness([operator, agentA, agentB])
    const item = harness.board.create(operator, harness.scope, { title: 'Task' })
    harness.board.claim(agentA, item.id)
    expect(() => harness.board.transition(agentB, item.id, 'in_progress')).toThrowError(/assigned to agent-a, not agent-b/)
    harness.close()
  })

  it('blocks a claim behind an unsatisfied dependency and unblocks it when the dependency lands', () => {
    const harness = workHarness([operator, agentA, agentB])
    const blocker = harness.board.create(operator, harness.scope, { title: 'Blocker' })
    const dependent = harness.board.create(operator, harness.scope, { title: 'Dependent' })
    harness.board.addDependency(operator, dependent.id, blocker.id, 'blocks')

    // Adding the dependency blocked the open item, and the claim sees the gate.
    expect(harness.board.item(operator, dependent.id).status).toBe('blocked')
    expect(() => harness.board.claim(agentA, dependent.id)).toThrowError(/is blocked, not claimable/)

    // Completing the blocker unblocks the dependent and the claim goes through.
    harness.board.claim(agentB, blocker.id)
    harness.board.transition(agentB, blocker.id, 'in_progress')
    harness.board.transition(agentB, blocker.id, 'done')
    expect(harness.board.item(operator, dependent.id).status).toBe('open')
    expect(harness.board.claim(agentA, dependent.id).item.status).toBe('assigned')
    harness.close()
  })

  it('does not unblock on a failed dependency: that is a decision, not a condition', () => {
    const harness = workHarness([operator, agentA])
    const blocker = harness.board.create(operator, harness.scope, { title: 'Blocker' })
    const dependent = harness.board.create(operator, harness.scope, { title: 'Dependent' })
    harness.board.addDependency(operator, dependent.id, blocker.id, 'blocks')
    harness.board.claim(agentA, blocker.id)
    harness.board.transition(agentA, blocker.id, 'in_progress')
    harness.board.transition(agentA, blocker.id, 'failed')
    expect(harness.board.item(operator, dependent.id).status).toBe('blocked')
    harness.close()
  })

  it('rejects self-dependencies, duplicates, and cycles', () => {
    const harness = workHarness([operator])
    const first = harness.board.create(operator, harness.scope, { title: 'First' })
    const second = harness.board.create(operator, harness.scope, { title: 'Second' })
    expect(() => harness.board.addDependency(operator, first.id, first.id)).toThrowError(/cannot depend on itself/)
    harness.board.addDependency(operator, first.id, second.id, 'blocks')
    expect(() => harness.board.addDependency(operator, first.id, second.id)).toThrowError(/already depends on/)
    expect(() => harness.board.addDependency(operator, second.id, first.id)).toThrowError(/cycle/)
    harness.close()
  })

  it('writes the plan only under the claim, with append-only history', () => {
    const harness = workHarness([operator, agentA])
    const item = harness.board.create(operator, harness.scope, { title: 'Planned' })
    expect(() => harness.board.plan(agentA, item.id, 'draft')).toThrowError(/Only the claimant/)
    harness.board.claim(agentA, item.id)
    const first = harness.board.plan(agentA, item.id, 'step 1')
    const second = harness.board.plan(agentA, item.id, 'step 1\nstep 2')
    expect(second.revision).toBe(first.revision + 1)
    expect(harness.board.planOf(operator, item.id)?.body).toBe('step 1\nstep 2')
    expect(harness.board.planHistory(operator, item.id).map((revision) => revision.body)).toEqual(['step 1', 'step 1\nstep 2'])
    harness.close()
  })

  it('records the lifecycle as Work events with unique keys', () => {
    const harness = workHarness([operator, agentA])
    const item = harness.board.create(operator, harness.scope, { title: 'Audited' })
    harness.board.claim(agentA, item.id)
    harness.board.transition(agentA, item.id, 'in_progress')
    // A rework cycle must not collide with the first review transition's event.
    harness.board.transition(agentA, item.id, 'review')
    harness.board.transition(agentA, item.id, 'in_progress')
    harness.board.transition(agentA, item.id, 'review')

    const events = harness.ledger.readEvents(0, 100)
    const keys = events.map((event) => event.idempotencyKey)
    expect(keys.filter((key) => key.startsWith('work:'))).toEqual([
      `work:created:created:${item.id}`,
      `work:claimed:claimed:${item.id}:1`,
      `work:status:status:${item.id}:2`,
      `work:status:status:${item.id}:3`,
      `work:status:status:${item.id}:4`,
      `work:status:status:${item.id}:5`,
    ])
    expect(events.every((event) => event.eventType === 'Work')).toBe(true)
    expect(events.every((event) => event.workItemId === item.id)).toBe(true)
    harness.close()
  })
})
