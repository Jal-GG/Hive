import { createHmac, timingSafeEqual } from 'node:crypto'
import { ActorContext, ObservationMetric, ObservationMetricKind, QueueDiagnostic, ScopeRef } from './contracts.js'
import { assertCapability } from './capabilities.js'
import { HiveError } from './errors.js'
import { Ledger } from './ledger.js'
import { Clock, ClockOptions, createId, resolveClock } from './shared.js'
import { WorkflowService } from './workflow.js'

export interface ObservabilityOptions extends ClockOptions {
  ledger: Ledger
  enabled?: boolean
}

export class ObservabilityService {
  private readonly ledger: Ledger
  private readonly enabled: boolean
  private readonly now: Clock

  constructor(options: ObservabilityOptions) {
    this.ledger = options.ledger
    this.enabled = options.enabled ?? false
    this.now = resolveClock(options)
  }

  isEnabled(): boolean { return this.enabled }

  record(actor: ActorContext, scope: ScopeRef, input: Omit<ObservationMetric, 'id' | 'scope' | 'recordedAt'>): ObservationMetric | undefined {
    if (!this.enabled) return undefined
    assertCapability(actor.capabilities, 'workspace:read')
    if (!input.name || !input.unit || !Number.isFinite(input.value)) throw new HiveError('METRIC_INVALID', 'Metric name, unit, and finite value are required')
    const labels = Object.fromEntries(Object.entries(input.labels).map(([key, value]) => {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(key) || !/^[a-z0-9_.-]{1,64}$/.test(value)) throw new HiveError('METRIC_INVALID', 'Metric labels must be bounded lowercase strings')
      return [key, value]
    }))
    const metric: ObservationMetric = { ...input, labels, id: createId(), scope, recordedAt: this.now().toISOString() }
    this.ledger.insertObservationMetric(metric)
    return metric
  }

  metrics(actor: ActorContext, scope: ScopeRef, kind?: ObservationMetricKind): ObservationMetric[] {
    assertCapability(actor.capabilities, 'workspace:read')
    return this.ledger.listObservationMetrics(scope, kind)
  }

  providerHealth(actor: ActorContext, scope: ScopeRef, provider: string, available: boolean): ObservationMetric | undefined {
    return this.record(actor, scope, { kind: 'provider_health', name: 'available', value: available ? 1 : 0, unit: 'boolean', labels: { provider } })
  }

  usage(actor: ActorContext, scope: ScopeRef, provider: string, tokensIn: number, tokensOut: number, costUsd = 0): ObservationMetric[] {
    const input = this.record(actor, scope, { kind: 'usage', name: 'tokens_in', value: tokensIn, unit: 'tokens', labels: { provider } })
    const output = this.record(actor, scope, { kind: 'usage', name: 'tokens_out', value: tokensOut, unit: 'tokens', labels: { provider } })
    const cost = this.record(actor, scope, { kind: 'usage', name: 'cost', value: costUsd, unit: 'usd', labels: { provider } })
    return [input, output, cost].filter((metric): metric is ObservationMetric => metric !== undefined)
  }

  queueDepth(actor: ActorContext, scope: ScopeRef, queue: string, depth: number): ObservationMetric | undefined {
    return this.record(actor, scope, { kind: 'queue', name: 'depth', value: depth, unit: 'items', labels: { queue } })
  }

  /** §7 Phase 8 "retrieval trajectory" as a metric kind, alongside the durable trajectory rows. */
  retrievalTrajectory(actor: ActorContext, scope: ScopeRef, query: string, hitCount: number, durationMs: number): ObservationMetric | undefined {
    const label = query.slice(0, 64).toLowerCase().replace(/[^a-z0-9_.-]/g, '_')
    return this.record(actor, scope, { kind: 'retrieval', name: 'hits', value: hitCount, unit: 'documents', labels: { query: label.length > 0 ? label : 'blank' } })
  }

  /**
   * Queue diagnostics (§7 Phase 8): the durable queue state read out of the
   * ledger, with the depth mirrored into metrics when telemetry is on so a
   * spend-capped or opt-in operator sees the same numbers a dashboard does.
   */
  queueDiagnostics(actor: ActorContext, scope: ScopeRef): QueueDiagnostic[] {
    assertCapability(actor.capabilities, 'workspace:read')
    const queues = this.ledger.queueDiagnostics(scope)
    for (const queue of queues) {
      this.queueDepth(actor, scope, queue.queue, queue.depth)
    }
    return queues
  }

  /**
   * Cost incurred in a scope, summed from recorded usage. This is the spend source
   * a trigger policy caps against (§5.7). With telemetry disabled nothing is
   * recorded, so this reports zero — a spend cap is only meaningful once the
   * operator has opted into usage recording, which is stated here rather than
   * left as a policy that silently never fires.
   */
  costUsd(actor: ActorContext, scope: ScopeRef): number {
    assertCapability(actor.capabilities, 'workspace:read')
    return this.ledger.listObservationMetrics(scope, 'usage')
      .filter((metric) => metric.name === 'cost')
      .reduce((total, metric) => total + metric.value, 0)
  }

  /**
   * An OTLP-shaped metrics snapshot (§7 Phase 8 "OTel/metrics"). It is a
   * deterministic local projection rather than a live exporter: the caller —
   * a periodic task, a CLI command, an SDK client — owns when and where it
   * goes, including nowhere. Fingerprinted and bounded so an export can never
   * become an unbounded dump: one gauge per (kind, name, label-set).
   */
  otlpSnapshot(actor: ActorContext, scope: ScopeRef): { resourceMetrics: { scope: { name: string; version: string }; metrics: Array<{ name: string; unit: string; gauge: { value: number; labels: Record<string, string>; recordedAt: string } }> } } {
    assertCapability(actor.capabilities, 'workspace:read')
    const gauges = new Map<string, { name: string; unit: string; gauge: { value: number; labels: Record<string, string>; recordedAt: string } }>()
    for (const metric of this.ledger.listObservationMetrics(scope)) {
      const labelsKey = Object.entries(metric.labels).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => `${key}=${value}`).join(',')
      const name = `hive_${metric.kind}_${metric.name}`
      const key = `${name}|${labelsKey}`
      // Last write wins: the snapshot reflects the most recent value of each series.
      gauges.set(key, { name, unit: metric.unit, gauge: { value: metric.value, labels: metric.labels, recordedAt: metric.recordedAt } })
    }
    return {
      resourceMetrics: {
        scope: { name: 'hive', version: '1' },
        metrics: [...gauges.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      },
    }
  }
}

export interface WebhookAdapterOptions {
  workflow: WorkflowService
  secret: string
  maxBodyBytes?: number
}

export class SignedWebhookAdapter {
  private readonly workflow: WorkflowService
  private readonly secret: string
  private readonly maxBodyBytes: number

  constructor(options: WebhookAdapterOptions) {
    if (!options.secret) throw new HiveError('WEBHOOK_INVALID', 'Webhook secret is required')
    this.workflow = options.workflow
    this.secret = options.secret
    this.maxBodyBytes = options.maxBodyBytes ?? 256 * 1024
  }

  receive(actor: ActorContext, scope: ScopeRef, input: { id: string; workflowId: string; body: string; signature: string }): ReturnType<WorkflowService['trigger']> {
    return this.receiveKind(actor, scope, 'webhook', input)
  }

  receiveKind(actor: ActorContext, scope: ScopeRef, kind: 'webhook' | 'github' | 'slack' | 'feed', input: { id: string; workflowId: string; body: string; signature: string }): ReturnType<WorkflowService['trigger']> {
    if (Buffer.byteLength(input.body, 'utf8') > this.maxBodyBytes) throw new HiveError('WEBHOOK_TOO_LARGE', 'Webhook body exceeds the configured limit')
    const expected = createHmac('sha256', this.secret).update(input.body, 'utf8').digest('hex')
    if (expected.length !== input.signature.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(input.signature))) throw new HiveError('WEBHOOK_UNAUTHORIZED', 'Webhook signature is invalid')
    let payload: Record<string, unknown>
    try {
      const parsed = JSON.parse(input.body) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('payload must be an object')
      payload = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([key, value]) => /^[a-zA-Z0-9_.-]{1,64}$/.test(key) && ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 32))
    } catch {
      throw new HiveError('WEBHOOK_INVALID', 'Webhook body must be a JSON object with scalar fields')
    }
    return this.workflow.trigger(actor, scope, { id: input.id, kind, workflowId: input.workflowId, payload })
  }
}

export class GitHubEventAdapter {
  constructor(private readonly adapter: SignedWebhookAdapter) {}
  receive(actor: ActorContext, scope: ScopeRef, input: Parameters<SignedWebhookAdapter['receive']>[2]): ReturnType<SignedWebhookAdapter['receive']> {
    return this.adapter.receiveKind(actor, scope, 'github', input)
  }
}

export class SlackEventAdapter {
  constructor(private readonly adapter: SignedWebhookAdapter) {}
  receive(actor: ActorContext, scope: ScopeRef, input: Parameters<SignedWebhookAdapter['receive']>[2]): ReturnType<SignedWebhookAdapter['receive']> {
    return this.adapter.receiveKind(actor, scope, 'slack', input)
  }
}

export class FeedEventAdapter {
  constructor(private readonly adapter: SignedWebhookAdapter) {}
  receive(actor: ActorContext, scope: ScopeRef, input: Parameters<SignedWebhookAdapter['receive']>[2]): ReturnType<SignedWebhookAdapter['receive']> {
    return this.adapter.receiveKind(actor, scope, 'feed', input)
  }
}
