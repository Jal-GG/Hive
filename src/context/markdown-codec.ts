import { createHash } from 'node:crypto'
import { ContextLevel, ContextNode, ContextProvenance, ScopeRef } from '../contracts.js'
import { HiveError } from '../errors.js'
import { createResourceUri } from '../resource-uri.js'
import { kindOf } from './namespace.js'

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/
const LEVELS: readonly string[] = ['L0', 'L1', 'L2']

/**
 * What frontmatter carries. `uri`, `scope`, and `kind` are omitted because the
 * file's canonical path already determines them — a document cannot claim to
 * live somewhere it does not. `sha256` is recorded but advisory: the
 * authoritative hash is always recomputed from the body on read.
 */
export interface StoredFrontMatter {
  level: ContextLevel
  title: string
  abstract?: string
  overview?: string
  tags: string[]
  links: string[]
  sourceUri?: string
  provenance: ContextProvenance
  expiresAt?: string
  pinned: boolean
  sha256?: string
  version: number
}

export interface DecodedContextNode {
  node: ContextNode
  /** The hash Hive recorded when it last wrote the file, if the file carries one. */
  recordedSha256?: string
  /** True when the body on disk no longer hashes to `recordedSha256` — an edit Hive did not make. */
  bodyModified: boolean
}

export class ContextMarkdownCodec {
  /**
   * Keys are emitted in a fixed order so an unchanged node always encodes to
   * identical bytes, which keeps hashes and Git diffs stable.
   */
  encode(node: ContextNode): string {
    const frontMatter: StoredFrontMatter = {
      level: node.level,
      title: node.title,
      abstract: node.abstract,
      overview: node.overview,
      tags: [...node.tags],
      links: [...node.links],
      sourceUri: node.sourceUri,
      provenance: {
        sourceType: node.provenance.sourceType,
        sourceId: node.provenance.sourceId,
        actorId: node.provenance.actorId,
        createdAt: node.provenance.createdAt,
        transformationChain: [...node.provenance.transformationChain],
        trust: node.provenance.trust,
      },
      expiresAt: node.expiresAt,
      pinned: node.pinned,
      sha256: node.sha256,
      version: node.version,
    }
    return `---\n${JSON.stringify(frontMatter, null, 2)}\n---\n${node.body ?? ''}`
  }

  decode(scope: ScopeRef, path: string, text: string): DecodedContextNode {
    const match = FRONT_MATTER.exec(text)
    if (!match) throw new HiveError('INVALID_FRONTMATTER', 'Context file must contain frontmatter')
    let parsed: unknown
    try {
      parsed = JSON.parse(match[1])
    } catch {
      throw new HiveError('INVALID_FRONTMATTER', 'Context frontmatter must be valid JSON')
    }
    const frontMatter = this.validate(parsed)
    const body = match[2]
    const sha256 = this.hash(body)
    return {
      node: {
        uri: createResourceUri(scope, path),
        scope,
        // The path is canonical, so it — not the frontmatter — decides the kind.
        kind: kindOf(path),
        level: frontMatter.level,
        title: frontMatter.title,
        abstract: frontMatter.abstract,
        overview: frontMatter.overview,
        body,
        tags: frontMatter.tags,
        links: frontMatter.links,
        sourceUri: frontMatter.sourceUri,
        provenance: frontMatter.provenance,
        expiresAt: frontMatter.expiresAt,
        pinned: frontMatter.pinned,
        sha256,
        version: frontMatter.version,
      },
      recordedSha256: frontMatter.sha256,
      bodyModified: frontMatter.sha256 !== undefined && frontMatter.sha256 !== sha256,
    }
  }

  hash(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex')
  }

  /** Externally edited frontmatter is untrusted input, so shape is checked before use. */
  private validate(parsed: unknown): StoredFrontMatter {
    if (typeof parsed !== 'object' || parsed === null) throw invalid('frontmatter must be a JSON object')
    const candidate = parsed as Record<string, unknown>
    if (typeof candidate.title !== 'string' || candidate.title.length === 0) throw invalid('title is required')
    if (typeof candidate.level !== 'string' || !LEVELS.includes(candidate.level)) throw invalid('level must be L0, L1, or L2')
    if (!Number.isInteger(candidate.version) || (candidate.version as number) < 1) throw invalid('version must be a positive integer')
    if (typeof candidate.pinned !== 'boolean') throw invalid('pinned must be a boolean')
    if (!isStringArray(candidate.tags)) throw invalid('tags must be an array of strings')
    if (!isStringArray(candidate.links)) throw invalid('links must be an array of strings')
    if (typeof candidate.provenance !== 'object' || candidate.provenance === null) throw invalid('provenance is required')
    return candidate as unknown as StoredFrontMatter
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function invalid(reason: string): HiveError {
  return new HiveError('INVALID_FRONTMATTER', `Context frontmatter is invalid: ${reason}`)
}
