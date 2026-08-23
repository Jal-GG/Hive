import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentProfile, RuntimeProvider, RuntimeIdentity } from '../../src/contracts.js'
import { HiveError } from '../../src/errors.js'
import { redactedValue } from '../../src/runtime/redaction.js'
import { ClaudeJsonlTranscriptAdapter, claudeProjectSlug } from '../../src/runtime/transcript/claude-jsonl-transcript.js'
import { FakeTranscriptAdapter, fakeTranscriptPath } from '../../src/runtime/transcript/fake-transcript.js'
import { formatCursor, parseCursor, readJsonlSlice } from '../../src/runtime/transcript/jsonl-transcript.js'
import { tempDirectory } from '../fixtures.js'

const identity: RuntimeIdentity = {
  runId: 'run-1',
  actorId: 'operator',
  workspaceName: 'main',
  projectName: 'hive',
  branch: 'hive/main/hive/run1',
  originMarker: 'hive:runtime',
}

/** `supports` reads only the provider and the adapter id, so the rest is filler. */
function profileFor(provider: RuntimeProvider, transcriptAdapter?: string): AgentProfile {
  return {
    id: 'x',
    provider,
    executable: 'x',
    argsTemplate: [],
    environmentPolicy: { allow: [], deny: [], set: {} },
    capabilities: ['interactive'],
    backend: 'process',
    transcriptAdapter,
    promptDelivery: 'none',
  }
}

function jsonlFile(lines: string[], name = 'transcript.jsonl'): string {
  const directory = tempDirectory('jsonl')
  const path = join(directory, name)
  writeFileSync(path, lines.join(''), 'utf8')
  return path
}

describe('readJsonlSlice', () => {
  it('reads whole lines and reports the file as fully consumed', () => {
    const path = jsonlFile(['{"n":1}\n', '{"n":2}\n'])
    const slice = readJsonlSlice(path, 0)
    expect(slice.lines.map((line) => line.value)).toEqual([{ n: 1 }, { n: 2 }])
    expect(slice.complete).toBe(true)
    expect(slice.lostCount).toBe(0)
    expect(slice.lines[1].offset).toBe(8)
  })

  it('leaves a partial tail unconsumed so a mid-write record is read once, whole', () => {
    const path = jsonlFile(['{"n":1}\n', '{"n":2'])
    const first = readJsonlSlice(path, 0)
    expect(first.lines).toHaveLength(1)
    // The fragment is still ahead of the cursor, and the slice says so.
    expect(first.endOffset).toBe(8)
    expect(first.complete).toBe(false)

    writeFileSync(path, '{"n":1}\n{"n":2}\n', 'utf8')
    const second = readJsonlSlice(path, first.endOffset)
    expect(second.lines.map((line) => line.value)).toEqual([{ n: 2 }])
    expect(second.complete).toBe(true)
  })

  it('reports incompleteness when the limit stops it short, and resumes from the cursor', () => {
    const path = jsonlFile(['{"n":1}\n', '{"n":2}\n', '{"n":3}\n'])
    const first = readJsonlSlice(path, 0, 2)
    expect(first.lines).toHaveLength(2)
    expect(first.complete).toBe(false)
    const second = readJsonlSlice(path, first.endOffset, 2)
    expect(second.lines.map((line) => line.value)).toEqual([{ n: 3 }])
    expect(second.complete).toBe(true)
  })

  it('counts a complete line it cannot decode instead of dropping it quietly', () => {
    const path = jsonlFile(['{"n":1}\n', 'not json at all\n', '{"n":3}\n'])
    const slice = readJsonlSlice(path, 0)
    expect(slice.lines.map((line) => line.value)).toEqual([{ n: 1 }, { n: 3 }])
    expect(slice.lostCount).toBe(1)
    expect(slice.complete).toBe(true)
  })

  it('skips blank lines without calling them losses', () => {
    const slice = readJsonlSlice(jsonlFile(['{"n":1}\n', '\n', '   \n', '{"n":2}\n']), 0)
    expect(slice.lines).toHaveLength(2)
    expect(slice.lostCount).toBe(0)
  })

  it('never reads past the end of a rotated or rewritten file', () => {
    const path = jsonlFile(['{"n":1}\n', '{"n":2}\n'])
    writeFileSync(path, '{"n":9}\n', 'utf8')
    const slice = readJsonlSlice(path, 16)
    expect(slice.lines).toEqual([])
    expect(slice.endOffset).toBe(8)
    expect(slice.complete).toBe(true)
  })

  it('treats a missing file as an empty transcript rather than an error', () => {
    const slice = readJsonlSlice(join(tempDirectory('jsonl-missing'), 'none.jsonl'), 0)
    expect(slice).toEqual({ lines: [], endOffset: 0, complete: true, lostCount: 0 })
  })

  it('stops at the byte cap and leaves the rest for the next read', () => {
    const path = jsonlFile(['{"n":1}\n', '{"n":2}\n'])
    const slice = readJsonlSlice(path, 0, 100, 8)
    expect(slice.lines).toHaveLength(1)
    expect(slice.complete).toBe(false)
    expect(slice.endOffset).toBe(8)
  })
})

describe('transcript cursors', () => {
  it('round trips a file and an offset', () => {
    expect(formatCursor({ file: 'session.jsonl', offset: 42 })).toBe('session.jsonl@42')
    expect(parseCursor('session.jsonl@42')).toEqual({ file: 'session.jsonl', offset: 42 })
    expect(parseCursor(undefined)).toBeUndefined()
    expect(parseCursor('')).toBeUndefined()
  })

  it('keeps the last @ so a Windows path or an email-like name still parses', () => {
    expect(parseCursor('C:\\runs\\a@b\\session.jsonl@7')).toEqual({ file: 'C:\\runs\\a@b\\session.jsonl', offset: 7 })
  })

  it('rejects a malformed cursor rather than restarting from zero', () => {
    for (const bad of ['session.jsonl', '@12', 'session.jsonl@', 'session.jsonl@-1', 'session.jsonl@abc']) {
      let code = 'no error'
      try {
        parseCursor(bad)
      } catch (error) {
        code = error instanceof HiveError ? error.code : 'unexpected'
      }
      expect(code).toBe('INVALID_CURSOR')
    }
  })
})

describe('FakeTranscriptAdapter', () => {
  function store(lines: string[]): string {
    const cwd = tempDirectory('fake-transcript')
    mkdirSync(join(cwd, '.hive'), { recursive: true })
    writeFileSync(join(cwd, fakeTranscriptPath), lines.join(''), 'utf8')
    return cwd
  }

  it('supports the fake profile by adapter id or provider', () => {
    const adapter = new FakeTranscriptAdapter()
    expect(adapter.supports(profileFor('fake'))).toBe(true)
    expect(adapter.supports(profileFor('other', 'fake_transcript'))).toBe(true)
    expect(adapter.supports(profileFor('other'))).toBe(false)
  })

  it('reads entries, ids, tokens, and a resumable cursor', () => {
    const cwd = store([
      '{"id":"e1","role":"user","text":"do the thing","at":"2026-01-01T00:00:00.000Z","tokensIn":10}\n',
      '{"id":"e2","role":"assistant","text":"done","tokensOut":4}\n',
    ])
    const adapter = new FakeTranscriptAdapter()
    const slice = adapter.read({ identity, cwd })
    expect(slice.schema).toBe('hive.fake_transcript/1')
    expect(slice.entries.map((entry) => [entry.id, entry.role, entry.text])).toEqual([
      ['e1', 'user', 'do the thing'],
      ['e2', 'assistant', 'done'],
    ])
    expect(slice.entries[0].tokensIn).toBe(10)
    expect(slice.entries[1].tokensOut).toBe(4)
    expect(slice.complete).toBe(true)

    // Re-reading from the returned cursor yields nothing new, which is what makes import idempotent.
    expect(adapter.read({ identity, cwd, cursor: slice.cursor }).entries).toEqual([])
  })

  it('falls back to an offset-derived id, normalizes an unknown role, and skips records with no text', () => {
    const cwd = store(['{"role":"wizard","text":"hm"}\n', '{"role":"user"}\n'])
    const entries = new FakeTranscriptAdapter().read({ identity, cwd }).entries
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe('fake-transcript:0')
    expect(entries[0].role).toBe('unknown')
  })

  it('redacts a credential the provider wrote into its own store', () => {
    const cwd = store(['{"role":"assistant","text":"export ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuv"}\n'])
    const entries = new FakeTranscriptAdapter().read({ identity, cwd }).entries
    expect(entries[0].text).toContain(redactedValue)
    expect(entries[0].text).not.toContain('sk-ant-')
  })

  it('reports loss and honours its limit', () => {
    const cwd = store(['{"role":"user","text":"a"}\n', 'garbage\n', '{"role":"user","text":"b"}\n'])
    const limited = new FakeTranscriptAdapter({ limit: 1 }).read({ identity, cwd })
    expect(limited.entries).toHaveLength(1)
    expect(limited.complete).toBe(false)
    expect(new FakeTranscriptAdapter().read({ identity, cwd }).lostCount).toBe(1)
  })
})

describe('ClaudeJsonlTranscriptAdapter', () => {
  function session(cwd: string, name: string, lines: string[]): string {
    const configDir = join(cwd, 'config')
    const directory = join(configDir, 'projects', claudeProjectSlug(cwd))
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, name), lines.join(''), 'utf8')
    return configDir
  }

  it('supports a profile by adapter id or by provider', () => {
    const adapter = new ClaudeJsonlTranscriptAdapter({ configDir: tempDirectory('claude-config') })
    expect(adapter.supports(profileFor('claude'))).toBe(true)
    expect(adapter.supports(profileFor('other', 'claude_jsonl'))).toBe(true)
    expect(adapter.supports(profileFor('codex'))).toBe(false)
  })

  it('reads both string content and block arrays, and prefers the provider uuid as the id', () => {
    const cwd = tempDirectory('claude-run')
    const configDir = session(cwd, 'a.jsonl', [
      '{"uuid":"u1","type":"user","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":"legacy string"}}\n',
      '{"uuid":"u2","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"block one"},{"type":"tool_use","name":"Bash"}],"usage":{"input_tokens":11,"output_tokens":22}}}\n',
    ])
    const slice = new ClaudeJsonlTranscriptAdapter({ configDir }).read({ identity, cwd })
    expect(slice.schema).toBe('claude_code.jsonl/1')
    expect(slice.entries).toHaveLength(2)
    expect(slice.entries[0]).toMatchObject({ id: 'u1', role: 'user', text: 'legacy string', occurredAt: '2026-01-01T00:00:00.000Z' })
    expect(slice.entries[1]).toMatchObject({ id: 'u2', role: 'assistant', text: 'block one\n[tool Bash]', tokensIn: 11, tokensOut: 22 })
    expect(slice.cursor?.startsWith('a.jsonl@')).toBe(true)
    expect(slice.complete).toBe(true)
  })

  it('never imports reasoning text and drops records that carry no message at all', () => {
    const cwd = tempDirectory('claude-run')
    const configDir = session(cwd, 'a.jsonl', [
      '{"uuid":"u1","type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"secret reasoning"},{"type":"text","text":"visible"}]}}\n',
      '{"type":"summary","summary":"a summary row"}\n',
      '{"uuid":"u3","type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"only reasoning"}]}}\n',
    ])
    const slice = new ClaudeJsonlTranscriptAdapter({ configDir }).read({ identity, cwd })
    expect(slice.entries.map((entry) => entry.text)).toEqual(['visible'])
    // Skipped records are not losses: there was nothing importable in them.
    expect(slice.lostCount).toBe(0)
  })

  it('flattens a tool result and maps its role', () => {
    const cwd = tempDirectory('claude-run')
    const configDir = session(cwd, 'a.jsonl', [
      '{"uuid":"u1","type":"user","message":{"role":"user","content":[{"type":"tool_result","content":[{"type":"text","text":"exit 0"}]}]}}\n',
      '{"uuid":"u2","type":"system","content":"system notice"}\n',
    ])
    const entries = new ClaudeJsonlTranscriptAdapter({ configDir }).read({ identity, cwd }).entries
    expect(entries[0]).toMatchObject({ role: 'user', text: 'exit 0' })
    expect(entries[1]).toMatchObject({ role: 'system', text: 'system notice' })
  })

  it('redacts a key the provider recorded verbatim', () => {
    const cwd = tempDirectory('claude-run')
    const configDir = session(cwd, 'a.jsonl', ['{"uuid":"u1","message":{"role":"user","content":"use sk-ant-abcdefghijklmnopqrstuv"}}\n'])
    const entries = new ClaudeJsonlTranscriptAdapter({ configDir }).read({ identity, cwd }).entries
    expect(entries[0].text).toBe(`use ${redactedValue}`)
  })

  it('reads the newest session for the directory but stays on one file once a cursor names it', () => {
    const cwd = tempDirectory('claude-run')
    const configDir = session(cwd, 'old.jsonl', ['{"uuid":"o1","message":{"role":"user","content":"old"}}\n'])
    session(cwd, 'new.jsonl', ['{"uuid":"n1","message":{"role":"user","content":"new"}}\n'])
    const adapter = new ClaudeJsonlTranscriptAdapter({ configDir })

    const latest = adapter.read({ identity, cwd })
    expect(latest.entries.map((entry) => entry.id)).toEqual(['n1'])
    expect(latest.cursor?.startsWith('new.jsonl@')).toBe(true)

    const pinned = adapter.read({ identity, cwd, cursor: 'old.jsonl@0' })
    expect(pinned.entries.map((entry) => entry.id)).toEqual(['o1'])
  })

  it('returns an empty slice when the provider has no store for the directory', () => {
    const slice = new ClaudeJsonlTranscriptAdapter({ configDir: tempDirectory('claude-empty') }).read({ identity, cwd: tempDirectory('claude-run') })
    expect(slice).toEqual({ schema: 'claude_code.jsonl/1', entries: [], lostCount: 0, complete: true })
  })
})
