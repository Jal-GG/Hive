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
    return failure(requestId, error)
  }
}

/** The same envelope for operations that have to await something, so async surfaces report failures identically. */
export async function asAsyncResult<T>(requestId: string, operation: () => Promise<T>): Promise<ResultEnvelope<T>> {
  try {
    return { version: 1, requestId, ok: true, data: await operation() }
  } catch (error) {
    return failure(requestId, error)
  }
}

function failure(requestId: string, error: unknown): ResultEnvelope<never> {
  const hiveError = error instanceof HiveError ? error : new HiveError('INTERNAL_ERROR', String(error))
  return { version: 1, requestId, ok: false, error: { code: hiveError.code, message: hiveError.message } }
}
