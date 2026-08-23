import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ContextFilesystem } from '../../src/context-filesystem.js'
import { HiveError } from '../../src/errors.js'
import { ledgerWithActors, tempDirectory, testActor } from '../fixtures.js'

const writer = testActor('writer-1', ['context:read', 'context:write'])
const reader = testActor('reader-1', ['context:read'], 'viewer')

function setup() {
  const ledger = ledgerWithActors(writer, reader)
  const workspaceId = ledger.createWorkspace('main')
  const projectId = ledger.createProject(workspaceId, 'hive')
  const scope = { workspaceId, projectId, workspaceName: 'main', projectName: 'hive' }
  return { ledger, scope, fs: new ContextFilesystem(tempDirectory('context'), ledger) }
}

describe('Phase 2 context filesystem', () => {
  it('writes frontmatter-backed nodes and lists deterministic URIs', () => {
    const { ledger, scope, fs } = setup()
    const node = fs.write(writer, scope, { path: 'docs/readme.md', body: '# Hello', tags: ['docs'] })
    expect(node.uri).toBe('viking://workspace/main/project/hive/docs/readme.md')
    expect(fs.read(reader, scope, 'docs/readme.md').body).toBe('# Hello')
    expect(fs.list(reader, scope, 'docs').map((entry) => entry.uri)).toEqual([node.uri])
    expect(ledger.auditCount('context.write')).toBe(1)
    ledger.close()
  })

  it('increments versions and rejects unauthorized mutations', () => {
    const { ledger, scope, fs } = setup()
    const first = fs.write(writer, scope, { path: 'memory.md', body: 'one' })
    const second = fs.write(writer, scope, { path: 'memory.md', body: 'two' })
    expect(second.version).toBe(first.version + 1)
    expect(() => fs.write(reader, scope, { path: 'blocked.md', body: 'no' })).toThrowError(HiveError)
    expect(() => fs.list(testActor('anon', []), scope)).toThrowError('Missing capability')
    ledger.close()
  })

  it('reconciles externally edited Markdown into the derived ledger index', () => {
    const { ledger, scope, fs } = setup()
    const node = fs.write(writer, scope, { path: 'external.md', body: 'before' })
    const file = join(fs.getRoot(), 'workspace', 'main', 'project', 'hive', 'external.md')
    writeFileSync(file, `---\n${JSON.stringify({ ...node, body: undefined }, null, 2)}\n---\nafter`, 'utf8')
    expect(fs.reconcile(writer, scope)).toBe(1)
    expect(fs.read(reader, scope, 'external.md').body).toBe('after')
    expect(ledger.contextNodeHash(node.uri)).not.toBe(node.sha256)
    ledger.close()
  })

  it('removes nodes and records the deletion', () => {
    const { ledger, scope, fs } = setup()
    fs.write(writer, scope, { path: 'remove.md', body: 'gone' })
    fs.remove(writer, scope, 'remove.md')
    expect(() => fs.read(reader, scope, 'remove.md')).toThrowError('does not exist')
    expect(ledger.auditCount('context.delete')).toBe(1)
    ledger.close()
  })
})
