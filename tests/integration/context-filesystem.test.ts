import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HiveError } from '../../src/errors.js'
import { contextFileName, contextHarness, editBodyOutsideHive, testActor } from '../fixtures.js'

const writer = testActor('writer-1', ['context:read', 'context:write'])
const reader = testActor('reader-1', ['context:read'], 'viewer')
const archivist = testActor('archivist-1', ['context:read', 'context:write', 'backup:create'])
const actors = [writer, reader, archivist]

/** Git costs a handful of subprocesses per write, so tests that never look at history skip it. */
function withoutGit() {
  return contextHarness(actors, { initializeGit: false })
}

describe('context filesystem — writes and layout', () => {
  it('writes frontmatter-backed nodes under namespace-rooted URIs', () => {
    const { ledger, scope, fs, close } = withoutGit()
    const node = fs.write(writer, scope, { path: 'page/readme.md', body: '# Hello', tags: ['docs'] })
    expect(node.uri).toBe('viking://workspace/main/project/hive/page/readme.md')
    expect(node.kind).toBe('page')
    expect(fs.read(reader, scope, 'page/readme.md').body).toBe('# Hello')
    expect(fs.list(reader, scope, 'page').map((entry) => entry.uri)).toEqual([node.uri])
    expect(ledger.contextNode(node.uri)?.sha256).toBe(node.sha256)
    expect(ledger.auditCount('context.write')).toBe(1)
    close()
  })

  it('derives the kind from the namespace the path names', () => {
    const { scope, fs, close } = withoutGit()
    expect(fs.write(writer, scope, { path: 'memory/today.md', body: 'x' }).kind).toBe('memory')
    expect(fs.write(writer, scope, { path: 'skill/review.md', body: 'y' }).kind).toBe('skill')
    close()
  })

  it('rejects paths outside a namespace and content at a namespace root', () => {
    const { scope, fs, close } = withoutGit()
    expect(() => fs.write(writer, scope, { path: 'docs/readme.md', body: 'x' })).toThrowError('must start with one of')
    expect(() => fs.write(writer, scope, { path: 'page', body: 'x' })).toThrowError('cannot hold content directly')
    expect(() => fs.write(writer, scope, { path: '../escape.md', body: 'x' })).toThrowError('traversal-free')
    close()
  })

  it('increments versions and refuses unauthorized callers', () => {
    const { scope, fs, close } = withoutGit()
    const first = fs.write(writer, scope, { path: 'memory/note.md', body: 'one' })
    const second = fs.write(writer, scope, { path: 'memory/note.md', body: 'two' })
    expect(second.version).toBe(first.version + 1)
    expect(() => fs.write(reader, scope, { path: 'page/blocked.md', body: 'no' })).toThrowError(HiveError)
    expect(() => fs.list(testActor('anon', []), scope)).toThrowError('Missing capability')
    close()
  })

  it('emits a Context event with a deterministic idempotency key per file operation', () => {
    const { ledger, scope, fs, close } = withoutGit()
    const node = fs.write(writer, scope, { path: 'page/readme.md', body: 'x' })
    const events = ledger.readEvents()
    expect(events).toHaveLength(1)
    expect(events[0].eventType).toBe('Context')
    expect(events[0].idempotencyKey).toBe(`context:write:${node.uri}:1`)
    expect(events[0].scope?.projectId).toBe(scope.projectId)
    close()
  })
})

describe('context filesystem — deterministic navigation', () => {
  function populated() {
    const harness = withoutGit()
    harness.fs.write(writer, harness.scope, { path: 'page/readme.md', body: '# Hive\nalpha line' })
    harness.fs.write(writer, harness.scope, { path: 'page/guides/setup.md', body: 'beta line' })
    harness.fs.write(writer, harness.scope, { path: 'memory/today.md', body: 'gamma line' })
    return harness
  }

  it('lists one level with directories first, then names', () => {
    const { scope, fs, close } = populated()
    expect(fs.list(reader, scope, 'page').map((entry) => entry.name)).toEqual(['guides', 'readme.md'])
    expect(fs.list(reader, scope).map((entry) => entry.name)).toEqual(['memory', 'page'])
    close()
  })

  it('walks the tree and honours a depth limit', () => {
    const { scope, fs, close } = populated()
    const shallow = fs.tree(reader, scope, 'page', 1)
    expect(shallow.map((entry) => entry.path)).toEqual(['page/guides', 'page/readme.md'])
    expect(shallow[0].children).toEqual([])
    const deep = fs.tree(reader, scope, 'page')
    expect(deep[0].children?.map((entry) => entry.path)).toEqual(['page/guides/setup.md'])
    close()
  })

  it('stats a node against its frontmatter and the derived index', () => {
    const { scope, fs, close } = populated()
    const stat = fs.stat(reader, scope, 'page/readme.md')
    expect(stat.namespace).toBe('page')
    expect(stat.bodyModified).toBe(false)
    expect(stat.indexInSync).toBe(true)
    expect(stat.expired).toBe(false)
    expect(stat.bytes).toBeGreaterThan(0)
    close()
  })

  it('reports an expired node without deleting it', () => {
    const { scope, fs, close } = withoutGit()
    fs.write(writer, scope, { path: 'session/old.md', body: 'x', expiresAt: '2020-01-01T00:00:00.000Z' })
    expect(fs.stat(reader, scope, 'session/old.md').expired).toBe(true)
    close()
  })

  it('globs, finds by path, and greps bodies without matching frontmatter', () => {
    const { scope, fs, close } = populated()
    expect(fs.glob(reader, scope, 'page/**/*.md')).toEqual(['page/guides/setup.md', 'page/readme.md'])
    expect(fs.glob(reader, scope, 'page/*.md')).toEqual(['page/readme.md'])
    expect(fs.find(reader, scope, 'today')).toEqual(['memory/today.md'])
    expect(fs.grep(reader, scope, 'beta').map((match) => match.path)).toEqual(['page/guides/setup.md'])
    // "title" appears only in frontmatter, which grep does not search.
    expect(fs.grep(reader, scope, 'title')).toEqual([])
    expect(fs.grep(reader, scope, 'ALPHA', { ignoreCase: true })).toHaveLength(1)
    expect(fs.grep(reader, scope, 'line', { path: 'memory' }).map((match) => match.path)).toEqual(['memory/today.md'])
    close()
  })

  it('rejects an unusable grep pattern rather than matching nothing', () => {
    const { scope, fs, close } = populated()
    expect(() => fs.grep(reader, scope, '([')).toThrowError('valid regular expression')
    close()
  })
})

describe('context filesystem — rename, delete, restore', () => {
  it('renames a node, moving its index row and bumping its version', () => {
    const { ledger, scope, fs, close } = withoutGit()
    const before = fs.write(writer, scope, { path: 'page/draft.md', body: 'text' })
    const after = fs.rename(writer, scope, 'page/draft.md', 'page/final.md')
    expect(after.uri).toBe('viking://workspace/main/project/hive/page/final.md')
    expect(after.version).toBe(before.version + 1)
    expect(ledger.contextNode(before.uri)).toBeUndefined()
    expect(ledger.contextNode(after.uri)?.version).toBe(after.version)
    expect(fs.read(reader, scope, 'page/final.md').body).toBe('text')
    close()
  })

  it('refuses a rename onto an existing node', () => {
    const { scope, fs, close } = withoutGit()
    fs.write(writer, scope, { path: 'page/a.md', body: 'a' })
    fs.write(writer, scope, { path: 'page/b.md', body: 'b' })
    expect(() => fs.rename(writer, scope, 'page/a.md', 'page/b.md')).toThrowError('already exists')
    expect(() => fs.rename(writer, scope, 'page/a.md', 'page/a.md')).toThrowError('same')
    close()
  })

  it('records a tombstone on delete so absence is provably a deletion', () => {
    const { ledger, scope, fs, close } = contextHarness(actors)
    const node = fs.write(writer, scope, { path: 'page/gone.md', body: 'bye' })
    const tombstone = fs.remove(writer, scope, 'page/gone.md')
    expect(tombstone.uri).toBe(node.uri)
    expect(tombstone.version).toBe(node.version)
    expect(tombstone.commit).toBeTypeOf('string')
    expect(ledger.contextNode(node.uri)).toBeUndefined()
    expect(fs.tombstones(reader, scope).map((entry) => entry.uri)).toEqual([node.uri])
    expect(() => fs.read(reader, scope, 'page/gone.md')).toThrowError('does not exist')
    expect(ledger.auditCount('context.delete')).toBe(1)
    close()
  })

  it('restores a deleted node from the commit before its deletion', () => {
    const { ledger, scope, fs, close } = contextHarness(actors)
    fs.write(writer, scope, { path: 'page/gone.md', body: 'first' })
    const deleted = fs.write(writer, scope, { path: 'page/gone.md', body: 'second' })
    fs.remove(writer, scope, 'page/gone.md')

    const restored = fs.restore(writer, scope, 'page/gone.md')
    expect(restored.body).toBe('second')
    expect(restored.version).toBeGreaterThan(deleted.version)
    expect(fs.tombstones(reader, scope)).toEqual([])
    expect(ledger.contextNode(restored.uri)?.sha256).toBe(restored.sha256)
    // Restoring twice is not possible: the tombstone is gone and the file is back.
    expect(() => fs.restore(writer, scope, 'page/gone.md')).toThrowError('No tombstone')
    close()
  })

  it('refuses to restore a node that was never deleted', () => {
    const { scope, fs, close } = contextHarness(actors)
    expect(() => fs.restore(writer, scope, 'page/never.md')).toThrowError('No tombstone')
    close()
  })
})

describe('context filesystem — reconciliation (definition of done)', () => {
  it('adopts a Markdown edit made outside Hive without losing the newest bytes', () => {
    const { ledger, scope, fs, close } = contextHarness(actors)
    const before = fs.write(writer, scope, { path: 'page/external.md', body: 'before' })
    editBodyOutsideHive(fs, scope, 'page/external.md', 'after')
    expect(fs.stat(reader, scope, 'page/external.md').bodyModified).toBe(true)

    const report = fs.reconcile(writer, scope)
    expect(report).toMatchObject({ scanned: 1, indexed: 0, reindexed: 1, removed: 0, resurrected: 0 })
    expect(fs.read(reader, scope, 'page/external.md').body).toBe('after')

    const stat = fs.stat(reader, scope, 'page/external.md')
    expect(stat.bodyModified).toBe(false)
    expect(stat.indexInSync).toBe(true)
    expect(stat.version).toBeGreaterThan(before.version)
    expect(fs.read(reader, scope, 'page/external.md').provenance.transformationChain).toContain('external-edit')
    expect(ledger.contextNode(before.uri)?.sha256).not.toBe(before.sha256)

    // Convergent: a second pass has nothing left to do.
    expect(fs.reconcile(writer, scope)).toMatchObject({ scanned: 1, indexed: 0, reindexed: 0 })
    close()
  })

  it('reconciles a crash between the file rename and the index update', () => {
    const { ledger, scope, fs, close } = withoutGit()
    const before = fs.write(writer, scope, { path: 'page/moved.md', body: 'contents' })
    // The move lands on disk; the process dies before any ledger row is touched.
    renameSync(contextFileName(fs, scope, 'page/moved.md'), contextFileName(fs, scope, 'page/renamed.md'))

    const report = fs.reconcile(writer, scope)
    expect(report).toMatchObject({ scanned: 1, indexed: 1, removed: 1, resurrected: 0 })
    expect(ledger.contextNode(before.uri)).toBeUndefined()
    const moved = ledger.contextNode('viking://workspace/main/project/hive/page/renamed.md')
    expect(moved?.sha256).toBe(before.sha256)
    expect(fs.read(reader, scope, 'page/renamed.md').body).toBe('contents')
    close()
  })

  it('resurrects a tombstoned node whose file reappeared behind Hive', () => {
    const { ledger, scope, fs, close } = contextHarness(actors)
    const node = fs.write(writer, scope, { path: 'page/back.md', body: 'here' })
    const fileName = contextFileName(fs, scope, 'page/back.md')
    const bytes = readFileSync(fileName, 'utf8')

    fs.remove(writer, scope, 'page/back.md')
    expect(fs.tombstones(reader, scope)).toHaveLength(1)
    // A backup tool, an editor's undo, or a stale sync puts the file back. The
    // tombstone now contradicts the disk, and the disk is the canonical copy.
    writeFileSync(fileName, bytes, 'utf8')

    const report = fs.reconcile(writer, scope)
    expect(report).toMatchObject({ scanned: 1, resurrected: 1, indexed: 1, removed: 0 })
    expect(ledger.tombstone(node.uri)).toBeUndefined()
    expect(fs.tombstones(reader, scope)).toEqual([])
    expect(fs.read(reader, scope, 'page/back.md').body).toBe('here')
    expect(ledger.contextNode(node.uri)?.sha256).toBe(node.sha256)

    // Convergent: the resurrection is not re-reported on a second pass.
    expect(fs.reconcile(writer, scope)).toMatchObject({ scanned: 1, resurrected: 0, indexed: 0, reindexed: 0 })
    close()
  })

  it('drops the index row for a file deleted outside Hive but keeps tombstoned deletions quiet', () => {
    const { ledger, scope, fs, close } = contextHarness(actors)
    const external = fs.write(writer, scope, { path: 'page/vanished.md', body: 'x' })
    fs.write(writer, scope, { path: 'page/tombstoned.md', body: 'y' })
    fs.remove(writer, scope, 'page/tombstoned.md')
    renameSync(contextFileName(fs, scope, 'page/vanished.md'), `${contextFileName(fs, scope, 'page/vanished.md')}.moved`)

    const report = fs.reconcile(writer, scope)
    // Only the untracked disappearance counts as `removed`; the tombstoned one was expected.
    expect(report.removed).toBe(1)
    expect(ledger.contextNode(external.uri)).toBeUndefined()
    close()
  })

  it('reports an undecodable file instead of aborting the sweep', () => {
    const { scope, fs, close } = withoutGit()
    fs.write(writer, scope, { path: 'page/good.md', body: 'ok' })
    editBodyOutsideHive(fs, scope, 'page/good.md', 'still ok')
    writeFileSync(contextFileName(fs, scope, 'page/broken.md'), 'no frontmatter here', 'utf8')

    const report = fs.reconcile(writer, scope)
    expect(report.scanned).toBe(2)
    expect(report.unreadable.map((failure) => failure.path)).toEqual(['page/broken.md'])
    expect(report.reindexed).toBe(1)
    close()
  })
})

describe('context filesystem — links across projects', () => {
  it('records a cross-project link and reports it once the target is gone', () => {
    const { ledger, scope, fs, addProject, close } = withoutGit()
    const other = addProject('atlas')
    const target = fs.write(writer, other, { path: 'page/spec.md', body: 'spec' })
    const source = fs.write(writer, scope, { path: 'page/readme.md', body: 'see spec', links: [target.uri] })

    const links = ledger.listContextLinks(scope)
    expect(links).toEqual([{ fromUri: source.uri, toUri: target.uri, crossProject: true, resolved: false }])
    expect(fs.reconcile(writer, scope).danglingLinks).toEqual([])

    fs.remove(writer, other, 'page/spec.md')
    expect(fs.reconcile(writer, scope).danglingLinks.map((link) => link.toUri)).toEqual([target.uri])
    close()
  })

  it('refuses a link that leaves the workspace before anything reaches disk', () => {
    const { scope, fs, close } = withoutGit()
    expect(() => fs.write(writer, scope, { path: 'page/readme.md', body: 'x', links: ['viking://workspace/other/project/hive/page/spec.md'] }))
      .toThrowError('leaves workspace')
    expect(() => fs.read(reader, scope, 'page/readme.md')).toThrowError('does not exist')
    close()
  })

  it('clears links when the node that owned them is deleted', () => {
    const { ledger, scope, fs, close } = withoutGit()
    const target = fs.write(writer, scope, { path: 'memory/note.md', body: 'note' })
    fs.write(writer, scope, { path: 'page/readme.md', body: 'x', links: [target.uri] })
    expect(ledger.listContextLinks(scope)).toHaveLength(1)
    fs.remove(writer, scope, 'page/readme.md')
    expect(ledger.listContextLinks(scope)).toEqual([])
    close()
  })
})

describe('context filesystem — history and snapshots', () => {
  it('keeps old versions readable through Git history', () => {
    const { scope, fs, close } = contextHarness(actors)
    fs.write(writer, scope, { path: 'page/readme.md', body: 'first' })
    fs.write(writer, scope, { path: 'page/readme.md', body: 'second' })
    const history = fs.history(reader, scope, 'page/readme.md')
    expect(history.length).toBeGreaterThanOrEqual(2)
    expect(fs.readAt(reader, scope, 'page/readme.md', history[1].commit)?.body).toBe('first')
    expect(fs.readAt(reader, scope, 'page/readme.md', history[0].commit)?.body).toBe('second')
    close()
  })

  it('takes a content snapshot with its own manifest and pack metadata', () => {
    const { ledger, scope, fs, close } = contextHarness(actors)
    fs.write(writer, scope, { path: 'page/readme.md', body: 'first' })
    fs.write(writer, scope, { path: 'memory/note.md', body: 'note' })

    const manifest = fs.createSnapshot(archivist, scope, 'release-1')
    expect(manifest.ref).toBe('context/release-1')
    expect(manifest.nodeCount).toBe(2)
    expect(manifest.totalBytes).toBeGreaterThan(0)
    expect(manifest.nodes.map((entry) => entry.path)).toEqual(['memory/note.md', 'page/readme.md'])
    expect(fs.listSnapshots(reader, scope).map((entry) => entry.label)).toEqual(['release-1'])
    expect(() => fs.createSnapshot(archivist, scope, 'release-1')).toThrowError('already exists')
    expect(() => fs.createSnapshot(writer, scope, 'release-2')).toThrowError('Missing capability')
    expect(fs.packMetadata(reader).looseObjects + fs.packMetadata(reader).packedObjects).toBeGreaterThan(0)
    expect(ledger.readEvents().some((event) => event.idempotencyKey.startsWith('context:snapshot:'))).toBe(true)
    close()
  })

  it('refuses snapshots when the context repository is disabled', () => {
    const { scope, fs, close } = withoutGit()
    fs.write(writer, scope, { path: 'page/readme.md', body: 'x' })
    expect(() => fs.createSnapshot(archivist, scope, 'nope')).toThrowError('require the context Git repository')
    expect(fs.history(reader, scope, 'page/readme.md')).toEqual([])
    close()
  })
})
