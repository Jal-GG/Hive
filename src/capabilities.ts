import { Capability } from './contracts.js'
import { HiveError } from './errors.js'

export function assertCapability(capabilities: Capability[], required: Capability): void {
  if (!capabilities.includes(required)) {
    throw new HiveError('FORBIDDEN', `Missing capability: ${required}`)
  }
}
