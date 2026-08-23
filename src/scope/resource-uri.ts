import { ScopeRef } from '../contracts.js'
import { HiveError } from '../errors.js'

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const PATH_PATTERN = /^[^\\/]+(?:\/[^\\/]+)*$/

export function validateScopeName(value: string, field: string): string {
  if (!NAME_PATTERN.test(value)) throw new HiveError('INVALID_NAME', `${field} is invalid`)
  return value
}

export function normalizeResourcePath(value: string): string {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('..') || !PATH_PATTERN.test(value)) {
    throw new HiveError('INVALID_PATH', 'Path must be relative, normalized, and traversal-free')
  }
  return value
}

export function assertCompleteScope(scope: Partial<ScopeRef>): ScopeRef {
  if (!scope.workspaceId || !scope.projectId || !scope.workspaceName || !scope.projectName) {
    throw new HiveError('PARTIAL_SCOPE', 'workspaceId, projectId, workspaceName, and projectName are required')
  }
  return scope as ScopeRef
}

/**
 * The single definition of the scope directory layout. Filesystem paths, Git
 * paths, and `viking://` URIs are all built from these segments so the layout
 * is spelled in exactly one place.
 */
export function scopeSegments(scope: ScopeRef): string[] {
  return [
    'workspace',
    validateScopeName(scope.workspaceName, 'workspaceName'),
    'project',
    validateScopeName(scope.projectName, 'projectName'),
  ]
}

export function createResourceUri(scope: ScopeRef, path: string): string {
  const segments = scopeSegments(scope).map(encodeURIComponent).join('/')
  return `viking://${segments}/${normalizeResourcePath(path)}`
}
