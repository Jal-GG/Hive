import { ActorContext } from '../contracts.js'
import { RunManager } from '../runtime/run-manager.js'
import { MailInterrupt, parseAddress } from './mail.js'

/**
 * The interrupt channel over a RunManager: an addressed agent's live session
 * receives the message as terminal input, exactly as if it had been typed.
 *
 * Delivery picks the newest live run for the agent — the session an operator
 * would mean by "the agent" right now — and the write is authorized by the
 * host actor the bridge is built with, because relaying mail into a session is
 * a host responsibility, not a power every sender needs.
 */
export function runManagerMailInterrupt(manager: RunManager, hostActor: ActorContext): MailInterrupt {
  return {
    deliver: (address, text) => {
      const parsed = parseAddress(address)
      if (parsed.kind !== 'agent') return undefined
      const run = manager
        .liveRunIds()
        .map((runId) => manager.get(runId))
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate?.agentId === parsed.id)
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0]
      if (!run) return undefined
      manager.write(hostActor, run.id, text)
      return { recipientActorId: run.actorId }
    },
  }
}
