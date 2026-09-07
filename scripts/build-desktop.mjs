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
    // .cjs because the package is "type": "module": Electron loads the main
    // entry as CommonJS regardless, and the extension is what Node/Electron
    // use to decide how to parse it.
    outfile: join(outdir, `${entry}.cjs`),
    // Native modules must stay external: bundling breaks the `bindings` path
    // search, and the .node file only loads against the ABI it was built for.
    external: ['electron', 'better-sqlite3'],
    sourcemap: false,
    logLevel: 'info',
  })
  if (result.errors.length > 0) process.exit(1)
}
console.log(`desktop entries bundled to ${outdir}`)
