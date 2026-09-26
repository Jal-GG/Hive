import { spawn } from 'node:child_process'
import { MergeGateResult } from '../contracts.js'

/** How much of a gate's output is kept: the tail, because the end is where the failure is. */
export const gateOutputLimit = 8 * 1024

export interface GateDefinition {
  name: string
  /** The command the gate runs, shell-split, in the integration worktree. */
  command: readonly string[]
}

/** Gates are injectable: the queue never spawns anything a test did not choose. */
export interface GateRunner {
  run(gates: readonly GateDefinition[], cwd: string): Promise<MergeGateResult[]>
}

/** Runs every gate in parallel, bounded in time and output, returning each verdict. */
export function commandGateRunner(options: { timeoutMs?: number } = {}): GateRunner {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000
  return {
    async run(gates, cwd) {
      return Promise.all(gates.map((gate) => runOne(gate, cwd, timeoutMs)))
    },
  }
}

function runOne(gate: GateDefinition, cwd: string, timeoutMs: number): Promise<MergeGateResult> {
  return new Promise((resolve) => {
    // On Windows, spawn does not resolve bare command names against PATH the
    // way a shell does, so gates run through a shell there; elsewhere a direct
    // spawn is both faster and stricter about argument boundaries.
    const child = spawn(gate.command[0], [...gate.command.slice(1)], {
      cwd,
      windowsHide: true,
      shell: process.platform === 'win32',
    })
    let output = ''
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      // Keep only the tail once over the limit: the end is where failures explain themselves.
      if (output.length > gateOutputLimit * 2) output = output.slice(-gateOutputLimit)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timer = setTimeout(() => child.kill(), timeoutMs)
    timer.unref?.()
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ gate: gate.name, passed: false, output: bounded(`${output}\n${String(error)}`) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ gate: gate.name, passed: code === 0, output: bounded(output) })
    })
  })
}

function bounded(output: string): string {
  const trimmed = output.trim()
  return trimmed.length <= gateOutputLimit ? trimmed : `…${trimmed.slice(-gateOutputLimit)}`
}
