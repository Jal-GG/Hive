/**
 * Phase 5's scheduler: wake-based ticks, nothing else.
 *
 * Every task is a self-rescheduling `setTimeout` chain rather than an interval,
 * and every timer is unref'd: the process sleeps when nothing is due, and a
 * slow tick pushes the next wake-up back instead of piling up. The ticks
 * themselves are idempotent passes (supervision, rest, requeue), so a missed or
 * doubled wake-up costs nothing but a redundant look.
 */
export interface ScheduledTask {
  name: string
  intervalMs: number
  run(): void | Promise<void>
}

export class Scheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly tasks = new Map<string, ScheduledTask>()
  private stopped = false

  /** Registers a task and starts its wake-up chain. Registering twice reschedules it. */
  schedule(task: ScheduledTask): void {
    this.cancel(task.name)
    this.tasks.set(task.name, task)
    this.stopped = false
    this.arm(task)
  }

  /** Stops every chain. A stopped scheduler stays stopped until something is scheduled again. */
  stop(): void {
    this.stopped = true
    for (const name of [...this.timers.keys()]) this.cancel(name)
  }

  names(): string[] {
    return [...this.tasks.keys()].sort()
  }

  private arm(task: ScheduledTask): void {
    if (this.stopped) return
    const timer = setTimeout(() => {
      this.timers.delete(task.name)
      void Promise.resolve(task.run())
        .catch(() => undefined)
        .then(() => this.arm(task))
    }, task.intervalMs)
    // Unref'd: the tick never holds the process open (§7 Phase 5, "all wake-ups idle-tick-based").
    timer.unref?.()
    this.timers.set(task.name, timer)
  }

  private cancel(name: string): void {
    const timer = this.timers.get(name)
    if (timer) clearTimeout(timer)
    this.timers.delete(name)
  }
}
