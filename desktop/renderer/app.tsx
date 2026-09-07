import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { RuntimeViewModel, type RuntimeViewState } from '../../src/interfaces/desktop/runtime-view-model.js'
import type { HiveWindow } from '../../src/interfaces/desktop/preload-bridge.js'

declare global {
  interface Window {
    hive: HiveWindow
  }
}

/**
 * The operator console: a roster of runs, one terminal, one status line.
 *
 * The view model owns every decision — what a roster row shows, when the cursor
 * moves, what an outcome reads as — so this component is layout only. A React
 * rewrite or a second front end would consume the same state object.
 */
function App({ model }: { model: RuntimeViewModel }) {
  const [state, setState] = useState<RuntimeViewState>(() => model.state())
  const [prompt, setPrompt] = useState('')
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

  return (
    <div className="app">
      <aside className="roster">
        <h1>Hive</h1>
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
        {state.error ? <p className="error">{state.error}</p> : null}
      </aside>
      <main className="console">
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
