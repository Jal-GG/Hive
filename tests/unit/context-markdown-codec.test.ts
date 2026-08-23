import { describe, expect, it } from 'vitest'
import { ContextNode } from '../../src/contracts.js'
import { ContextMarkdownCodec } from '../../src/context/markdown-codec.js'
import { HiveError } from '../../src/errors.js'

const codec = new ContextMarkdownCodec()
const scope = { workspaceId: 'w', projectId: 'p', workspaceName: 'main', projectName: 'hive' }

function pageNode(body: string, overrides: Partial<ContextNode> = {}): ContextNode {
  return {
    uri: 'viking://workspace/main/project/hive/page/readme.md',
    scope,
    kind: 'page',
    level: 'L2',
    title: 'readme',
    body,
    tags: ['docs'],
    links: [],
    provenance: { sourceType: 'user', sourceId: 'test', createdAt: '2026-08-22T00:00:00.000Z', transformationChain: [], trust: 'approved' },
    pinned: false,
    sha256: codec.hash(body),
    version: 1,
    ...overrides,
  }
}

describe('ContextMarkdownCodec', () => {
  it('round-trips frontmatter and body', () => {
    const node = pageNode('# Hello')
    const decoded = codec.decode(scope, 'page/readme.md', codec.encode(node))
    expect(decoded.node.body).toBe('# Hello')
    expect(decoded.node.sha256).toBe(node.sha256)
    expect(decoded.node.title).toBe('readme')
    expect(decoded.node.tags).toEqual(['docs'])
    expect(decoded.bodyModified).toBe(false)
  })

  it('encodes byte-identically for an unchanged node', () => {
    const node = pageNode('# Hello')
    expect(codec.encode(node)).toBe(codec.encode({ ...node }))
  })

  it('derives kind from the path, not from frontmatter', () => {
    // A file that moved namespaces cannot keep claiming its old kind.
    const encoded = codec.encode(pageNode('body'))
    expect(codec.decode(scope, 'memory/note.md', encoded).node.kind).toBe('memory')
  })

  it('detects a body edited outside Hive through the recorded hash', () => {
    const encoded = codec.encode(pageNode('original'))
    const tampered = encoded.replace(/original$/, 'replaced')
    const decoded = codec.decode(scope, 'page/readme.md', tampered)
    expect(decoded.bodyModified).toBe(true)
    expect(decoded.recordedSha256).toBe(codec.hash('original'))
    expect(decoded.node.sha256).toBe(codec.hash('replaced'))
  })

  it('rejects frontmatter that is missing, malformed, or the wrong shape', () => {
    expect(() => codec.decode(scope, 'page/readme.md', 'no frontmatter')).toThrowError(HiveError)
    expect(() => codec.decode(scope, 'page/readme.md', '---\n{not json}\n---\nbody')).toThrowError('valid JSON')
    expect(() => codec.decode(scope, 'page/readme.md', '---\n{"title":"t"}\n---\nbody')).toThrowError('level must be')
    expect(() => codec.decode(scope, 'page/readme.md', '---\n{"title":"t","level":"L2","version":0,"pinned":false,"tags":[],"links":[],"provenance":{}}\n---\nb')).toThrowError('positive integer')
  })
})
