import { ActorContext, ContextLevel, ScopeRef, SearchHit } from '../contracts.js'
import { assertCapability } from '../capabilities.js'
import { Ledger, RankedChunk } from '../ledger.js'

/** RRF's smoothing constant: rank 1 in one list beats rank 2 in every list, but not by much. */
export const rrfK = 60

export interface SearchOptions {
  /** Restrict results to these tiers; absent means every tier, best-fused first. */
  tiers?: readonly ContextLevel[]
  limit?: number
}

/**
 * Reciprocal rank fusion: each list votes 1/(k + rank) for what it ranked, and
 * the votes add. Rank order is the only thing a list contributes — scores from
 * different retrieval functions are not comparable, and pretending otherwise
 * is how one path silently dominates the merge.
 */
export function reciprocalRankFusion<T>(lists: readonly (readonly T[])[], keyOf: (item: T) => string, k = rrfK): Array<{ item: T; score: number }> {
  const scores = new Map<string, { item: T; score: number }>()
  for (const list of lists) {
    list.forEach((item, index) => {
      const key = keyOf(item)
      const entry = scores.get(key) ?? { item, score: 0 }
      entry.score += 1 / (k + index + 1)
      scores.set(key, entry)
    })
  }
  return [...scores.values()].sort((a, b) => b.score - a.score || (keyOf(a.item) < keyOf(b.item) ? -1 : 1))
}

/**
 * The deterministic lexical path: BM25 over the FTS index, two column rankings
 * (title and body) fused by RRF, tier-filtered, scoped to one project. Same
 * query, same index, same answer — every time, on every machine.
 */
export class Searcher {
  constructor(private readonly ledger: Ledger) {}

  search(actor: ActorContext, scope: ScopeRef, query: string, options: SearchOptions = {}): SearchHit[] {
    assertCapability(actor.capabilities, 'context:read')
    const terms = query.trim().split(/\s+/).filter((term) => term.length > 0)
    if (terms.length === 0) return []
    const limit = options.limit ?? 20
    const tierFilter = options.tiers && options.tiers.length === 1 ? options.tiers[0] : undefined

    const match = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' ')
    // Two rankings of the same index: a title hit is a strong signal about what
    // a chunk *is*; a body hit says what it *mentions*. RRF blends the votes
    // without letting either scale dominate.
    const byTitle = this.ledger.searchIngestChunks(`{title}: ${match}`, scope, tierFilter, limit)
    const byBody = this.ledger.searchIngestChunks(`{body}: ${match}`, scope, tierFilter, limit)
    const fused = reciprocalRankFusion(
      [byTitle, byBody],
      (chunk) => `${chunk.uri}#${chunk.chunkId}`,
    )
    const wanted = new Set(options.tiers ?? [])
    return fused
      .filter(({ item }) => wanted.size === 0 || wanted.has(item.tier))
      .slice(0, limit)
      .map(({ item, score }) => ({
        uri: item.uri,
        chunkId: item.chunkId,
        tier: item.tier,
        title: item.title,
        snippet: snippetOf(item, byTitle, byBody),
        score,
      }))
  }
}

/** The snippet from whichever list actually ranked the chunk; title-only matches still show a window. */
function snippetOf(chunk: RankedChunk, ...lists: Array<readonly RankedChunk[]>): string {
  for (const list of lists) {
    const found = list.find((candidate) => candidate.uri === chunk.uri && candidate.chunkId === chunk.chunkId)
    if (found && found.snippet.length > 0) return found.snippet
  }
  return chunk.snippet
}
