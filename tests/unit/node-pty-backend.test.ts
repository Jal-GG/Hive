import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveWindowsExecutable } from '../../src/runtime/node-pty-backend.js'
import { tempDirectory } from '../fixtures.js'

describe('resolveWindowsExecutable', () => {
  it('finds a bare name on the PATH, preferring .exe', () => {
    const first = tempDirectory('pty-resolve-first')
    const second = tempDirectory('pty-resolve-second')
    writeFileSync(join(first, 'agent.exe'), '', 'utf8')
    writeFileSync(join(second, 'agent.cmd'), '', 'utf8')

    const resolved = resolveWindowsExecutable('agent', [first, second].join(';'))
    expect(resolved).toBe(join(first, 'agent.exe'))
  })

  it('resolves a .cmd shim when no .exe exists', () => {
    const directory = tempDirectory('pty-resolve-cmd')
    writeFileSync(join(directory, 'agent.cmd'), '', 'utf8')

    expect(resolveWindowsExecutable('agent', directory)).toBe(join(directory, 'agent.cmd'))
  })

  it('resolves an already-extensioned name without doubling it', () => {
    const directory = tempDirectory('pty-resolve-exe')
    writeFileSync(join(directory, 'agent.exe'), '', 'utf8')

    expect(resolveWindowsExecutable('agent.exe', directory)).toBe(join(directory, 'agent.exe'))
  })

  it('leaves a name that already carries a path alone', () => {
    expect(resolveWindowsExecutable('C:/tools/agent.exe', undefined)).toBe('C:/tools/agent.exe')
    expect(resolveWindowsExecutable('.\\bin\\agent', undefined)).toBe('.\\bin\\agent')
  })

  it('returns an unresolvable name unchanged, so the spawn reports the miss', () => {
    const directory = tempDirectory('pty-resolve-empty')
    expect(resolveWindowsExecutable('no-such-agent', directory)).toBe('no-such-agent')
    expect(resolveWindowsExecutable('no-such-agent', undefined)).toBe('no-such-agent')
  })
})
