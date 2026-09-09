import {
  ActorContext,
  HandoffState,
  IssueType,
  MessagePriority,
  MessageType,
  DeliveryMode,
  ResultEnvelope,
  WorkItemStatus,
} from '../../contracts.js'
import { HiveError } from '../../errors.js'
import { Ledger } from '../../ledger.js'
import { HandoffService } from '../../work/handoffs.js'
import { MailService } from '../../work/mail.js'
import { PacketCompiler } from '../../work/packet.js'
import { WorkBoard } from '../../work/board.js'

export interface WorkCliSurfaces {
  ledger: Ledger
  board: WorkBoard
  mail: MailService
  handoffs: HandoffService
  packets: PacketCompiler
}

const workItemStatuses: readonly WorkItemStatus[] = ['open', 'blocked', 'assigned', 'in_progress', 'review', 'merged', 'done', 'failed', 'cancelled']
const messageStates: readonly string[] = ['pending', 'claimed', 'delivered', 'acked', 'expired']
const messagePriorities: readonly string[] = ['low', 'normal', 'high', 'urgent']
const issueTypes: readonly string[] = ['task', 'bug', 'question', 'escalation', 'workflow_step']
const deliveryModes: readonly string[] = ['queue', 'interrupt']

/**
 * `hive work <operation> [id] [--flag value]` and `hive work context --task <id>`
 * — the task-board views plus the `gt prime` equivalent, neutralized as
 * `agent context` (C14: the compiled packet is the delivery boundary).
 *
 * A pure function of its argv that returns JSON, so it composes with other
 * tools the same way the runtime and context CLIs do.
 */
export async function runWorkCli(surfaces: WorkCliSurfaces, actor: ActorContext, argv: readonly string[]): Promise<string> {
  const [operation, ...rest] = argv
  if (operation === undefined || operation === '--help' || operation === 'help') return usage()
  const scope = surfaces.ledger.resolveScope(flagValue(rest, '--workspace') ?? 'main', flagValue(rest, '--project') ?? 'hive')

  switch (operation) {
    case 'create': {
      const item = surfaces.board.create(actor, scope, {
        title: requireValue('--title', flagValue(rest, '--title')),
        description: flagValue(rest, '--description'),
        priority: optionalNumber(rest, '--priority'),
        issueType: optionalEnum('--type', flagValue(rest, '--type'), issueTypes) as IssueType | undefined,
        convoyId: flagValue(rest, '--convoy'),
        sourceTriggerId: flagValue(rest, '--trigger'),
      })
      return render({ ok: true, version: 1, requestId: item.id, data: item })
    }
    case 'show': {
      const item = surfaces.board.item(actor, positional(rest))
      return render({ ok: true, version: 1, requestId: item.id, data: item })
    }
    case 'list': {
      const statuses = repeatable(rest, '--state').map((value) => enumValue('--state', value, workItemStatuses) as WorkItemStatus)
      const items = surfaces.board.list(actor, scope, statuses)
      return render({ ok: true, version: 1, requestId: 'list', data: items })
    }
    case 'depend': {
      const dependency = surfaces.board.addDependency(
        actor,
        positional(rest),
        requireValue('--on', flagValue(rest, '--on')),
        optionalEnum('--type', flagValue(rest, '--type'), ['blocks', 'tracks', 'relates']) as 'blocks' | 'tracks' | 'relates' | undefined ?? 'blocks',
      )
      return render({ ok: true, version: 1, requestId: dependency.workItemId, data: dependency })
    }
    case 'claim': {
      const ttl = optionalNumber(rest, '--ttl')
      const claim = surfaces.board.claim(actor, positional(rest), ttl !== undefined ? { ttlMs: ttl } : {})
      return render({ ok: true, version: 1, requestId: claim.item.id, data: claim })
    }
    case 'start': {
      const item = surfaces.board.transition(actor, positional(rest), 'in_progress')
      return render({ ok: true, version: 1, requestId: item.id, data: item })
    }
    case 'status': {
      const to = enumValue('--to', requireValue('--to', flagValue(rest, '--to')), workItemStatuses) as WorkItemStatus
      const item = surfaces.board.transition(actor, positional(rest), to)
      return render({ ok: true, version: 1, requestId: item.id, data: item })
    }
    case 'plan': {
      const revision = surfaces.board.plan(actor, positional(rest), requireValue('--body', flagValue(rest, '--body')))
      return render({ ok: true, version: 1, requestId: revision.workItemId, data: revision })
    }
    case 'plan-show': {
      const revision = surfaces.board.planOf(actor, positional(rest))
      return render({ ok: true, version: 1, requestId: 'plan', data: revision ?? null })
    }
    case 'plan-history': {
      const history = surfaces.board.planHistory(actor, positional(rest))
      return render({ ok: true, version: 1, requestId: 'history', data: history })
    }
    case 'mail-send': {
      const message = surfaces.mail.send(actor, scope, {
        to: flagValue(rest, '--to'),
        queue: flagValue(rest, '--queue'),
        subject: requireValue('--subject', flagValue(rest, '--subject')),
        body: flagValue(rest, '--body'),
        type: optionalEnum('--type', flagValue(rest, '--type'), ['task', 'escalation', 'notification', 'reply', 'handoff', 'protocol']) as MessageType | undefined,
        priority: optionalEnum('--priority', flagValue(rest, '--priority'), messagePriorities) as MessagePriority | undefined,
        delivery: optionalEnum('--delivery', flagValue(rest, '--delivery'), deliveryModes) as DeliveryMode | undefined,
        threadId: flagValue(rest, '--thread'),
        replyTo: flagValue(rest, '--reply'),
      })
      return render({ ok: true, version: 1, requestId: message.id, data: message })
    }
    case 'mail-list': {
      const states = repeatable(rest, '--state').map((value) => enumValue('--state', value, messageStates))
      const messages = surfaces.mail.inbox(actor, {
        scope,
        queue: flagValue(rest, '--queue'),
        to: flagValue(rest, '--to'),
        threadId: flagValue(rest, '--thread'),
        states: states as never,
      })
      return render({ ok: true, version: 1, requestId: 'inbox', data: messages })
    }
    case 'mail-claim': {
      const claimed = surfaces.mail.claimNext(actor, requireValue('--queue', flagValue(rest, '--queue')))
      return render({ ok: true, version: 1, requestId: 'claim', data: claimed ?? null })
    }
    case 'mail-ack': {
      const acked = surfaces.mail.ack(actor, positional(rest))
      return render({ ok: true, version: 1, requestId: acked.id, data: acked })
    }
    case 'handoff-create': {
      const handoff = surfaces.handoffs.create(actor, scope, {
        toAgentId: flagValue(rest, '--to'),
        cwd: requireValue('--cwd', flagValue(rest, '--cwd')),
        summary: requireValue('--summary', flagValue(rest, '--summary')),
        openQuestions: repeatable(rest, '--question'),
        filesTouched: repeatable(rest, '--file'),
        nextSteps: repeatable(rest, '--step'),
      })
      return render({ ok: true, version: 1, requestId: handoff.id, data: handoff })
    }
    case 'handoff-list': {
      const states = repeatable(rest, '--state').map((value) => enumValue('--state', value, ['open', 'accepted', 'expired', 'cancelled']) as HandoffState)
      const handoffs = surfaces.handoffs.list(actor, scope, states)
      return render({ ok: true, version: 1, requestId: 'handoffs', data: handoffs })
    }
    case 'handoff-accept': {
      const handoff = surfaces.handoffs.accept(actor, positional(rest), { cwd: flagValue(rest, '--cwd') })
      return render({ ok: true, version: 1, requestId: handoff.id, data: handoff })
    }
    case 'context': {
      const packet = surfaces.packets.compile(actor, scope, {
        taskId: requireValue('--task', flagValue(rest, '--task')),
        agentId: flagValue(rest, '--agent'),
        cwd: flagValue(rest, '--cwd'),
        runId: flagValue(rest, '--run'),
        byteBudget: optionalNumber(rest, '--budget'),
      })
      return render({ ok: true, version: 1, requestId: packet.task.id, data: { packet, prompt: surfaces.packets.render(packet) } })
    }
    default:
      throw new HiveError('UNKNOWN_OPERATION', `Unknown work operation: ${operation}\n\n${usage()}`)
  }
}

export function usage(): string {
  return [
    'Usage: hive work <operation> [id] [options]',
    '',
    'Task board (work:mutate to change, workspace:read to view):',
    '  create             Create a work item (--title, --description, --priority, --type, --convoy, --trigger)',
    '  show <id>          One work item',
    '  list               Work items (--state, repeatable)',
    '  depend <id>        Add a dependency (--on required, --type blocks|tracks|relates)',
    '  claim <id>         Claim the item for this actor (--ttl ms)',
    '  start <id>         Move the claimed item to in_progress',
    '  status <id>        Transition status (--to required)',
    '  plan <id>          Replace the plan body (--body), claimant only',
    '  plan-show <id>     Current plan revision',
    '  plan-history <id>  Every revision, oldest first',
    '',
    'Mail (work:dispatch):',
    '  mail-send          Send a message (--to or --queue, --subject, --body, --type, --priority, --delivery, --thread, --reply)',
    '  mail-list          Inbox view (--queue, --to, --thread, --state)',
    '  mail-claim         Claim the next message in --queue',
    '  mail-ack <id>      Acknowledge a claimed message',
    '',
    'Handoffs (work:mutate):',
    '  handoff-create     Leave a handoff (--cwd, --summary, --to, --question, --file, --step — repeatable)',
    '  handoff-list       Handoffs (--state)',
    '  handoff-accept <id> Accept a handoff (--cwd to enforce the boundary)',
    '',
    'Context (the neutral `agent context` command):',
    '  context            Compile the packet for a task (--task required, --agent, --cwd, --run, --budget)',
    '',
    'Options:',
    '  --workspace <name>  Workspace name (default main)',
    '  --project <name>    Project name (default hive)',
  ].join('\n')
}

function positional(argv: readonly string[]): string {
  const first = argv.find((argument) => !argument.startsWith('--'))
  if (!first) throw new HiveError('MISSING_ARGUMENT', 'A work item or message id is required')
  return first
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new HiveError('MISSING_ARGUMENT', `${flag} needs a value`)
  return value
}

function repeatable(argv: readonly string[], flag: string): string[] {
  const values: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== flag) continue
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new HiveError('MISSING_ARGUMENT', `${flag} needs a value`)
    values.push(value)
    index += 1
  }
  return values
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value === '') throw new HiveError('MISSING_ARGUMENT', `${flag} is required`)
  return value
}

function optionalNumber(argv: readonly string[], flag: string): number | undefined {
  const value = flagValue(argv, flag)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new HiveError('INVALID_ARGUMENT', `${flag} must be a non-negative integer`)
  return parsed
}

function optionalEnum(flag: string, value: string | undefined, allowed: readonly string[]): string | undefined {
  return value === undefined ? undefined : enumValue(flag, value, allowed)
}

function enumValue(flag: string, value: string, allowed: readonly string[]): string {
  if (!allowed.includes(value)) throw new HiveError('INVALID_ARGUMENT', `${flag} must be one of ${allowed.join(', ')}; got ${value}`)
  return value
}

function render(result: ResultEnvelope<unknown>): string {
  if (!result.ok) throw new HiveError(result.error.code, result.error.message)
  return JSON.stringify(result.data, null, 2)
}
