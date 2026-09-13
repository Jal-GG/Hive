import { ActorContext, ResultEnvelope, ScopeRef, TriggerRecord, WorkflowDefinition, WorkflowSchedule, WorkflowWatch } from '../../contracts.js'
import { asResult, HiveError } from '../../errors.js'
import { Ledger } from '../../ledger.js'
import { ObservabilityService } from '../../observability.js'
import { WorkflowService, TriggerInput } from '../../workflow.js'
import { VoiceOperator } from '../../voice.js'
import { currentVersion } from '../../release.js'
import { createId } from '../../shared.js'
import { RuntimeIpcHandler, RuntimeIpcRegistrar, controlBrowseOperationNames, controlControlOperationNames, controlIpcPrefix } from './runtime-channels.js'
import { optional, payloadOf, required, whole } from './ipc-payload.js'

/**
 * The Phase 8 control plane on the desktop: the same services the CLI and MCP
 * call, one channel per operation. Nothing here re-implements a rule — the
 * ingress policy, the idempotency check, and the capability checks all live in
 * `WorkflowService`, so the desktop cannot admit work the CLI would refuse.
 */
export interface ControlIpcSurfaces {
  scope: ScopeRef
  ledger: Ledger
  workflows: WorkflowService
  observability: ObservabilityService
  /** §7 Phase 8 voice: absent means the `voice` channel answers unavailable. */
  voice?: VoiceOperator
  /** Package root for `version`; defaults to the process working directory. */
  packageRoot?: string
}

export function controlIpcHandlers(surfaces: ControlIpcSurfaces, actor: ActorContext): Map<string, RuntimeIpcHandler> {
  const { scope, ledger, workflows, observability, voice } = surfaces
  const handlers = new Map<string, RuntimeIpcHandler>()
  const envelope = <T>(operation: () => T): ResultEnvelope<T> => asResult(createId(), operation)

  for (const operation of controlBrowseOperationNames) {
    handlers.set(`${controlIpcPrefix}${operation}`, (_event) =>
      envelope(() => {
        switch (operation) {
          case 'workflows': return ledger.listWorkflows()
          case 'runs': return ledger.listWorkflowRuns(scope)
          case 'triggers': return ledger.listTriggers(scope)
          case 'schedules': return workflows.schedules(scope)
          case 'watches': return workflows.watches(scope)
          case 'skills': return ledger.listSkills(scope)
          case 'metrics': return observability.metrics(actor, scope)
          case 'admission': return workflows.admissionState()
          case 'queues': return observability.queueDiagnostics(actor, scope)
        }
      }),
    )
  }

  for (const operation of controlControlOperationNames) {
    handlers.set(`${controlIpcPrefix}${operation}`, (_event, payload) =>
      envelope(() => {
        const body = payloadOf(payload)
        switch (operation) {
          case 'register': {
            // The definition arrives from the renderer, so it is passed to the same
            // validator the CLI uses rather than trusted field by field here.
            const definition = body.definition
            if (typeof definition !== 'object' || definition === null) throw new HiveError('MISSING_ARGUMENT', 'definition is required')
            return workflows.register(actor, definition as Omit<WorkflowDefinition, 'createdBy' | 'createdAt' | 'updatedAt'>)
          }
          case 'trigger': {
            const input: TriggerInput = {
              id: required(body, 'id'),
              kind: (optional(body, 'kind') as TriggerRecord['kind'] | undefined) ?? 'manual',
              workflowId: required(body, 'workflowId'),
              version: optional(body, 'version'),
            }
            return workflows.trigger(actor, scope, input)
          }
          case 'cancel': return workflows.cancel(actor, required(body, 'runId'))
          case 'tick': return { triggered: workflows.tick(actor, body.at === undefined ? undefined : new Date(required(body, 'at'))) }
          case 'pause': return { policy: workflows.setPaused(actor, scope, true) }
          case 'resume': return { policy: workflows.setPaused(actor, scope, false) }
          case 'schedule': {
            const schedule: Omit<WorkflowSchedule, 'scope' | 'createdBy' | 'createdAt' | 'updatedAt'> & { scope: ScopeRef } = {
              id: required(body, 'id'),
              workflowId: required(body, 'workflowId'),
              intervalMs: whole(body, 'intervalMs') ?? 0,
              state: 'enabled',
              nextRunAt: required(body, 'nextRunAt'),
              scope,
            }
            return workflows.schedule(actor, schedule)
          }
          case 'schedule-state':
            return workflows.setScheduleState(actor, required(body, 'id'), (optional(body, 'state') as WorkflowSchedule['state'] | undefined) ?? 'enabled')
          case 'watch': {
            const watch: Omit<WorkflowWatch, 'scope' | 'createdBy' | 'createdAt' | 'updatedAt'> & { scope: ScopeRef } = {
              id: required(body, 'id'),
              workflowId: required(body, 'workflowId'),
              uriPrefix: required(body, 'uriPrefix'),
              state: 'enabled',
              nextRunAt: (optional(body, 'nextRunAt') as string | undefined) ?? new Date().toISOString(),
              scope,
            }
            return workflows.watch(actor, watch)
          }
          case 'watch-state':
            return workflows.setWatchState(actor, required(body, 'id'), (optional(body, 'state') as WorkflowWatch['state'] | undefined) ?? 'enabled')
          case 'watch-remove': return { removed: workflows.removeWatch(actor, required(body, 'id')) }
          case 'voice': {
            if (!voice) throw new HiveError('VOICE_UNAVAILABLE', 'The voice operator is not configured on this host')
            if (optional(body, 'utterance') === undefined) return { vocabulary: voice.vocabulary() }
            return voice.turn(actor, required(body, 'utterance'))
          }
          case 'version': return { version: currentVersion(surfaces.packageRoot ?? process.cwd()) }
        }
      }),
    )
  }
  return handlers
}

export function registerControlIpc(registrar: RuntimeIpcRegistrar, surfaces: ControlIpcSurfaces, actor: ActorContext): string[] {
  const channels: string[] = []
  for (const [channel, handler] of controlIpcHandlers(surfaces, actor)) {
    registrar.handle(channel, handler)
    channels.push(channel)
  }
  return channels
}
