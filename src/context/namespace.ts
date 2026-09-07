import { ContextKind, ContextNamespace } from '../contracts.js'
import { HiveError } from '../errors.js'

/**
 * The namespaces a project's context root is divided into, in `ls` order. Every
 * canonical path starts with one of these, which is what lets a bare URI answer
 * "what kind of node is this?" without consulting the ledger.
 */
export const contextNamespaces: readonly ContextNamespace[] = ['experience', 'memory', 'page', 'resource', 'session', 'skill']

const namespaceSet = new Set<string>(contextNamespaces)

export function isContextNamespace(value: string): value is ContextNamespace {
  return namespaceSet.has(value)
}

/** The namespace a canonical path lives under. Paths are namespace-rooted by construction. */
export function namespaceOf(canonicalPath: string): ContextNamespace {
  const first = canonicalPath.split('/', 1)[0]
  if (!isContextNamespace(first)) {
    throw new HiveError('UNKNOWN_NAMESPACE', `Context path must start with one of: ${contextNamespaces.join(', ')}`)
  }
  return first
}

/**
 * A node's kind is its namespace. `directory` is the one kind with no namespace
 * of its own — it describes an intermediate path, never a stored document.
 */
export function kindOf(canonicalPath: string): ContextKind {
  return namespaceOf(canonicalPath)
}

/** Asserts the path is namespace-rooted and names a document, not just a namespace directory. */
export function assertNamespacedPath(canonicalPath: string): string {
  namespaceOf(canonicalPath)
  if (!canonicalPath.includes('/')) throw new HiveError('NAMESPACE_ROOT', 'A namespace directory cannot hold content directly')
  return canonicalPath
}
