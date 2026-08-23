import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function createId(): string {
  return randomUUID()
}

export type Clock = () => Date

export interface ClockOptions {
  now?: Clock
}

export function resolveClock(options: ClockOptions = {}): Clock {
  return options.now ?? (() => new Date())
}

export function ensureParentDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
}
