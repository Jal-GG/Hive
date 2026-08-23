export type Clock = () => Date

export interface ClockOptions {
  now?: Clock
}

export function resolveClock(options: ClockOptions = {}): Clock {
  return options.now ?? (() => new Date())
}
