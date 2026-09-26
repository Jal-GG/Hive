#!/usr/bin/env node
/**
 * One checkout, two ABIs.
 *
 * better-sqlite3 and node-pty are native modules: the build sitting in
 * node_modules must match whichever runtime is about to load it — plain Node
 * (vitest, the CLI) or Electron (the desktop app) — and one node_modules cannot
 * serve both. This script puts the right build in place by file copy, caching
 * one build per target under .native-abi/ so only the first run per target pays
 * for a compile.
 *
 *   node scripts/native-abi.mjs node      # before vitest or plain node
 *   node scripts/native-abi.mjs electron  # before `electron .`
 *
 * Which modules are required depends on the target: the ledger must load for
 * anything to boot under either runtime, while node-pty is loaded lazily at the
 * first PTY spawn — so under Electron it is best-effort. Verification is
 * behavioural, not structural: after swapping, each module is required under
 * the target runtime, because where a module's binary lives differs between
 * them (build/Release for one, a prebuilds/ fallback for the other).
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const target = process.argv[2]
if (target !== 'node' && target !== 'electron') {
  console.error('Usage: node scripts/native-abi.mjs <node|electron>')
  process.exit(1)
}

const modules = ['better-sqlite3', 'node-pty']
// Under Electron the ledger is boot-critical; node-pty loads lazily and only
// fails a real-provider spawn, so it degrades to a warning instead of blocking.
const required = target === 'electron' ? ['better-sqlite3'] : modules
const optional = target === 'electron' ? ['node-pty'] : []

const cacheRoot = '.native-abi'
const readyMarker = '.ready'
const skippedMarker = '.skipped'

const releaseDir = (module) => join('node_modules', module, 'build', 'Release')
const cacheDir = (module) => join(cacheRoot, target, module)
const cacheReady = (module) => existsSync(join(cacheDir(module), readyMarker))
const settled = (module) => cacheReady(module) || existsSync(join(cacheDir(module), skippedMarker))

function nodeFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter((file) => file.endsWith('.node')).map((file) => join(directory, file))
}

/**
 * Requires the listed modules under the target runtime; the exit code is the
 * verdict. Electron is checked through ELECTRON_RUN_AS_NODE, which loads
 * native modules against Electron's ABI without booting an app.
 */
function verify(list) {
  const probe = join(cacheRoot, 'verify.cjs')
  mkdirSync(cacheRoot, { recursive: true })
  writeFileSync(probe, `${list.map((module) => `require('${module}')`).join('\n')}\n`)
  const command = target === 'node' ? `node ${probe}` : `npx --no-install electron ${probe}`
  return spawnSync(command, {
    shell: true,
    encoding: 'utf8',
    env: target === 'electron' ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
  })
}

/** Makes build/Release match the cached set exactly: cached copies in, anything else out. No cache means no opinion. */
function applyCached(module) {
  if (!cacheReady(module)) return
  const desired = nodeFiles(cacheDir(module))
  for (const installed of nodeFiles(releaseDir(module))) {
    if (!desired.some((file) => basename(file) === basename(installed))) rmSync(installed)
  }
  for (const file of desired) {
    mkdirSync(releaseDir(module), { recursive: true })
    copyFileSync(file, join(releaseDir(module), basename(file)))
  }
}

/** Records the current build/Release state as this target's cached state. */
function snapshot(module) {
  mkdirSync(cacheDir(module), { recursive: true })
  for (const stale of nodeFiles(cacheDir(module))) rmSync(stale)
  for (const file of nodeFiles(releaseDir(module))) copyFileSync(file, join(cacheDir(module), basename(file)))
  writeFileSync(join(cacheDir(module), readyMarker), `${target}\n`)
}

function run(command) {
  const result = spawnSync(command, { shell: true, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`command failed: ${command}`)
}

function rebuild(module) {
  console.log(`[native-abi] building ${module} for ${target} (cached after this once)`)
  if (target === 'electron') {
    run(`npx --no-install electron-rebuild --force --only ${module}`)
    return
  }
  run(`npm rebuild ${module}`)
  // An install that finds a shipped prebuild is a no-op and can leave the other
  // runtime's binary sitting in build/Release. For modules that fall back to
  // prebuilds/, removing it is the correct Node state; verify decides which.
  if (verify([module]).status !== 0) {
    for (const file of nodeFiles(releaseDir(module))) rmSync(file)
    if (verify([module]).status !== 0) {
      run(`npm rebuild ${module} --build-from-source`)
    }
  }
}

try {
  if (required.every(cacheReady) && optional.every(settled)) {
    for (const module of modules) applyCached(module)
    if (verify([...required, ...optional.filter(cacheReady)]).status === 0) {
      console.log(`[native-abi] ${target} ABI in place`)
      process.exit(0)
    }
    console.log('[native-abi] cached state no longer verifies; rebuilding')
    for (const module of modules) rmSync(cacheDir(module), { recursive: true, force: true })
  }

  for (const module of modules) {
    if (settled(module)) continue
    try {
      rebuild(module)
      snapshot(module)
    } catch (error) {
      if (!optional.includes(module)) throw error
      mkdirSync(cacheDir(module), { recursive: true })
      writeFileSync(join(cacheDir(module), skippedMarker), `${error instanceof Error ? error.message : String(error)}\n`)
      console.warn(
        `[native-abi] ${module} could not be built for electron; continuing without it. ` +
          'The desktop boots and runs the fake backend, but real-provider launches from the desktop will report PTY_UNAVAILABLE. ' +
          `Install the missing build components (the error above names it), delete ${join(cacheRoot, 'electron', module)}, and rerun to retry.`,
      )
    }
  }

  for (const module of modules) applyCached(module)
  const check = verify([...required, ...optional.filter(cacheReady)])
  if (check.status !== 0) {
    console.error(`[native-abi] modules do not load under ${target}:\n${check.stdout || ''}${check.stderr || ''}`)
    process.exit(1)
  }
  const missing = optional.filter((module) => !cacheReady(module))
  console.log(`[native-abi] ${target} ABI in place${missing.length > 0 ? ` (without ${missing.join(', ')})` : ''}`)
} catch (error) {
  console.error(`[native-abi] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
