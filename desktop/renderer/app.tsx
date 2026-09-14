import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { AnimatePresence, motion } from 'framer-motion'
import { Activity, Bot, Hexagon, ListChecks, Map, Plus, Send, Square, Zap } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import './app.css'
import { RuntimeViewModel, type RuntimeViewState } from '../../src/interfaces/desktop/runtime-view-model.js'
import type { HiveWindow } from '../../src/interfaces/desktop/preload-bridge.js'
import type { RunState, WorkItemStatus } from '../../src/contracts.js'

declare global {
  interface Window {
    hive: HiveWindow
  }
}

/** The work-plane view types the renderer needs; the bridge returns JSON shapes. */
interface WorkItemView {
  id: string
  title: string
  status: WorkItemStatus
  assigneeActorId?: string
}
interface AgentView {
  id: string
  name: string
  profileId: string
  skills: string[]
  energy: number
  maxEnergy: number
}
interface PlanView {
  revision: number
  body: string
  updatedByActorId: string
}

/** The Phase 8 control-plane views (§7 Phase 8). Shapes match the control IPC envelope. */
interface WorkflowView {
  id: string
  version: string
  enabled: boolean
}
interface WorkflowRunView {
  id: string
  workflowId: string
  state: string
}
interface TriggerView {
  id: string
  kind: string
  workflowId: string
  state: 'accepted' | 'duplicate' | 'rejected'
  payload: Record<string, unknown>
  createdAt: string
}
interface ScheduleView {
  id: string
  workflowId: string
  intervalMs: number
  state: 'enabled' | 'disabled'
  nextRunAt: string
}
interface AdmissionView {
  policy: { paused?: boolean; allowedKinds?: string[]; spendCapUsd?: number }
  breaker: { failures: number; openUntil?: string }
}

/** A desk in the office: one agent, its state, and the work it holds. */
interface OfficeDeskView {
  id: string
  name: string
  state: 'live' | 'idle' | 'gone'
}

type Tab = 'runs' | 'tasks' | 'fleet' | 'ingress' | 'office'

const liveRunStates: readonly RunState[] = ['spawning', 'running', 'idle', 'completing']
const liveWorkStates: readonly WorkItemStatus[] = ['assigned', 'in_progress', 'review']

/**
 * The operator console: fleet, board, and one terminal, in Hive's own skin.
 *
 * The run view model still owns every terminal decision — this file is layout
 * and motion only. The work and fleet panels talk to their bridges directly;
 * they poll while in front because the work plane has no push streams yet.
 */
function App({ model }: { model: RuntimeViewModel }) {
  const [state, setState] = useState<RuntimeViewState>(() => model.state())
  const [prompt, setPrompt] = useState('')
  const [taskTitle, setTaskTitle] = useState('')
  const [tab, setTab] = useState<Tab>('runs')
  const [items, setItems] = useState<WorkItemView[]>([])
  const [agents, setAgents] = useState<AgentView[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>(undefined)
  const [plan, setPlan] = useState<PlanView | null>(null)
  const [workError, setWorkError] = useState<string | undefined>(undefined)
  const [workflows, setWorkflows] = useState<WorkflowView[]>([])
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunView[]>([])
  const [triggers, setTriggers] = useState<TriggerView[]>([])
  const [schedules, setSchedules] = useState<ScheduleView[]>([])
  const [admission, setAdmission] = useState<AdmissionView | undefined>(undefined)
  const terminalElement = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | undefined>(undefined)

  useEffect(() => model.subscribe(setState), [model])

  useEffect(() => {
    const element = terminalElement.current
    if (!element) return
    const term = new Terminal({
      fontSize: 13,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      cursorBlink: true,
      convertEol: false,
      theme: {
        background: '#0e1118',
        foreground: '#e6e9f2',
        cursor: '#f5b942',
        selectionBackground: '#8b7cf655',
        black: '#0e1118',
        green: '#4ade80',
        yellow: '#f5b942',
        blue: '#8b7cf6',
        magenta: '#c4b5fd',
        cyan: '#86efac',
        red: '#f87171',
      },
    })
    const addon = new FitAddon()
    term.loadAddon(addon)
    term.open(element)
    term.write(state.terminal)
    terminal.current = term
    const resize = () => addon.fit()
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('resize', resize)
      term.dispose()
      terminal.current = undefined
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    terminal.current?.write(state.terminal)
  }, [state.terminal])

  useEffect(() => {
    void model.refresh()
    void window.hive.stream.follow(state.cursor)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (state.selectedRunId) void window.hive.stream.attach(state.selectedRunId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.selectedRunId])

  useEffect(() => {
    if (terminal.current && state.selectedRunId) void model.resize(terminal.current.cols, terminal.current.rows)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.selectedRunId, state.status?.cols])

  const refreshWork = useCallback(async () => {
    const [itemsResult, agentsResult] = await Promise.all([
      window.hive.work.invoke('items'),
      window.hive.work.invoke('agents'),
    ])
    if (itemsResult.ok) setItems(itemsResult.data as WorkItemView[])
    else setWorkError(itemsResult.error.message)
    if (agentsResult.ok) setAgents(agentsResult.data as AgentView[])
  }, [])

  const selectTask = useCallback(async (taskId: string) => {
    setSelectedTaskId(taskId)
    const result = await window.hive.work.invoke('plan', { workItemId: taskId })
    setPlan(result.ok ? ((result.data as PlanView | null) ?? null) : null)
  }, [])

  /**
   * The Phase 8 control plane, read through the same channels the CLI's services
   * back — one truth, not a desktop copy of it. A refusal is surfaced rather than
   * swallowed: an operator who paused ingress needs to see that it held.
   */
  const refreshControl = useCallback(async () => {
    const [workflowsResult, runsResult, triggersResult, schedulesResult, admissionResult] = await Promise.all([
      window.hive.control.invoke('workflows'),
      window.hive.control.invoke('runs'),
      window.hive.control.invoke('triggers'),
      window.hive.control.invoke('schedules'),
      window.hive.control.invoke('admission'),
    ])
    if (workflowsResult.ok) setWorkflows(workflowsResult.data as WorkflowView[])
    if (runsResult.ok) setWorkflowRuns(runsResult.data as WorkflowRunView[])
    if (triggersResult.ok) setTriggers(triggersResult.data as TriggerView[])
    else setWorkError(triggersResult.error.message)
    if (schedulesResult.ok) setSchedules(schedulesResult.data as ScheduleView[])
    if (admissionResult.ok) setAdmission(admissionResult.data as AdmissionView)
  }, [])

  const controlAction = useCallback(
    async (operation: string, payload?: Record<string, unknown>) => {
      const result = await window.hive.control.invoke(operation, payload)
      if (!result.ok) {
        setWorkError(result.error.message)
        return
      }
      setWorkError(undefined)
      await refreshControl()
    },
    [refreshControl],
  )

  // The board and fleet poll while their tab is in front: no push streams yet.
  useEffect(() => {
    if (tab === 'runs') return
    if (tab === 'ingress' || tab === 'office') {
      void refreshControl()
      void refreshWork()
      const timer = setInterval(() => {
        void refreshControl()
        void refreshWork()
      }, 2500)
      return () => clearInterval(timer)
    }
    void refreshWork()
    const timer = setInterval(() => void refreshWork(), 2500)
    return () => clearInterval(timer)
  }, [tab, refreshWork, refreshControl])

  const runWork = useCallback(async (operation: string, payload: Record<string, unknown>) => {
    const result = await window.hive.work.invoke(operation, payload)
    if (!result.ok) {
      setWorkError(result.error.message)
      return undefined
    }
    setWorkError(undefined)
    return result.data
  }, [])

  const selected = useMemo(() => state.runs.find((run) => run.id === state.selectedRunId), [state.runs, state.selectedRunId])
  const selectedTask = items.find((item) => item.id === selectedTaskId)
  const liveRuns = state.runs.filter((run) => liveRunStates.includes(run.state)).length
  const openTasks = items.filter((item) => item.status === 'open' || item.status === 'blocked').length
  const inFlight = items.filter((item) => liveWorkStates.includes(item.status)).length

  return (
    <div className="flex h-full flex-col">
      <header className="glass z-10 flex items-center gap-4 border-x-0 border-t-0 px-5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="hex-chip flex h-7 w-7 items-center justify-center bg-gradient-to-br from-honey-400 to-honey-600">
            <Hexagon className="h-4 w-4 text-hive-950" strokeWidth={2.6} />
          </span>
          <span className="font-display text-lg font-bold tracking-[0.2em] text-honey-300">HIVE</span>
        </div>
        <span className="font-mono text-[11px] uppercase tracking-widest text-hive-500">agent control</span>
        <div className="ml-auto flex items-center gap-2">
          <StatChip icon={<Activity className="h-3.5 w-3.5" />} value={liveRuns} label="live" tone="phosphor" />
          <StatChip icon={<ListChecks className="h-3.5 w-3.5" />} value={openTasks} label="open" tone="orchid" />
          <StatChip icon={<Zap className="h-3.5 w-3.5" />} value={inFlight} label="in flight" tone="honey" />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="glass z-10 flex w-72 flex-col border-y-0 border-l-0">
          <nav className="relative flex p-2">
            {(
              [
                { id: 'runs', label: 'Runs', icon: <Activity className="h-3.5 w-3.5" /> },
                { id: 'tasks', label: 'Tasks', icon: <ListChecks className="h-3.5 w-3.5" /> },
                { id: 'fleet', label: 'Fleet', icon: <Bot className="h-3.5 w-3.5" /> },
                { id: 'ingress', label: 'Ingress', icon: <Zap className="h-3.5 w-3.5" /> },
                { id: 'office', label: 'Office', icon: <Map className="h-3.5 w-3.5" /> },
              ] as const
            ).map((entry) => (
              <button
                key={entry.id}
                onClick={() => setTab(entry.id)}
                className={`relative flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 font-display text-[13px] font-medium transition-colors ${
                  tab === entry.id ? 'text-honey-300' : 'text-hive-500 hover:text-orchid-300'
                }`}
              >
                {tab === entry.id && (
                  <motion.span
                    layoutId="tab-pill"
                    className="glass-soft absolute inset-0 rounded-lg"
                    transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                  />
                )}
                <span className="relative z-10 flex items-center gap-1.5">
                  {entry.icon}
                  {entry.label}
                </span>
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            <AnimatePresence mode="wait">
              {tab === 'runs' && (
                <motion.div
                  key="runs"
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 8 }}
                  transition={{ duration: 0.15 }}
                  className="flex flex-col gap-2"
                >
                  <form
                    className="glass-soft flex flex-col gap-2 rounded-xl p-2.5"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void model.launch({ profileId: 'fake', workspace: 'main', project: 'hive', prompt: prompt || undefined })
                      setPrompt('')
                    }}
                  >
                    <input className="field" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="prompt (optional)" />
                    <button className="btn btn-honey flex items-center justify-center gap-1.5" disabled={state.busy}>
                      <Plus className="h-4 w-4" /> Launch agent
                    </button>
                  </form>
                  {state.roster.map((row, index) => (
                    <motion.button
                      key={row.runId}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: Math.min(index * 0.03, 0.2) }}
                      onClick={() => void model.select(row.runId)}
                      className={`glass-soft flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                        row.live ? 'ring-1 ring-orchid-500/60' : 'hover:border-hive-500'
                      }`}
                    >
                      <StatusDot state={row.state} live={row.live} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-[12px] text-honey-300">{row.short}</span>
                        <span className="block truncate text-[11px] text-hive-500">{row.profile}{row.outcome ? ` · ${row.outcome}` : ''}</span>
                      </span>
                      <span className="font-mono text-[10px] uppercase tracking-wide text-hive-500">{row.state}</span>
                    </motion.button>
                  ))}
                </motion.div>
              )}

              {tab === 'tasks' && (
                <motion.div
                  key="tasks"
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 8 }}
                  transition={{ duration: 0.15 }}
                  className="flex flex-col gap-2"
                >
                  <form
                    className="glass-soft flex gap-2 rounded-xl p-2.5"
                    onSubmit={(event) => {
                      event.preventDefault()
                      const title = taskTitle.trim()
                      if (!title) return
                      void runWork('create', { title }).then(() => refreshWork())
                      setTaskTitle('')
                    }}
                  >
                    <input className="field flex-1" value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="task title" />
                    <button className="btn btn-honey px-3" title="New task">
                      <Plus className="h-4 w-4" />
                    </button>
                  </form>
                  {items.map((item) => (
                    <motion.button
                      key={item.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      onClick={() => void selectTask(item.id)}
                      className={`glass-soft flex items-center gap-3 rounded-xl px-3 py-2.5 text-left ${
                        item.id === selectedTaskId ? 'ring-1 ring-honey-500/70' : ''
                      }`}
                    >
                      <TaskStatusChip status={item.status} />
                      <span className="min-w-0 flex-1 truncate text-[13px]">{item.title}</span>
                    </motion.button>
                  ))}
                  {items.length === 0 && <EmptyHint text="no tasks — the board is clear" />}
                </motion.div>
              )}

              {tab === 'fleet' && (
                <motion.div
                  key="fleet"
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 8 }}
                  transition={{ duration: 0.15 }}
                  className="flex flex-col gap-2"
                >
                  {agents.map((agent) => (
                    <motion.div key={agent.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="glass-soft rounded-xl p-3">
                      <div className="flex items-center gap-2">
                        <span className="hex-chip flex h-5 w-5 items-center justify-center bg-gradient-to-br from-orchid-400 to-orchid-500">
                          <Bot className="h-3 w-3 text-hive-950" />
                        </span>
                        <span className="font-mono text-[12px] text-orchid-300">{agent.name}</span>
                        <span className="ml-auto font-mono text-[10px] text-hive-500">{agent.profileId}</span>
                      </div>
                      <EnergyMeter energy={agent.energy} maxEnergy={agent.maxEnergy} />
                      {agent.skills.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {agent.skills.map((skill) => (
                            <span key={skill} className="rounded-full border border-hive-600 px-2 py-0.5 font-mono text-[10px] text-hive-500">
                              {skill}
                            </span>
                          ))}
                        </div>
                      )}
                    </motion.div>
                  ))}
                  {agents.length === 0 && <EmptyHint text="no agents registered — the hive sleeps" />}
                </motion.div>
              )}

              {tab === 'ingress' && (
                <motion.div
                  key="ingress"
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 8 }}
                  transition={{ duration: 0.15 }}
                  className="flex flex-col gap-2"
                >
                  <div className="glass-soft rounded-xl p-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] uppercase tracking-widest text-hive-500">trigger ingress</span>
                      <span className={`ml-auto font-mono text-[10px] ${admission?.policy.paused ? 'text-ember-400' : 'text-phosphor-400'}`}>
                        {admission?.policy.paused ? 'paused' : 'live'}
                      </span>
                    </div>
                    {admission?.breaker.failures ? (
                      <p className="mt-1 font-mono text-[10px] text-ember-400">
                        breaker {admission.breaker.failures}
                        {admission.breaker.openUntil ? ` · open until ${admission.breaker.openUntil}` : ''}
                      </p>
                    ) : null}
                    {admission?.policy.allowedKinds?.length ? (
                      <p className="mt-1 font-mono text-[10px] text-hive-500">kinds {admission.policy.allowedKinds.join(', ')}</p>
                    ) : null}
                    <div className="mt-2 flex gap-2">
                      <button className="btn btn-ghost" disabled={admission?.policy.paused === true} onClick={() => void controlAction('pause')}>
                        Pause
                      </button>
                      <button className="btn btn-ghost" disabled={admission?.policy.paused !== true} onClick={() => void controlAction('resume')}>
                        Resume
                      </button>
                    </div>
                  </div>

                  <p className="px-1 font-mono text-[10px] uppercase tracking-widest text-hive-500">
                    {workflows.length} workflows · {workflowRuns.length} runs · {schedules.length} schedules
                  </p>

                  {triggers
                    .slice()
                    .reverse()
                    .slice(0, 12)
                    .map((trigger, index) => (
                      <motion.div
                        key={`${trigger.id}:${trigger.createdAt}`}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: Math.min(index * 0.02, 0.2) }}
                        className="glass-soft rounded-xl px-3 py-2"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`font-mono text-[10px] ${
                              trigger.state === 'accepted' ? 'text-phosphor-400' : trigger.state === 'rejected' ? 'text-ember-400' : 'text-hive-500'
                            }`}
                          >
                            {trigger.state}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-hive-100">{trigger.workflowId}</span>
                          <span className="font-mono text-[10px] text-hive-500">{trigger.kind}</span>
                        </div>
                        {trigger.state === 'rejected' && typeof trigger.payload.reason === 'string' ? (
                          <p className="mt-1 truncate text-[11px] text-ember-400">{String(trigger.payload.reason)}</p>
                        ) : null}
                      </motion.div>
                    ))}
                  {triggers.length === 0 && <EmptyHint text="no triggers yet — ingress is quiet" />}
                </motion.div>
              )}

              {tab === 'office' && (
                <motion.div
                  key="office"
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 8 }}
                  transition={{ duration: 0.15 }}
                  className="flex flex-col gap-2"
                >
                  <div className="glass-soft rounded-xl p-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] uppercase tracking-widest text-hive-500">the office</span>
                      <span className="ml-auto font-mono text-[10px] text-hive-500">a view, not a control</span>
                    </div>
                    <p className="mt-1 font-mono text-[10px] text-hive-500">
                      {agents.length} agents · {liveRuns} at a desk · {openTasks} open tasks on the board
                    </p>
                  </div>
                  <div className="office-floor grid grid-cols-2 gap-2">
                    {agents.map((agent) => (
                      <motion.div
                        key={agent.id}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="glass-soft office-desk flex items-center gap-3 rounded-xl px-3 py-3"
                      >
                        <span className="hex-chip flex h-8 w-8 items-center justify-center bg-gradient-to-br from-honey-400 to-honey-600">
                          <Bot className="h-4 w-4 text-hive-950" strokeWidth={2.4} />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-mono text-[12px] text-honey-300">{agent.name}</p>
                          <p className="font-mono text-[10px] text-hive-500">
                            {agent.energy > 0 ? `${agent.energy}/${agent.maxEnergy} energy` : 'resting'}
                            {agent.skills.length > 0 ? ` · ${agent.skills.slice(0, 2).join(', ')}` : ''}
                          </p>
                        </div>
                        <StatusDot state={agent.energy > 0 ? 'running' : 'idle'} live={agent.energy > 0} />
                      </motion.div>
                    ))}
                    {Array.from({ length: Math.max(0, 4 - agents.length) }, (_, index) => (
                      <div key={`empty-${index}`} className="glass-soft office-desk-empty flex items-center justify-center rounded-xl px-3 py-3">
                        <span className="font-mono text-[10px] text-hive-500">empty desk</span>
                      </div>
                    ))}
                  </div>
                  {agents.length === 0 && <EmptyHint text="the office is dark — no agents registered" />}
                  <p className="px-1 font-mono text-[10px] text-hive-500">
                    {inFlight} tasks in flight · workflows {workflows.length} · runs {workflowRuns.length}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          {workError ? <p className="px-4 pb-3 text-[11px] text-ember-400">{workError}</p> : null}
          {state.error ? <p className="px-4 pb-3 text-[11px] text-ember-400">{state.error}</p> : null}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col p-3">
          <section className="glass flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl">
            {tab === 'tasks' && selectedTask ? (
              <div className="border-b border-hive-700/60 px-4 py-3">
                <div className="flex items-center gap-3">
                  <TaskStatusChip status={selectedTask.status} />
                  <span className="font-display text-[15px] font-medium">{selectedTask.title}</span>
                  <span className="font-mono text-[11px] text-hive-500">{selectedTask.assigneeActorId ?? 'unassigned'}</span>
                  <div className="ml-auto flex gap-2">
                    <button className="btn btn-ghost" onClick={() => void runWork('claim', { workItemId: selectedTask.id }).then(() => refreshWork())}>
                      Claim
                    </button>
                    <button className="btn btn-ghost" onClick={() => void runWork('start', { workItemId: selectedTask.id }).then(() => refreshWork())}>
                      Start
                    </button>
                  </div>
                </div>
                {plan ? (
                  <pre className="glass-soft mt-3 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg p-2.5 font-mono text-[11px] text-phosphor-400">
                    {`plan r${plan.revision} · ${plan.updatedByActorId}\n${plan.body}`}
                  </pre>
                ) : (
                  <p className="mt-2 text-[12px] text-hive-500">no plan written yet</p>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-3 border-b border-hive-700/60 px-4 py-2.5">
                <span className={`status-dot ${selected ? dotClass(selected.state) : 'status-dot-gone'}`} />
                <span className="font-mono text-[12px] text-honey-300">{selected ? selected.branch : '—'}</span>
                <span className="font-mono text-[11px] text-hive-500">{selected ? `${selected.runtimeProfile} · ${selected.state}` : 'select a run'}</span>
                {selected && (
                  <button className="btn btn-ghost ml-auto flex items-center gap-1.5" onClick={() => void model.stop({ cleanup: true })}>
                    <Square className="h-3.5 w-3.5" /> Stop
                  </button>
                )}
              </div>
            )}
            <div className="terminal min-h-0 flex-1" ref={terminalElement} />
          </section>

          <form
            className="mt-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void model.send(`${prompt}\n`)
              setPrompt('')
            }}
          >
            <div className="glass flex min-w-0 flex-1 items-center rounded-xl px-3">
              <input
                className="w-full bg-transparent py-2.5 font-mono text-[13px] outline-none placeholder:text-hive-500"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={selected ? 'type to the agent…' : 'no run selected'}
                disabled={!selected}
              />
            </div>
            <button className="btn btn-honey flex items-center gap-1.5 px-4" disabled={!selected}>
              <Send className="h-4 w-4" />
            </button>
          </form>
        </main>
      </div>
    </div>
  )
}

function StatChip({ icon, value, label, tone }: { icon: ReactNode; value: number; label: string; tone: 'phosphor' | 'orchid' | 'honey' }) {
  const toneClass = { phosphor: 'text-phosphor-400', orchid: 'text-orchid-300', honey: 'text-honey-300' }[tone]
  return (
    <span className="glass-soft flex items-center gap-1.5 rounded-full px-3 py-1.5">
      <span className={toneClass}>{icon}</span>
      <span className={`font-mono text-[13px] font-bold ${toneClass}`}>{value}</span>
      <span className="text-[11px] text-hive-500">{label}</span>
    </span>
  )
}

function StatusDot({ state, live }: { state: string; live: boolean }) {
  return <span className={`status-dot ${dotClass(state, live)}`} />
}

function dotClass(state: string, live = true): string {
  if (!live) return 'status-dot-gone'
  if (state === 'running' || state === 'spawning') return 'status-dot-live'
  if (state === 'idle' || state === 'stalled') return 'status-dot-idle'
  if (state === 'escalated') return 'status-dot-escalated'
  return 'status-dot-done'
}

function TaskStatusChip({ status }: { status: WorkItemStatus }) {
  const tone =
    status === 'in_progress' || status === 'review'
      ? 'border-honey-600/50 text-honey-300'
      : status === 'blocked'
        ? 'border-ember-500/50 text-ember-400'
        : status === 'open'
          ? 'border-orchid-500/50 text-orchid-300'
          : 'border-hive-600 text-hive-500'
  return <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide ${tone}`}>{status.replace('_', ' ')}</span>
}

function EnergyMeter({ energy, maxEnergy }: { energy: number; maxEnergy: number }) {
  const cells = Math.max(1, Math.min(maxEnergy, 12))
  const filled = Math.round((energy / maxEnergy) * cells)
  return (
    <div className="mt-2.5 flex items-center gap-2">
      <div className="flex flex-1 gap-0.5">
        {Array.from({ length: cells }, (_, index) => (
          <span key={index} className={`energy-cell ${index < filled ? 'energy-cell-full' : ''}`} />
        ))}
      </div>
      <span className="font-mono text-[10px] text-hive-500">
        {energy}/{maxEnergy}
      </span>
    </div>
  )
}

function EmptyHint({ text }: { text: string }) {
  return <p className="px-3 py-6 text-center font-mono text-[11px] text-hive-500">{text}</p>
}

const model = new RuntimeViewModel({ bridge: window.hive.runtime })
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App model={model} />
  </StrictMode>,
)
