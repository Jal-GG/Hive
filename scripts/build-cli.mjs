import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'

mkdirSync('dist', { recursive: true })
await build({
  entryPoints: ['src/cli-entry.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/cli.cjs',
  external: ['better-sqlite3', 'node-pty'],
  sourcemap: false,
  logLevel: 'info',
})
console.log('CLI bundled to dist/cli.cjs')
