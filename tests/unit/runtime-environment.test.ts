import { describe, expect, it } from 'vitest'
import { EnvironmentPolicy, RuntimeIdentity } from '../../src/contracts.js'
import { baseEnvironmentAllowList, resolveEnvironment, runtimeIdentityEnvironment } from '../../src/runtime/environment.js'
import { redactArguments, redactEnvironment, redactText, redactedValue } from '../../src/runtime/redaction.js'

const identity: RuntimeIdentity = {
  runId: 'run-1',
  actorId: 'operator',
  agentId: 'agent-7',
  workspaceName: 'main',
  projectName: 'hive',
  workItemId: 'item-3',
  branch: 'hive/main/hive/item-3-run1',
  originMarker: 'hive:runtime',
}

function policy(overrides: Partial<EnvironmentPolicy> = {}): EnvironmentPolicy {
  return { allow: [], deny: [], set: {}, ...overrides }
}

describe('resolveEnvironment', () => {
  it('inherits only what the base list and the policy name', () => {
    const environment = resolveEnvironment({
      policy: policy({ allow: ['ANTHROPIC_BASE_URL'] }),
      identity,
      host: { PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'https://api', SOME_OTHER_THING: 'visible', HOME: '/home/op' },
    })
    expect(environment.PATH).toBe('/usr/bin')
    expect(environment.HOME).toBe('/home/op')
    expect(environment.ANTHROPIC_BASE_URL).toBe('https://api')
    expect(environment.SOME_OTHER_THING).toBeUndefined()
  })

  it('lets an exact allow entry inherit a credential but never a wildcard', () => {
    const host = { ANTHROPIC_API_KEY: 'sk-live', CLAUDE_CODE_THEME: 'dark', CLAUDE_CODE_API_KEY: 'sk-other' }
    const wildcardOnly = resolveEnvironment({ policy: policy({ allow: ['CLAUDE_CODE_*'] }), identity, host })
    expect(wildcardOnly.CLAUDE_CODE_THEME).toBe('dark')
    // The wildcard matches the name, but a secret-looking name still needs to be written out.
    expect(wildcardOnly.CLAUDE_CODE_API_KEY).toBeUndefined()
    expect(wildcardOnly.ANTHROPIC_API_KEY).toBeUndefined()

    const explicit = resolveEnvironment({ policy: policy({ allow: ['ANTHROPIC_API_KEY'] }), identity, host })
    expect(explicit.ANTHROPIC_API_KEY).toBe('sk-live')
  })

  it('denies even what the allowlist widens', () => {
    const environment = resolveEnvironment({
      policy: policy({ allow: ['SSH_AUTH_SOCK', 'PATH'], deny: ['SSH_AUTH_SOCK'] }),
      identity,
      host: { SSH_AUTH_SOCK: '/tmp/agent.sock', PATH: '/usr/bin' },
    })
    expect(environment.SSH_AUTH_SOCK).toBeUndefined()
    expect(environment.PATH).toBe('/usr/bin')
  })

  it('matches names case-insensitively, because Windows does', () => {
    const environment = resolveEnvironment({ policy: policy({ allow: ['my_var'] }), identity, host: { MY_VAR: 'yes', Path: 'C:\\bin' } })
    expect(environment.MY_VAR).toBe('yes')
    expect(environment.Path).toBe('C:\\bin')
  })

  it('injects run identity and refuses to inherit a host claim to be another run', () => {
    const environment = resolveEnvironment({
      policy: policy(),
      identity,
      host: { HIVE_RUN_ID: 'someone-elses-run', HIVE_SMUGGLED: 'x' },
    })
    expect(environment.HIVE_RUN_ID).toBe('run-1')
    expect(environment.HIVE_SMUGGLED).toBeUndefined()
    expect(environment.HIVE_ACTOR_ID).toBe('operator')
    expect(environment.HIVE_AGENT_ID).toBe('agent-7')
    expect(environment.HIVE_WORK_ITEM_ID).toBe('item-3')
    expect(environment.HIVE_ORIGIN_MARKER).toBe('hive:runtime')
  })

  it('lets a profile set values but never override identity', () => {
    const environment = resolveEnvironment({
      policy: policy({ allow: ['TERM'], set: { TERM: 'dumb', FAKE_MARKER: '1' } }),
      identity,
      host: { TERM: 'xterm-256color' },
    })
    expect(environment.TERM).toBe('dumb')
    expect(environment.FAKE_MARKER).toBe('1')
    expect(() => resolveEnvironment({ policy: policy({ set: { HIVE_RUN_ID: 'mine' } }), identity, host: {} })).toThrowError(/reserved/)
    // The whole prefix is reserved, not just the names identity happens to use today.
    expect(() => resolveEnvironment({ policy: policy({ set: { HIVE_ANYTHING: '1' } }), identity, host: {} })).toThrowError(/reserved/)
  })

  it('rejects unusable policies at resolution rather than at spawn', () => {
    expect(() => resolveEnvironment({ policy: policy({ allow: [''] }), identity, host: {} })).toThrowError(/cannot be empty/)
    expect(() => resolveEnvironment({ policy: policy({ allow: ['A*B'] }), identity, host: {} })).toThrowError(/trailing \*/)
  })

  it('skips host variables with no value', () => {
    const environment = resolveEnvironment({ policy: policy(), identity, host: { PATH: undefined, HOME: '/home/op' } })
    expect('PATH' in environment).toBe(false)
    expect(environment.HOME).toBe('/home/op')
  })

  it('keeps the base list minimal enough to be reviewable and free of credentials', () => {
    expect(baseEnvironmentAllowList).toContain('PATH')
    expect(baseEnvironmentAllowList.some((name) => /KEY|TOKEN|SECRET|PASSWORD/i.test(name))).toBe(false)
  })

  it('builds identity without optional fields when a run has none', () => {
    const environment = runtimeIdentityEnvironment({ ...identity, agentId: undefined, workItemId: undefined })
    expect('HIVE_AGENT_ID' in environment).toBe(false)
    expect('HIVE_WORK_ITEM_ID' in environment).toBe(false)
  })
})

describe('redaction', () => {
  it('replaces provider key shapes wherever they appear', () => {
    expect(redactText('using sk-ant-abcdefghijklmnopqrstuv now')).toBe(`using ${redactedValue} now`)
    expect(redactText('token ghp_abcdefghijklmnopqrst')).toContain(redactedValue)
    expect(redactText('Authorization: Bearer abcdefghijklmnop')).toContain(redactedValue)
    expect(redactText('AWS AKIAIOSFODNN7EXAMPLE key')).toContain(redactedValue)
    expect(redactText('plain output line')).toBe('plain output line')
  })

  it('keeps environment names but never secret values', () => {
    const safe = redactEnvironment({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-live-abcdefghijklmnop' })
    expect(safe.PATH).toBe('/usr/bin')
    expect(safe.ANTHROPIC_API_KEY).toBe(redactedValue)
    expect(Object.keys(safe)).toContain('ANTHROPIC_API_KEY')
  })

  it('redacts the token after a secret-looking flag as well as inside one', () => {
    expect(redactArguments(['--api-key', 'abcdef123456', '--model', 'opus'])).toEqual(['--api-key', redactedValue, '--model', 'opus'])
    // The flag name survives so a recorded command line still reads; only the value goes.
    expect(redactArguments(['--token=abcdef123456'])).toEqual([`--${redactedValue}`])
  })
})
