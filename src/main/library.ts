// =====================================================================
// TEST LIBRARY (Day 11)
// Saved tests live as JSON files in a VISIBLE folder (Documents\QATestFlow
// Tests) — test files are artifacts a QA team shares, backs up, and puts in
// git, so they must not hide in AppData. One file per test, named by a slug
// of the test's name; saving the same name again overwrites (an update).
//
// The JSON holds the STEP MODEL, not generated code: Playwright code is a
// VIEW of the model (regenerable any time via export), the model is the
// source of truth that stays editable. `version` is there so a future format
// change can migrate old files instead of breaking them.
// =====================================================================

import { app } from 'electron'
import { mkdir, readdir, readFile, writeFile, unlink } from 'fs/promises'
import { join } from 'path'

// Outcome of one replay — gives the library list its green/red
// "mini CI dashboard" dots.
export interface RunInfo {
  status: 'passed' | 'failed'
  at: string // ISO timestamp
  failedAt?: number // step index of the first failure
  error?: string
  screenshotPath?: string // page capture at the failing step (Day 11.5)
}

// How many past runs each test remembers (newest first). Enough to spot
// "newly broken" vs "flaky all week" without growing files forever.
const RUN_HISTORY_LIMIT = 10

// The full on-disk shape. Steps are opaque to main (the renderer owns the
// RecorderStep type) — main just stores and returns them.
export interface SavedTestFile {
  version: 1
  name: string
  baseURL: string
  createdAt: string
  updatedAt: string
  lastRun?: RunInfo // most recent outcome (= runs[0]; kept for older files)
  runs?: RunInfo[] // run history, newest first, capped (Day 11.5)
  // Day 17: a saved session (storageState) file in _sessions to start this test
  // already logged in (skip the login steps). Undefined = fresh/clean state.
  storageState?: string
  // Day 17: render the test at a fixed viewport (device emulation). Undefined =
  // fill the window (desktop, the default).
  viewport?: { width: number; height: number }
  steps: unknown[]
}

// What the library LIST shows — everything except the steps themselves,
// so listing 50 tests doesn't read 50 full step arrays into the UI.
export interface SavedTestSummary {
  // Path RELATIVE to the library folder — includes the section subfolder
  // when the test lives in one (e.g. "E2E/login-flow.json").
  fileName: string
  suite: string // the section (subfolder) — '' for legacy root files
  name: string
  baseURL: string
  updatedAt: string
  stepCount: number
  storageState?: string // Day 17: attached session, if any
  lastRun?: RunInfo
  runs?: RunInfo[]
}

export function libraryDir(): string {
  return join(app.getPath('documents'), 'QATestFlow Tests')
}

// Sections that exist from the first launch (Surbhi's model: E2E = the
// crown-jewel regression flows; Daily = the feature-under-test scratchpad).
// Users can create more by typing a new name when saving.
const DEFAULT_SUITES = ['E2E', 'Daily']

// "Login flow (staging)" -> "login-flow-staging.json"
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'untitled'
}

// One path segment (a suite folder name or a file name): no separators, no
// Windows-reserved characters, no ".." — so nothing can escape the library.
function safeSegment(segment: string): string {
  const clean = segment.replace(/[\\/:*?"<>|]/g, '').trim()
  return clean === '..' || clean === '.' ? '' : clean
}

// A relative path arriving over IPC: at most "suite/file.json". Each segment
// sanitised independently, then rejoined.
function safeRel(relPath: string): string {
  return relPath.split(/[\\/]/).map(safeSegment).filter(Boolean).slice(0, 2).join('/')
}

async function ensureDir(): Promise<void> {
  await mkdir(libraryDir(), { recursive: true })
  for (const suite of DEFAULT_SUITES) {
    await mkdir(join(libraryDir(), suite), { recursive: true })
  }
}

function toSummary(fileName: string, test: SavedTestFile): SavedTestSummary {
  return {
    fileName,
    // The folder IS the suite — derived, never stored, so the two can't drift.
    suite: fileName.includes('/') ? fileName.split('/')[0] : '',
    name: test.name,
    baseURL: test.baseURL,
    updatedAt: test.updatedAt,
    stepCount: Array.isArray(test.steps) ? test.steps.length : 0,
    storageState: test.storageState,
    lastRun: test.lastRun,
    runs: test.runs?.slice(0, RUN_HISTORY_LIMIT)
  }
}

async function readTestFile(fileName: string): Promise<SavedTestFile | null> {
  try {
    const raw = await readFile(join(libraryDir(), safeRel(fileName)), 'utf-8')
    const parsed = JSON.parse(raw)
    // Minimal sanity check — a corrupt/foreign JSON file is skipped, not fatal.
    if (!parsed || typeof parsed.name !== 'string' || !Array.isArray(parsed.steps)) return null
    return parsed as SavedTestFile
  } catch {
    return null
  }
}

// Save (create or update) into a section subfolder. createdAt and run history
// survive an overwrite — re-saving edits content, it doesn't erase history.
export async function saveTest(input: {
  name: string
  baseURL: string
  suite: string
  steps: unknown[]
  storageState?: string
  viewport?: { width: number; height: number }
}): Promise<SavedTestSummary> {
  await ensureDir()
  const suite = safeSegment(input.suite)
  const fileName = suite ? `${suite}/${slugify(input.name)}.json` : `${slugify(input.name)}.json`
  if (suite) await mkdir(join(libraryDir(), suite), { recursive: true })
  const now = new Date().toISOString()
  const previous = await readTestFile(fileName)
  const test: SavedTestFile = {
    version: 1,
    name: input.name,
    baseURL: input.baseURL,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    lastRun: previous?.lastRun,
    runs: previous?.runs,
    storageState: input.storageState,
    viewport: input.viewport,
    steps: input.steps
  }
  await writeFile(join(libraryDir(), fileName), JSON.stringify(test, null, 2), 'utf-8')
  return toSummary(fileName, test)
}

// Every section folder, defaults first — shown even when empty (a fresh app
// must still offer E2E and Daily as save targets).
export async function listSuites(): Promise<string[]> {
  await ensureDir()
  const entries = await readdir(libraryDir(), { withFileTypes: true })
  const found = entries.filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name)
  const rest = found.filter((s) => !DEFAULT_SUITES.includes(s)).sort()
  return [...DEFAULT_SUITES, ...rest]
}

// All tests across all sections, newest-updated first within the list.
// Reads the root too, so tests saved before sections existed still appear.
export async function listTests(): Promise<SavedTestSummary[]> {
  await ensureDir()
  const relPaths: string[] = []
  const entries = await readdir(libraryDir(), { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.json')) relPaths.push(entry.name)
    if (entry.isDirectory() && !entry.name.startsWith('_')) {
      const inner = await readdir(join(libraryDir(), entry.name))
      for (const f of inner) {
        if (f.endsWith('.json')) relPaths.push(`${entry.name}/${f}`)
      }
    }
  }
  const summaries: SavedTestSummary[] = []
  for (const fileName of relPaths) {
    const test = await readTestFile(fileName)
    if (test) summaries.push(toSummary(fileName, test))
  }
  return summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

export async function loadTest(fileName: string): Promise<SavedTestFile | null> {
  return readTestFile(fileName)
}

export async function deleteTest(fileName: string): Promise<void> {
  try {
    await unlink(join(libraryDir(), safeRel(fileName)))
  } catch {
    // already gone — deleting a missing file is not an error worth surfacing
  }
}

// Stamp a replay outcome onto the file: push onto the capped history AND keep
// lastRun as the newest (older files have only lastRun). Deliberately does
// NOT touch updatedAt: that field means "the test's CONTENT changed",
// not "it was run".
export async function recordRun(fileName: string, run: RunInfo): Promise<void> {
  const test = await readTestFile(fileName)
  if (!test) return
  test.lastRun = run
  test.runs = [run, ...(test.runs ?? [])].slice(0, RUN_HISTORY_LIMIT)
  await writeFile(join(libraryDir(), safeRel(fileName)), JSON.stringify(test, null, 2), 'utf-8')
}
