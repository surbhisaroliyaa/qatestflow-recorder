// Post-build guard for QF-002: every built preload must be sandbox-safe.
//
//   npm run build && node tools/check-preload-sandbox.mjs
//
// Both windows run with Electron's sandbox ON. A sandboxed preload can
// require('electron') and nothing else — an npm package or a shared chunk file
// makes the preload throw at startup, and the window it serves then has no
// `window.api` (the app UI) or no recorder relay (the page under test).
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'preload')
const bad = []
for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
  const src = readFileSync(join(dir, f), 'utf-8')
  for (const m of src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
    if (m[1] !== 'electron') bad.push(`${f} requires "${m[1]}"`)
  }
}
if (bad.length) {
  console.error('Preloads are not sandbox-safe:\n  ' + bad.join('\n  '))
  console.error('Bundle the dependency (electron.vite.config.ts: externalizeDeps: false).')
  process.exit(1)
}
console.log('preloads are sandbox-safe (require only "electron")')
