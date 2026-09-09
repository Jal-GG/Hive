import { basename, extname } from 'node:path'
import { ContextLevel, IngestChunk } from '../contracts.js'

/** How large one L2 chunk may grow before it is split at the next boundary. */
const maxChunkChars = 2_000

export interface Parser {
  /** Provenance: recorded on the source, so every chunk can be traced to how it was read. */
  id: string
  extensions: readonly string[]
  parse(path: string, text: string): ParsedChunk[]
}

export interface ParsedChunk {
  chunkId: string
  tier: ContextLevel
  title: string
  body: string
}

/**
 * Markdown is the shape Hive's own knowledge takes, so it gets the full tier
 * treatment: the document's title is L0, its opening paragraph is L1, and every
 * section after that is L2 in document order.
 */
export const markdownParser: Parser = {
  id: 'markdown',
  extensions: ['.md', '.markdown'],
  parse(path, text) {
    const title = firstHeading(text) ?? basename(path)
    const chunks: ParsedChunk[] = [{ chunkId: 'l0', tier: 'L0', title, body: title }]
    const overview = firstParagraph(text)
    if (overview) chunks.push({ chunkId: 'l1', tier: 'L1', title, body: overview })
    for (const [index, section] of splitSections(text).entries()) {
      chunks.push({ chunkId: `l2-${index}`, tier: 'L2', title: section.title, body: section.body })
    }
    return chunks
  },
}

/** Plain text: title from the first line, overview from the leading paragraph, body in bounded slices. */
export const textParser: Parser = {
  id: 'text',
  extensions: ['.txt', '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.html', '.css'],
  parse(path, text) {
    const title = firstNonEmptyLine(text) ?? basename(path)
    const chunks: ParsedChunk[] = [{ chunkId: 'l0', tier: 'L0', title, body: title }]
    const overview = firstParagraph(text)
    if (overview) chunks.push({ chunkId: 'l1', tier: 'L1', title, body: overview })
    for (const [index, slice] of splitByChars(text, maxChunkChars).entries()) {
      chunks.push({ chunkId: `l2-${index}`, tier: 'L2', title, body: slice })
    }
    return chunks
  },
}

/**
 * Code reads in lines, so it chunks in lines: the filename is L0, and the body
 * is fixed line windows that keep functions roughly whole. No L1 — a code file
 * has no honest overview without reading it, and a fabricated one would lie.
 */
export const codeParser: Parser = {
  id: 'code',
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.sh', '.sql'],
  parse(path, text) {
    const title = basename(path)
    const chunks: ParsedChunk[] = [{ chunkId: 'l0', tier: 'L0', title, body: title }]
    const lines = text.split('\n')
    const window = 80
    for (let start = 0; start < lines.length; start += window) {
      const body = lines.slice(start, start + window).join('\n')
      if (body.trim().length === 0) continue
      chunks.push({ chunkId: `l2-${start / window}`, tier: 'L2', title, body })
    }
    return chunks
  },
}

/** JSON: top-level keys are the overview; the body is the pretty-printed whole, bounded. */
export const jsonParser: Parser = {
  id: 'json',
  extensions: ['.json'],
  parse(path, text) {
    const title = basename(path)
    const chunks: ParsedChunk[] = [{ chunkId: 'l0', tier: 'L0', title, body: title }]
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const keys = Object.keys(parsed)
        if (keys.length > 0) chunks.push({ chunkId: 'l1', tier: 'L1', title, body: `Keys: ${keys.join(', ')}` })
      }
    } catch {
      // Malformed JSON is still searchable text; the L2 chunks carry it.
    }
    for (const [index, slice] of splitByChars(text, maxChunkChars).entries()) {
      chunks.push({ chunkId: `l2-${index}`, tier: 'L2', title, body: slice })
    }
    return chunks
  },
}

const registry: readonly Parser[] = [markdownParser, textParser, codeParser, jsonParser]

export function parserFor(path: string): Parser | undefined {
  const extension = extname(path).toLowerCase()
  return registry.find((parser) => parser.extensions.includes(extension))
}

/** Every parser id the registry knows — the status surface reports provenance from here. */
export function parserIds(): string[] {
  return registry.map((parser) => parser.id)
}

function firstHeading(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const match = /^#{1,3}\s+(.*)$/.exec(line)
    if (match) return match[1].trim()
  }
  return undefined
}

function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed.slice(0, 120)
  }
  return undefined
}

function firstParagraph(text: string): string | undefined {
  const paragraph = text
    .split(/\n\s*\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0 && !candidate.startsWith('#'))
  if (!paragraph) return undefined
  return paragraph.split('\n').join(' ').slice(0, 500)
}

/** Markdown sections: each heading starts a chunk that carries its heading line and what follows. */
function splitSections(text: string): Array<{ title: string; body: string }> {
  const sections: Array<{ title: string; body: string }> = []
  const lines = text.split('\n')
  let current: { title: string; lines: string[] } | undefined
  for (const line of lines) {
    const match = /^#{1,3}\s+(.*)$/.exec(line)
    if (match) {
      if (current && current.lines.join('\n').trim().length > 0) {
        sections.push({ title: current.title, body: current.lines.join('\n').trim() })
      }
      current = { title: match[1].trim(), lines: [line] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current && current.lines.join('\n').trim().length > 0) {
    sections.push({ title: current.title, body: current.lines.join('\n').trim() })
  }
  // Oversized sections split again at paragraph boundaries so no chunk is unbounded.
  const bounded: Array<{ title: string; body: string }> = []
  for (const section of sections) {
    if (section.body.length <= maxChunkChars) {
      bounded.push(section)
      continue
    }
    for (const slice of splitByChars(section.body, maxChunkChars)) {
      bounded.push({ title: section.title, body: slice })
    }
  }
  return bounded
}

/** Character-window slicing that prefers breaking at blank lines and sentence ends. */
function splitByChars(text: string, limit: number): string[] {
  if (text.trim().length === 0) return []
  if (text.length <= limit) return [text]
  const slices: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + limit, text.length)
    if (end < text.length) {
      const window = text.slice(start, end)
      const breakAt = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '), window.lastIndexOf('\n'))
      if (breakAt > limit / 2) end = start + breakAt + 1
    }
    const slice = text.slice(start, end).trim()
    if (slice.length > 0) slices.push(slice)
    start = end
  }
  return slices
}
