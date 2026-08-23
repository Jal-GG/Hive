import { AgentProfile, RuntimeBackend, RuntimeCapability } from '../contracts.js'
import { HiveError } from '../errors.js'
import { RuntimeAdapter, TranscriptAdapter } from './runtime-adapter.js'

/**
 * Capabilities a backend is responsible for. `transcript` is deliberately absent:
 * whether a run's history can be imported is a property of the provider's own
 * store, not of the thing that started the process, so a profile declaring it
 * must not be rejected for running on a backend that knows nothing about it.
 */
const backendOwnedCapabilities: readonly RuntimeCapability[] = ['interactive', 'resize', 'heartbeat', 'process_tree_kill', 'persistent_session']

/**
 * The one place that turns a profile into the thing that can run it.
 *
 * Nothing above this — the run manager, the supervisor, the surfaces — names a
 * backend directly, so adding one is a registration and removing one is a missing
 * entry rather than a broken import.
 */
export class RuntimeRegistry {
  private readonly adapters = new Map<RuntimeBackend, RuntimeAdapter>()
  private readonly transcripts = new Map<string, TranscriptAdapter>()

  constructor(adapters: readonly RuntimeAdapter[] = [], transcripts: readonly TranscriptAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter)
    for (const transcript of transcripts) this.registerTranscript(transcript)
  }

  register(adapter: RuntimeAdapter): void {
    this.adapters.set(adapter.backend, adapter)
  }

  registerTranscript(adapter: TranscriptAdapter): void {
    this.transcripts.set(adapter.id, adapter)
  }

  has(backend: RuntimeBackend): boolean {
    return this.adapters.has(backend)
  }

  backends(): RuntimeBackend[] {
    return [...this.adapters.keys()].sort()
  }

  adapter(backend: RuntimeBackend): RuntimeAdapter {
    const adapter = this.adapters.get(backend)
    if (!adapter) throw new HiveError('BACKEND_UNAVAILABLE', `No runtime adapter registered for ${backend}`)
    return adapter
  }

  /**
   * Resolves the adapter for a profile and refuses the pairing up front when the
   * backend cannot do what the profile asks of it. Failing here means an operator
   * hears "this backend cannot resize" before a worktree exists, rather than
   * discovering mid-run that resize requests have been going nowhere.
   */
  forProfile(profile: AgentProfile): RuntimeAdapter {
    const adapter = this.adapter(profile.backend)
    const missing = profile.capabilities
      .filter((capability) => backendOwnedCapabilities.includes(capability))
      .filter((capability) => !adapter.capabilities.includes(capability))
    if (missing.length > 0) {
      throw new HiveError('RUNTIME_CAPABILITY_MISSING', `Backend ${adapter.backend} cannot satisfy ${missing.join(', ')} required by profile ${profile.id}`)
    }
    return adapter
  }

  /** The transcript adapter a profile names, if it names one this host has. */
  transcript(profile: AgentProfile): TranscriptAdapter | undefined {
    if (!profile.transcriptAdapter) return undefined
    const adapter = this.transcripts.get(profile.transcriptAdapter)
    if (!adapter) return undefined
    return adapter.supports(profile) ? adapter : undefined
  }

  transcriptAdapters(): string[] {
    return [...this.transcripts.keys()].sort()
  }
}
