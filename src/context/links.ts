import { ContextLinkRef, ScopeRef } from '../contracts.js'
import { HiveError } from '../errors.js'
import { createResourceUri, isSameScope, parseResourceUri, resourceUriFromParts } from '../resource-uri.js'
import { assertNamespacedPath } from './namespace.js'

/**
 * Validates the outbound links of one node and classifies each one.
 *
 * C3 makes the workspace the outer authorization boundary, so a link that leaves
 * the workspace is a scope violation and is rejected at write time. A link to a
 * sibling project in the same workspace is allowed but recorded as
 * cross-project, so it can be audited and re-checked during reconciliation.
 * `resolved` is left false here — only the filesystem and index can answer it.
 */
export function classifyLinks(scope: ScopeRef, fromPath: string, links: readonly string[]): ContextLinkRef[] {
  const fromUri = createResourceUri(scope, fromPath)
  const seen = new Set<string>()
  const classified: ContextLinkRef[] = []
  for (const link of links) {
    const parts = parseResourceUri(link)
    if (parts.workspaceName !== scope.workspaceName) {
      throw new HiveError('SCOPE_VIOLATION', `Link leaves workspace ${scope.workspaceName}: ${link}`)
    }
    assertNamespacedPath(parts.path)
    const toUri = resourceUriFromParts(parts)
    if (toUri === fromUri) throw new HiveError('SELF_LINK', 'A context node cannot link to itself')
    if (seen.has(toUri)) continue
    seen.add(toUri)
    classified.push({ fromUri, toUri, crossProject: !isSameScope(scope, parts), resolved: false })
  }
  return classified
}
