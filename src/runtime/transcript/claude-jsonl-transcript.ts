import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { AgentProfile, TranscriptEntry, TranscriptSlice } from '../../contracts.js'
import { redactText } from '../redaction.js'
import { TranscriptAdapter, TranscriptReadRequest } from '../runtime-adapter.js'
import { defaultTranscriptLimit, formatCursor, parseCursor, readJsonlSlice, readNumber, readObject, readString } from './jsonl-transcript.js'

export interface ClaudeTranscriptOptions {
  /** Overridden in tests; in production this is `CLAUDE_CONFIG_DIR` or `~/.claude`. */
  configDir?: string
  home?: string
  limit?: number
}

/**
 * Claude Code keeps one JSONL file per session under a directory named after the
 * working directory, with every non-alphanumeric character replaced by a dash.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * Read-only import of Claude Code's own session files (C17).
 *
 * There is no write path here by design. The native format is private, rewrites
 * itself in place, and gains fields between releases; the only durable posture is
 * to read what can be decoded, report what cannot, and never become the reason a
 * user's provider history is damaged. The schema string is versioned so a stored
 * entry always says which reading produced it.
 */
export class ClaudeJsonlTranscriptAdapter implements TranscriptAdapter {
  readonly id = 'claude_jsonl'
  readonly schema = 'claude_code.jsonl/1'
  private readonly configDir: string
  private readonly limit: number

  constructor(options: ClaudeTranscriptOptions = {}) {
    this.configDir = options.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(options.home ?? homedir(), '.claude')
    this.limit = options.limit ?? defaultTranscriptLimit
  }

  supports(profile: AgentProfile): boolean {
    return profile.transcriptAdapter === this.id || profile.provider === 'claude'
  }

  read(request: TranscriptReadRequest): TranscriptSlice {
    const directory = join(this.configDir, 'projects', claudeProjectSlug(request.cwd))
    const cursor = parseCursor(request.cursor)
    const file = cursor?.file ?? newestTranscriptFile(directory)
    if (!file) return { schema: this.schema, entries: [], lostCount: 0, complete: true }

    const path = join(directory, file)
    const slice = readJsonlSlice(path, cursor?.offset ?? 0, request.limit ?? this.limit)
    const entries: TranscriptEntry[] = []
    for (const line of slice.lines) {
      const entry = toEntry(line.value, file, line.offset)
      if (entry) entries.push(entry)
      // Records that are valid JSON but carry no message (summaries, meta rows) are
      // skipped rather than counted: nothing was lost, there was nothing to import.
    }
    return {
      schema: this.schema,
      entries,
      cursor: formatCursor({ file, offset: slice.endOffset }),
      lostCount: slice.lostCount,
      complete: slice.complete,
    }
  }
}

/** Newest by modification time, since a provider may keep several sessions for one directory. */
function newestTranscriptFile(directory: string): string | undefined {
  if (!existsSync(directory)) return undefined
  const candidates = readdirSync(directory)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => ({ name, modifiedAt: statSync(join(directory, name)).mtimeMs }))
    .sort((left, right) => right.modifiedAt - left.modifiedAt || left.name.localeCompare(right.name))
  return candidates[0]?.name
}

function toEntry(value: unknown, file: string, offset: number): TranscriptEntry | undefined {
  const message = readObject(value, 'message')
  const type = readString(value, 'type')
  if (message === undefined && type !== 'system') return undefined

  const role = normalizeRole(readString(message, 'role') ?? type)
  const text = extractText(readObject(message, 'content') ?? readObject(value, 'content'))
  if (text.length === 0) return undefined

  const usage = readObject(message, 'usage')
  return {
    // The provider's own uuid when it has one, so re-reading an overlapping range
    // is recognised as the same entry instead of appended twice.
    id: readString(value, 'uuid') ?? `${basename(file, '.jsonl')}:${offset}`,
    role,
    text: redactText(text),
    occurredAt: readString(value, 'timestamp'),
    tokensIn: readNumber(usage, 'input_tokens'),
    tokensOut: readNumber(usage, 'output_tokens'),
  }
}

function normalizeRole(role: string | undefined): TranscriptEntry['role'] {
  switch (role) {
    case 'user':
      return 'user'
    case 'assistant':
      return 'assistant'
    case 'tool':
    case 'tool_result':
      return 'tool'
    case 'system':
      return 'system'
    default:
      return 'unknown'
  }
}

/** Content is a string in older records and a block array in newer ones; both still appear in one file. */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const blockType = readString(block, 'type')
    if (blockType === 'text') {
      const text = readString(block, 'text')
      if (text) parts.push(text)
      continue
    }
    if (blockType === 'tool_use') {
      parts.push(`[tool ${readString(block, 'name') ?? 'unknown'}]`)
      continue
    }
    if (blockType === 'tool_result') {
      const nested = readObject(block, 'content')
      const text = typeof nested === 'string' ? nested : extractText(nested)
      if (text) parts.push(text)
      continue
    }
    if (blockType === 'thinking') {
      // Deliberately not imported: reasoning text is the provider's, not the record's.
      continue
    }
  }
  return parts.join('\n').trim()
}
