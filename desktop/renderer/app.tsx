import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  Bug,
  Check,
  Clock,
  Droplet,
  GitBranch,
  GitMerge,
  Hexagon,
  KeyRound,
  ListChecks,
  Map,
  Moon,
  Plus,
  Send,
  Square,
  Sun,
  X,
  Zap,
} from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import './app.css'
import { RuntimeViewModel, type ProfileView, type RuntimeViewState } from '../../src/interfaces/desktop/runtime-view-model.js'
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
interface SignalView {
  id: string
  subject: string
  from: string
  state: string
  priority: string
  createdAt: string
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
interface MetricView {
  kind: string
  name: string
  value: number
  unit: string
  labels: Record<string, string>
  recordedAt: string
}

/** The merge plane (§7 Phase 7), read through the same channels the CLI serves. */
interface MergeRequestView {
  id: string
  sourceBranch: string
  targetBranch: string
  state: string
  failureKind?: string
  batchId?: string
  conflictFiles?: string[]
}
interface MergeBatchView {
  id: string
  targetBranch: string
  state: string
  mergeRequestIds: string[]
  createdAt: string
}

/** The selected run's worktree, as the runtime browse op reports it. */
interface WorktreePanelView {
  branch: string
  path: string
  headCommit?: string
  dirtyFiles: string[]
  clean: boolean
  aheadOfBase: number
  exists: boolean
  cleanup?: { allowed: boolean; blockedBy: string[] }
}

type Tab = 'hive' | 'bees' | 'comb' | 'ingress' | 'nectar' | 'gate' | 'settings'

const tabs: readonly { id: Tab; label: string }[] = [
  { id: 'hive', label: 'Hive' },
  { id: 'bees', label: 'Bees' },
  { id: 'comb', label: 'Comb' },
  { id: 'ingress', label: 'Ingress' },
  { id: 'nectar', label: 'Nectar Store' },
  { id: 'gate', label: 'Gate' },
  { id: 'settings', label: 'Settings' },
]

const liveRunStates: readonly RunState[] = ['spawning', 'running', 'idle', 'completing']
const liveWorkStates: readonly WorkItemStatus[] = ['assigned', 'in_progress', 'review']

/**
 * The operator console: one top bar, one contextual sidebar, and the terminal
 * the whole product turns around.
 *
 * The run view model still owns every terminal decision — this file is layout
 * and motion only. The work, fleet, control, and merge panels talk to their
 * bridges directly; they poll while the header and tab need them because those
 * planes have no push streams yet.
 */
function SettingsPanel() {
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<string>('')
  const fetchSettings = useCallback(async () => {
    const result = await window.hive.control.invoke('settings')
    if (result.ok) setSettings(result.data as Record<string, string>)
  }, [])
  useEffect(() => { void fetchSettings() }, [fetchSettings])
  const handleSave = async (key: string, value: string) => {
    setStatus('Saving...')
    await window.hive.control.invoke('settings-set', { key, value })
    setStatus('Saved')
    setTimeout(() => setStatus(''), 2000)
    await fetchSettings()
  }
  const keys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'GITHUB_TOKEN']
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Settings">
      <SectionHeader icon={<KeyRound className="h-3.5 w-3.5" />} label="Environment Settings" />
      <div className="mt-2 flex flex-col gap-3 overflow-y-auto pr-2">
         {keys.map(key => (
           <div key={key} className="panel-soft rounded-lg px-3 py-3">
             <label className="font-mono text-[11px] text-hive-300 block mb-1.5">{key}</label>
             <input 
               className="field w-full"
               type={key.includes('KEY') || key.includes('TOKEN') ? 'password' : 'text'}
               value={settings[`env:${key}`] || ''}
               onChange={(e) => setSettings({ ...settings, [`env:${key}`]: e.target.value })}
               onBlur={(e) => void handleSave(`env:${key}`, e.target.value)}
               placeholder={`Enter ${key} (stored locally)`}
             />
           </div>
         ))}
         {status && <p className="text-meadow-400 font-mono text-[10px] mt-1 ml-1">{status}</p>}
      </div>
    </section>
  )
}

function App({ model }: { model: RuntimeViewModel }) {
  const [state, setState] = useState<RuntimeViewState>(() => model.state())
  const [launchPrompt, setLaunchPrompt] = useState('')
  const [modelInput, setModelInput] = useState('')
  const [workItemInput, setWorkItemInput] = useState('')
  const [message, setMessage] = useState('')
  const [taskTitle, setTaskTitle] = useState('')
  const [tab, setTab] = useState<Tab>('hive')
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system')

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') {
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      root.classList.toggle('light', !isDark)
    } else {
      root.classList.toggle('light', theme === 'light')
    }
  }, [theme])
  const [items, setItems] = useState<WorkItemView[]>([])
  const [agents, setAgents] = useState<AgentView[]>([])
  const [signals, setSignals] = useState<SignalView[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>(undefined)
  const [selectedProfileId, setSelectedProfileId] = useState<string>('')
  const [plan, setPlan] = useState<PlanView | null>(null)
  const [packet, setPacket] = useState<string | undefined>(undefined)
  const [packetBusy, setPacketBusy] = useState(false)
  const [metrics, setMetrics] = useState<MetricView[]>([])
  const [worktree, setWorktree] = useState<WorktreePanelView | undefined>(undefined)
  const [mergeRequests, setMergeRequests] = useState<MergeRequestView[]>([])
  const [mergeBatches, setMergeBatches] = useState<MergeBatchView[]>([])
  const [workError, setWorkError] = useState<string | undefined>(undefined)
  const [workflows, setWorkflows] = useState<WorkflowView[]>([])
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunView[]>([])
  const [triggers, setTriggers] = useState<TriggerView[]>([])
  const [schedules, setSchedules] = useState<ScheduleView[]>([])
  const [admission, setAdmission] = useState<AdmissionView | undefined>(undefined)
  const terminalElement = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | undefined>(undefined)
  const profileDefaultChosen = useRef(false)

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
        background: '#111114',
        foreground: '#ececef',
        cursor: '#eeb22f',
        selectionBackground: '#eeb22f33',
        black: '#111114',
        green: '#4cb87d',
        yellow: '#eeb22f',
        blue: '#8ab4de',
        magenta: '#c9a3e0',
        cyan: '#7fd6a4',
        red: '#e26d6d',
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

  /**
   * The picker opens on the best real launch this machine can make: a provider
   * whose CLI resolves and whose keys are in the environment. The fake bee is
   * the fallback, never the default, so the console shows real work by default.
   */
  useEffect(() => {
    if (profileDefaultChosen.current || state.profiles.length === 0) return
    profileDefaultChosen.current = true
    const real = state.profiles.find(
      (profile) => profile.id !== 'fake' && profile.onPath && (profile.credentials?.present.length ?? 0) > 0,
    )
    const fallback = state.profiles.find((profile) => profile.id === 'fake')
    setSelectedProfileId((real ?? fallback ?? state.profiles[0]).id)
  }, [state.profiles])

  const selectedProfile = useMemo(
    () => state.profiles.find((profile) => profile.id === selectedProfileId),
    [state.profiles, selectedProfileId],
  )

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
    setPacket(undefined)
    const result = await window.hive.work.invoke('plan', { workItemId: taskId })
    setPlan(result.ok ? ((result.data as PlanView | null) ?? null) : null)
  }, [])

  /**
   * The Phase 8 control plane, read through the same channels the CLI's services
   * back — one truth, not a desktop copy of it. A refusal is surfaced rather than
   * swallowed: an operator who paused ingress needs to see that it held.
   */
  const refreshControl = useCallback(async () => {
    const [workflowsResult, runsResult, triggersResult, schedulesResult, admissionResult, metricsResult] = await Promise.all([
      window.hive.control.invoke('workflows'),
      window.hive.control.invoke('runs'),
      window.hive.control.invoke('triggers'),
      window.hive.control.invoke('schedules'),
      window.hive.control.invoke('admission'),
      window.hive.control.invoke('metrics'),
    ])
    if (workflowsResult.ok) setWorkflows(workflowsResult.data as WorkflowView[])
    if (runsResult.ok) setWorkflowRuns(runsResult.data as WorkflowRunView[])
    if (triggersResult.ok) setTriggers(triggersResult.data as TriggerView[])
    else setWorkError(triggersResult.error.message)
    if (schedulesResult.ok) setSchedules(schedulesResult.data as ScheduleView[])
    if (admissionResult.ok) setAdmission(admissionResult.data as AdmissionView)
    if (metricsResult.ok) setMetrics(metricsResult.data as MetricView[])
  }, [])

  const refreshSignals = useCallback(async () => {
    const result = await window.hive.work.invoke('inbox', {})
    if (result.ok) setSignals(result.data as SignalView[])
  }, [])

  const refreshWorktree = useCallback(async (runId: string) => {
    const result = await window.hive.runtime.invoke('worktree', { runId })
    if (!result.ok) return
    const data = result.data as { status?: WorktreePanelView; cleanup?: { allowed: boolean; blockedBy: string[] } } | null
    setWorktree(data?.status ? { ...data.status, cleanup: data.cleanup } : undefined)
  }, [])

  const refreshMerge = useCallback(async () => {
    const [requestsResult, batchesResult] = await Promise.all([
      window.hive.merge.invoke('requests'),
      window.hive.merge.invoke('batches'),
    ])
    if (requestsResult.ok) setMergeRequests(requestsResult.data as MergeRequestView[])
    if (batchesResult.ok) setMergeBatches(batchesResult.data as MergeBatchView[])
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

  // The header's KPIs are alive on every tab, so the board, the control plane,
  // and the field poll always; the merge queue is read only at the gate.
  useEffect(() => {
    const tick = () => {
      void refreshWork()
      void refreshControl()
      if (tab === 'comb') void refreshSignals()
      if (tab === 'gate') void refreshMerge()
      if (tab === 'hive' && state.selectedRunId) void refreshWorktree(state.selectedRunId)
    }
    tick()
    const timer = setInterval(tick, 2500)
    return () => clearInterval(timer)
  }, [tab, refreshWork, refreshControl, refreshSignals, refreshMerge, refreshWorktree, state.selectedRunId])

  const runWork = useCallback(async (operation: string, payload: Record<string, unknown>) => {
    const result = await window.hive.work.invoke(operation, payload)
    if (!result.ok) {
      setWorkError(result.error.message)
      return undefined
    }
    setWorkError(undefined)
    return result.data
  }, [])

  /** Explicit, because compiling accepts the oldest pending handoff — a real act, not a view. */
  const compilePacket = useCallback(async (taskId: string) => {
    setPacketBusy(true)
    const result = await window.hive.work.invoke('context', { taskId })
    setPacketBusy(false)
    if (!result.ok) {
      setWorkError(result.error.message)
      return
    }
    const data = result.data as { prompt?: string }
    setPacket(typeof data.prompt === 'string' ? data.prompt : '')
  }, [])

  const launchBee = useCallback(() => {
    if (!selectedProfile) return
    void model.launch({
      profileId: selectedProfile.id,
      workspace: 'main',
      project: 'hive',
      prompt: launchPrompt.trim() || undefined,
      model: modelInput.trim() || undefined,
      workItemId: workItemInput.trim() || undefined,
    })
    setLaunchPrompt('')
  }, [model, selectedProfile, launchPrompt, modelInput, workItemInput])

  const selected = useMemo(() => state.runs.find((run) => run.id === state.selectedRunId), [state.runs, state.selectedRunId])
  const selectedTask = items.find((item) => item.id === selectedTaskId)
  const liveRuns = state.runs.filter((run) => liveRunStates.includes(run.state)).length
  const outRuns = state.runs.filter((run) => run.endedAt).length
  const escalations = state.runs.filter((run) => run.state === 'escalated').length
  const openTasks = items.filter((item) => item.status === 'open' || item.status === 'blocked').length
  const blockedTasks = items.filter((item) => item.status === 'blocked').length
  const inFlightItems = items.filter((item) => liveWorkStates.includes(item.status))
  const reserves = metrics
    .filter((metric) => metric.kind === 'usage' && metric.name === 'cost' && metric.unit === 'usd')
    .reduce((total, metric) => total + metric.value, 0)
  const latestTrigger = triggers.length > 0 ? triggers[triggers.length - 1] : undefined

  return (
    <div className="flex h-full flex-col">
      <header className="topbar z-10 flex shrink-0 items-center gap-5 px-4">
        <div className="flex items-center gap-2.5">
          <span className="hex-chip flex h-7 w-7 items-center justify-center bg-gradient-to-br from-honey-400 to-honey-600">
            <Hexagon className="h-4 w-4 text-hive-950" strokeWidth={2.6} />
          </span>
          <span className="font-display text-[15px] font-bold tracking-[0.22em] text-honey-300">HIVE OS</span>
        </div>

        <nav className="flex items-center gap-1" aria-label="Hive sections">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setTab(entry.id)}
              className={`tab-btn ${tab === entry.id ? 'tab-btn-active' : ''}`}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-4">
          <button
            onClick={() => setTheme(t => t === 'dark' ? 'light' : t === 'light' ? 'system' : 'dark')}
            className="btn btn-ghost ml-4 flex h-8 w-8 items-center justify-center rounded-full p-0 transition-transform"
            title={`Theme: ${theme}`}
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? <Moon className="h-4 w-4" /> : theme === 'light' ? <Sun className="h-4 w-4" /> : <div className="h-4 w-4 rounded-sm border border-current" />}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 shrink-0 flex-col bg-hive-900">
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <AnimatePresence mode="wait">
              {(tab === 'hive' || tab === 'bees' || tab === 'settings') && (
                <motion.div
                  key="hive-side"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                  className="flex flex-col gap-4"
                >
                  <section aria-label="Launch a bee">
                    <SectionHeader icon={<Plus className="h-3.5 w-3.5" />} label="Launch bee" />
                    <form
                      className="panel-soft mt-2 flex flex-col gap-2 rounded-lg p-3"
                      onSubmit={(event) => {
                        event.preventDefault()
                        launchBee()
                      }}
                    >
                      <label className="sr-only" htmlFor="profile-select">
                        Agent profile
                      </label>
                      <select
                        id="profile-select"
                        className="field"
                        value={selectedProfileId}
                        onChange={(event) => setSelectedProfileId(event.target.value)}
                      >
                        {state.profiles.length === 0 && <option value="">loading profiles…</option>}
                        {state.profiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.id}
                            {profile.onPath === false ? ' — CLI not found' : profile.credentials?.present.length ? ' — ready' : ''}
                          </option>
                        ))}
                      </select>
                      {selectedProfile && <ProfileStateCard profile={selectedProfile} />}
                      <label className="sr-only" htmlFor="launch-prompt">
                        Launch prompt
                      </label>
                      <input
                        id="launch-prompt"
                        className="field"
                        value={launchPrompt}
                        onChange={(event) => setLaunchPrompt(event.target.value)}
                        placeholder="prompt (optional)"
                      />
                      <label className="sr-only" htmlFor="launch-model">
                        Model
                      </label>
                      <input
                        id="launch-model"
                        className="field"
                        value={modelInput}
                        onChange={(event) => setModelInput(event.target.value)}
                        placeholder="model (optional)"
                      />
                      <label className="sr-only" htmlFor="launch-work-item">
                        Work item to bind
                      </label>
                      <input
                        id="launch-work-item"
                        className="field"
                        value={workItemInput}
                        onChange={(event) => setWorkItemInput(event.target.value)}
                        placeholder="bind work item id (optional)"
                      />
                      <button
                        className="btn btn-honey flex items-center justify-center gap-1.5"
                        disabled={state.busy || !selectedProfile || !selectedProfile.available}
                      >
                        <Plus className="h-4 w-4" /> Launch
                      </button>
                    </form>
                  </section>

                  {tab === 'hive' && <RosterList roster={state.roster} onSelect={(runId) => void model.select(runId)} />}

                  {tab === 'bees' && <FleetSummary agents={agents} liveRuns={liveRuns} />}

                  {tab === 'hive' && <EventLogPanel events={state.events} />}
                </motion.div>
              )}

              {tab === 'comb' && (
                <motion.div
                  key="comb-side"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                  className="flex flex-col gap-4"
                >
                  <section aria-label="The board">
                    <SectionHeader icon={<ListChecks className="h-3.5 w-3.5" />} label="The board" count={items.length} />
                    <form
                      className="panel-soft mt-2 flex gap-2 rounded-lg p-2.5"
                      onSubmit={(event) => {
                        event.preventDefault()
                        const title = taskTitle.trim()
                        if (!title) return
                        void runWork('create', { title }).then(() => refreshWork())
                        setTaskTitle('')
                      }}
                    >
                      <label className="sr-only" htmlFor="task-title">
                        New task title
                      </label>
                      <input
                        id="task-title"
                        className="field flex-1"
                        value={taskTitle}
                        onChange={(event) => setTaskTitle(event.target.value)}
                        placeholder="new cell title"
                      />
                      <button className="btn btn-honey px-3" title="New task">
                        <Plus className="h-4 w-4" />
                      </button>
                    </form>
                    <div className="mt-2 flex flex-col gap-2">
                      {items.map((item) => (
                        <button
                          key={item.id}
                          onClick={() => void selectTask(item.id)}
                          className={`panel-soft flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                            item.id === selectedTaskId ? 'border-honey-600/60' : 'hover:border-hive-500'
                          }`}
                        >
                          <TaskStatusChip status={item.status} />
                          <span className="min-w-0 flex-1 truncate text-[13px]">{item.title}</span>
                        </button>
                      ))}
                      {items.length === 0 && <EmptyHint icon={<ListChecks className="h-5 w-5" />} text="the comb is empty — no cells yet" />}
                    </div>
                  </section>
                </motion.div>
              )}

              {tab === 'ingress' && (
                <motion.div
                  key="ingress-side"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                  className="flex flex-col gap-4"
                >
                  <section aria-label="The hive mouth">
                    <SectionHeader icon={<Zap className="h-3.5 w-3.5" />} label="Hive mouth" />
                    <div className="panel-soft mt-2 rounded-lg p-3">
                      <div className="flex items-center gap-2">
                        <span
                          className={`flex items-center gap-1 font-mono text-[10px] ${
                            admission?.policy.paused ? 'text-ember-400' : 'text-meadow-400'
                          }`}
                        >
                          {admission?.policy.paused ? <AlertTriangle className="h-3 w-3" /> : <Check className="h-3 w-3" />}
                          {admission?.policy.paused ? 'paused' : 'admitting'}
                        </span>
                      </div>
                      {admission?.breaker.failures ? (
                        <p className="mt-1 font-mono text-[10px] text-ember-400">
                          breaker {admission.breaker.failures}
                          {admission.breaker.openUntil ? ` · open until ${admission.breaker.openUntil}` : ''}
                        </p>
                      ) : null}
                      {admission?.policy.allowedKinds?.length ? (
                        <p className="mt-1 font-mono text-[10px] text-hive-400">kinds {admission.policy.allowedKinds.join(', ')}</p>
                      ) : null}
                      <div className="mt-2.5 flex gap-2">
                        <button className="btn btn-ghost" disabled={admission?.policy.paused === true} onClick={() => void controlAction('pause')}>
                          Pause
                        </button>
                        <button className="btn btn-ghost" disabled={admission?.policy.paused !== true} onClick={() => void controlAction('resume')}>
                          Resume
                        </button>
                      </div>
                    </div>
                    <p className="mt-3 px-1 font-mono text-[10px] text-hive-400">
                      {workflows.length} workflows · {workflowRuns.length} runs · {schedules.length} schedules
                    </p>
                  </section>

                  <section aria-label="Entrance pulse">
                    <SectionHeader icon={<Zap className="h-3.5 w-3.5" />} label="Entrance pulse" count={triggers.length} />
                    <div className="mt-2 flex flex-col gap-1.5">
                      {triggers
                        .slice()
                        .reverse()
                        .slice(0, 12)
                        .map((trigger, index) => (
                          <motion.div
                            key={`${trigger.id}:${trigger.createdAt}`}
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: Math.min(index * 0.02, 0.2) }}
                            className="panel-soft rounded-lg px-3 py-2"
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className={`font-mono text-[10px] ${
                                  trigger.state === 'accepted' ? 'text-meadow-400' : trigger.state === 'rejected' ? 'text-ember-400' : 'text-hive-400'
                                }`}
                              >
                                {trigger.state}
                              </span>
                              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-hive-100">{trigger.workflowId}</span>
                              <span className="font-mono text-[10px] text-hive-400">{trigger.kind}</span>
                            </div>
                            {trigger.state === 'rejected' && typeof trigger.payload.reason === 'string' ? (
                              <p className="mt-1 truncate text-[11px] text-ember-400">{String(trigger.payload.reason)}</p>
                            ) : null}
                          </motion.div>
                        ))}
                      {triggers.length === 0 && <EmptyHint icon={<Zap className="h-5 w-5" />} text="the mouth is quiet — no triggers yet" />}
                    </div>
                  </section>
                </motion.div>
              )}

              {tab === 'nectar' && (
                <motion.div
                  key="nectar-side"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                  className="flex flex-col gap-4"
                >
                  <section aria-label="Reserves">
                    <SectionHeader icon={<Droplet className="h-3.5 w-3.5" />} label="Reserves" />
                    <div className="panel-soft mt-2 rounded-lg p-3">
                      <p className="flex items-baseline gap-1.5">
                        <span className="font-display text-2xl font-bold text-honey-300">${reserves.toFixed(2)}</span>
                        <span className="font-mono text-[10px] text-hive-400">spend recorded</span>
                      </p>
                      <p className="mt-1 font-mono text-[10px] text-hive-400">
                        cap {admission?.policy.spendCapUsd !== undefined ? `$${admission.policy.spendCapUsd.toFixed(2)}` : 'unset'} ·{' '}
                        {capLabel(reserves, admission?.policy.spendCapUsd)}
                      </p>
                      {metrics.length === 0 && (
                        <p className="mt-1.5 font-mono text-[10px] text-hive-500">telemetry is opt-in — the store is quiet until enabled</p>
                      )}
                    </div>
                  </section>

                  <section aria-label="Metrics">
                    <SectionHeader icon={<Droplet className="h-3.5 w-3.5" />} label="Metrics" count={metrics.length} />
                    <div className="mt-2 flex flex-col gap-1.5">
                      {metrics.slice(0, 8).map((metric, index) => (
                        <div key={`${metric.name}:${metric.recordedAt}:${index}`} className="panel-soft flex items-center gap-2 rounded-lg px-3 py-2">
                          <span className="font-mono text-[10px] text-hive-400">{metric.kind}</span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-hive-100">{metric.name}</span>
                          <span className="font-mono text-[11px] text-honey-300">
                            {metric.value} {metric.unit}
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section aria-label="Schedules">
                    <SectionHeader icon={<Clock className="h-3.5 w-3.5" />} label="Schedules" count={schedules.length} />
                    <div className="mt-2 flex flex-col gap-1.5">
                      {schedules.map((schedule) => (
                        <div key={schedule.id} className="panel-soft rounded-lg px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-hive-100">{schedule.workflowId}</span>
                            <span className={`font-mono text-[10px] ${schedule.state === 'enabled' ? 'text-meadow-400' : 'text-hive-500'}`}>
                              {schedule.state}
                            </span>
                          </div>
                          <p className="font-mono text-[10px] text-hive-400">
                            every {formatInterval(schedule.intervalMs)} · next {formatTime(schedule.nextRunAt)}
                          </p>
                        </div>
                      ))}
                      {schedules.length === 0 && <EmptyHint icon={<Clock className="h-5 w-5" />} text="no schedules — nothing on a clock" />}
                    </div>
                  </section>
                </motion.div>
              )}

              {tab === 'gate' && (
                <motion.div
                  key="gate-side"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                  className="flex flex-col gap-4"
                >
                  <section aria-label="Merge requests">
                    <SectionHeader icon={<GitMerge className="h-3.5 w-3.5" />} label="Queue" count={mergeRequests.length} />
                    <div className="mt-2 flex flex-col gap-1.5">
                      {mergeRequests.map((request) => (
                        <div key={request.id} className="panel-soft rounded-lg px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-hive-100">
                              {shortRef(request.sourceBranch)} → {shortRef(request.targetBranch)}
                            </span>
                            <span
                              className={`font-mono text-[10px] ${
                                request.state === 'landed' ? 'text-meadow-400' : request.state === 'failed' ? 'text-ember-400' : 'text-honey-300'
                              }`}
                            >
                              {request.state}
                            </span>
                          </div>
                          {request.failureKind ? (
                            <p className="mt-1 truncate font-mono text-[10px] text-ember-400">
                              {request.failureKind}
                              {request.conflictFiles?.length ? ` · ${request.conflictFiles.length} conflicts` : ''}
                            </p>
                          ) : null}
                        </div>
                      ))}
                      {mergeRequests.length === 0 && <EmptyHint icon={<GitMerge className="h-5 w-5" />} text="the gate is quiet — nothing queued" />}
                    </div>
                  </section>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          {workError ? <p className="border-t border-hive-700 px-4 py-2.5 text-[11px] text-ember-400">{workError}</p> : null}
          {state.error ? <p className="border-t border-hive-700 px-4 py-2.5 text-[11px] text-ember-400">{state.error}</p> : null}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col gap-3 p-3">
          {tab === 'bees' && (
            <section className="flex min-h-0 flex-1 flex-col" aria-label="The field">
              <SectionHeader icon={<Map className="h-3.5 w-3.5" />} label="The field (fleet)" count={agents.length} />
              <div className="office-floor mt-2 grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-y-auto xl:grid-cols-3">
                {agents.map((agent) => (
                  <motion.div
                    key={agent.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="panel-soft flex items-center gap-3 rounded-lg px-3 py-3"
                  >
                    <span className="hex-chip flex h-9 w-9 items-center justify-center bg-gradient-to-br from-honey-400 to-honey-600">
                      <Bug className="h-4 w-4 text-hive-950" strokeWidth={2.4} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate font-mono text-[12px] text-honey-300">{agent.name}</p>
                        <StatusDot state={agent.energy > 0 ? 'running' : 'idle'} live={agent.energy > 0} />
                      </div>
                      <p className="truncate font-mono text-[10px] text-hive-400">
                        {agent.profileId}
                        {agent.skills.length > 0 ? ` · ${agent.skills.slice(0, 3).join(', ')}` : ''}
                      </p>
                      <NectarMeter energy={agent.energy} maxEnergy={agent.maxEnergy} />
                    </div>
                  </motion.div>
                ))}
                {Array.from({ length: Math.max(0, 4 - agents.length) }, (_, index) => (
                  <div key={`empty-${index}`} className="panel-soft office-desk-empty flex items-center justify-center rounded-lg px-3 py-3">
                    <span className="font-mono text-[10px] text-hive-400">empty desk</span>
                  </div>
                ))}
                {agents.length === 0 && (
                  <div className="col-span-2 xl:col-span-3">
                    <EmptyHint icon={<Bug className="h-5 w-5" />} text="the field is empty — no bees registered" />
                  </div>
                )}
              </div>
            </section>
          )}

          {tab === 'comb' && (
            <BoardDetail
              selectedTask={selectedTask}
              plan={plan}
              signals={signals}
              packet={packet}
              packetBusy={packetBusy}
              inFlight={inFlightItems}
              onCompile={() => selectedTask && void compilePacket(selectedTask.id)}
              onClaim={() => selectedTask && void runWork('claim', { workItemId: selectedTask.id }).then(() => refreshWork())}
              onStart={() => selectedTask && void runWork('start', { workItemId: selectedTask.id }).then(() => refreshWork())}
            />
          )}

          {tab === 'gate' && (
            <section className="flex min-h-0 flex-1 flex-col" aria-label="Merge batches">
              <SectionHeader icon={<GitBranch className="h-3.5 w-3.5" />} label="Batches" count={mergeBatches.length} />
              <div className="mt-2 grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-y-auto xl:grid-cols-3">
                {mergeBatches.map((batch) => (
                  <div key={batch.id} className="panel-soft rounded-lg px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-honey-300">{shortRef(batch.targetBranch)}</span>
                      <span
                        className={`font-mono text-[10px] ${
                          batch.state === 'landed' ? 'text-meadow-400' : batch.state === 'isolated' ? 'text-ember-400' : 'text-hive-300'
                        }`}
                      >
                        {batch.state}
                      </span>
                    </div>
                    <p className="mt-1 font-mono text-[10px] text-hive-400">
                      {batch.mergeRequestIds.length} branch{batch.mergeRequestIds.length === 1 ? '' : 'es'} · {formatTime(batch.createdAt)}
                    </p>
                  </div>
                ))}
                {mergeBatches.length === 0 && (
                  <div className="col-span-2 xl:col-span-3">
                    <EmptyHint icon={<GitBranch className="h-5 w-5" />} text="no batches — the queue has landed clean" />
                  </div>
                )}
              </div>
            </section>
          )}

          {tab === 'settings' && <SettingsPanel />}

          <section
            className={`panel flex min-h-0 flex-col overflow-hidden rounded-lg ${
              tab === 'hive' || tab === 'ingress' || tab === 'nectar' ? 'flex-1' : 'h-72 shrink-0'
            }`}
            aria-label="Terminal"
          >
            <div className="flex items-center gap-3 border-b border-hive-700 px-4 py-2">
              <span className="section-label">Terminal</span>
              <span className="font-mono text-[12px] font-bold text-honey-300">
                {selected ? `BEE.${selected.id.slice(0, 8).toUpperCase()}` : '—'}
              </span>
              <span className="hidden min-w-0 flex-1 truncate font-mono text-[10px] text-hive-500 md:block">
                {selected ? `hive run agent --id bee-${selected.id.slice(0, 8)} --profile ${selected.runtimeProfile}` : 'select a run from the roster'}
              </span>
              {selected && (
                <>
                  <span className="font-mono text-[10px] uppercase tracking-wide text-hive-400">{selected.state}</span>
                  <button className="btn btn-ghost flex items-center gap-1.5 px-2.5 py-1" onClick={() => void model.stop({ cleanup: true })}>
                    <Square className="h-3 w-3" /> Stop
                  </button>
                </>
              )}
            </div>
            <div className="terminal min-h-0 flex-1" ref={terminalElement} />
          </section>

          <form
            className="flex shrink-0 gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void model.send(`${message}\n`)
              setMessage('')
            }}
          >
            <div className="panel flex min-w-0 flex-1 items-center rounded-lg px-3">
              <label className="sr-only" htmlFor="composer">
                Message the selected run
              </label>
              <input
                id="composer"
                className="w-full bg-transparent py-2.5 font-mono text-[13px] outline-none placeholder:text-hive-500"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder={selected ? 'message the bee…' : 'no run selected'}
                disabled={!selected}
              />
            </div>
            <button className="btn btn-honey flex items-center gap-1.5 px-4" disabled={!selected}>
              <Send className="h-4 w-4" />
            </button>
          </form>

          {tab === 'hive' && (
            <div className="grid h-48 shrink-0 grid-cols-2 gap-3">
              <WorktreePanel runId={state.selectedRunId} worktree={worktree} />
              <CombHeatMap
                items={items}
                selectedId={selectedTaskId}
                onSelect={(id) => {
                  void selectTask(id)
                  setTab('comb')
                }}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

/** A small-caps mono header with its count, the naming unit of every panel. */
function SectionHeader({ icon, label, count }: { icon: ReactNode; label: string; count?: number }) {
  return (
    <p className="flex items-center gap-1.5 px-1">
      <span className="text-hive-500">{icon}</span>
      <span className="section-label">{label}</span>
      {count !== undefined && <span className="ml-auto font-mono text-[10px] text-hive-500">{count}</span>}
    </p>
  )
}

/** The roster: every run this host has launched, the selected one ringed in honey. */
function RosterList({ roster, onSelect }: { roster: RuntimeViewState['roster']; onSelect: (runId: string) => void }) {
  return (
    <section aria-label="Roster">
      <SectionHeader icon={<Hexagon className="h-3.5 w-3.5" />} label="Roster" count={roster.length} />
      <div className="mt-2 flex flex-col gap-2">
        {roster.map((row, index) => (
          <motion.button
            key={row.runId}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(index * 0.03, 0.2) }}
            onClick={() => onSelect(row.runId)}
            className={`panel-soft flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
              row.live ? 'border-honey-600/60' : 'hover:border-hive-500'
            }`}
          >
            <StatusDot state={row.state} live={row.live} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[12px] text-honey-300">BEE.{row.short.toUpperCase()}</span>
              <span className="block truncate text-[11px] text-hive-400">
                {row.profile}
                {row.outcome ? ` · ${row.outcome}` : ''}
              </span>
            </span>
            <span className="font-mono text-[10px] uppercase tracking-wide text-hive-400">{row.state}</span>
          </motion.button>
        ))}
        {roster.length === 0 && <EmptyHint icon={<Hexagon className="h-5 w-5" />} text="no bees out — the hive is warm and waiting" />}
      </div>
    </section>
  )
}

/** Fleet counts for the bees tab: how many bees, how much nectar in reserve. */
function FleetSummary({ agents, liveRuns }: { agents: AgentView[]; liveRuns: number }) {
  const totalEnergy = agents.reduce((total, agent) => total + agent.energy, 0)
  return (
    <section aria-label="Fleet summary">
      <SectionHeader icon={<Bug className="h-3.5 w-3.5" />} label="Fleet" count={agents.length} />
      <div className="panel-soft mt-2 rounded-lg p-3">
        <p className="font-mono text-[10px] uppercase tracking-widest text-hive-400">the field</p>
        <p className="mt-1 font-mono text-[11px] text-hive-200">
          {agents.length} bees · {liveRuns} at a desk
        </p>
        <p className="mt-1 flex items-center gap-1 font-mono text-[11px] text-honey-300">
          <Droplet className="h-3 w-3" /> {totalEnergy} nectar across the fleet
        </p>
      </div>
    </section>
  )
}

/** The event log: the ledger's pulse, newest first, names and times only. */
function EventLogPanel({ events }: { events: RuntimeViewState['events'] }) {
  return (
    <section aria-label="Event log">
      <SectionHeader icon={<Clock className="h-3.5 w-3.5" />} label="Event log" count={events.length} />
      <div className="mt-2 flex flex-col gap-1 rounded-lg border border-hive-700 bg-hive-950 p-2">
        {events.slice(0, 14).map((event, index) => (
          <p key={`${event.sequence ?? index}:${event.eventType}:${event.occurredAt}`} className="flex gap-2 font-mono text-[10px] leading-4">
            <span className="text-hive-600">{formatTime(event.occurredAt)}</span>
            <span className="text-hive-300">{event.eventType}</span>
            {event.runId && <span className="min-w-0 flex-1 truncate text-hive-500">bee-{event.runId.slice(0, 8)}</span>}
          </p>
        ))}
        {events.length === 0 && <p className="px-1 py-2 font-mono text-[10px] text-hive-500">no events yet — the ledger is still</p>}
      </div>
    </section>
  )
}

/**
 * The comb view's detail row: the blackboard a bee works from, the signals
 * waiting in the inbox, and the packet a launch would carry.
 */
function BoardDetail({
  selectedTask,
  plan,
  signals,
  packet,
  packetBusy,
  inFlight,
  onCompile,
  onClaim,
  onStart,
}: {
  selectedTask?: WorkItemView
  plan: PlanView | null
  signals: SignalView[]
  packet: string | undefined
  packetBusy: boolean
  inFlight: WorkItemView[]
  onCompile: () => void
  onClaim: () => void
  onStart: () => void
}) {
  if (!selectedTask) {
    return (
      <section className="panel flex min-h-0 flex-1 items-center justify-center rounded-lg" aria-label="The board">
        <EmptyHint icon={<ListChecks className="h-6 w-6" />} text="select a cell from the board" />
      </section>
    )
  }
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2" aria-label="The board">
      <div className="flex items-center gap-3">
        <TaskStatusChip status={selectedTask.status} />
        <span className="truncate font-display text-[15px] font-medium">{selectedTask.title}</span>
        <span className="font-mono text-[11px] text-hive-400">{selectedTask.assigneeActorId ?? 'unassigned'}</span>
        <div className="ml-auto flex gap-2">
          <button className="btn btn-ghost" onClick={onClaim}>
            Claim
          </button>
          <button className="btn btn-ghost" onClick={onStart}>
            Start
          </button>
        </div>
      </div>

      {inFlight.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="section-label mr-1">Cells in flight</span>
          {inFlight.map((item) => (
            <span
              key={item.id}
              className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${
                item.id === selectedTask.id ? 'border-honey-600/60 text-honey-300' : 'border-hive-700 text-hive-400'
              }`}
            >
              {item.title}
            </span>
          ))}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-3 gap-3">
        <div className="panel flex min-h-0 flex-col rounded-lg">
          <div className="border-b border-hive-700 px-3 py-2">
            <span className="section-label">Blackboard</span>
          </div>
          {plan ? (
            <pre className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap p-3 font-mono text-[11px] leading-4 text-meadow-400">
              {`plan r${plan.revision} · ${plan.updatedByActorId}\n${plan.body}`}
            </pre>
          ) : (
            <p className="p-3 text-[12px] text-hive-400">no plan written yet</p>
          )}
        </div>

        <div className="panel flex min-h-0 flex-col rounded-lg">
          <div className="border-b border-hive-700 px-3 py-2">
            <span className="section-label">Signals</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {signals.slice(0, 8).map((signal) => (
              <div key={signal.id} className="px-1 py-1.5">
                <div className="flex items-center gap-2">
                  <span
                    className={`font-mono text-[10px] ${
                      signal.state === 'pending' ? 'text-honey-300' : signal.state === 'acked' ? 'text-hive-500' : 'text-meadow-400'
                    }`}
                  >
                    {signal.state}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-hive-100">{signal.subject}</span>
                </div>
                <p className="truncate font-mono text-[10px] text-hive-500">from {signal.from}</p>
              </div>
            ))}
            {signals.length === 0 && <p className="px-1 py-2 font-mono text-[10px] text-hive-500">no signals — the inbox is clear</p>}
          </div>
        </div>

        <div className="panel flex min-h-0 flex-col rounded-lg">
          <div className="flex items-center gap-2 border-b border-hive-700 px-3 py-2">
            <span className="section-label">Packet preview</span>
            <button
              className="btn btn-ghost ml-auto px-2 py-0.5 text-[11px]"
              disabled={packetBusy}
              onClick={onCompile}
              title="Compiles the launch packet; this also accepts the oldest pending handoff"
            >
              {packetBusy ? 'Compiling…' : 'Compile'}
            </button>
          </div>
          {packet !== undefined ? (
            <pre className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap p-3 font-mono text-[10px] leading-4 text-hive-300">{packet}</pre>
          ) : (
            <p className="p-3 font-mono text-[10px] text-hive-500">compile to see the packet a bee would carry</p>
          )}
        </div>
      </div>
    </section>
  )
}

/** The selected run's ground truth: branch, commits ahead, uncommitted work. */
function WorktreePanel({ runId, worktree }: { runId?: string; worktree?: WorktreePanelView }) {
  return (
    <section className="panel flex min-h-0 flex-col rounded-lg" aria-label="Worktree status">
      <div className="flex items-center gap-2 border-b border-hive-700 px-3 py-2">
        <span className="section-label">Worktree status</span>
        {worktree && (
          <span className={`ml-auto flex items-center gap-1 font-mono text-[10px] ${worktree.clean ? 'text-meadow-400' : 'text-honey-300'}`}>
            {worktree.clean ? <Check className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
            {worktree.clean ? 'clean' : `${worktree.dirtyFiles.length} dirty`}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!runId && <p className="font-mono text-[10px] text-hive-500">select a run to see its worktree</p>}
        {runId && !worktree && <p className="font-mono text-[10px] text-hive-500">no worktree recorded for this run</p>}
        {worktree && (
          <div className="flex flex-col gap-1.5 font-mono text-[10px]">
            <p className="flex items-center gap-1.5 text-hive-200">
              <GitBranch className="h-3 w-3 text-honey-500" /> {worktree.branch}
            </p>
            <p className="text-hive-400">
              {worktree.aheadOfBase} commit{worktree.aheadOfBase === 1 ? '' : 's'} ahead of base
              {worktree.headCommit ? ` · head ${worktree.headCommit.slice(0, 8)}` : ''}
            </p>
            {!worktree.exists && <p className="text-hive-500">worktree removed</p>}
            {worktree.dirtyFiles.length > 0 && (
              <div className="mt-1 flex flex-col gap-0.5">
                {worktree.dirtyFiles.slice(0, 4).map((file) => (
                  <p key={file} className="truncate text-hive-300">
                    {file}
                  </p>
                ))}
                {worktree.dirtyFiles.length > 4 && <p className="text-hive-500">+{worktree.dirtyFiles.length - 4} more</p>}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

/** The comb as a heat map: one hexagon per cell, colored by the work it holds. */
function CombHeatMap({ items, selectedId, onSelect }: { items: WorkItemView[]; selectedId?: string; onSelect: (id: string) => void }) {
  return (
    <section className="panel flex min-h-0 flex-col rounded-lg" aria-label="Comb heat map">
      <div className="flex items-center gap-2 border-b border-hive-700 px-3 py-2">
        <span className="section-label">Comb heat map</span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[9px] text-hive-500">
          <span className="heat-cell heat-cell-open" style={{ cursor: 'default' }} /> open
          <span className="heat-cell heat-cell-work" style={{ cursor: 'default' }} /> working
          <span className="heat-cell heat-cell-blocked" style={{ cursor: 'default' }} /> blocked
          <span className="heat-cell heat-cell-done" style={{ cursor: 'default' }} /> done
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {items.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {items.map((item) => (
              <button
                key={item.id}
                className={`heat-cell ${heatClass(item.status)} ${item.id === selectedId ? 'ring-1 ring-honey-300' : ''}`}
                title={item.title}
                onClick={() => onSelect(item.id)}
              />
            ))}
          </div>
        ) : (
          <p className="font-mono text-[10px] text-hive-500">the comb is empty — create a cell on the board</p>
        )}
      </div>
    </section>
  )
}

/**
 * The launch card's honesty: what this machine can really do with this profile.
 * Key names come from the host environment as presence only — never values —
 * so the operator sees exactly what the bee would inherit.
 */
function ProfileStateCard({ profile }: { profile: ProfileView }) {
  const present = profile.credentials?.present ?? []
  const missing = profile.credentials?.missing ?? []
  return (
    <div className="flex flex-col gap-1 rounded-md bg-hive-950 p-2 font-mono text-[10px]">
      <span className={`flex items-center gap-1.5 ${profile.onPath ? 'text-meadow-400' : 'text-ember-400'}`}>
        {profile.onPath ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
        {profile.onPath ? `cli ${profile.provider} on this machine` : `cli ${profile.provider} not found on PATH`}
      </span>
      {present.length > 0 && (
        <span className="flex items-center gap-1.5 text-meadow-400" title={present.join(', ')}>
          <KeyRound className="h-3 w-3" />
          {present.join(', ')}
        </span>
      )}
      {missing.length > 0 && (
        <span className="flex items-center gap-1.5 text-hive-400" title={missing.join(', ')}>
          <KeyRound className="h-3 w-3" />
          {missing.length} key{missing.length === 1 ? '' : 's'} not set ({missing.slice(0, 2).join(', ')}
          {missing.length > 2 ? ', …' : ''})
        </span>
      )}
      {present.length === 0 && missing.length === 0 && (
        <span className="flex items-center gap-1.5 text-hive-400">
          <KeyRound className="h-3 w-3" />
          no environment keys named — this bee needs none
        </span>
      )}
    </div>
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

function heatClass(status: WorkItemStatus): string {
  if (status === 'in_progress') return 'heat-cell-work'
  if (status === 'review') return 'heat-cell-review'
  if (status === 'blocked') return 'heat-cell-blocked'
  if (status === 'open' || status === 'assigned') return 'heat-cell-open'
  return 'heat-cell-done'
}

function TaskStatusChip({ status }: { status: WorkItemStatus }) {
  const tone =
    status === 'in_progress' || status === 'review'
      ? 'border-honey-600/50 text-honey-300'
      : status === 'blocked'
        ? 'border-ember-500/50 text-ember-400'
        : status === 'open'
          ? 'border-hive-600 text-hive-300'
          : 'border-hive-700 text-hive-500'
  return <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide ${tone}`}>{status.replace('_', ' ')}</span>
}

/** Agent energy, drawn as nectar cells: quiet honey bars, no glow. */
function NectarMeter({ energy, maxEnergy }: { energy: number; maxEnergy: number }) {
  const cells = Math.max(1, Math.min(maxEnergy, 12))
  const filled = Math.round((energy / Math.max(1, maxEnergy)) * cells)
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <div className="flex flex-1 gap-0.5" title={`nectar ${energy}/${maxEnergy}`}>
        {Array.from({ length: cells }, (_, index) => (
          <span key={index} className={`nectar-cell ${index < filled ? 'nectar-cell-full' : ''}`} />
        ))}
      </div>
      <span className="flex items-center gap-1 font-mono text-[10px] text-hive-400">
        <Droplet className="h-3 w-3 text-honey-600" />
        {energy}/{maxEnergy}
      </span>
    </div>
  )
}

function EmptyHint({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
      <span className="text-hive-600">{icon}</span>
      <p className="font-mono text-[11px] text-hive-400">{text}</p>
    </div>
  )
}

/** The spend-cap posture in one word: what an operator glances at, not computes. */
function capLabel(spend: number, cap?: number): string {
  if (cap === undefined || cap <= 0) return 'uncapped'
  const ratio = spend / cap
  if (ratio >= 1) return 'spent'
  if (ratio >= 0.8) return 'fading'
  if (ratio >= 0.5) return 'watch'
  return 'optimal'
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour12: false })
}

function formatInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}

/** `hive/main/hive/branch` reads as just `branch` where the prefix is noise. */
function shortRef(ref: string): string {
  const parts = ref.split('/')
  return parts[parts.length - 1] || ref
}

const model = new RuntimeViewModel({ bridge: window.hive.runtime })
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App model={model} />
  </StrictMode>,
)
