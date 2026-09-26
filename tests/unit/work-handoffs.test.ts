import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { Capability } from '../../src/contracts.js'
import { isWithinBoundary } from '../../src/work/handoffs.js'
import { workHarness, testActor, testAgent } from '../fixtures.js'

const capabilities: Capability[] = ['workspace:read', 'work:mutate']
const operator = testActor('operator', capabilities)
const agentA = testAgent('agent-a', capabilities)
const agentB = testAgent('agent-b', capabilities)

describe('cwd boundaries', () => {
  it('accepts the boundary itself and a child, refuses a sibling', () => {
    const root = resolve('work-root', 'repo')
    expect(isWithinBoundary(root, root)).toBe(true)
    expect(isWithinBoundary(join(root, 'src'), root)).toBe(true)
    expect(isWithinBoundary(resolve('work-root', 'other'), root)).toBe(false)
    // A prefix that is not a directory boundary is not inside: "repo-2" is a sibling.
    expect(isWithinBoundary(`${root}-2`, root)).toBe(false)
  })
})

describe('handoffs', () => {
  it('creates an open handoff and keeps the boundary absolute', () => {
    const harness = workHarness([operator, agentA])
    const cwd = resolve('work-root', 'repo')
    const handoff = harness.handoffs.create(operator, harness.scope, {
      cwd,
      summary: 'Parser half-landed',
      openQuestions: ['keep the AST?'],
      filesTouched: ['src/parser.ts'],
      nextSteps: ['finish errors'],
    })
    expect(handoff.state).toBe('open')
    expect(handoff.toAgentId).toBeUndefined()
    expect(() => harness.handoffs.create(operator, harness.scope, { cwd: 'relative/path', summary: 'Nope' })).toThrowError(/must be absolute/)
    harness.close()
  })

  it('accepts once: the second acceptance, by anyone, is refused', () => {
    const harness = workHarness([operator, agentA, agentB])
    const cwd = resolve('work-root', 'repo')
    const handoff = harness.handoffs.create(operator, harness.scope, { toAgentId: 'agent-b', cwd, summary: 'Take over' })

    const accepted = harness.handoffs.accept(agentB, handoff.id, { cwd: join(cwd, 'src') })
    expect(accepted.state).toBe('accepted')
    expect(accepted.ownerActorId).toBe(agentB.actorId)
    expect(() => harness.handoffs.accept(agentB, handoff.id, { cwd })).toThrowError(/is accepted/)
    expect(() => harness.handoffs.accept(agentA, handoff.id, { cwd })).toThrowError(/is accepted/)
    harness.close()
  })

  it('filters by addressee: a handoff offered to one agent is not another’s to take', () => {
    const harness = workHarness([operator, agentA, agentB])
    const cwd = resolve('work-root', 'repo')
    const handoff = harness.handoffs.create(operator, harness.scope, { toAgentId: 'agent-b', cwd, summary: 'For B only' })
    expect(() => harness.handoffs.accept(agentA, handoff.id, { cwd })).toThrowError(/addressed to agent agent-b/)

    // Unaddressed, the same handoff is any agent's to accept.
    const open = harness.handoffs.create(operator, harness.scope, { cwd, summary: 'Anyone' })
    expect(harness.handoffs.accept(agentA, open.id, { cwd }).state).toBe('accepted')
    harness.close()
  })

  it('enforces the cwd boundary on acceptance', () => {
    const harness = workHarness([operator, agentB])
    const cwd = resolve('work-root', 'repo')
    const handoff = harness.handoffs.create(operator, harness.scope, { cwd, summary: 'Rooted work' })
    expect(() => harness.handoffs.accept(agentB, handoff.id, { cwd: resolve('elsewhere') })).toThrowError(/outside the session's/)
    expect(harness.handoffs.accept(agentB, handoff.id, { cwd: join(cwd, 'deep', 'sub') }).state).toBe('accepted')
    harness.close()
  })

  it('cancels only for the author and only while open', () => {
    const harness = workHarness([operator, agentA, agentB])
    const handoff = harness.handoffs.create(operator, harness.scope, { cwd: resolve('work-root'), summary: 'Cancel me' })
    expect(() => harness.handoffs.cancel(agentA, handoff.id)).toThrowError(/not cancellable/)
    expect(harness.handoffs.cancel(operator, handoff.id).state).toBe('cancelled')

    const accepted = harness.handoffs.create(operator, harness.scope, { cwd: resolve('work-root'), summary: 'Too late' })
    harness.handoffs.accept(agentA, accepted.id, { cwd: accepted.cwd })
    expect(() => harness.handoffs.cancel(operator, accepted.id)).toThrowError(/not cancellable/)
    harness.close()
  })

  it('expires open handoffs past the TTL, oldest first for eligibility', () => {
    const harness = workHarness([operator, agentA, agentB])
    const cwd = resolve('work-root', 'repo')
    const older = harness.handoffs.create(operator, harness.scope, { toAgentId: 'agent-b', cwd, summary: 'Older' })
    harness.clock.advance(60_000)
    const newer = harness.handoffs.create(operator, harness.scope, { toAgentId: 'agent-b', cwd, summary: 'Newer' })

    const eligible = harness.handoffs.eligible(agentB, harness.scope, 'agent-b', cwd)
    expect(eligible.map((candidate) => candidate.id)).toEqual([older.id, newer.id])
    // A handoff addressed to another agent never appears for this one.
    expect(harness.handoffs.eligible(agentA, harness.scope, 'agent-a', cwd)).toEqual([])

    harness.clock.advance(48 * 60 * 60 * 1000)
    expect(harness.handoffs.expire(operator, harness.scope, 24 * 60 * 60 * 1000)).toBe(2)
    expect(harness.handoffs.list(operator, harness.scope, ['expired'])).toHaveLength(2)
    harness.close()
  })
})
