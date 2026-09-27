import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Capability } from '../../src/contracts.js'
import { resetFakeSessions } from '../../src/runtime/fake-backend.js'
import { fakeProfileId } from '../../src/runtime/provider-catalog.js'
import { Searcher } from '../../src/search/searcher.js'
import { SessionStore } from '../../src/session/store.js'
import { runKnowledgeCli } from '../../src/interfaces/cli/knowledge-cli.js'
import { dispatchHarness, knowledgeHarness, tempDirectory, testActor } from '../fixtures.js'

/**
 * The Phase 6 gate: sources ingest incrementally and are browseable with
 * provenance; lexical search returns strict-tier RRF-fused results; the index
 * rebuilds cleanly after deletion; sessions replay and summarize, and their
 * summaries are searchable; the packet compiler folds search hits in, bounded.
 */
const capabilities: Capability[] = ['workspace:read', 'work:mutate', 'work:dispatch', 'runtime:control', 'runtime:read', 'context:read', 'context:write']
const operator = testActor('operator', capabilities)

afterEach(() => resetFakeSessions())

function sourceTree(): string {
  const root = tempDirectory('ingest-tree')
  writeFileSync(join(root, 'design.md'), [
    '# Parser Design',
    '',
    'The parser registry turns files into tiered chunks.',
    '',
    '## Chunking',
    '',
    'Sections split at headings and stay bounded by a byte limit.',
    '',
    '## Tiers',
    '',
    'L0 is the title, L1 the overview, L2 the body.',
  ].join('\n'), 'utf8')
  writeFileSync(join(root, 'research.md'), [
    '# Parser Registry Notes',
    '',
    'The parser registry research settled on provenance per source.',
    '',
    '## Open questions',
    '',
    'Whether code files deserve an L1 overview at all.',
  ].join('\n'), 'utf8')
  writeFileSync(join(root, 'history.md'), `# Parser History\n\n${'The parser registry grew from a long line of registry designs, each registry generation informing the next registry iteration. '.repeat(8)}\n`, 'utf8')
  writeFileSync(join(root, 'deep.md'), '# Parser Depth\n\nThe parser registry keeps every registry entry deep and searchable.\n', 'utf8')
  writeFileSync(join(root, 'notes.txt'), 'Meeting notes: the retrieval meeting settled on lexical search first.\n\nFollow-up: wire embeddings later, optionally.', 'utf8')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'searcher.ts'), Array.from({ length: 30 }, (_, index) => `export function search${index}() { return ${index} }`).join('\n'), 'utf8')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ingested-project', keywords: ['parser'] }, null, 2), 'utf8')
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, 'node_modules', 'dep.md'), '# Dependency\nshould never be ingested', 'utf8')
  return root
}

describe('ingestion and lexical search — the Phase 6 gate', () => {
  it('ingests a source tree with provenance, skips excluded directories', () => {
    const harness = knowledgeHarness([operator])
    const root = sourceTree()
    const report = harness.ingest.ingest(operator, harness.scope, root)
    expect(report).toMatchObject({ added: 7, removed: 0 })
    expect(report.chunks).toBeGreaterThan(6)

    const sources = harness.ingest.status(operator, harness.scope)
    expect(sources).toHaveLength(7)
    const byParser = new Map(sources.map((source) => [source.uri, source.parser]))
    expect([...byParser.values()].sort()).toEqual(['code', 'json', 'markdown', 'markdown', 'markdown', 'markdown', 'text'])
    expect(sources.every((source) => source.uri.startsWith('viking://workspace/main/project/hive/'))).toBe(true)
    harness.close()
  })

  it('finds tiered, snippeted, RRF-fused results and respects strict tier filters', () => {
    const harness = knowledgeHarness([operator])
    harness.ingest.ingest(operator, harness.scope, sourceTree())

    const hits = harness.search.search(operator, harness.scope, 'parser registry')
    expect(hits.length).toBeGreaterThan(0)
    // The design doc's L0 (title "Parser Design") and L1 lead a title+body fused query.
    expect(hits.some((hit) => hit.title === 'Parser Design')).toBe(true)
    expect(hits.every((hit) => hit.snippet.length > 0)).toBe(true)
    // Deterministic: same query, same order.
    const again = harness.search.search(operator, harness.scope, 'parser registry')
    expect(again.map((hit) => hit.uri)).toEqual(hits.map((hit) => hit.uri))

    // Strict tier filter: L0 only is titles only.
    const titles = harness.search.search(operator, harness.scope, 'parser', { tiers: ['L0'] })
    expect(titles.length).toBeGreaterThan(0)
    expect(titles.every((hit) => hit.tier === 'L0')).toBe(true)
    // An empty query is empty, not everything.
    expect(harness.search.search(operator, harness.scope, '  ')).toEqual([])
    harness.close()
  })

  it('records a retrieval trajectory for every search: query, tiers, hits, top hit, duration', () => {
    const harness = knowledgeHarness([operator])
    harness.ingest.ingest(operator, harness.scope, sourceTree())
    const observed = new Searcher({
      ledger: harness.ledger,
      trajectory: {
        record: (scope, query, tiers, hitCount, topHitUri, durationMs) => {
          harness.ledger.insertRetrievalTrajectory({ id: `traj:${query}:${tiers.join(',')}`, scope, query, tiers, hitCount, topHitUri, durationMs, occurredAt: new Date().toISOString() })
        },
      },
    })

    observed.search(operator, harness.scope, 'parser registry', { tiers: ['L0'] })
    observed.search(operator, harness.scope, '   ')
    const trajectories = harness.ledger.listRetrievalTrajectories(harness.scope)
    expect(trajectories).toHaveLength(2)
    const scored = trajectories.find((trajectory) => trajectory.query === 'parser registry')
    expect(scored).toMatchObject({ hitCount: expect.any(Number), topHitUri: expect.any(String) })
    expect(scored?.tiers).toEqual(['L0'])
    expect(scored?.hitCount).toBeGreaterThan(0)
    // The empty query is a recorded decision too: zero hits is a fact, not a gap.
    const blank = trajectories.find((trajectory) => trajectory.query.trim() === '')
    expect(blank?.hitCount).toBe(0)
    harness.close()
  })

  it('re-ingests incrementally: untouched files are skipped, edits reparse, deletions leave', () => {
    const harness = knowledgeHarness([operator])
    const root = sourceTree()
    harness.ingest.ingest(operator, harness.scope, root)

    // An untouched tree reads nothing new.
    const second = harness.ingest.ingest(operator, harness.scope, root)
    expect(second).toMatchObject({ added: 0, updated: 0, unchanged: 7, removed: 0 })

    // A content edit reparses exactly that file; a same-bytes touch does not.
    writeFileSync(join(root, 'notes.txt'), 'Meeting notes: the retrieval meeting settled on lexical search first.\n\nFollow-up: embeddings stay optional, always.', 'utf8')
    utimesSync(join(root, 'design.md'), new Date(), new Date())
    const third = harness.ingest.ingest(operator, harness.scope, root)
    expect(third).toMatchObject({ added: 0, updated: 1, unchanged: 6 })

    // A deleted file leaves the index with the file.
    rmSync(join(root, 'package.json'))
    const fourth = harness.ingest.ingest(operator, harness.scope, root)
    expect(fourth).toMatchObject({ removed: 1 })
    expect(harness.ingest.status(operator, harness.scope).some((source) => source.path.endsWith('package.json'))).toBe(false)
    harness.close()
  })

  it('rebuilds cleanly after the index is wiped: same sources, same search results', () => {
    const harness = knowledgeHarness([operator])
    const root = sourceTree()
    harness.ingest.ingest(operator, harness.scope, root)
    const before = harness.search.search(operator, harness.scope, 'parser registry').map((hit) => `${hit.uri}#${hit.chunkId}`)

    // The index is a projection: drop it, rebuild from the sources table.
    harness.ledger.replaceIngestChunks(before[0], []) // wipe one explicitly...
    for (const source of harness.ingest.status(operator, harness.scope)) harness.ledger.replaceIngestChunks(source.uri, [])
    const rebuilt = harness.ingest.ingest(operator, harness.scope, root, { force: true })
    expect(rebuilt.updated).toBe(7)

    const after = harness.search.search(operator, harness.scope, 'parser registry').map((hit) => `${hit.uri}#${hit.chunkId}`)
    expect(after).toEqual(before)
    harness.close()
  })

  it('captures sessions deterministically, replays them by cursor, and makes them searchable', async () => {
    const harness = dispatchHarness([operator])
    const sessions = new SessionStore(harness.ledger, { now: harness.clock.now })
    const search = new Searcher(harness.ledger)

    harness.dispatcher.registerAgent(operator, { agentId: 'scribe', profileId: fakeProfileId })
    const dispatched = await harness.dispatcher.intake(operator, harness.scope, { title: 'Fix the parser registry', description: 'The markdown parser missed sections.', sourceTriggerId: 't-session' })
    const runId = dispatched.outcome!.runId!

    // A live run captures as in-flight; recapture after stop lands the outcome.
    const live = sessions.capture(operator, runId)
    expect(live.summary).toContain('in flight')
    await harness.manager.stop(operator, { runId })
    const done = sessions.capture(operator, runId)
    expect(done.summary).toBe('Fix the parser registry — ended by SIGTERM')
    expect(done.overview).toContain('markdown parser missed sections')

    // Replay pages by cursor, and a second pass from the cursor returns nothing new.
    const page = sessions.replay(operator, runId)
    expect(page.events.length).toBeGreaterThan(0)
    const tail = sessions.replay(operator, runId, page.cursor)
    expect(tail.events).toEqual([])
    expect(tail.cursor).toBe(page.cursor)

    // The session summary is in the lexical index: task terms find the session.
    const hits = search.search(operator, harness.scope, 'parser registry')
    expect(hits.some((hit) => hit.uri.includes(`sessions/${runId}`))).toBe(true)
    harness.close()
  })

  it('folds bounded search hits into the packet, below the store\'s own references', async () => {
    const harness = knowledgeHarness([operator])
    harness.ingest.ingest(operator, harness.scope, sourceTree())
    const task = harness.board.create(operator, harness.scope, { title: 'parser registry', description: 'Keep the chunking bounded.' })

    const packet = harness.searchingPackets.compile(operator, harness.scope, { taskId: task.id })
    const uris = packet.memory.map((reference) => reference.uri)
    expect(uris.some((uri) => uri.endsWith('design.md'))).toBe(true)
    // Both markdown files matched at L0/L1: the store's references plus fused search hits.
    expect(packet.memory.length).toBeGreaterThanOrEqual(2)
    // Deterministic with the same inputs.
    const again = harness.searchingPackets.compile(operator, harness.scope, { taskId: task.id })
    expect(again.memory.map((reference) => reference.uri)).toEqual(uris)

    // A tiny budget drops search hits whole and says so in the warnings.
    const tight = harness.searchingPackets.compile(operator, harness.scope, { taskId: task.id, byteBudget: 1_024 })
    expect(tight.byteBudget).toBe(1_024)
    expect(tight.memory.length).toBeLessThan(packet.memory.length)
    expect(tight.operationalWarnings.some((warning) => warning.includes('dropped'))).toBe(true)
    harness.close()
  })

  it('serves the knowledge surfaces through the CLI', async () => {
    const harness = knowledgeHarness([operator])
    const root = sourceTree()
    const surfaces = { ledger: harness.ledger, ingest: harness.ingest, search: harness.search, sessions: harness.sessions }
    const cli = (argv: string[]) => runKnowledgeCli(surfaces, operator, argv)

    const report = JSON.parse(await cli(['ingest', '--path', root])) as { added: number }
    expect(report.added).toBe(7)

    const status = JSON.parse(await cli(['status'])) as Array<{ parser: string }>
    expect(status.map((source) => source.parser).sort()).toEqual(['code', 'json', 'markdown', 'markdown', 'markdown', 'markdown', 'text'])

    const hits = JSON.parse(await cli(['search', '--query', 'parser', '--tier', 'L0'])) as Array<{ tier: string }>
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((hit) => hit.tier === 'L0')).toBe(true)

    const sessions = JSON.parse(await cli(['sessions'])) as unknown[]
    expect(sessions).toEqual([])
    await expect(cli(['explode'])).rejects.toThrowError(/Unknown knowledge operation/)
    harness.close()
  })
})
