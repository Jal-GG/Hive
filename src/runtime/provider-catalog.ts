import { AgentProfile, EnvironmentPolicy, RuntimeBackend, RuntimeCapability, RuntimeProvider } from '../contracts.js'
import { HiveError } from '../errors.js'

/** Values a command template may reference. Anything else in braces is a typo, not a feature. */
export interface CommandPlaceholders {
  prompt?: string
  model?: string
  cwd?: string
  branch?: string
  runId?: string
}

export interface RuntimeCommand {
  executable: string
  args: string[]
}

const placeholderNames: readonly (keyof CommandPlaceholders)[] = ['prompt', 'model', 'cwd', 'branch', 'runId']

const interactiveCapabilities: RuntimeCapability[] = ['interactive', 'resize', 'heartbeat', 'process_tree_kill']

function policy(allow: string[], set: Record<string, string> = {}): EnvironmentPolicy {
  // Denied even when a caller widens `allow`: these hand the operator's own credential agents to the child.
  return { allow, deny: ['SSH_AUTH_SOCK', 'GIT_ASKPASS', 'SUDO_ASKPASS', 'AWS_SESSION_TOKEN'], set }
}

/**
 * Known provider CLIs and how to start them. Kept as data rather than code so a
 * new provider is a catalog entry plus, at most, a transcript adapter — never a
 * change to the runtime, the supervisor, or any surface.
 *
 * Credential names are listed exactly. That is deliberate: `resolveEnvironment`
 * refuses to hand a secret-looking variable to a wildcard, so every key an agent
 * can see is a line someone wrote and a reviewer can read.
 */
export const defaultAgentProfiles: readonly AgentProfile[] = [
  {
    id: 'claude',
    provider: 'claude',
    executable: 'claude',
    argsTemplate: ['--model={model}'],
    environmentPolicy: policy(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_*', 'CLAUDE_CONFIG_DIR']),
    capabilities: interactiveCapabilities.concat('transcript'),
    backend: 'node_pty',
    transcriptAdapter: 'claude_jsonl',
    promptDelivery: 'stdin',
    idleAfterMs: 120_000,
  },
  {
    id: 'codex',
    provider: 'codex',
    executable: 'codex',
    argsTemplate: ['--model={model}'],
    environmentPolicy: policy(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'CODEX_*']),
    capabilities: interactiveCapabilities,
    backend: 'node_pty',
    promptDelivery: 'stdin',
    idleAfterMs: 120_000,
  },
  {
    id: 'grok',
    provider: 'grok',
    executable: 'grok',
    argsTemplate: ['--model={model}'],
    environmentPolicy: policy(['XAI_API_KEY', 'XAI_BASE_URL', 'GROK_*']),
    capabilities: interactiveCapabilities,
    backend: 'node_pty',
    promptDelivery: 'stdin',
    idleAfterMs: 120_000,
  },
  {
    id: 'qwen',
    provider: 'qwen',
    executable: 'qwen',
    argsTemplate: ['--model={model}'],
    environmentPolicy: policy(['DASHSCOPE_API_KEY', 'QWEN_*', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']),
    capabilities: interactiveCapabilities,
    backend: 'node_pty',
    promptDelivery: 'stdin',
    idleAfterMs: 120_000,
  },
  {
    id: 'opencode',
    provider: 'opencode',
    executable: 'opencode',
    argsTemplate: ['--model={model}'],
    environmentPolicy: policy(['OPENCODE_*', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY']),
    capabilities: interactiveCapabilities,
    backend: 'node_pty',
    promptDelivery: 'stdin',
    idleAfterMs: 120_000,
  },
  {
    id: 'crush',
    provider: 'crush',
    executable: 'crush',
    argsTemplate: [],
    environmentPolicy: policy(['CRUSH_*', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']),
    capabilities: interactiveCapabilities,
    backend: 'node_pty',
    promptDelivery: 'stdin',
    idleAfterMs: 120_000,
  },
  {
    id: 'pi',
    provider: 'pi',
    executable: 'pi',
    argsTemplate: ['--model={model}'],
    environmentPolicy: policy(['PI_API_KEY', 'PI_*']),
    capabilities: interactiveCapabilities,
    backend: 'node_pty',
    promptDelivery: 'stdin',
    idleAfterMs: 120_000,
  },
  {
    id: 'copilot',
    provider: 'copilot',
    executable: 'copilot',
    argsTemplate: [],
    environmentPolicy: policy(['GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_*', 'GITHUB_COPILOT_*']),
    capabilities: interactiveCapabilities,
    backend: 'node_pty',
    promptDelivery: 'stdin',
    idleAfterMs: 120_000,
  },
  {
    /**
     * The configured fake provider Phase 3 is defined against. It runs no
     * external binary, so the whole launch path — worktree, lease, spawn,
     * streaming, resize, stop, restart recovery — is exercised deterministically
     * on a machine with no provider CLI installed at all.
     */
    id: 'fake',
    provider: 'fake',
    executable: 'hive-fake-agent',
    argsTemplate: ['--run={runId}', '--branch={branch}', '--prompt={prompt}'],
    // Not `HIVE_FAKE`: the `HIVE_` prefix is reserved for injected identity, which is
    // what lets a child trust every `HIVE_*` variable it sees as coming from Hive.
    environmentPolicy: policy([], { FAKE_PROVIDER: '1' }),
    capabilities: ['interactive', 'resize', 'heartbeat', 'transcript', 'process_tree_kill'],
    backend: 'fake',
    transcriptAdapter: 'fake_transcript',
    readyPattern: 'HIVE_FAKE_READY',
    promptDelivery: 'argument',
    idleAfterMs: 5_000,
  },
]

export const fakeProfileId = 'fake'

/**
 * The set of profiles a host may launch. Built-ins are seeded on construction and
 * registration overrides by id, so an operator's configured profile shadows the
 * shipped one without the two ever disagreeing at launch time.
 */
export class ProviderCatalog {
  private readonly profiles = new Map<string, AgentProfile>()

  constructor(profiles: readonly AgentProfile[] = defaultAgentProfiles) {
    for (const profile of profiles) this.register(profile)
  }

  register(profile: AgentProfile): AgentProfile {
    const validated = validateProfile(profile)
    this.profiles.set(validated.id, validated)
    return validated
  }

  get(id: string): AgentProfile {
    const profile = this.profiles.get(id)
    if (!profile) throw new HiveError('PROFILE_NOT_FOUND', `No agent profile registered as ${id}`)
    return profile
  }

  has(id: string): boolean {
    return this.profiles.has(id)
  }

  list(provider?: RuntimeProvider, backend?: RuntimeBackend): AgentProfile[] {
    return [...this.profiles.values()]
      .filter((profile) => (provider ? profile.provider === provider : true))
      .filter((profile) => (backend ? profile.backend === backend : true))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  buildCommand(profile: AgentProfile, placeholders: CommandPlaceholders = {}): RuntimeCommand {
    return buildCommand(profile, placeholders)
  }
}

/**
 * Substitutes placeholders per argv token and never re-splits the result, so a
 * prompt containing spaces, quotes, or newlines stays exactly one argument and no
 * command line can be injected through its content.
 *
 * A token referencing a placeholder with no value is dropped whole. Optional
 * flags therefore carry their value in the same token (`--model={model}`), which
 * keeps a dangling `--model` from ever reaching the provider.
 */
export function buildCommand(profile: AgentProfile, placeholders: CommandPlaceholders = {}): RuntimeCommand {
  const args: string[] = []
  for (const token of profile.argsTemplate) {
    const rendered = renderToken(token, placeholders, profile.id)
    if (rendered !== undefined) args.push(rendered)
  }
  return { executable: profile.executable, args }
}

function renderToken(token: string, placeholders: CommandPlaceholders, profileId: string): string | undefined {
  let missing = false
  let referenced = false
  const rendered = token.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name: string) => {
    if (!placeholderNames.includes(name as keyof CommandPlaceholders)) {
      throw new HiveError('UNKNOWN_PLACEHOLDER', `Profile ${profileId} references unknown placeholder {${name}}`)
    }
    referenced = true
    const value = placeholders[name as keyof CommandPlaceholders]
    if (value === undefined || value.length === 0) {
      missing = true
      return ''
    }
    return value
  })
  return referenced && missing ? undefined : rendered
}

function validateProfile(profile: AgentProfile): AgentProfile {
  if (profile.id.trim().length === 0) throw new HiveError('INVALID_PROFILE', 'Agent profile id cannot be empty')
  if (profile.executable.trim().length === 0) throw new HiveError('INVALID_PROFILE', `Profile ${profile.id} has no executable`)
  if (profile.readyPattern !== undefined) {
    // Compiled now so a bad pattern fails at registration rather than mid-launch.
    try {
      new RegExp(profile.readyPattern)
    } catch (error) {
      throw new HiveError('INVALID_PROFILE', `Profile ${profile.id} has an invalid readyPattern: ${(error as Error).message}`)
    }
  }
  // Rendering every token surfaces unknown placeholders at registration too.
  for (const token of profile.argsTemplate) renderToken(token, { prompt: 'p', model: 'm', cwd: 'c', branch: 'b', runId: 'r' }, profile.id)

  const carriesPrompt = profile.argsTemplate.some((token) => token.includes('{prompt}'))
  if (profile.promptDelivery === 'argument' && !carriesPrompt) {
    throw new HiveError('INVALID_PROFILE', `Profile ${profile.id} delivers its prompt by argument but no token references {prompt}`)
  }
  if (profile.promptDelivery !== 'argument' && carriesPrompt) {
    throw new HiveError('INVALID_PROFILE', `Profile ${profile.id} references {prompt} but does not deliver its prompt by argument`)
  }
  // A run adopted after a restart must have been startable that way to begin with.
  if (profile.backend === 'tmux' && !profile.capabilities.includes('persistent_session')) {
    throw new HiveError('INVALID_PROFILE', `Profile ${profile.id} uses tmux but does not declare persistent_session`)
  }
  if (profile.idleAfterMs !== undefined && profile.idleAfterMs <= 0) {
    throw new HiveError('INVALID_PROFILE', `Profile ${profile.id} has a non-positive idleAfterMs`)
  }
  return profile
}
