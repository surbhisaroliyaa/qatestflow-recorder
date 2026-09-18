import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  // Two preload bundles now:
  //   index    → the API bridge for the main window (window.api)
  //   recorder → the "observer" injected into the embedded browser's pages
  preload: {
    build: {
      // QF-002: both windows now run with Electron's SANDBOX on. A sandboxed
      // preload may require('electron') and nothing else — no npm package, and
      // no shared chunk file. So dependencies are bundled in rather than left
      // as require() calls to node_modules (externalizeDeps: false).
      //
      // The two preloads share no code, so no shared chunk is emitted. (The
      // experimental `isolatedEntries` would guarantee that, but in electron-vite
      // 5.0.0 it crashes whenever stdout isn't a terminal — i.e. in CI.) The
      // guard is tools/check-preload-sandbox.mjs, run in CI after the build: it
      // fails if a built preload ever requires anything but `electron`.
      externalizeDeps: false,
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          recorder: resolve('src/preload/recorder.ts')
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
