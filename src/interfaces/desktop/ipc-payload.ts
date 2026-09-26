import { HiveError } from '../../errors.js'

/**
 * Payload coercion shared by the IPC namespaces. Every value a renderer sends is
 * untrusted, so each field is read through one of these rather than cast: a
 * wrong-typed field becomes a named argument error, not a service call with
 * garbage in it (C16: no renderer-provided value is trusted without validation).
 */
export function payloadOf(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
}

export function required(payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  if (typeof value !== 'string' || value === '') throw new HiveError('MISSING_ARGUMENT', `${field} is required`)
  return value
}

export function optional(payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field]
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function whole(payload: Record<string, unknown>, field: string): number | undefined {
  const value = payload[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new HiveError('INVALID_ARGUMENT', `${field} must be a non-negative integer`)
  }
  return value
}

export function strings(payload: Record<string, unknown>, field: string): string[] | undefined {
  const value = payload[field]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new HiveError('INVALID_ARGUMENT', `${field} must be a list of strings`)
  }
  return value as string[]
}
