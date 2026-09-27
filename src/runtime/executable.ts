import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/** Windows resolves a bare name against these when PATHEXT is absent. */
const windowsExtensions = ['.exe', '.cmd', '.bat']

/**
 * Whether an executable name resolves against a PATH, without spawning it.
 *
 * This is what a launcher shows beside a profile — "claude is on this machine" —
 * so an operator's choices are real ones. The check is filesystem-only: no
 * process is started, and nothing about the file is read.
 */
export function commandExists(executable: string, host?: Record<string, string | undefined>): boolean {
  const env = host ?? (process.env as Record<string, string | undefined>)
  if (isAbsolute(executable) || executable.includes('/') || executable.includes('\\')) {
    return matches(executable)
  }
  const pathValue = env.PATH ?? env.Path
  if (!pathValue) return false
  const directories = pathValue.split(delimiter).filter((entry) => entry.length > 0)
  const names = candidateNames(executable, env)
  return directories.some((directory) => names.some((name) => matches(join(directory, name))))
}

function candidateNames(executable: string, env: Record<string, string | undefined>): string[] {
  if (process.platform !== 'win32') return [executable]
  const pathExt = env.PATHEXT
  const extensions = pathExt ? pathExt.split(';').filter((entry) => entry.length > 0) : windowsExtensions
  return [executable, ...extensions.map((extension) => executable + extension)]
}

/** Existence on Windows, the execute bit everywhere else: the truth per platform. */
function matches(file: string): boolean {
  try {
    if (process.platform === 'win32') return existsSync(file)
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}
