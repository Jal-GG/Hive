import { describe, expect, it } from 'vitest'
import { ContextMarkdownCodec } from '../../src/context/markdown/context-markdown-codec.js'

describe('ContextMarkdownCodec', () => {
  it('round-trips frontmatter and body', () => {
    const codec = new ContextMarkdownCodec()
    const scope = { workspaceId: 'w', projectId: 'p', workspaceName: 'main', projectName: 'hive' }
    const node = {
      uri: 'viking://workspace/main/project/hive/readme.md', scope, kind: 'page' as const, level: 'L2' as const,
      title: 'readme', body: '# Hello', tags: ['docs'], links: [], provenance: { sourceType: 'user' as const, sourceId: 'test', createdAt: '2026-08-22T00:00:00.000Z', transformationChain: [], trust: 'approved' as const }, pinned: false, sha256: codec.hash('# Hello'), version: 1,
    }
    const restored = codec.decode(scope, 'readme.md', codec.encode(node))
    expect(restored.body).toBe('# Hello')
    expect(restored.sha256).toBe(node.sha256)
    expect(restored.title).toBe('readme')
  })
})
