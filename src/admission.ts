import { ActorContext, ScopeRef, TriggerRecord } from './contracts.js'
import { Clock } from './shared.js'

/** A kind a webhook may deliver: matching the trigger kinds the ledger can record. */
export type AdmittedKind = TriggerRecord['kind']

/**
 * Admission policy for external and scheduled triggers (§5.7).
 *
 * §5.7 puts a policy step between "classify and validate payload" and "enqueue
 * WorkItem/WorkflowRun": the trigger must pass `source, actor, spend, pause,
 * allowlist`, and a circuit breaker sits in front of it. Defaults admit
 * everything, so the gate is live but behaviour is unchanged until an operator
 * configures it — a deployment that never sets a policy cannot be surprised by
 * it, and one that does gets the refusal recorded rather than silently ignored.
 */
export interface TriggerAdmissionPolicy {
  /** Kinds admitted at the ingress. Absent means every kind is admitted. */
  allowedKinds?: readonly AdmittedKind[]
  /** Actor sources admitted, e.g. only `webhook`. Absent means every source. */
  allowedSources?: readonly ActorContext['source'][]
  /** An operator stop: every trigger is refused while paused, schedules included. */
  paused?: boolean
  /** Quota: admitted runs per rolling window. Absent or 0 disables the cap. */
  maxRunsPerWindow?: number
  windowMs?: number
  /** Cost cap in USD, checked against the configured spend source. Absent disables it. */
  spendCapUsd?: number
  /** Consecutive refusals that open the breaker. Absent or 0 disables the breaker. */
  breakerThreshold?: number
  /** How long the breaker stays open before it admits a probe. */
  breakerCooldownMs?: number
}

export type AdmissionRefusal =
  | 'paused'
  | 'kind_not_allowed'
  | 'source_not_allowed'
  | 'spend_exceeded'
  | 'quota_exceeded'
  | 'breaker_open'

export type AdmissionDecision =
  | { admitted: true }
  | { admitted: false; reason: AdmissionRefusal; detail: string }

export interface TriggerAdmissionDeps {
  now: Clock
  /** Runs admitted in this scope at or after a timestamp — the quota basis. */
  admittedSince(scope: ScopeRef, since: string): number
  /** Cost incurred in this scope, in USD. Absent means spend is never capped. */
  spend?(scope: ScopeRef): number
  /**
   * The operator's persisted policy. Read on every decision rather than cached,
   * because a pause issued from a one-shot CLI process has to reach the
   * long-running desktop that is actually admitting triggers.
   */
  readPolicy?(): TriggerAdmissionPolicy | undefined
  writePolicy?(policy: TriggerAdmissionPolicy): void
}

const defaultBreakerThreshold = 20
const defaultBreakerCooldownMs = 60_000
const defaultWindowMs = 60 * 60 * 1000

/**
 * The trigger gate. Holds the only mutable state in the decision — the breaker's
 * consecutive-refusal count and its open-until deadline — so the decision itself
 * is a pure function of the policy, the clock, and that state.
 */
export class TriggerAdmission {
  private readonly deps: TriggerAdmissionDeps
  private policy: TriggerAdmissionPolicy
  private failures = 0
  private openUntil?: number

  constructor(policy: TriggerAdmissionPolicy = {}, deps: TriggerAdmissionDeps) {
    this.policy = policy
    this.deps = deps
  }

  current(): TriggerAdmissionPolicy {
    return this.effective()
  }

  /** Breaker state, for the operator's view: open means refusals are being fast-pathed. */
  breaker(): { failures: number; openUntil?: string } {
    return { failures: this.failures, openUntil: this.openUntil === undefined ? undefined : new Date(this.openUntil).toISOString() }
  }

  setPaused(paused: boolean): TriggerAdmissionPolicy {
    return this.persist({ ...this.effective(), paused })
  }

  configure(policy: TriggerAdmissionPolicy): TriggerAdmissionPolicy {
    return this.persist({ ...this.effective(), ...policy })
  }

  /**
   * Deployment default overlaid with the operator's persisted policy, so an
   * operator stop outranks configuration without either side rewriting the other.
   */
  private effective(): TriggerAdmissionPolicy {
    return { ...this.policy, ...(this.deps.readPolicy?.() ?? {}) }
  }

  private persist(policy: TriggerAdmissionPolicy): TriggerAdmissionPolicy {
    this.policy = policy
    this.deps.writePolicy?.(policy)
    return policy
  }

  /**
   * Decides, and moves the breaker. A refusal is what the breaker counts, and an
   * admission is what resets it, so the two cannot drift apart across callers.
   */
  evaluate(actor: ActorContext, scope: ScopeRef, kind: AdmittedKind): AdmissionDecision {
    const now = this.deps.now().getTime()
    const policy = this.effective()

    // The breaker short-circuits before every other check, and does not count its
    // own refusals: counting them would keep it open forever after one bad burst.
    const openUntil = this.openUntil
    if (openUntil !== undefined) {
      if (now < openUntil) return this.refuse('breaker_open', `Circuit breaker open until ${new Date(openUntil).toISOString()}`)
      // Cooldown elapsed: close it and let this call act as the probe.
      this.openUntil = undefined
      this.failures = 0
    }

    if (policy.paused) return this.refuse('paused', 'Trigger ingress is paused')
    if (policy.allowedKinds && !policy.allowedKinds.includes(kind)) {
      return this.refuse('kind_not_allowed', `Kind ${kind} is not in the ingress allowlist`)
    }
    if (policy.allowedSources && !policy.allowedSources.includes(actor.source)) {
      return this.refuse('source_not_allowed', `Source ${actor.source} is not in the ingress allowlist`)
    }

    const spendCap = policy.spendCapUsd
    if (spendCap !== undefined && this.deps.spend) {
      const spent = this.deps.spend(scope)
      if (spent >= spendCap) return this.refuse('spend_exceeded', `Spend ${spent.toFixed(4)} USD has reached the ${spendCap} USD cap`)
    }

    const quota = policy.maxRunsPerWindow
    if (quota !== undefined && quota > 0) {
      const since = new Date(now - (policy.windowMs ?? defaultWindowMs)).toISOString()
      const admitted = this.deps.admittedSince(scope, since)
      if (admitted >= quota) return this.refuse('quota_exceeded', `${admitted} runs admitted in the window, quota is ${quota}`)
    }

    this.failures = 0
    return { admitted: true }
  }

  private refuse(reason: AdmissionRefusal, detail: string): AdmissionDecision {
    // A breaker-open refusal is the breaker's own state, not a fresh failure.
    if (reason !== 'breaker_open') {
      this.failures += 1
      const policy = this.effective()
      const threshold = policy.breakerThreshold ?? defaultBreakerThreshold
      if (threshold > 0 && this.failures >= threshold) {
        this.openUntil = this.deps.now().getTime() + (policy.breakerCooldownMs ?? defaultBreakerCooldownMs)
      }
    }
    return { admitted: false, reason, detail }
  }
}
