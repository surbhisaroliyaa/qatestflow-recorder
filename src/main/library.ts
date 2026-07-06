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

// F12: how many PAST edits of a test to keep (newest first) — enough to see
// "what changed and when" and roll back a bad edit, without bloating the file.
const VERSION_LIMIT = 15

// F12: one past edit of a test — the steps as they were, and when that version
// was superseded. Lets the UI diff any past version against the current steps.
export interface TestVersion {
  at: string // ISO time this version was replaced (the old updatedAt)
  steps: unknown[]
}

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
  // Day 20 (data-driven): the table of rows this test runs against. Each row is
  // a { column: value } map; columns are derived from the {{tokens}} in steps.
  dataRows?: Record<string, string>[]
  // F1 (HAR): a captured network archive in _hars/ (bare filename, like
  // storageState). When set, replay serves matched responses from it.
  har?: string
  // F12: previous edits of this test (newest first, capped) — snapshotted on
  // save whenever the steps change, so you can see the history and roll back.
  versions?: TestVersion[]
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
  har?: string // F1: a captured network archive, if any (drives a 🌐 badge)
  // F5 (trust score): light aggregates computed from the steps so the renderer
  // can score a test WITHOUT loading every step array. assertCount = how many
  // checks it makes; selectorHealth = avg stability (0–100) of its selectors.
  assertCount?: number
  selectorHealth?: number
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

// F5: cheap per-test stats for the trust score — how many CHECKS the test makes
// (assert / snapshot / a11y / perf), and the average stability of its selectors
// (the primary candidate's 0–100 score). Disabled steps don't count.
function stepStats(steps: unknown[]): { assertCount: number; selectorHealth?: number } {
  const arr = Array.isArray(steps) ? (steps as Record<string, unknown>[]) : []
  const CHECKS = new Set(['assert', 'snapshot', 'a11y', 'perf'])
  let assertCount = 0
  const scores: number[] = []
  for (const s of arr) {
    if (!s || s.disabled) continue
    if (CHECKS.has(s.type as string)) assertCount++
    const cands = s.candidates as { locator?: string; score?: number }[] | undefined
    if (Array.isArray(cands) && cands.length) {
      const primary = cands.find((c) => c.locator === s.selector) ?? cands[0]
      if (primary && typeof primary.score === 'number') scores.push(primary.score)
    }
  }
  const selectorHealth = scores.length
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : undefined
  return { assertCount, selectorHealth }
}

function toSummary(fileName: string, test: SavedTestFile): SavedTestSummary {
  const stats = stepStats(test.steps)
  return {
    fileName,
    // The folder IS the suite — derived, never stored, so the two can't drift.
    suite: fileName.includes('/') ? fileName.split('/')[0] : '',
    name: test.name,
    baseURL: test.baseURL,
    updatedAt: test.updatedAt,
    stepCount: Array.isArray(test.steps) ? test.steps.length : 0,
    storageState: test.storageState,
    har: test.har,
    assertCount: stats.assertCount,
    selectorHealth: stats.selectorHealth,
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

// === F1 (HAR) — captured network archives, stored like sessions ===========
// One `.har` per test in a hidden _hars/ folder, named from the test's
// relative path (so E2E/login.json ↔ E2E__login.har, unique across suites).
function harsDir(): string {
  return join(libraryDir(), '_hars')
}
const SAFE_HAR = /^[a-zA-Z0-9_-]+\.har$/
function harNameForFile(fileName: string): string {
  return fileName.replace(/\.json$/, '').replace(/\//g, '__') + '.har'
}
// Read a saved HAR (the standard { log: { entries: [...] } } shape). Guards the
// filename so it can only ever read inside _hars/.
export async function loadHar(harName: string): Promise<unknown | null> {
  if (!SAFE_HAR.test(harName)) return null
  try {
    return JSON.parse(await readFile(join(harsDir(), harName), 'utf-8'))
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
  dataRows?: Record<string, string>[]
  // F1: the captured HAR log to write alongside this test (main passes it in;
  // the renderer only signals intent). Absent = keep whatever HAR existed.
  harLog?: unknown
}): Promise<SavedTestSummary> {
  await ensureDir()
  const suite = safeSegment(input.suite)
  const fileName = suite ? `${suite}/${slugify(input.name)}.json` : `${slugify(input.name)}.json`
  if (suite) await mkdir(join(libraryDir(), suite), { recursive: true })
  const now = new Date().toISOString()
  const previous = await readTestFile(fileName)
  // F1: write the new HAR (if capturing) and point the test at it; otherwise
  // keep whatever HAR the test already had.
  let har = previous?.har
  if (input.harLog) {
    har = harNameForFile(fileName)
    await mkdir(harsDir(), { recursive: true })
    await writeFile(join(harsDir(), har), JSON.stringify(input.harLog), 'utf-8')
  }
  // F12: if the STEPS actually changed vs the last save, snapshot the previous
  // steps as a version (so you can see what changed and roll back). Re-saving
  // without touching the steps (e.g. a rename) doesn't add a version.
  let versions = previous?.versions
  if (previous && JSON.stringify(previous.steps) !== JSON.stringify(input.steps)) {
    versions = [
      { at: previous.updatedAt, steps: previous.steps },
      ...(previous.versions ?? [])
    ].slice(0, VERSION_LIMIT)
  }
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
    dataRows: input.dataRows,
    har,
    versions,
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

// =====================================================================
// DRAFTS (Day 18) — auto-saved in-progress recordings, so a forgotten Save
// doesn't lose work. They live under _drafts (a hidden folder, excluded from
// the suite listing like the other _ folders). The newest is offered for
// recovery on launch; all of them form a "Recent recordings" list. Capped so
// abandoned drafts don't pile up forever. A draft is deleted once it's saved
// as a real test.
// =====================================================================
const DRAFT_LIMIT = 15
const SAFE_DRAFT_ID = /^draft-[a-zA-Z0-9_-]+$/

export interface DraftFile {
  id: string
  name: string
  baseURL: string
  suite: string
  storageState?: string
  viewport?: { width: number; height: number }
  dataRows?: Record<string, string>[] // Day 20: data-driven table rows
  updatedAt: string
  steps: unknown[]
}

export interface DraftSummary {
  id: string
  name: string
  stepCount: number
  updatedAt: string
  firstUrl?: string // the recording's starting URL — identifies an unnamed draft
}

function draftsDir(): string {
  return join(libraryDir(), '_drafts')
}

export async function saveDraft(input: {
  id: string
  name: string
  baseURL: string
  suite: string
  storageState?: string
  viewport?: { width: number; height: number }
  dataRows?: Record<string, string>[]
  steps: unknown[]
}): Promise<void> {
  if (!SAFE_DRAFT_ID.test(input.id)) return
  await mkdir(draftsDir(), { recursive: true })
  const draft: DraftFile = {
    id: input.id,
    name: input.name,
    baseURL: input.baseURL,
    suite: input.suite,
    storageState: input.storageState,
    viewport: input.viewport,
    dataRows: input.dataRows,
    updatedAt: new Date().toISOString(),
    steps: input.steps
  }
  await writeFile(join(draftsDir(), `${input.id}.json`), JSON.stringify(draft, null, 2), 'utf-8')
  await pruneDrafts()
}

export async function listDrafts(): Promise<DraftSummary[]> {
  let files: string[]
  try {
    files = await readdir(draftsDir())
  } catch {
    return [] // no drafts folder yet
  }
  const drafts: DraftSummary[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const d = JSON.parse(await readFile(join(draftsDir(), f), 'utf-8')) as DraftFile
      if (!d || !Array.isArray(d.steps)) continue
      // The first navigate step's URL is the best label for an unnamed draft.
      const firstNav = (d.steps as Array<{ type?: string; url?: string }>).find(
        (s) => s?.type === 'navigate' && !!s.url
      )
      drafts.push({
        id: d.id,
        name: d.name,
        stepCount: d.steps.length,
        updatedAt: d.updatedAt,
        firstUrl: firstNav?.url
      })
    } catch {
      // skip a corrupt draft
    }
  }
  // Newest first (ISO timestamps sort lexicographically).
  return drafts.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

export async function loadDraft(id: string): Promise<DraftFile | null> {
  if (!SAFE_DRAFT_ID.test(id)) return null
  try {
    const d = JSON.parse(await readFile(join(draftsDir(), `${id}.json`), 'utf-8'))
    if (!d || !Array.isArray(d.steps)) return null
    return d as DraftFile
  } catch {
    return null
  }
}

export async function deleteDraft(id: string): Promise<void> {
  if (!SAFE_DRAFT_ID.test(id)) return
  try {
    await unlink(join(draftsDir(), `${id}.json`))
  } catch {
    // already gone — fine
  }
}

async function pruneDrafts(): Promise<void> {
  try {
    const summaries = await listDrafts() // newest first
    for (const d of summaries.slice(DRAFT_LIMIT)) await deleteDraft(d.id)
  } catch {
    // best-effort
  }
}

// =====================================================================
// REUSABLE STEP BLOCKS (Pillar 4) — a named, saved sequence of steps (e.g.
// "Login") you record ONCE and INSERT into many tests. Stored like tests but in
// a hidden _blocks folder. Inserting COPIES the steps into the test (v1: copy-in,
// no live link), so replay + export need zero block awareness — a block is just
// steps. Same-name save overwrites (an update), like tests.
// =====================================================================
export interface BlockFile {
  version: 1
  name: string
  createdAt: string
  updatedAt: string
  steps: unknown[]
}

export interface BlockSummary {
  fileName: string
  name: string
  stepCount: number
  updatedAt: string
}

// F7 (blast-radius): one test that LINKS a given block, and how many times it
// references it (a block can be inserted more than once in a test).
export interface BlockLink {
  fileName: string // the test's path relative to the library (e.g. "E2E/login.json")
  name: string
  suite: string
  count: number // how many `block` steps in this test point at the block
}

function blocksDir(): string {
  return join(libraryDir(), '_blocks')
}

// F7 (blast-radius map): which saved tests LINK each block, so the UI can warn
// "editing this block changes these N tests" before you touch it. Returns a map
// of block fileName → the tests that reference it (empty/absent = unused, so it's
// safe to edit freely). One pass over every test file; blocks are flattened on
// save, so a live link is always one level (a test → a block, never nested).
export async function blockUsage(): Promise<Record<string, BlockLink[]>> {
  await ensureDir()
  const relPaths: string[] = []
  const entries = await readdir(libraryDir(), { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.json')) relPaths.push(entry.name)
    if (entry.isDirectory() && !entry.name.startsWith('_')) {
      const inner = await readdir(join(libraryDir(), entry.name))
      for (const f of inner) if (f.endsWith('.json')) relPaths.push(`${entry.name}/${f}`)
    }
  }
  const usage: Record<string, BlockLink[]> = {}
  for (const fileName of relPaths) {
    const test = await readTestFile(fileName)
    if (!test) continue
    // Count each block ref in THIS test (a block may appear more than once).
    const counts = new Map<string, number>()
    for (const step of test.steps as { type?: string; blockRef?: string }[]) {
      if (step?.type === 'block' && step.blockRef) {
        counts.set(step.blockRef, (counts.get(step.blockRef) ?? 0) + 1)
      }
    }
    for (const [blockRef, count] of counts) {
      ;(usage[blockRef] ??= []).push({
        fileName,
        name: test.name,
        suite: fileName.includes('/') ? fileName.split('/')[0] : '',
        count
      })
    }
  }
  return usage
}

async function readBlockFile(fileName: string): Promise<BlockFile | null> {
  try {
    const raw = await readFile(join(blocksDir(), safeSegment(fileName)), 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.name !== 'string' || !Array.isArray(parsed.steps)) return null
    return parsed as BlockFile
  } catch {
    return null
  }
}

export async function saveBlock(input: { name: string; steps: unknown[] }): Promise<BlockSummary> {
  await mkdir(blocksDir(), { recursive: true })
  const fileName = `${slugify(input.name)}.json`
  const now = new Date().toISOString()
  const previous = await readBlockFile(fileName)
  const block: BlockFile = {
    version: 1,
    name: input.name,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    steps: input.steps
  }
  await writeFile(join(blocksDir(), fileName), JSON.stringify(block, null, 2), 'utf-8')
  return { fileName, name: block.name, stepCount: block.steps.length, updatedAt: block.updatedAt }
}

export async function listBlocks(): Promise<BlockSummary[]> {
  let files: string[]
  try {
    files = await readdir(blocksDir())
  } catch {
    return [] // no blocks folder yet
  }
  const out: BlockSummary[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const b = await readBlockFile(f)
    if (b)
      out.push({ fileName: f, name: b.name, stepCount: b.steps.length, updatedAt: b.updatedAt })
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)) // newest first
}

export async function loadBlock(fileName: string): Promise<BlockFile | null> {
  return readBlockFile(fileName)
}

export async function deleteBlock(fileName: string): Promise<void> {
  try {
    await unlink(join(blocksDir(), safeSegment(fileName)))
  } catch {
    // already gone — fine
  }
}
