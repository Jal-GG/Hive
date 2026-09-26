import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { ActorContext, IngestChunk, IngestReport, IngestSource, ScopeRef } from '../contracts.js'
import { assertCapability } from '../capabilities.js'
import { HiveError } from '../errors.js'
import { Ledger } from '../ledger.js'
import { createResourceUri } from '../resource-uri.js'
import { Clock, ClockOptions, resolveClock } from '../shared.js'
import { parserFor } from './parsers.js'

/** Directory names never ingested: build output, dependencies, and the app's own state. */
export const defaultExcludedDirectories: readonly string[] = ['node_modules', '.git', 'dist', '.native-abi', '.hive']

export interface IngestOptions {
  /** Reparse everything, even unchanged files — the rebuild path after an index wipe. */
  force?: boolean
  /** Extra directory names to skip, on top of the defaults. */
  excludedDirectories?: readonly string[]
}

/**
 * Phase 6's local source accessor: one directory tree in, one scope's lexical
 * index maintained. Change detection is mtime+size first (cheap) and sha256
 * second (certain), so a re-ingest of an untouched tree reads nothing and a
 * touched-but-identical file does not reparse. The sources table is the truth;
 * the FTS index is a projection of it that can be dropped and rebuilt at will.
 */
export class IngestionPipeline {
  private readonly now: Clock

  constructor(private readonly ledger: Ledger, options: ClockOptions = {}) {
    this.now = resolveClock(options)
  }

  ingest(actor: ActorContext, scope: ScopeRef, root: string, options: IngestOptions = {}): IngestReport {
    assertCapability(actor.capabilities, 'context:write')
    const excluded = new Set([...defaultExcludedDirectories, ...(options.excludedDirectories ?? [])])
    const report: IngestReport = { added: 0, updated: 0, unchanged: 0, removed: 0, chunks: 0 }

    const files = walk(root, excluded)
    const seenUris = new Set<string>()
    for (const path of files) {
      const parser = parserFor(path)
      if (!parser) continue
      const uri = this.uriFor(scope, root, path)
      seenUris.add(uri)

      const stats = statSync(path)
      const existing = this.ledger.ingestSource(uri)
      if (!options.force && existing && existing.mtimeMs === stats.mtimeMs && existing.sizeBytes === stats.size) {
        report.unchanged += 1
        report.chunks += existing.chunkCount
        continue
      }
      const text = readFileSync(path, 'utf8')
      const sha256 = createHash('sha256').update(text).digest('hex')
      if (!options.force && existing && existing.sha256 === sha256) {
        // Same bytes, new mtime: refresh the cheap signal, skip the reparse.
        this.ledger.upsertIngestSource({ ...existing, mtimeMs: stats.mtimeMs, sizeBytes: stats.size })
        report.unchanged += 1
        report.chunks += existing.chunkCount
        continue
      }

      const parsed = parser.parse(path, text)
      const chunks: IngestChunk[] = parsed.map((chunk) => ({ uri, chunkId: chunk.chunkId, tier: chunk.tier, title: chunk.title, body: chunk.body }))
      const source: IngestSource = {
        uri,
        path,
        scope,
        sha256,
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs,
        parser: parser.id,
        chunkCount: chunks.length,
        ingestedAt: this.now().toISOString(),
      }
      this.ledger.replaceIngestChunks(uri, chunks)
      this.ledger.upsertIngestSource(source)
      if (existing) report.updated += 1
      else report.added += 1
      report.chunks += chunks.length
    }

    // Sources that vanished from the tree leave the index with the file.
    for (const source of this.ledger.listIngestSources(scope)) {
      if (seenUris.has(source.uri)) continue
      if (!files.includes(source.path) && !existsQuiet(source.path)) {
        this.ledger.removeIngestSource(source.uri)
        report.removed += 1
      }
    }
    return report
  }

  /** One scope's sources with provenance — the browseable half of the gate. */
  status(actor: ActorContext, scope?: ScopeRef): IngestSource[] {
    assertCapability(actor.capabilities, 'workspace:read')
    return this.ledger.listIngestSources(scope)
  }

  private uriFor(scope: ScopeRef, root: string, path: string): string {
    const rel = relative(root, path).split(sep).join('/')
    if (rel.startsWith('..')) throw new HiveError('SCOPE_LEAK', `Ingested file escapes its root: ${path}`)
    return createResourceUri(scope, rel)
  }
}

function walk(root: string, excluded: ReadonlySet<string>): string[] {
  const files: string[] = []
  const entries = readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      if (excluded.has(entry.name)) continue
      files.push(...walk(full, excluded))
    } else if (entry.isFile()) {
      files.push(full)
    }
  }
  return files.sort()
}

function existsQuiet(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}
