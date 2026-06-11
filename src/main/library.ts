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

// Outcome of the most recent replay — gives the library list its
// green/red "mini CI dashboard" dots.
export interface RunInfo {
  status: 'passed' | 'failed'
  at: string // ISO timestamp
  failedAt?: number // step index of the first failure
  error?: string
}

// The full on-disk shape. Steps are opaque to main (the renderer owns the
// RecorderStep type) — main just stores and returns them.
export interface SavedTestFile {
  version: 1
  name: string
  baseURL: string
  createdAt: string
  updatedAt: string
  lastRun?: RunInfo
  steps: unknown[]
}

// What the library LIST shows — everything except the steps themselves,
// so listing 50 tests doesn't read 50 full step arrays into the UI.
export interface SavedTestSummary {
  fileName: string
  name: string
  baseURL: string
  updatedAt: string
  stepCount: number
  lastRun?: RunInfo
}

export function libraryDir(): string {
  return join(app.getPath('documents'), 'QATestFlow Tests')
}

// "Login flow (staging)" -> "login-flow-staging.json"
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'untitled'
}

// File names arrive from the renderer over IPC — strip any path separators so
// a malformed name can never escape the library folder.
function safeName(fileName: string): string {
  return fileName.replace(/[\\/]/g, '')
}

async function ensureDir(): Promise<void> {
  await mkdir(libraryDir(), { recursive: true })
}

function toSummary(fileName: string, test: SavedTestFile): SavedTestSummary {
  return {
    fileName,
    name: test.name,
    baseURL: test.baseURL,
    updatedAt: test.updatedAt,
    stepCount: Array.isArray(test.steps) ? test.steps.length : 0,
    lastRun: test.lastRun
  }
}

async function readTestFile(fileName: string): Promise<SavedTestFile | null> {
  try {
    const raw = await readFile(join(libraryDir(), safeName(fileName)), 'utf-8')
    const parsed = JSON.parse(raw)
    // Minimal sanity check — a corrupt/foreign JSON file is skipped, not fatal.
    if (!parsed || typeof parsed.name !== 'string' || !Array.isArray(parsed.steps)) return null
    return parsed as SavedTestFile
  } catch {
    return null
  }
}

// Save (create or update). createdAt and lastRun survive an overwrite —
// re-saving a test edits its content, it doesn't erase its history.
export async function saveTest(input: {
  name: string
  baseURL: string
  steps: unknown[]
}): Promise<SavedTestSummary> {
  await ensureDir()
  const fileName = `${slugify(input.name)}.json`
  const now = new Date().toISOString()
  const previous = await readTestFile(fileName)
  const test: SavedTestFile = {
    version: 1,
    name: input.name,
    baseURL: input.baseURL,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    lastRun: previous?.lastRun,
    steps: input.steps
  }
  await writeFile(join(libraryDir(), fileName), JSON.stringify(test, null, 2), 'utf-8')
  return toSummary(fileName, test)
}

// Newest-updated first — the test you just worked on tops the list.
export async function listTests(): Promise<SavedTestSummary[]> {
  await ensureDir()
  const files = (await readdir(libraryDir())).filter((f) => f.endsWith('.json'))
  const summaries: SavedTestSummary[] = []
  for (const fileName of files) {
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
    await unlink(join(libraryDir(), safeName(fileName)))
  } catch {
    // already gone — deleting a missing file is not an error worth surfacing
  }
}

// Stamp the latest replay outcome onto the file. Deliberately does NOT touch
// updatedAt: that field means "the test's CONTENT changed", not "it was run".
export async function recordRun(fileName: string, run: RunInfo): Promise<void> {
  const test = await readTestFile(fileName)
  if (!test) return
  test.lastRun = run
  await writeFile(join(libraryDir(), safeName(fileName)), JSON.stringify(test, null, 2), 'utf-8')
}
