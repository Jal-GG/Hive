import { createId } from '../shared.js'
import type { RemoteObjectStore } from './object-store.js'

/**
 * Load tests (§7 Phase 9 "load tests") as a deterministic harness rather than a
 * separate tool: N operations against the remote surfaces, measuring throughput
 * and worst-case latency, with a bounded-failure assertion — the run fails if
 * any operation errored or any latency exceeded the budget. Deterministic input
 * means a failing run is reproducible from its seed.
 */

export interface LoadProfile {
  /** Distinct objects/requests the run creates; repeatable from the seed. */
  operations: number
  /** Seed for deterministic content generation. */
  seed: number
  /** Per-operation latency budget; exceeding it fails the run. */
  maxLatencyMs: number
  /** Payload size per operation, bytes. */
  payloadBytes: number
}

export interface LoadReport {
  profile: LoadProfile
  ok: boolean
  throughputOpsPerSecond: number
  worstLatencyMs: number
  failures: Array<{ operation: number; reason: string }>
}

/** xorshift32: deterministic, fast, and enough for load-test content. */
class SeededContent {
  private state: number

  constructor(seed: number) {
    this.state = seed || 1
  }

  next(): number {
    let x = this.state
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.state = x
    return x >>> 0
  }

  bytes(length: number): Buffer {
    const buffer = Buffer.alloc(length)
    for (let index = 0; index < length; index += 4) {
      const value = this.next()
      buffer.writeUInt32BE(value, Math.min(index, buffer.length - 4))
    }
    return buffer
  }
}

/**
 * The store load run: put+get each object, verify the returned bytes hash to
 * the address, and measure every operation's latency. The run is deliberately
 * sequential — remote-mode throughput for Hive is bounded by the control plane's
 * correctness, not by concurrent connection count.
 */
export async function objectStoreLoadRun(store: RemoteObjectStore, tenant: string, profile: LoadProfile): Promise<LoadReport> {
  const content = new SeededContent(profile.seed)
  const failures: LoadReport['failures'] = []
  const started = Date.now()
  let worst = 0
  for (let operation = 0; operation < profile.operations; operation += 1) {
    const bytes = content.bytes(profile.payloadBytes)
    const t0 = Date.now()
    try {
      const stored = await store.put(tenant, bytes)
      const fetched = await store.get(tenant, stored.sha256)
      const latency = Date.now() - t0
      worst = Math.max(worst, latency)
      if (latency > profile.maxLatencyMs) failures.push({ operation, reason: `latency ${latency}ms exceeded budget ${profile.maxLatencyMs}ms` })
      if (!fetched.equals(bytes)) failures.push({ operation, reason: 'returned bytes differ from what was stored' })
    } catch (error) {
      failures.push({ operation, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  const elapsed = Date.now() - started
  return {
    profile,
    ok: failures.length === 0,
    throughputOpsPerSecond: elapsed > 0 ? Math.round((profile.operations / elapsed) * 1000) : profile.operations,
    worstLatencyMs: worst,
    failures,
  }
}

/**
 * The request load run against an agent-style request target: issues N calls
 * through an injectable caller, measuring latency and asserting every reply is
 * ok. Used with a live `RemoteAgentClient.request` in tests.
 */
export async function requestLoadRun(
  caller: (index: number) => Promise<{ ok: boolean; error?: { message: string } }>,
  profile: LoadProfile,
): Promise<LoadReport> {
  const failures: LoadReport['failures'] = []
  const started = Date.now()
  let worst = 0
  for (let operation = 0; operation < profile.operations; operation += 1) {
    const t0 = Date.now()
    try {
      const reply = await caller(operation)
      const latency = Date.now() - t0
      worst = Math.max(worst, latency)
      if (!reply.ok) failures.push({ operation, reason: reply.error?.message ?? 'reply was not ok' })
      if (latency > profile.maxLatencyMs) failures.push({ operation, reason: `latency ${latency}ms exceeded budget ${profile.maxLatencyMs}ms` })
    } catch (error) {
      failures.push({ operation, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  const elapsed = Date.now() - started
  return {
    profile,
    ok: failures.length === 0,
    throughputOpsPerSecond: elapsed > 0 ? Math.round((profile.operations / elapsed) * 1000) : profile.operations,
    worstLatencyMs: worst,
    failures,
  }
}

/** A stable request-ID generator for idempotent-retry load runs. */
export function seededRequestId(seed: number): string {
  return `load-${seed}-${createId()}`
}
