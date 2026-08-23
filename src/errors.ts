import { ResultEnvelope } from './contracts.js'

export class HiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HiveError'
  }
}

export function asResult<T>(requestId: string, operation: () => T): ResultEnvelope<T> {
  try {
    return { version: 1, requestId, ok: true, data: operation() }
  } catch (error) {
    const hiveError = error instanceof HiveError ? error : new HiveError('INTERNAL_ERROR', String(error))
    return { version: 1, requestId, ok: false, error: { code: hiveError.code, message: hiveError.message } }
  }
}
