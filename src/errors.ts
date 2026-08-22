export class HiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HiveError'
  }
}

export function asResult<T>(requestId: string, operation: () => T) {
  try {
    return { version: 1 as const, requestId, ok: true as const, data: operation() }
  } catch (error) {
    const hiveError = error instanceof HiveError ? error : new HiveError('INTERNAL_ERROR', String(error))
    return {
      version: 1 as const,
      requestId,
      ok: false as const,
      error: { code: hiveError.code, message: hiveError.message },
    }
  }
}
