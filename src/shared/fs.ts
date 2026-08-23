import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function ensureParentDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
}
