import { execFileSync } from 'node:child_process'
import { HiveError } from '../../errors.js'

/** Injected so the kill path can be asserted without ending real processes. */
export interface ProcessControl {
  kill(pid: number, signal: string | number): void
  run(file: string, args: string[]): void
  platform: NodeJS.Platform
}

export const systemProcessControl: ProcessControl = {
  kill: (pid, signal) => {
    process.kill(pid, signal as NodeJS.Signals)
  },
  run: (file, args) => {
    execFileSync(file, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
  },
  platform: process.platform,
}

/**
 * Ends a process and everything it started.
 *
 * Agent CLIs spawn shells, language servers, and test runners; signalling only
 * the process Hive holds a handle to leaves that fan-out running, holding the
 * worktree open and burning tokens against a run that is supposed to be over.
 * Windows has no process groups, so ConPTY children are collected by
 * `taskkill /T`; POSIX children are signalled through the negative process group
 * id that node-pty's own session gives them.
 */
export function killProcessTree(pid: number, signal = 'SIGTERM', control: ProcessControl = systemProcessControl): void {
  if (pid <= 0) throw new HiveError('INVALID_PID', `Refusing to signal pid ${pid}`)
  if (control.platform === 'win32') {
    // /T takes the whole tree, /F is unconditional. Windows offers no graceful equivalent for a console child.
    ignoreMissing(() => control.run('taskkill', ['/pid', String(pid), '/T', '/F']))
    return
  }
  try {
    control.kill(-pid, signal)
  } catch (error) {
    // No group (already reaped, or never a session leader): fall back to the process itself.
    if (!isMissingProcess(error)) throw error
    ignoreMissing(() => control.kill(pid, signal))
  }
}

/** Whether a pid is still addressable, used by adoption and reconciliation before trusting a stored pid. */
export function processAlive(pid: number, control: ProcessControl = systemProcessControl): boolean {
  if (pid <= 0) return false
  try {
    control.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else — still alive, just not ours.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function ignoreMissing(action: () => void): void {
  try {
    action()
  } catch (error) {
    if (!isMissingProcess(error)) throw error
  }
}

function isMissingProcess(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ESRCH' || code === 'ENOENT') return true
  // taskkill reports 128 for "process not found"; a race with a natural exit is not a failure.
  const status = (error as { status?: number } | undefined)?.status
  return status === 128 || status === 1
}
