import { join } from 'node:path'
import { AgentProfile, TranscriptEntry, TranscriptSlice } from '../../contracts.js'
import { redactText } from '../redaction.js'
import { TranscriptAdapter, TranscriptReadRequest } from '../runtime-adapter.js'
import { defaultTranscriptLimit, formatCursor, parseCursor, readJsonlSlice, readNumber, readString } from './jsonl-transcript.js'

/** Where the fake provider's "native" store lives, relative to a run's working directory. */
export const fakeTranscriptPath = join('.hive', 'fake-transcript.jsonl')

/**
 * The fake provider's transcript store, in the same read-only shape as a real one.
 *
 * It exists so the import path — cursors, partial tails, undecodable lines, loss
 * counting — is exercised on every machine, not only where a provider CLI happens
 * to be installed and has happened to run.
 */
export class FakeTranscriptAdapter implements TranscriptAdapter {
  readonly id = 'fake_transcript'
  readonly schema = 'hive.fake_transcript/1'
  private readonly limit: number

  constructor(options: { limit?: number } = {}) {
    this.limit = options.limit ?? defaultTranscriptLimit
  }

  supports(profile: AgentProfile): boolean {
    return profile.transcriptAdapter === this.id || profile.provider === 'fake'
  }

  read(request: TranscriptReadRequest): TranscriptSlice {
    const cursor = parseCursor(request.cursor)
    const file = cursor?.file ?? 'fake-transcript'
    const slice = readJsonlSlice(join(request.cwd, fakeTranscriptPath), cursor?.offset ?? 0, request.limit ?? this.limit)
    const entries: TranscriptEntry[] = []
    for (const line of slice.lines) {
      const text = readString(line.value, 'text')
      if (text === undefined) continue
      entries.push({
        id: readString(line.value, 'id') ?? `${file}:${line.offset}`,
        role: normalizeRole(readString(line.value, 'role')),
        text: redactText(text),
        occurredAt: readString(line.value, 'at'),
        tokensIn: readNumber(line.value, 'tokensIn'),
        tokensOut: readNumber(line.value, 'tokensOut'),
      })
    }
    return { schema: this.schema, entries, cursor: formatCursor({ file, offset: slice.endOffset }), lostCount: slice.lostCount, complete: slice.complete }
  }
}

function normalizeRole(role: string | undefined): TranscriptEntry['role'] {
  return role === 'user' || role === 'assistant' || role === 'tool' || role === 'system' ? role : 'unknown'
}
