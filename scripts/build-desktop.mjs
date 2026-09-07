import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Bundles the Electron main and preload entries into CommonJS, so Electron can
 * load them without an ESM loader dance. The renderer is Vite's business; these
 * two are Node-side and stay dependency-free apart from Electron's own runtime.
 */
const outdir = 'dist/desktop'
mkdirSync(outdir, { recursive: true })

for (const entry of ['main', 'preload']) {
  const result = await build({
    entryPoints: [`desktop/${entry}.ts`],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: join(outdir, `${entry}.js`),
    external: ['electron'],
    sourcemap: false,
    logLevel: 'info',
  })
  if (result.errors.length > 0) process.exit(1)
}
console.log(`desktop entries bundled to ${outdir}`)
