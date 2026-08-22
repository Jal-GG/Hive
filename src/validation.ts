import { randomUUID } from 'node:crypto'
import { Capability, ScopeRef } from './contracts.js'
import { HiveError } from './errors.js'

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const PATH = /^[^\\/]+(?:\/[^\\/]+)*$/

export function id(): string {
  return randomUUID()
}

export function validateName(value: string, field: string): string {
  if (!NAME.test(value)) throw new HiveError('INVALID_NAME', `${field} is invalid`)
  return value
}

export function canonicalPath(value: string): string {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('..') || !PATH.test(value)) {
    throw new HiveError('INVALID_PATH', 'Path must be relative, normalized, and traversal-free')
  }
  return value
}

export function resourceUri(scope: ScopeRef, path: string): string {
  validateName(scope.workspaceName, 'workspaceName')
  validateName(scope.projectName, 'projectName')
  return `viking://workspace/${encodeURIComponent(scope.workspaceName)}/project/${encodeURIComponent(scope.projectName)}/${canonicalPath(path)}`
}

export function requireScope(scope: Partial<ScopeRef>): ScopeRef {
  if (!scope.workspaceId || !scope.projectId || !scope.workspaceName || !scope.projectName) {
    throw new HiveError('PARTIAL_SCOPE', 'workspaceId, projectId, workspaceName, and projectName are required')
  }
  return scope as ScopeRef
}

export function requireCapability(capabilities: Capability[], capability: Capability): void {
  if (!capabilities.includes(capability)) throw new HiveError('FORBIDDEN', `Missing capability: ${capability}`)
}
