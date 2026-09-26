import { ActorContext, HiveStatusSnapshot, RunState, ScopeRef, VoiceOutcome, VoiceTurnResult, WorkItemStatus } from './contracts.js'
import { assertCapability } from './capabilities.js'
import { HiveError } from './errors.js'
import { Ledger } from './ledger.js'
import { Clock, ClockOptions, createId, resolveClock } from './shared.js'
import { ObservabilityService } from './observability.js'
import { WorkflowService } from './workflow.js'

const liveRunStates: readonly RunState[] = ['spawning', 'running', 'idle', 'completing']
const liveWorkStates: readonly WorkItemStatus[] = ['assigned', 'in_progress', 'review']

/** The operations voice may reach, and whether they change state. Everything else is out of vocabulary. */
export type VoiceOperation =
  | 'status' | 'runs' | 'work' | 'queues' | 'admission' | 'triggers'
  | 'pause' | 'resume' | 'trigger' | 'cancel'

const voiceOperations: ReadonlyArray<{ operation: VoiceOperation; action: boolean; phrases: readonly RegExp[] }> = [
  { operation: 'status', action: false, phrases: [/^status$/, /how are (things|we) doing/, /give me (the )?status/] },
  { operation: 'runs', action: false, phrases: [/^(show|list) (me )?(the )?runs/, /^runs$/, /what.s (running|live)/] },
  { operation: 'work', action: false, phrases: [/^(show|list) (me )?(the )?(work|tasks|board)/, /^(work|tasks)$/] },
  { operation: 'queues', action: false, phrases: [/^(show|list) (me )?(the )?queues/, /^queues$/, /queue (depths|diagnostics)/] },
  { operation: 'admission', action: false, phrases: [/^(show )?(admission|ingress)( state)?$/, /is (the )?ingress (paused|live)/] },
  { operation: 'triggers', action: false, phrases: [/^(show|list) (me )?(the )?triggers/, /^triggers$/] },
  { operation: 'pause', action: true, phrases: [/^pause( (the )?(triggers|ingress))?$/] },
  { operation: 'resume', action: true, phrases: [/^resume( (the )?(triggers|ingress))?$/, /^unpause( (the )?(triggers|ingress))?$/] },
  { operation: 'trigger', action: true, phrases: [/^(run|trigger|start) workflow (?<workflowId>[a-z0-9][a-z0-9._-]*)/] },
  { operation: 'cancel', action: true, phrases: [/^cancel (the )?(run|workflow run) (?<runId>[a-z0-9][a-z0-9-]*)/] },
]

export interface VoiceOperatorOptions extends ClockOptions {
  ledger: Ledger
  workflows: WorkflowService
  observability: ObservabilityService
  scope: ScopeRef
  /** Cost incurred in the scope, USD. Absent means voice has no spend basis and actions are uncapped. */
  spend?: (scope: ScopeRef) => number
  /** Actions are refused at or above this spend (§7 Phase 8 "spend controls"). Reads are never spend-capped. */
  spendCapUsd?: number
}

/**
 * The optional voice operator (§7 Phase 8): an utterance, already transcribed
 * by whatever realtime provider an operator configured, resolved onto the same
 * capability-checked services the CLI and desktop use.
 *
 * Deliberately deterministic: a keyword grammar, not a model. §4.1 rules that
 * no correctness may depend on model behavior, and §5.7 rules that realtime
 * voice can call only the same capability-checked operator commands — so this
 * class is a narrow router over those commands, and the transcription provider
 * is outside it entirely. A voice provider that fails takes nothing with it,
 * because nothing else depends on this class at all.
 */
export class VoiceOperator {
  private readonly ledger: Ledger
  private readonly workflows: WorkflowService
  private readonly observability: ObservabilityService
  private readonly scope: ScopeRef
  private readonly spend?: (scope: ScopeRef) => number
  private readonly spendCapUsd?: number
  private readonly now: Clock

  constructor(options: VoiceOperatorOptions) {
    this.ledger = options.ledger
    this.workflows = options.workflows
    this.observability = options.observability
    this.scope = options.scope
    this.spend = options.spend
    this.spendCapUsd = options.spendCapUsd
    this.now = resolveClock(options)
  }

  /** The allowlist itself, so a surface can tell an operator exactly what voice can say. */
  vocabulary(): Array<{ operation: VoiceOperation; action: boolean }> {
    return voiceOperations.map(({ operation, action }) => ({ operation, action }))
  }

  turn(actor: ActorContext, utterance: string): VoiceTurnResult {
    const occurredAt = this.now().toISOString()
    const normalized = utterance.trim().toLowerCase().replace(/[.!?]+$/, '')
    const parsed = this.parse(normalized)
    if (!parsed) {
      return { utterance, outcome: { kind: 'refused', reason: 'unrecognized', detail: `No voice operation matches: ${normalized.slice(0, 120)}` }, occurredAt }
    }
    const { operation, action, named } = parsed
    if (action && this.spend !== undefined && this.spendCapUsd !== undefined) {
      const spent = this.spend(this.scope)
      if (spent >= this.spendCapUsd) {
        return { utterance, parsedOperation: operation, outcome: { kind: 'refused', reason: 'spend_exceeded', detail: `Spend ${spent.toFixed(4)} USD has reached the voice cap ${this.spendCapUsd} USD` }, occurredAt }
      }
    }
    try {
      return { utterance, parsedOperation: operation, outcome: { kind: 'answered', operation, data: this.execute(actor, operation, named) }, occurredAt }
    } catch (error) {
      // A refusal from the capability check or the service is the answer, not a crash.
      const detail = error instanceof HiveError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)
      return { utterance, parsedOperation: operation, outcome: { kind: 'refused', reason: 'command_refused', detail }, occurredAt }
    }
  }

  private parse(normalized: string): { operation: VoiceOperation; action: boolean; named: Record<string, string> } | undefined {
    for (const entry of voiceOperations) {
      for (const phrase of entry.phrases) {
        const match = phrase.exec(normalized)
        if (match) return { operation: entry.operation, action: entry.action, named: (match.groups ?? {}) as Record<string, string> }
      }
    }
    return undefined
  }

  /** Every branch calls the real service; every real service re-checks capability. */
  private execute(actor: ActorContext, operation: VoiceOperation, named: Record<string, string>): unknown {
    switch (operation) {
      case 'status':
        assertCapability(actor.capabilities, 'workspace:read')
        return this.status(actor)
      case 'runs':
        assertCapability(actor.capabilities, 'runtime:read')
        return this.ledger.listRuns(this.scope).map((run) => ({ id: run.id, branch: run.branch, state: run.state }))
      case 'work':
        assertCapability(actor.capabilities, 'workspace:read')
        return this.ledger.listWorkItems(this.scope).map((item) => ({ id: item.id, title: item.title, status: item.status }))
      case 'queues':
        return this.observability.queueDiagnostics(actor, this.scope)
      case 'admission':
        assertCapability(actor.capabilities, 'workspace:read')
        return this.workflows.admissionState()
      case 'triggers':
        assertCapability(actor.capabilities, 'workspace:read')
        return this.ledger.listTriggers(this.scope).slice(0, 20)
      case 'pause':
        assertCapability(actor.capabilities, 'work:mutate')
        return this.workflows.setPaused(actor, this.scope, true)
      case 'resume':
        assertCapability(actor.capabilities, 'work:mutate')
        return this.workflows.setPaused(actor, this.scope, false)
      case 'trigger': {
        assertCapability(actor.capabilities, 'work:dispatch')
        const workflowId = named.workflowId
        if (!workflowId) throw new HiveError('VOICE_INVALID', 'Trigger needs a workflow id')
        return this.workflows.trigger(actor, this.scope, { id: `voice:${createId()}`, kind: 'manual', workflowId })
      }
      case 'cancel': {
        assertCapability(actor.capabilities, 'work:mutate')
        const runId = named.runId
        if (!runId) throw new HiveError('VOICE_INVALID', 'Cancel needs a run id')
        return this.workflows.cancel(actor, runId)
      }
    }
  }

  /** The same snapshot the dashboard serves, so voice and dash never disagree. */
  private status(actor: ActorContext): HiveStatusSnapshot {
    const runs = this.ledger.listRuns(this.scope)
    const items = this.ledger.listWorkItems(this.scope)
    const admission = this.workflows.admissionState()
    const hourAgo = new Date(this.now().getTime() - 60 * 60 * 1000).toISOString()
    return {
      version: '0.1.0',
      scope: { workspace: this.scope.workspaceName, project: this.scope.projectName },
      runs: { live: runs.filter((run) => liveRunStates.includes(run.state)).length, total: runs.length },
      work: {
        open: items.filter((item) => item.status === 'open' || item.status === 'blocked').length,
        inFlight: items.filter((item) => liveWorkStates.includes(item.status)).length,
        total: items.length,
      },
      queues: this.observability.queueDiagnostics(actor, this.scope),
      triggerIngress: {
        paused: admission.policy.paused === true,
        breakerFailures: admission.breaker.failures,
        recentAccepted: this.ledger.listTriggers(this.scope).filter((trigger) => trigger.state === 'accepted' && trigger.createdAt >= hourAgo).length,
      },
      telemetryEnabled: this.observability.isEnabled(),
    }
  }
}

export type { VoiceOutcome, VoiceTurnResult }
