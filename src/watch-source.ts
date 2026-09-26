import { createHash } from 'node:crypto'
import { ScopeRef } from './contracts.js'
import { Ledger } from './ledger.js'
import type { WorkflowWatchSource } from './workflow.js'

/**
 * The ledger-backed watch source: a watch observes context through the index
 * the canonical filesystem maintains, so the fingerprint is derived state over
 * the same rows every other reader sees — never a second copy of content.
 *
 * The digest is order-stable (rows sorted by URI), so two passes over the same
 * content produce the same fingerprint regardless of row iteration order.
 */
export class LedgerWatchSource implements WorkflowWatchSource {
  constructor(private readonly ledger: Ledger) {}

  fingerprint(scope: ScopeRef, uriPrefix: string): string {
    const digest = createHash('sha256')
    let seen = 0
    for (const node of this.ledger.listContextNodes(scope).sort((a, b) => (a.uri < b.uri ? -1 : 1))) {
      if (!node.uri.startsWith(uriPrefix)) continue
      digest.update(`${node.uri}\t${node.sha256}\t${node.version}\n`)
      seen += 1
    }
    if (seen === 0) throw new Error(`No context nodes under ${uriPrefix}`)
    return `${seen}:${digest.digest('hex')}`
  }
}
