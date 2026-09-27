import { execFileSync } from 'node:child_process'

const root = process.cwd()
const channel = process.env.HIVE_RELEASE_CHANNEL ?? 'nightly'
const out = process.env.HIVE_RELEASE_OUT ?? 'release'

// The CLI owns the assembly logic (src/release.ts) and is bundled by build:cli;
// this script is only the npm-friendly entry point that sequences build → package.
execFileSync(process.execPath, ['scripts/build-cli.mjs'], { cwd: root, stdio: 'inherit' })
execFileSync(process.execPath, ['dist/cli.cjs', 'release', '--channel', channel, '--out', out], { cwd: root, stdio: 'inherit' })
