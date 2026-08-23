import { describe, expect, it } from 'vitest'
import { assertCompleteScope, createResourceUri, normalizeResourcePath } from '../../src/resource-uri.js'
import { HiveError } from '../../src/errors.js'

describe('resource URI policy', () => {
  it('creates a stable URI from a complete scope', () => {
    const scope = { workspaceId: 'w', projectId: 'p', workspaceName: 'main', projectName: 'hive' }
    expect(createResourceUri(scope, 'docs/readme.md')).toBe('viking://workspace/main/project/hive/docs/readme.md')
  })

  it('rejects traversal and incomplete scopes', () => {
    expect(() => normalizeResourcePath('../secret')).toThrowError(HiveError)
    expect(() => assertCompleteScope({ workspaceId: 'w' })).toThrowError(HiveError)
  })
})
