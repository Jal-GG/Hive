import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { RuntimeViewModel, type RuntimeViewState } from '../../src/interfaces/desktop/runtime-view-model.js'
import type { HiveWindow } from '../../src/interfaces/desktop/preload-bridge.js'
import type { WorkItem, WorkPlanRevision } from '../../src/contracts.js'

declare global {
  interface Window {
    hive: HiveWindow
  }
}

/**
 * The operator console: a roster of runs, one terminal, one status line, and
 * the task board the runs belong to.
 *
 * The run view model owns every terminal decision — what a roster row shows,
 * when the cursor moves, what an outcome reads as — so this component is layout
 * only. The task panel talks to the work bridge directly: the work plane has no
 * push streams yet, so there is nothing for a view model to subscribe to.
 */
function App({ model }: { model: RuntimeViewModel }) {
  const [state, setState] = useState<RuntimeViewState>(() => model.state())
  const [prompt, setPrompt] = useState('')
  const [tab, setTab] = useState<'runs' | 'tasks'>('runs')
  const terminalElement = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | undefined>(undefined)
  const fit = useRef<FitAddon | undefined>(undefined)

  useEffect(() => model.subscribe(setState), [model])

  // One xterm, fed by the view model's terminal buffer.
  useEffect(() => {
    const element = terminalElement.current
    if (!element) return
    const term = new Terminal({ fontSize: 13, cursorBlink: true, convertEol: false })
    const addon = new FitAddon()
    term.loadAddon(addon)
    term.open(element)
    term.write(state.terminal)
    terminal.current = term
    fit.current = addon
    const resize = () => addon.fit()
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('resize', resize)
      term.dispose()
      terminal.current = undefined
    }
    // The terminal is created once; the buffer is written by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Stream the terminal buffer into xterm whenever it changes.
  useEffect(() => {
    terminal.current?.write(state.terminal)
  }, [state.terminal])

  // Keep the roster's selected run attached and the event log followed.
  useEffect(() => {
    void model.refresh()
    void window.hive.stream.follow(state.cursor)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Attach when a run is selected, so its output streams into the terminal.
  useEffect(() => {
    if (state.selectedRunId) void window.hive.stream.attach(state.selectedRunId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.selectedRunId])

  // The pane size follows the terminal size the operator actually has.
  useEffect(() => {
    if (terminal.current && state.selectedRunId) {
      void model.resize(terminal.current.cols, terminal.current.rows)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.selectedRunId, state.status?.cols])

  const selected = useMemo(
    () => state.runs.find((run) => run.id === state.selectedRunId),
    [state.runs, state.selectedRunId],
  )

  const [items, setItems] = useState<WorkItem[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>(undefined)
  const [plan, setPlan] = useState<WorkPlanRevision | null>(null)
  const [taskTitle, setTaskTitle] = useState('')
  const [workError, setWorkError] = useState<string | undefined>(undefined)

  const refreshTasks = useCallback(async (select?: string) => {
    const result = await window.hive.work.invoke('items')
    if (!result.ok) {
      setWorkError(result.error.message)
      return
    }
    const rows = result.data as WorkItem[]
    setItems(rows)
    const next = select ?? selectedTaskId
    if (next && rows.some((item) => item.id === next)) {
      setSelectedTaskId(next)
      const planResult = await window.hive.work.invoke('plan', { workItemId: next })
      setPlan(planResult.ok ? ((planResult.data as WorkPlanRevision | null) ?? null) : null)
    } else {
      setSelectedTaskId(undefined)
      setPlan(null)
    }
  }, [selectedTaskId])

  useEffect(() => {
    if (tab === 'tasks') void refreshTasks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const runWork = useCallback(async (operation: string, payload: Record<string, unknown>) => {
    const result = await window.hive.work.invoke(operation, payload)
    if (!result.ok) {
      setWorkError(result.error.message)
      return
    }
    setWorkError(undefined)
    return result.data
  }, [])

  const selectedTask = items.find((item) => item.id === selectedTaskId)

  return (
    <div className="app">
      <aside className="roster">
        <h1>Hive</h1>
        <nav className="tabs">
          <button className={tab === 'runs' ? 'tab tab-active' : 'tab'} onClick={() => setTab('runs')}>Runs</button>
          <button className={tab === 'tasks' ? 'tab tab-active' : 'tab'} onClick={() => setTab('tasks')}>Tasks</button>
        </nav>

        {tab === 'runs' ? (
          <>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void model.launch({
                  profileId: 'fake',
                  workspace: 'main',
                  project: 'hive',
                  prompt: prompt || undefined,
                })
                setPrompt('')
              }}
            >
              <input
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="prompt (optional)"
              />
              <button type="submit" disabled={state.busy}>
                Launch fake agent
              </button>
            </form>
            <ul>
              {state.roster.map((row) => (
                <li key={row.runId} className={row.live ? 'selected' : undefined}>
                  <button onClick={() => void model.select(row.runId)}>
                    <span className="short">{row.short}</span>
                    <span className="profile">{row.profile}</span>
                    <span className={`state state-${row.state}`}>{row.state}</span>
                    {row.outcome ? <span className="outcome">{row.outcome}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                const title = taskTitle.trim()
                if (!title) return
                void runWork('create', { title }).then(() => refreshTasks())
                setTaskTitle('')
              }}
            >
              <input
                value={taskTitle}
                onChange={(event) => setTaskTitle(event.target.value)}
                placeholder="task title"
              />
              <button type="submit">New task</button>
            </form>
            <ul>
              {items.map((item) => (
                <li key={item.id} className={item.id === selectedTaskId ? 'selected' : undefined}>
                  <button onClick={() => void refreshTasks(item.id)}>
                    <span className="task-title">{item.title}</span>
                    <span className={`state state-${item.status}`}>{item.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {state.error ? <p className="error">{state.error}</p> : null}
        {workError ? <p className="error">{workError}</p> : null}
      </aside>

      <main className="console">
        {tab === 'tasks' && selectedTask ? (
          <section className="task-detail">
            <header>
              <strong>{selectedTask.title}</strong>
              <span className={`state state-${selectedTask.status}`}>{selectedTask.status}</span>
              {selectedTask.assigneeActorId ? <span>{selectedTask.assigneeActorId}</span> : <span>unassigned</span>}
              <button
                onClick={() =>
                  void runWork('claim', { workItemId: selectedTask.id }).then(() => refreshTasks(selectedTask.id))
                }
              >
                Claim
              </button>
              <button
                onClick={() =>
                  void runWork('start', { workItemId: selectedTask.id }).then(() => refreshTasks(selectedTask.id))
                }
              >
                Start
              </button>
            </header>
            {selectedTask.description ? <p>{selectedTask.description}</p> : null}
            {plan ? (
              <pre className="plan">
                {`plan r${plan.revision} by ${plan.updatedByActorId}\n${plan.body}`}
              </pre>
            ) : (
              <p className="muted">no plan written yet</p>
            )}
          </section>
        ) : (
          <header>
            {selected ? (
              <>
                <strong>{selected.branch}</strong>
                <span>{selected.runtimeProfile}</span>
                <span>{selected.state}</span>
                <button onClick={() => void model.stop({ cleanup: true })}>Stop</button>
              </>
            ) : (
              <span>select a run</span>
            )}
          </header>
        )}
        <div className="terminal" ref={terminalElement} />
        <form
          className="input"
          onSubmit={(event) => {
            event.preventDefault()
            void model.send(`${prompt}\n`)
            setPrompt('')
          }}
        >
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={selected ? 'type to the agent' : 'no run selected'}
            disabled={!selected}
          />
        </form>
      </main>
    </div>
  )
}

const model = new RuntimeViewModel({ bridge: window.hive.runtime })
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App model={model} />
  </StrictMode>,
)
