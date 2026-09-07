import { ScopeRef } from './contracts.js'
import { HiveError } from './errors.js'

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const PATH_PATTERN = /^[^\\/]+(?:\/[^\\/]+)*$/
const URI_PATTERN = /^viking:\/\/workspace\/([^/]+)\/project\/([^/]+)\/(.+)$/

/** The parts of a `viking://` URI, before any scope is resolved to UUIDs. */
export interface ResourceUriParts {
  workspaceName: string
  projectName: string
  path: string
}

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
  return buildResourceUri(scope.workspaceName, scope.projectName, path)
}

/**
 * Re-encodes already-parsed parts, so two spellings of the same target collapse
 * to one canonical URI. Used for links, whose targets may name another project
 * and therefore have no `ScopeRef` of their own.
 */
export function resourceUriFromParts(parts: ResourceUriParts): string {
  return buildResourceUri(parts.workspaceName, parts.projectName, parts.path)
}

function buildResourceUri(workspaceName: string, projectName: string, path: string): string {
  const segments = ['workspace', validateScopeName(workspaceName, 'workspaceName'), 'project', validateScopeName(projectName, 'projectName')]
  return `viking://${segments.map(encodeURIComponent).join('/')}/${normalizeResourcePath(path)}`
}

/** The inverse of `createResourceUri`. Canonicalizes before returning, per §6.1. */
export function parseResourceUri(uri: string): ResourceUriParts {
  const match = URI_PATTERN.exec(uri)
  if (!match) throw new HiveError('INVALID_URI', 'URI must be viking://workspace/{workspace}/project/{project}/{path}')
  return {
    workspaceName: validateScopeName(decodeURIComponent(match[1]), 'workspaceName'),
    projectName: validateScopeName(decodeURIComponent(match[2]), 'projectName'),
    path: normalizeResourcePath(match[3]),
  }
}

export function isSameScope(scope: ScopeRef, parts: ResourceUriParts): boolean {
  return scope.workspaceName === parts.workspaceName && scope.projectName === parts.projectName
}
