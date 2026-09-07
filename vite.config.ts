import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Renderer build only. The main and preload processes are plain Node-flavoured
 * TypeScript bundled by the same tsc setup as `src/`, so one Vite root (the
 * renderer) keeps the toolchain to exactly two tools.
 */
export default defineConfig({
  root: 'desktop/renderer',
  // Vitest must keep scanning from the project root; the renderer root is only
  // for the production bundle.
  test: {
    root: '.',
    include: ['tests/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
  },
  plugins: [react()],
  build: {
    // Beside the bundled main/preload entries, so one directory is the whole
    // desktop artifact and `loadFile` has a single relative root.
    outDir: '../../dist/desktop/renderer',
    emptyOutDir: true,
  },
})
