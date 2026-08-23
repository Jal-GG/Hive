import { RuntimeExit } from '../contracts.js'
import { HiveError } from '../errors.js'
import { Clock } from '../shared.js'
import { Unsubscribe } from './runtime-adapter.js'

const defaultScrollbackBytes = 256 * 1024

export interface SessionOutputOptions {
  now: Clock
  /** Regular-expression source that marks the provider ready; absent means ready on spawn. */
  readyPattern?: string
  scrollbackBytes?: number
}

/**
 * The bookkeeping every backend needs and none of them should re-invent: a
 * bounded scrollback buffer, byte counters, readiness detection, listener
 * fan-out, and a single settled exit status.
 *
 * Listeners are replayed the retained buffer on subscribe, so attaching a
 * terminal view to a run already in flight shows the session instead of an empty
 * pane, and the order in which a caller subscribes stops mattering.
 */
export class SessionOutput {
  private readonly now: Clock
  private readonly readyPattern?: RegExp
  private readonly limit: number
  private readonly dataListeners = new Set<(chunk: string) => void>()
  private readonly exitListeners = new Set<(exit: RuntimeExit) => void>()
  private readonly readyWaiters: { resolve: () => void; reject: (error: Error) => void }[] = []
  private readonly exitWaiters: ((exit: RuntimeExit) => void)[] = []
  private buffer = ''
  /** Matched against a sliding window so a ready marker split across chunks is still seen. */
  private pending = ''

  bytesOut = 0
  bytesIn = 0
  lastOutputAt?: string
  ready: boolean
  exit?: RuntimeExit

  constructor(private readonly startedAt: string, options: SessionOutputOptions) {
    this.now = options.now
    this.readyPattern = options.readyPattern === undefined ? undefined : new RegExp(options.readyPattern)
    this.limit = options.scrollbackBytes ?? defaultScrollbackBytes
    this.ready = this.readyPattern === undefined
  }

  push(chunk: string): void {
    if (chunk.length === 0) return
    this.bytesOut += Buffer.byteLength(chunk)
    this.lastOutputAt = this.now().toISOString()
    this.buffer = truncateStart(this.buffer + chunk, this.limit)
    this.detectReady(chunk)
    for (const listener of this.dataListeners) listener(chunk)
  }

  /** Input is counted, never retained: what an operator types can contain credentials. */
  countInput(data: string): void {
    this.bytesIn += Buffer.byteLength(data)
  }

  /** Idempotent: the first exit wins, so a kill racing a natural exit reports one status. */
  finish(exit: RuntimeExit): void {
    if (this.exit) return
    this.exit = exit
    // An unready session that exits must not leave `ready()` pending forever.
    this.rejectReadyWaiters(new HiveError('RUNTIME_EXITED', 'Session exited before becoming ready'))
    for (const listener of this.exitListeners) listener(exit)
    for (const waiter of this.exitWaiters.splice(0)) waiter(exit)
  }

  onData(listener: (chunk: string) => void): Unsubscribe {
    if (this.buffer.length > 0) listener(this.buffer)
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }

  onExit(listener: (exit: RuntimeExit) => void): Unsubscribe {
    if (this.exit) {
      listener(this.exit)
      return () => undefined
    }
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  waitForReady(timeoutMs?: number): Promise<void> {
    if (this.ready) return Promise.resolve()
    if (this.exit) return Promise.reject(new HiveError('RUNTIME_EXITED', 'Session exited before becoming ready'))
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      const waiter = {
        resolve: () => {
          if (timer) clearTimeout(timer)
          resolve()
        },
        reject: (error: Error) => {
          if (timer) clearTimeout(timer)
          reject(error)
        },
      }
      this.readyWaiters.push(waiter)
      if (timeoutMs === undefined) return
      timer = setTimeout(() => {
        const index = this.readyWaiters.indexOf(waiter)
        if (index >= 0) this.readyWaiters.splice(index, 1)
        waiter.reject(new HiveError('RUNTIME_NOT_READY', `Provider did not signal readiness within ${timeoutMs}ms`))
      }, timeoutMs)
      // Unreferenced so a pending readiness check never holds the process open.
      timer.unref()
    })
  }

  waitForExit(): Promise<RuntimeExit> {
    if (this.exit) return Promise.resolve(this.exit)
    return new Promise((resolve) => this.exitWaiters.push(resolve))
  }

  scrollback(): string {
    return this.buffer
  }

  /** Milliseconds since the last output, or since spawn when there has been none. */
  idleMs(): number {
    const since = this.lastOutputAt ?? this.startedAt
    return Math.max(0, this.now().getTime() - new Date(since).getTime())
  }

  private detectReady(chunk: string): void {
    if (this.ready || !this.readyPattern) return
    this.pending = truncateStart(this.pending + chunk, 4096)
    if (!this.readyPattern.test(this.pending)) return
    this.ready = true
    this.pending = ''
    for (const waiter of this.readyWaiters.splice(0)) waiter.resolve()
  }

  private rejectReadyWaiters(error: Error): void {
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(error)
  }
}

function truncateStart(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(text.length - limit)
}
