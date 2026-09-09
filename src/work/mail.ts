import {
  ActorContext,
  Address,
  AddressKind,
  DeliveryMode,
  Message,
  MessagePriority,
  MessageState,
  MessageType,
  protocolSubjects,
  ScopeRef,
} from '../contracts.js'
import { assertCapability } from '../capabilities.js'
import { HiveError } from '../errors.js'
import { Ledger } from '../ledger.js'
import { Clock, ClockOptions, createId, resolveClock } from '../shared.js'
import { workEvent } from './events.js'

export interface ParsedAddress {
  kind: AddressKind
  id: string
}

/** `kind:id`, with an explicit kind so `foo:bar:baz` is an error, not a guess. */
export function parseAddress(address: Address): ParsedAddress {
  const match = /^(\w+):(.+)$/.exec(address.trim())
  if (!match) throw new HiveError('INVALID_ADDRESS', `Address must be kind:id, got: ${address}`)
  const kind = match[1] as AddressKind
  if (kind !== 'actor' && kind !== 'agent' && kind !== 'queue') {
    throw new HiveError('INVALID_ADDRESS', `Unknown address kind: ${match[1]} (expected actor, agent, or queue)`)
  }
  return { kind, id: match[2] }
}

/**
 * The delivery lane an address resolves to: an agent's messages queue under the
 * agent's own name, an actor's under the actor's. Resolution happens at send
 * time and is stored, so a claimant never re-derives it and the two can never
 * disagree.
 */
export function queueForAddress(address: Address): string {
  const parsed = parseAddress(address)
  return parsed.kind === 'queue' ? parsed.id : address
}

export interface SendMessageInput {
  to?: Address
  queue?: string
  subject: string
  body?: string
  type?: MessageType
  priority?: MessagePriority
  delivery?: DeliveryMode
  threadId?: string
  replyTo?: string
}

/**
 * How interrupt mail reaches a live session. Returns the recipient's actor id
 * when a session accepted the write, or undefined when there is no live session
 * for the address — in which case the message falls back to its queue.
 */
export interface MailInterrupt {
  deliver(address: Address, text: string): { recipientActorId: string } | undefined
}

export interface MailServiceOptions extends ClockOptions {
  /** Absent means every interrupt falls back to the queue, which is the honest default for a host with no runtime. */
  interrupt?: MailInterrupt
}

/**
 * C13: the closed loop. Mail is claims with acknowledgements, not reads — a
 * message is work to one recipient, delivered queue-style or interrupt-style,
 * with requeue as the fallback when a worker dies mid-claim.
 */
export class MailService {
  private readonly now: Clock
  private readonly interrupt?: MailInterrupt

  constructor(private readonly ledger: Ledger, options: MailServiceOptions = {}) {
    this.now = resolveClock(options)
    this.interrupt = options.interrupt
  }

  /** Sending requires `work:dispatch`: mail is how work reaches a recipient. */
  send(actor: ActorContext, scope: ScopeRef, input: SendMessageInput): Message {
    assertCapability(actor.capabilities, 'work:dispatch')
    const subject = input.subject?.trim()
    if (!subject) throw new HiveError('MISSING_ARGUMENT', 'A message needs a subject')
    if (input.type === 'protocol' && !protocolSubjects.includes(subject)) {
      throw new HiveError('INVALID_SUBJECT', `Protocol subject must be one of ${protocolSubjects.join(', ')}; got: ${subject}`)
    }
    // One destination or the other: a message that is both addressed and queued
    // has two definitions of "for whom", which is a bug at read time.
    if (input.to && input.queue) {
      throw new HiveError('INVALID_ARGUMENT', 'A message goes to an address or a queue, not both')
    }
    const to = input.to ? parseAddress(input.to) : undefined
    if (input.queue === undefined && !to) {
      throw new HiveError('MISSING_ARGUMENT', 'A message needs a to address or a queue')
    }
    if (to && to.kind === 'queue') {
      throw new HiveError('INVALID_ADDRESS', 'Use the queue field for a queue, not the to address')
    }
    const occurredAt = this.now().toISOString()
    const message: Message = {
      id: createId(),
      scope,
      from: `actor:${actor.actorId}`,
      to: input.to,
      queue: input.queue ?? (to ? queueForAddress(input.to!) : undefined),
      subject,
      body: input.body ?? '',
      type: input.type ?? 'notification',
      priority: input.priority ?? 'normal',
      delivery: input.delivery ?? 'queue',
      threadId: input.threadId,
      replyTo: input.replyTo,
      state: 'pending',
      createdAt: occurredAt,
    }
    this.ledger.insertMessage(message)
    this.ledger.appendEvent(workEvent(actor, scope, 'Mail', 'sent', `sent:${message.id}`, occurredAt, {
      id: message.id, to: message.to, queue: message.queue, subject, priority: message.priority, delivery: message.delivery,
    }))
    // Interrupt delivery is attempted once, at send: the whole point is to
    // reach a session that is live right now. No session means the message
    // stays pending in its queue — the retry fallback is the claim cycle.
    if (message.delivery === 'interrupt' && message.to && this.interrupt) {
      const delivered = this.interrupt.deliver(message.to, interruptText(message))
      if (delivered) {
        return this.recordInterruptDelivery(message, delivered.recipientActorId, actor)
      }
    }
    return message
  }

  message(actor: ActorContext, messageId: string): Message {
    assertCapability(actor.capabilities, 'workspace:read')
    const message = this.ledger.message(messageId)
    if (!message) throw new HiveError('MESSAGE_NOT_FOUND', `Message ${messageId} not found`)
    return message
  }

  inbox(actor: ActorContext, filter: { scope?: ScopeRef; queue?: string; to?: string; threadId?: string; states?: readonly MessageState[] }): Message[] {
    assertCapability(actor.capabilities, 'workspace:read')
    return this.ledger.listMessages(filter)
  }

  /**
   * The next message for a claimant: highest urgency first, then age. Claiming
   * is the guarded update — two pollers see the same head but only one lands.
   */
  claimNext(actor: ActorContext, queue: string): Message | undefined {
    assertCapability(actor.capabilities, 'work:dispatch')
    const candidate = this.ledger.nextPendingMessage(queue)
    if (!candidate) return undefined
    return this.claim(actor, candidate)
  }

  claim(actor: ActorContext, message: Message): Message | undefined {
    assertCapability(actor.capabilities, 'work:dispatch')
    const claimedAt = this.now().toISOString()
    const claimed = this.ledger.claimMessage(message.id, actor.actorId, claimedAt)
    if (!claimed) return undefined
    this.ledger.appendEvent(workEvent(actor, claimed.scope, 'Mail', 'claimed', `claimed:${claimed.id}:${actor.actorId}`, claimedAt, {
      id: claimed.id, subject: claimed.subject, claimedBy: actor.actorId,
    }))
    return claimed
  }

  /**
   * Records that a live session took an interrupt: the recipient's actor is the
   * claimant from that moment, so the loop closes with their acknowledgement.
   */
  private recordInterruptDelivery(message: Message, recipientActorId: string, actor: ActorContext): Message {
    const deliveredAt = this.now().toISOString()
    const delivered = this.ledger.deliverInterruptMessage(message.id, recipientActorId, deliveredAt)
    this.ledger.appendEvent(workEvent(actor, delivered.scope, 'Mail', 'delivered', `delivered:${delivered.id}`, deliveredAt, {
      id: delivered.id, subject: delivered.subject, recipient: recipientActorId, delivery: 'interrupt',
    }))
    return delivered
  }

  /** Acknowledgement closes the loop: only the claimant, from `claimed` or `delivered`. */
  ack(actor: ActorContext, messageId: string): Message {
    assertCapability(actor.capabilities, 'work:dispatch')
    const message = this.ledger.message(messageId)
    if (!message) throw new HiveError('MESSAGE_NOT_FOUND', `Message ${messageId} not found`)
    if (message.claimedBy !== actor.actorId) {
      throw new HiveError('MESSAGE_NOT_CLAIMED', `Message ${messageId} is claimed by ${message.claimedBy ?? 'nobody'}, not ${actor.actorId}`)
    }
    const ackedAt = this.now().toISOString()
    const acked = this.ledger.acknowledgeMessage(messageId, actor.actorId, ackedAt)
    if (!acked) {
      throw new HiveError('MESSAGE_STATE', `Message ${messageId} is ${message.state} and cannot be acknowledged from there`)
    }
    this.ledger.appendEvent(workEvent(actor, acked.scope, 'Mail', 'acked', `acked:${acked.id}`, ackedAt, {
      id: acked.id, subject: acked.subject,
    }))
    return acked
  }

  /**
   * The retry fallback: claims older than the expiry go back to pending, and
   * the number is returned so the caller can report the recovery it caused.
   */
  requeue(actor: ActorContext, scope: ScopeRef, olderThanMs: number): number {
    assertCapability(actor.capabilities, 'work:dispatch')
    const cutoff = new Date(this.now().getTime() - olderThanMs).toISOString()
    const requeued = this.ledger.requeueExpiredClaims(cutoff)
    if (requeued > 0) {
      this.ledger.appendEvent(workEvent(actor, scope, 'Mail', 'requeued', `requeued:${cutoff}`, cutoff, { requeued }))
    }
    return requeued
  }
}

/** What a session actually sees on its terminal: provenance first, so it reads as mail, not as a prompt. */
function interruptText(message: Message): string {
  return `[hive mail from ${message.from}] ${message.subject}\n${message.body}\n`
}
