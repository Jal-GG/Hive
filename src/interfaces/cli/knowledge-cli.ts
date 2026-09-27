import { ActorContext, ContextLevel } from '../../contracts.js'
import { HiveError } from '../../errors.js'
import { Ledger } from '../../ledger.js'
import { IngestionPipeline } from '../../ingest/pipeline.js'
import { Searcher } from '../../search/searcher.js'
import { SessionStore } from '../../session/store.js'

export interface KnowledgeCliSurfaces {
  ledger: Ledger
  ingest: IngestionPipeline
  search: Searcher
  sessions: SessionStore
}

const operations = ['ingest', 'status', 'search', 'sessions', 'session', 'replay', 'summary'] as const
type KnowledgeOperation = (typeof operations)[number]

/**
 * `hive knowledge <operation> [--flag value]` — the Phase 6 surfaces: ingest a
 * source tree, search it lexically with tier filters, and walk sessions by
 * cursor. JSON out, composable with every other CLI surface.
 */
export async function runKnowledgeCli(surfaces: KnowledgeCliSurfaces, actor: ActorContext, argv: readonly string[]): Promise<string> {
  const [operation, ...rest] = argv
  if (operation === undefined || operation === '--help' || operation === 'help') return usage()
  if (!operations.includes(operation as KnowledgeOperation)) {
    throw new HiveError('UNKNOWN_OPERATION', `Unknown knowledge operation: ${operation}\n\n${usage()}`)
  }
  const scope = surfaces.ledger.resolveScope(flagValue(rest, '--workspace') ?? 'main', flagValue(rest, '--project') ?? 'hive')

  switch (operation as KnowledgeOperation) {
    case 'ingest': {
      const root = requireValue('--path', flagValue(rest, '--path'))
      const report = surfaces.ingest.ingest(actor, scope, root, { force: rest.includes('--force') })
      return render(report)
    }
    case 'status': {
      const sources = surfaces.ingest.status(actor, scope)
      return render(sources.map((source) => ({
        uri: source.uri, parser: source.parser, chunks: source.chunkCount, ingestedAt: source.ingestedAt,
      })))
    }
    case 'search': {
      const query = requireValue('--query', flagValue(rest, '--query'))
      const tiers = repeatable(rest, '--tier') as ContextLevel[]
      const limit = optionalNumber(rest, '--limit')
      const hits = surfaces.search.search(actor, scope, query, { tiers, limit })
      return render(hits)
    }
    case 'sessions': {
      return render(surfaces.sessions.list(actor, scope))
    }
    case 'session': {
      return render(surfaces.sessions.session(actor, positional(rest)))
    }
    case 'replay': {
      const sessionId = positional(rest)
      const after = optionalNumber(rest, '--after') ?? 0
      const page = surfaces.sessions.replay(actor, sessionId, after)
      return render({ cursor: page.cursor, events: page.events.map((event) => ({
        sequence: event.sequence, type: event.eventType, key: event.idempotencyKey, occurredAt: event.occurredAt,
      })) })
    }
    case 'summary': {
      const record = surfaces.sessions.session(actor, positional(rest))
      return render({ summary: record.summary, overview: record.overview, capturedAt: record.capturedAt })
    }
  }
}

export function usage(): string {
  return [
    'Usage: hive knowledge <operation> [id] [options]',
    '',
    'Ingestion (context:write):',
    '  ingest               Index a source tree (--path required, --force to rebuild)',
    '  status               Ingested sources with parser provenance',
    '',
    'Search (context:read):',
    '  search               Lexical search, RRF-fused (--query required, --tier L0|L1|L2 repeatable, --limit)',
    '',
    'Sessions (workspace:read):',
    '  sessions             Captured sessions, newest first',
    '  session <id>         One session record',
    '  replay <id>          A session\'s events by cursor (--after sequence)',
    '  summary <id>         The stored L0 summary and L1 overview',
    '',
    'Options:',
    '  --workspace <name>   Workspace name (default main)',
    '  --project <name>     Project name (default hive)',
  ].join('\n')
}

function positional(argv: readonly string[]): string {
  const first = argv.find((argument) => !argument.startsWith('--'))
  if (!first) throw new HiveError('MISSING_ARGUMENT', 'A session id is required')
  return first
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new HiveError('MISSING_ARGUMENT', `${flag} needs a value`)
  return value
}

function repeatable(argv: readonly string[], flag: string): string[] {
  const values: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== flag) continue
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new HiveError('MISSING_ARGUMENT', `${flag} needs a value`)
    values.push(value)
    index += 1
  }
  return values
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value === '') throw new HiveError('MISSING_ARGUMENT', `${flag} is required`)
  return value
}

function optionalNumber(argv: readonly string[], flag: string): number | undefined {
  const value = flagValue(argv, flag)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new HiveError('INVALID_ARGUMENT', `${flag} must be a non-negative integer`)
  return parsed
}

function render(data: unknown): string {
  return JSON.stringify(data, null, 2)
}
