import { describe, expect, it } from 'vitest'
import { AgentProfile } from '../../src/contracts.js'
import { HiveError } from '../../src/errors.js'
import { ProviderCatalog, buildCommand, defaultAgentProfiles, fakeProfileId } from '../../src/runtime/provider-catalog.js'

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'test',
    provider: 'other',
    executable: 'agent',
    argsTemplate: [],
    environmentPolicy: { allow: [], deny: [], set: {} },
    capabilities: ['interactive'],
    backend: 'process',
    promptDelivery: 'stdin',
    ...overrides,
  }
}

/** `validateProfile` is module-private, so registration is how a test reaches it. */
function register(overrides: Partial<AgentProfile>): AgentProfile {
  return new ProviderCatalog([]).register(profile(overrides))
}

function codeOf(operation: () => unknown): string {
  try {
    operation()
    return 'no error'
  } catch (error) {
    return error instanceof HiveError ? error.code : `unexpected: ${String(error)}`
  }
}

describe('buildCommand', () => {
  it('substitutes per token so a prompt with spaces stays one argument', () => {
    const command = buildCommand(profile({ executable: 'claude', argsTemplate: ['--print', '--prompt={prompt}'], promptDelivery: 'argument' }), {
      prompt: 'fix the parser; rm -rf /',
    })
    expect(command.executable).toBe('claude')
    expect(command.args).toEqual(['--print', '--prompt=fix the parser; rm -rf /'])
  })

  it('drops a token whose placeholder has no value rather than passing a dangling flag', () => {
    const template = profile({ argsTemplate: ['--model={model}', '--cwd={cwd}', '--always'] })
    expect(buildCommand(template, { cwd: '/tmp/run' }).args).toEqual(['--cwd=/tmp/run', '--always'])
    expect(buildCommand(template, { model: '', cwd: '/tmp/run' }).args).toEqual(['--cwd=/tmp/run', '--always'])
    expect(buildCommand(template, {}).args).toEqual(['--always'])
  })

  it('keeps a token that references several placeholders only when all of them resolve', () => {
    const template = profile({ argsTemplate: ['{runId}@{branch}'] })
    expect(buildCommand(template, { runId: 'r1', branch: 'b1' }).args).toEqual(['r1@b1'])
    expect(buildCommand(template, { runId: 'r1' }).args).toEqual([])
  })

  it('refuses an unknown placeholder instead of passing braces to the provider', () => {
    expect(codeOf(() => buildCommand(profile({ argsTemplate: ['--session={sessionKey}'] }), {}))).toBe('UNKNOWN_PLACEHOLDER')
  })

  it('leaves text that only looks like a placeholder alone', () => {
    // `{}` and `{1}` are not placeholder syntax, so a regex or JSON argument survives.
    expect(buildCommand(profile({ argsTemplate: ['--filter={}', '--repeat=a{1}'] }), {}).args).toEqual(['--filter={}', '--repeat=a{1}'])
  })
})

describe('ProviderCatalog', () => {
  it('seeds the shipped profiles, including the fake provider Phase 3 is defined against', () => {
    const catalog = new ProviderCatalog()
    expect(catalog.has(fakeProfileId)).toBe(true)
    expect(catalog.list().map((entry) => entry.id)).toEqual(defaultAgentProfiles.map((entry) => entry.id).sort())
    expect(catalog.get(fakeProfileId).backend).toBe('fake')
    expect(catalog.get(fakeProfileId).promptDelivery).toBe('argument')
  })

  it('names the missing profile when one is not registered', () => {
    const catalog = new ProviderCatalog()
    expect(codeOf(() => catalog.get('nope'))).toBe('PROFILE_NOT_FOUND')
    expect(() => catalog.get('nope')).toThrowError(/nope/)
  })

  it('lets a configured profile shadow a shipped one by id', () => {
    const catalog = new ProviderCatalog()
    const before = catalog.list().length
    catalog.register(profile({ id: 'claude', provider: 'claude', executable: '/opt/claude', backend: 'node_pty' }))
    expect(catalog.get('claude').executable).toBe('/opt/claude')
    expect(catalog.list()).toHaveLength(before)
  })

  it('filters by provider and backend', () => {
    const catalog = new ProviderCatalog()
    expect(catalog.list('fake').map((entry) => entry.id)).toEqual(['fake'])
    expect(catalog.list(undefined, 'fake').map((entry) => entry.id)).toEqual(['fake'])
    expect(catalog.list('claude', 'fake')).toEqual([])
    expect(catalog.list('other')).toEqual([])
  })

  it('sorts by id so two hosts list profiles the same way', () => {
    const catalog = new ProviderCatalog([profile({ id: 'zebra' }), profile({ id: 'alpha' }), profile({ id: 'middle' })])
    expect(catalog.list().map((entry) => entry.id)).toEqual(['alpha', 'middle', 'zebra'])
  })

  it('rejects a profile that could only fail at launch', () => {
    expect(codeOf(() => register({ id: '  ' }))).toBe('INVALID_PROFILE')
    expect(codeOf(() => register({ executable: '' }))).toBe('INVALID_PROFILE')
    expect(codeOf(() => register({ readyPattern: '([unclosed' }))).toBe('INVALID_PROFILE')
    expect(codeOf(() => register({ idleAfterMs: 0 }))).toBe('INVALID_PROFILE')
    expect(codeOf(() => register({ idleAfterMs: -1 }))).toBe('INVALID_PROFILE')
    // A prompt delivered by argument with nothing to carry it would launch an agent with no task.
    expect(codeOf(() => register({ promptDelivery: 'argument', argsTemplate: ['--go'] }))).toBe('INVALID_PROFILE')
    // And a `{prompt}` token on a stdin profile would deliver the prompt twice.
    expect(codeOf(() => register({ promptDelivery: 'stdin', argsTemplate: ['--prompt={prompt}'] }))).toBe('INVALID_PROFILE')
    // tmux is the backend a restart re-adopts, so a profile using it has to say so.
    expect(codeOf(() => register({ backend: 'tmux', capabilities: ['interactive'] }))).toBe('INVALID_PROFILE')
    expect(codeOf(() => register({ argsTemplate: ['--x={nonsense}'] }))).toBe('UNKNOWN_PLACEHOLDER')
  })

  it('accepts the valid shapes those rules are guarding', () => {
    expect(register({ readyPattern: 'ready|listening' }).readyPattern).toBe('ready|listening')
    expect(register({ promptDelivery: 'argument', argsTemplate: ['--prompt={prompt}'] }).promptDelivery).toBe('argument')
    expect(register({ promptDelivery: 'none', argsTemplate: ['--resume'] }).promptDelivery).toBe('none')
    expect(register({ backend: 'tmux', capabilities: ['interactive', 'persistent_session'] }).backend).toBe('tmux')
    expect(register({ idleAfterMs: 1 }).idleAfterMs).toBe(1)
  })

  it('never hands a credential to a wildcard in any shipped profile', () => {
    for (const entry of defaultAgentProfiles) {
      for (const allowed of entry.environmentPolicy.allow) {
        if (!allowed.endsWith('*')) continue
        expect(allowed.indexOf('*')).toBe(allowed.length - 1)
      }
      // Every shipped profile denies the operator's own credential helpers.
      expect(entry.environmentPolicy.deny).toContain('SSH_AUTH_SOCK')
    }
  })

  it('builds a command through the catalog the same way as the free function', () => {
    const catalog = new ProviderCatalog()
    const fake = catalog.get(fakeProfileId)
    expect(catalog.buildCommand(fake, { runId: 'r1', branch: 'b1', prompt: 'go' })).toEqual(buildCommand(fake, { runId: 'r1', branch: 'b1', prompt: 'go' }))
    expect(catalog.buildCommand(fake, { runId: 'r1', branch: 'b1' }).args).toEqual(['--run=r1', '--branch=b1'])
  })
})
