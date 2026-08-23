import { describe, expect, it } from 'vitest'
import { assertNamespacedPath, kindOf, namespaceOf } from '../../src/context/namespace.js'
import { classifyLinks } from '../../src/context/links.js'
import { compileGlob, matchesGlob } from '../../src/context/glob.js'
import { HiveError } from '../../src/errors.js'

const scope = { workspaceId: 'w', projectId: 'p', workspaceName: 'main', projectName: 'hive' }

describe('context namespaces', () => {
  it('derives the namespace and kind from the first path segment', () => {
    expect(namespaceOf('memory/notes/today.md')).toBe('memory')
    expect(kindOf('skill/review.md')).toBe('skill')
  })

  it('rejects paths outside the known namespaces', () => {
    expect(() => namespaceOf('docs/readme.md')).toThrowError('must start with one of')
  })

  it('refuses content stored directly at a namespace root', () => {
    expect(() => assertNamespacedPath('page')).toThrowError('cannot hold content directly')
    expect(assertNamespacedPath('page/readme.md')).toBe('page/readme.md')
  })
})

describe('context globs', () => {
  it('keeps * and ? inside one segment', () => {
    expect(matchesGlob('page/*.md', 'page/readme.md')).toBe(true)
    expect(matchesGlob('page/*.md', 'page/guides/readme.md')).toBe(false)
    expect(matchesGlob('page/????.md', 'page/spec.md')).toBe(true)
  })

  it('crosses segments with ** and matches zero segments for **/', () => {
    expect(matchesGlob('page/**/*.md', 'page/a/b/c.md')).toBe(true)
    expect(matchesGlob('page/**/*.md', 'page/c.md')).toBe(true)
    expect(matchesGlob('**/notes.md', 'memory/deep/notes.md')).toBe(true)
  })

  it('matches case-sensitively regardless of the host filesystem', () => {
    expect(matchesGlob('page/README.md', 'page/readme.md')).toBe(false)
  })

  it('treats regex metacharacters in the pattern as literals', () => {
    expect(compileGlob('page/a+b.md').test('page/a+b.md')).toBe(true)
    expect(compileGlob('page/a+b.md').test('page/aab.md')).toBe(false)
  })
})

describe('context links', () => {
  it('classifies same-project and cross-project links', () => {
    const links = classifyLinks(scope, 'page/readme.md', [
      'viking://workspace/main/project/hive/memory/note.md',
      'viking://workspace/main/project/other/page/spec.md',
    ])
    expect(links.map((link) => link.crossProject)).toEqual([false, true])
    expect(links[0].fromUri).toBe('viking://workspace/main/project/hive/page/readme.md')
  })

  it('rejects a link that leaves the workspace', () => {
    expect(() => classifyLinks(scope, 'page/readme.md', ['viking://workspace/other/project/hive/page/spec.md'])).toThrowError('leaves workspace')
  })

  it('rejects self-links and non-viking targets', () => {
    expect(() => classifyLinks(scope, 'page/readme.md', ['viking://workspace/main/project/hive/page/readme.md'])).toThrowError('cannot link to itself')
    expect(() => classifyLinks(scope, 'page/readme.md', ['https://example.com/doc'])).toThrowError(HiveError)
  })

  it('collapses duplicate targets to one link', () => {
    const links = classifyLinks(scope, 'page/readme.md', [
      'viking://workspace/main/project/hive/memory/note.md',
      'viking://workspace/main/project/hive/memory/note.md',
    ])
    expect(links).toHaveLength(1)
  })
})
