import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Renderer build only. The main and preload processes are plain Node-flavoured
 * TypeScript bundled by the same tsc setup as `src/`, so one Vite root (the
 * renderer) keeps the toolchain to exactly two tools.
 */
export default defineConfig({
  root: 'desktop/renderer',
  // Relative asset paths: the renderer loads via file://, where Vite's default
  // absolute '/assets/...' would resolve to the drive root and never load.
  base: './',
  // Vitest must keep scanning from the project root; the renderer root is only
  // for the production bundle.
  test: {
    root: '.',
    include: ['tests/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
  },
  plugins: [react(), tailwindcss()],
  build: {
    // Beside the bundled main/preload entries, so one directory is the whole
    // desktop artifact and `loadFile` has a single relative root.
    outDir: '../../dist/desktop/renderer',
    emptyOutDir: true,
  },
})
