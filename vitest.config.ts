import { defineConfig } from 'vitest/config'

// Unit tests for the PURE logic modules — no Electron, no browser, no network.
//
// Scope is deliberate. These cover token substitution, control-flow pairing,
// failure triage and the OS-env collision list: the four places this codebase
// has actually shipped bugs. Everything else (IPC, replay, the native pane) needs
// a running app and stays with the manual/integration passes.
//
// Tests live in test/ rather than src/ so `electron-vite build` never sees them.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node'
  }
})
