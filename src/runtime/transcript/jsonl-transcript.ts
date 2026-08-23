import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { HiveError } from '../../errors.js'

/**
 * A position inside one append-only file. Byte offsets rather than line numbers:
 * providers append while Hive reads, and a byte offset stays correct even when the
 * tail grows between two reads.
 */
export interface JsonlCursor {
  file: string
  offset: number
}

export interface JsonlLine {
  raw: string
  value: unknown
  /** Byte offset of this line's start, used to derive a stable id when the record has no key of its own. */
  offset: number
}

export interface JsonlSlice {
  lines: JsonlLine[]
  endOffset: number
  /** False when the file has more to give: the limit was hit, the read was capped, or the tail is a partial record. */
  complete: boolean
  lostCount: number
}

export const defaultTranscriptLimit = 200
const defaultMaxBytes = 4 * 1024 * 1024

export function formatCursor(cursor: JsonlCursor): string {
  return `${cursor.file}@${cursor.offset}`
}

/**
 * Cursors are handed back to callers and returned later, so a malformed one is
 * rejected rather than silently reset — resuming from offset zero would re-import
 * an entire transcript and double every entry in it.
 */
export function parseCursor(cursor?: string): JsonlCursor | undefined {
  if (cursor === undefined || cursor.length === 0) return undefined
  const separator = cursor.lastIndexOf('@')
  if (separator <= 0) throw new HiveError('INVALID_CURSOR', `Transcript cursor ${cursor} is not <file>@<offset>`)
  const offset = Number.parseInt(cursor.slice(separator + 1), 10)
  if (!Number.isInteger(offset) || offset < 0) throw new HiveError('INVALID_CURSOR', `Transcript cursor ${cursor} has no valid offset`)
  return { file: cursor.slice(0, separator), offset }
}

/**
 * Reads whole JSON lines from a byte offset without ever writing to the file.
 *
 * A trailing fragment is left unconsumed: the provider is probably mid-write, and
 * treating half a record as corruption would both lose it and inflate the loss
 * count on the next read. Records that are complete but undecodable are counted
 * instead of dropped quietly, because unmeasured loss is the failure mode C17
 * exists to prevent.
 */
export function readJsonlSlice(path: string, startOffset: number, limit = defaultTranscriptLimit, maxBytes = defaultMaxBytes): JsonlSlice {
  if (!existsSync(path)) return { lines: [], endOffset: startOffset, complete: true, lostCount: 0 }
  const size = statSync(path).size
  if (size <= startOffset) {
    // A shrunken file was rotated or rewritten in place; report the truncation instead of reading past its end.
    return { lines: [], endOffset: Math.min(startOffset, size), complete: true, lostCount: 0 }
  }
  const length = Math.min(size - startOffset, maxBytes)
  const buffer = Buffer.allocUnsafe(length)
  const fd = openSync(path, 'r')
  let read = 0
  try {
    read = readSync(fd, buffer, 0, length, startOffset)
  } finally {
    closeSync(fd)
  }

  const lines: JsonlLine[] = []
  let lostCount = 0
  let position = 0
  let consumed = 0
  while (lines.length < limit) {
    const newline = buffer.indexOf(0x0a, position)
    if (newline < 0 || newline >= read) break
    const raw = buffer.subarray(position, newline).toString('utf8').trim()
    const offset = startOffset + position
    position = newline + 1
    consumed = position
    if (raw.length === 0) continue
    try {
      lines.push({ raw, value: JSON.parse(raw), offset })
    } catch {
      lostCount += 1
    }
  }

  const endOffset = startOffset + consumed
  return { lines, endOffset, complete: endOffset === size, lostCount }
}

/** Reads a record field without trusting the provider's schema to be what it was last week. */
export function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'string' ? candidate : undefined
}

export function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined
}

export function readObject(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}
