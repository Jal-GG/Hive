import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FeedEventAdapter, GitHubEventAdapter, ObservabilityService, SignedWebhookAdapter, SlackEventAdapter } from '../../src/observability.js'
import { WorkflowService } from '../../src/workflow.js'
import { testActor, workHarness } from '../fixtures.js'
import type { Capability, WorkflowDefinition } from '../../src/contracts.js'

const capabilities: Capability[] = ['workspace:read', 'work:mutate', 'work:dispatch']
const actor = () => testActor('operator', capabilities)
const definition = (): Omit<WorkflowDefinition, 'createdBy' | 'createdAt' | 'updatedAt'> => ({
  id: 'webhook-flow', version: '1.0.0', name: 'Webhook flow', description: 'Accepts webhook work', enabled: true,
  steps: [{ id: 'one', type: 'create_work', title: 'Handle webhook' }],
})

describe('Phase 8 integrations and observability', () => {
  it('accepts only HMAC-signed bounded webhook payloads and deduplicates delivery', () => {
    const operator = actor()
    const harness = workHarness([operator])
    const workflow = new WorkflowService({ ledger: harness.ledger, board: harness.board, now: harness.clock.now })
    workflow.register(operator, definition())
    const adapter = new SignedWebhookAdapter({ workflow, secret: 'test-secret' })
    const body = JSON.stringify({ action: 'opened', number: 7, ignored: { secret: 'no' } })
    const signature = createHmac('sha256', 'test-secret').update(body).digest('hex')

    expect(() => adapter.receive(operator, harness.scope, { id: 'hook-7', workflowId: 'webhook-flow', body, signature: 'bad' })).toThrowError(/signature is invalid/)
    expect(harness.board.list(operator, harness.scope)).toHaveLength(0)
    const first = adapter.receive(operator, harness.scope, { id: 'hook-7', workflowId: 'webhook-flow', body, signature })
    const second = adapter.receive(operator, harness.scope, { id: 'hook-7', workflowId: 'webhook-flow', body, signature })
    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(harness.board.list(operator, harness.scope)).toHaveLength(1)

    const github = new GitHubEventAdapter(adapter)
    const slack = new SlackEventAdapter(adapter)
    const feed = new FeedEventAdapter(adapter)
    const githubBody = JSON.stringify({ event: 'issues' })
    const githubSignature = createHmac('sha256', 'test-secret').update(githubBody).digest('hex')
    expect(github.receive(operator, harness.scope, { id: 'github:8', workflowId: 'webhook-flow', body: githubBody, signature: githubSignature }).trigger.kind).toBe('github')
    const slackBody = JSON.stringify({ event: 'app_mention' })
    const slackSignature = createHmac('sha256', 'test-secret').update(slackBody).digest('hex')
    expect(slack.receive(operator, harness.scope, { id: 'slack:8', workflowId: 'webhook-flow', body: slackBody, signature: slackSignature }).trigger.kind).toBe('slack')
    const feedBody = JSON.stringify({ entry: 'new' })
    const feedSignature = createHmac('sha256', 'test-secret').update(feedBody).digest('hex')
    expect(feed.receive(operator, harness.scope, { id: 'feed:8', workflowId: 'webhook-flow', body: feedBody, signature: feedSignature }).trigger.kind).toBe('feed')
    harness.close()
  })

  it('keeps metrics disabled by default and enforces bounded labels when enabled', () => {
    const operator = actor()
    const harness = workHarness([operator])
    const disabled = new ObservabilityService({ ledger: harness.ledger, now: harness.clock.now })
    expect(disabled.record(operator, harness.scope, { kind: 'queue', name: 'depth', value: 2, unit: 'items', labels: { queue: 'dispatch' } })).toBeUndefined()
    expect(disabled.metrics(operator, harness.scope)).toHaveLength(0)

    const enabled = new ObservabilityService({ ledger: harness.ledger, enabled: true, now: harness.clock.now })
    const metric = enabled.record(operator, harness.scope, { kind: 'provider_health', name: 'available', value: 1, unit: 'boolean', labels: { provider: 'fake' } })
    expect(metric?.labels).toEqual({ provider: 'fake' })
    expect(enabled.metrics(operator, harness.scope, 'provider_health')).toHaveLength(1)
    expect(enabled.providerHealth(operator, harness.scope, 'fake', true)?.value).toBe(1)
    expect(enabled.usage(operator, harness.scope, 'fake', 10, 5, 0.02)).toHaveLength(3)
    expect(enabled.queueDepth(operator, harness.scope, 'dispatch', 4)?.value).toBe(4)
    expect(() => enabled.record(operator, harness.scope, { kind: 'queue', name: 'depth', value: 1, unit: 'items', labels: { request_id: 'unbounded value!' } })).toThrowError(/bounded lowercase strings/)
    harness.close()
  })
})
