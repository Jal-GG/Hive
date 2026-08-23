import { EnvironmentPolicy, RuntimeIdentity } from '../contracts.js'
import { HiveError } from '../errors.js'
import { isSecretName } from './redaction.js'

/** Reserved for identity Hive injects itself, so no profile can claim to be a different run. */
export const identityPrefix = 'HIVE_'

/**
 * The minimum a child process needs to start at all — a shell, a temp directory,
 * a home, a locale. Everything beyond this is opt-in per profile, because the
 * default posture is that a provider CLI sees nothing it was not given.
 */
export const baseEnvironmentAllowList: readonly string[] = [
  'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'SHELL', 'ComSpec', 'SystemRoot', 'SystemDrive', 'windir',
  'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'COLORTERM', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
]

export interface ResolveEnvironmentInput {
  policy: EnvironmentPolicy
  identity: RuntimeIdentity
  /** Host environment to inherit from. Injected rather than read, so tests never mutate `process.env`. */
  host?: Record<string, string | undefined>
}

/**
 * Builds a child environment by construction rather than by subtraction: it
 * starts empty and only named variables are copied in.
 *
 * A `PREFIX_*` entry never matches a secret-looking name. Inheriting a
 * credential therefore always requires writing its exact name in the profile,
 * which turns "the agent has my API key" from an accident into a reviewable line
 * in the catalog.
 */
export function resolveEnvironment(input: ResolveEnvironmentInput): Record<string, string> {
  const { policy, identity } = input
  const host = input.host ?? (process.env as Record<string, string | undefined>)
  assertPolicy(policy)

  const denied = matcher(policy.deny)
  const exact = new Set([...baseEnvironmentAllowList, ...policy.allow.filter((entry) => !entry.includes('*'))].map(lower))
  const wildcard = matcher([...policy.allow.filter((entry) => entry.includes('*'))])

  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(host)) {
    if (value === undefined) continue
    if (name.toUpperCase().startsWith(identityPrefix)) continue
    if (denied(name)) continue
    const allowed = exact.has(lower(name)) || (wildcard(name) && !isSecretName(name))
    if (allowed) environment[name] = value
  }

  // Profile-set values override inherited ones; injected identity overrides both.
  for (const [name, value] of Object.entries(policy.set)) environment[name] = value
  return { ...environment, ...runtimeIdentityEnvironment(identity) }
}

/** C16: identity is handed over explicitly, never inferred from the working directory. */
export function runtimeIdentityEnvironment(identity: RuntimeIdentity): Record<string, string> {
  const environment: Record<string, string> = {
    HIVE_RUN_ID: identity.runId,
    HIVE_ACTOR_ID: identity.actorId,
    HIVE_WORKSPACE: identity.workspaceName,
    HIVE_PROJECT: identity.projectName,
    HIVE_BRANCH: identity.branch,
    HIVE_ORIGIN_MARKER: identity.originMarker,
  }
  if (identity.agentId) environment.HIVE_AGENT_ID = identity.agentId
  if (identity.workItemId) environment.HIVE_WORK_ITEM_ID = identity.workItemId
  return environment
}

function assertPolicy(policy: EnvironmentPolicy): void {
  for (const name of Object.keys(policy.set)) {
    if (name.toUpperCase().startsWith(identityPrefix)) {
      throw new HiveError('INVALID_ENVIRONMENT_POLICY', `${name} is reserved: a profile cannot set run identity`)
    }
  }
  for (const entry of [...policy.allow, ...policy.deny]) {
    if (entry.length === 0) throw new HiveError('INVALID_ENVIRONMENT_POLICY', 'Environment policy entries cannot be empty')
    if (entry.includes('*') && !entry.endsWith('*')) {
      throw new HiveError('INVALID_ENVIRONMENT_POLICY', `${entry} is not a supported pattern: only a trailing * is allowed`)
    }
  }
}

/** Case-insensitive because Windows environment variables are, and a run must behave the same on both. */
function matcher(entries: readonly string[]): (name: string) => boolean {
  const exact = new Set(entries.filter((entry) => !entry.includes('*')).map(lower))
  const prefixes = entries.filter((entry) => entry.endsWith('*')).map((entry) => lower(entry.slice(0, -1)))
  return (name: string) => {
    const candidate = lower(name)
    return exact.has(candidate) || prefixes.some((prefix) => candidate.startsWith(prefix))
  }
}

function lower(value: string): string {
  return value.toLowerCase()
}
