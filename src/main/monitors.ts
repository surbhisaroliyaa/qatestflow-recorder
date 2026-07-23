// F32 — scheduled monitors. A saved test can be "promoted" to a monitor: the app
// re-runs it on an interval (headless, via the same Playwright path as F17
// cross-browser) and alerts on failure. HONEST LIMIT: monitors only fire while
// the app is open — there's no background service. The scheduler itself lives in
// the renderer (it already owns spec generation + xbrowser.run); this module is
// just the persisted store, mirroring environments.ts.
import { app } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'

export interface MonitorRun {
  at: string // ISO timestamp
  // 'error' = the run couldn't even happen (Playwright missing, test gone) — kept
  // distinct from 'failed' (the test ran and a step/assertion failed) so a broken
  // setup never masquerades as a product regression.
  status: 'passed' | 'failed' | 'error'
  detail?: string // failing test title / error message
}

export interface Monitor {
  id: string
  fileName: string // the saved test this watches
  name: string // display name (the test's name at promote time)
  intervalMin: number // how often to run
  enabled: boolean
  alertOnFail: boolean // fire a desktop notification when a run isn't 'passed'
  // F32+: the environment PINNED to this monitor (its baseURL + vars), so its
  // result is independent of whatever's selected in the global "Run against"
  // dropdown. null/undefined = the recorded URLs (no retarget, no injected vars).
  envId?: string | null
  lastRunAt: string | null
  runs: MonitorRun[] // capped history, newest first
}

export interface MonitorState {
  version: 1
  monitors: Monitor[]
}

const RUN_HISTORY_LIMIT = 30
const EMPTY: MonitorState = { version: 1, monitors: [] }

function storePath(): string {
  return join(app.getPath('userData'), 'monitors.json')
}

let cache: MonitorState | null = null

async function load(): Promise<MonitorState> {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await readFile(storePath(), 'utf-8'))
    if (parsed && Array.isArray(parsed.monitors)) {
      cache = { version: 1, monitors: parsed.monitors }
      return cache
    }
  } catch {
    // no file yet (or corrupt) — start empty
  }
  cache = { ...EMPTY }
  return cache
}

async function persist(state: MonitorState): Promise<void> {
  cache = state
  await writeFile(storePath(), JSON.stringify(state, null, 2), 'utf-8')
}

export async function listMonitors(): Promise<Monitor[]> {
  return (await load()).monitors
}

// Upsert by id. A new monitor (no matching id) is appended; an existing one is
// replaced wholesale (the renderer sends the full object).
export async function saveMonitor(mon: Monitor): Promise<Monitor[]> {
  const state = await load()
  const i = state.monitors.findIndex((m) => m.id === mon.id)
  const monitors = [...state.monitors]
  if (i >= 0) monitors[i] = mon
  else monitors.push(mon)
  await persist({ version: 1, monitors })
  return monitors
}

export async function deleteMonitor(id: string): Promise<Monitor[]> {
  const state = await load()
  const monitors = state.monitors.filter((m) => m.id !== id)
  await persist({ version: 1, monitors })
  return monitors
}

// Stamp a run outcome: set lastRunAt and push onto the capped history.
export async function recordMonitorRun(id: string, run: MonitorRun): Promise<Monitor[]> {
  const state = await load()
  const monitors = state.monitors.map((m) =>
    m.id === id
      ? { ...m, lastRunAt: run.at, runs: [run, ...m.runs].slice(0, RUN_HISTORY_LIMIT) }
      : m
  )
  await persist({ version: 1, monitors })
  return monitors
}
