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
// F40: keeps plaintext passwords out of the shared/committed test files.
import { stripSecrets, stripDataRows, refsByStepId, SECRETS_FILE_VERSION } from './secrets'
import { secretCellRef } from '../shared/secretCells'
// QF-001: repair checkbox steps recorded before the canonical `check` step.
import { migrateLegacyCheckSteps, type LegacyStep } from '../shared/legacyCheckSteps'

// Outcome of one replay — gives the library list its green/red
// "mini CI dashboard" dots.
export interface RunInfo {
  status: 'passed' | 'failed'
  at: string // ISO timestamp
  failedAt?: number // step index of the first failure
  error?: string
  screenshotPath?: string // page capture at the failing step (Day 11.5)
  // F9 (Stage 2): the finer failure category (stale-selector / stale-data / …),
  // stamped automatically on every failed run so the suite-wide breakdown can
  // count failures by type. Absent on passes and on older runs.
  category?: string
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
  // F36: which DEVICE profile that viewport came from — carries the UA, touch
  // and pixel-density signals a bare width×height can't. Stored alongside (not
  // instead of) `viewport`, so a test saved before F36 — and an older build of
  // the app reading a newer file — still gets the right size.
  deviceId?: string
  // F38: cross-cutting labels (@smoke, @regression). A test has ONE suite but
  // MANY tags — that is the whole difference between them.
  tags?: string[]
  // Day 20 (data-driven): the table of rows this test runs against. Each row is
  // a { column: value } map; columns are derived from the {{tokens}} in steps.
  dataRows?: Record<string, string>[]
  // F1 (HAR): a captured network archive in _hars/ (bare filename, like
  // storageState). When set, replay serves matched responses from it.
  har?: string
  // F12: previous edits of this test (newest first, capped) — snapshotted on
  // save whenever the steps change, so you can see the history and roll back.
  versions?: TestVersion[]
  // Set once the secret sweep has run over this file (see
  // SECRETS_FILE_VERSION in secrets.ts) — stops a one-time repair re-running.
  secretsVersion?: number
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
  // F38: cross-cutting labels (@smoke, @regression, @checkout). Deliberately in
  // the SUMMARY, not just the test file — the library filters and "Run all
  // @smoke" would otherwise have to open every test on disk to know its tags,
  // which is exactly the thing that stops scaling at 500 tests.
  tags?: string[]
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
export function safeSegment(segment: string): string {
  const clean = segment.replace(/[\\/:*?"<>|]/g, '').trim()
  return clean === '..' || clean === '.' ? '' : clean
}

// A relative path arriving over IPC: at most "suite/file.json". Each segment
// sanitised independently, then rejoined.
export function safeRel(relPath: string): string {
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
export function stepStats(steps: unknown[]): { assertCount: number; selectorHealth?: number } {
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
    tags: test.tags, // F38
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
    // QF-001: every saved test enters the app through here, so this is the one
    // place a pre-fix checkbox recording can be repaired for ALL of them at once
    // — the step list, replay, export, suites, monitors and bundles alike.
    //
    // Read-time, not write-time: the file on disk is left exactly as the user
    // saved it until they save again, so a migration that ever guessed wrong
    // costs them nothing permanent.
    parsed.steps = migrateLegacyCheckSteps(parsed.steps as LegacyStep[]).steps
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
export function harNameForFile(fileName: string): string {
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
  deviceId?: string // F36
  tags?: string[] // F38
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
  // F40: the choke point. Every save comes through here, so this is the one
  // place that can guarantee no password is ever written into a test file. The
  // value moves to the userData secret store and the step keeps only a ref.
  // Done BEFORE the version snapshot below, so history holds the safe form too.
  const safeSteps = await stripSecrets(input.steps)
  // …and the data table's sensitive cells, the same way (Option A, 2026-09-18).
  const safeRows = await stripDataRows(input.dataRows)

  // F12: if the STEPS actually changed vs the last save, snapshot the previous
  // steps as a version (so you can see what changed and roll back). Re-saving
  // without touching the steps (e.g. a rename) doesn't add a version.
  let versions = previous?.versions
  if (previous && JSON.stringify(previous.steps) !== JSON.stringify(safeSteps)) {
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
    deviceId: input.deviceId,
    tags: input.tags,
    dataRows: safeRows,
    har,
    versions,
    // Saved by a build that already protects secrets, so the one-time by-name
    // repair must never run over it — it would re-mask a deliberate unmask.
    secretsVersion: SECRETS_FILE_VERSION,
    steps: safeSteps // F40: never the plaintext form
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
  const relPaths = await listTestPaths()
  const summaries: SavedTestSummary[] = []
  for (const fileName of relPaths) {
    const test = await readTestFile(fileName)
    if (test) summaries.push(toSummary(fileName, test))
  }
  return summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

/** Every test file path in the library, relative to its folder. */
async function listTestPaths(): Promise<string[]> {
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
  return relPaths
}

/**
 * Every secret reference still reachable from anything on disk (QF-003).
 *
 * This is the "live set" for garbage-collecting the secret store, so being
 * wrong in one direction is very different from being wrong in the other:
 * missing a ref DELETES a password the user still needs, while including a
 * dead one merely delays a cleanup. So it reads everything that can hold a
 * step — and that includes:
 *
 *   · VERSION HISTORY. F12 keeps previous edits so you can roll back, and
 *     those snapshots carry their own secretRefs. Collecting only the current
 *     steps would quietly break every rollback to a version with a login in it.
 *   · reusable blocks, which are steps too
 *   · auto-saved drafts, which are a recording the user has not saved yet —
 *     the most painful thing to break, because it is unrecoverable
 */
export async function allSecretRefs(): Promise<string[]> {
  const refs = new Set<string>()
  const collect = (steps: unknown): void => {
    if (!Array.isArray(steps)) return
    for (const raw of steps) {
      const ref = (raw as Record<string, unknown> | null)?.secretRef
      if (typeof ref === 'string' && ref) refs.add(ref)
    }
  }
  // A sensitive data cell holds `{{secret:ref}}` — a ref like any other.
  const collectRows = (rows: unknown): void => {
    if (!Array.isArray(rows)) return
    for (const row of rows) {
      for (const cell of Object.values((row as Record<string, unknown>) ?? {})) {
        const ref = secretCellRef(cell)
        if (ref) refs.add(ref)
      }
    }
  }
  const collectFile = (data: Record<string, unknown> | null | undefined): void => {
    if (!data) return
    collect(data.steps)
    collectRows(data.dataRows)
    for (const version of (data.versions as { steps?: unknown }[] | undefined) ?? []) {
      collect(version?.steps)
    }
  }

  for (const file of await listTestPaths()) {
    collectFile((await readTestFile(file)) as unknown as Record<string, unknown> | null)
  }

  for (const block of await listBlocks()) {
    const b = await readBlockFile(block.fileName)
    if (b) collect(b.steps)
  }

  for (const draft of await listDrafts()) {
    collectFile((await loadDraft(draft.id)) as unknown as Record<string, unknown> | null)
  }

  // BACKUPS. Their passwords were moved into the store under refs the backup
  // now carries (scrubBackups). Restoring one must get its password back, so
  // those refs are live for as long as the backup exists.
  for (const file of await backupJsonFiles()) {
    try {
      collectFile(JSON.parse(await readFile(file, 'utf-8')))
    } catch {
      // not JSON — carries no refs
    }
  }

  // EDGE RUNS. Each saved variant keeps its steps, login included, so "replay
  // just these" needs those refs alive. Read directly rather than through
  // edgeRuns.ts, which imports this module.
  for (const file of await backupJsonFiles(join(libraryDir(), '_edgeRuns'))) {
    try {
      const rec = JSON.parse(await readFile(file, 'utf-8')) as { results?: { steps?: unknown }[] }
      for (const r of rec.results ?? []) collect(r?.steps)
    } catch {
      // not JSON — carries no refs
    }
  }

  return [...refs]
}

async function backupJsonFiles(dir = join(libraryDir(), '_backups')): Promise<string[]> {
  let entries: import('fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await backupJsonFiles(p)))
    else if (e.isFile() && e.name.endsWith('.json')) out.push(p)
  }
  return out
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
  deviceId?: string // F36
  tags?: string[] // F38
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
  deviceId?: string // F36
  tags?: string[] // F38
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
    deviceId: input.deviceId,
    tags: input.tags,
    // A draft is auto-saved every few seconds DURING a recording — so a login
    // you just typed sat in _drafts/ in plaintext until you saved the test.
    // It goes through the same stripping as a saved test. The renderer never
    // learns the ref, so reuse the one the previous autosave minted for the
    // same step, or every autosave would add a new entry to the store.
    dataRows: await stripDataRows(input.dataRows),
    updatedAt: new Date().toISOString(),
    steps: await stripSecrets(input.steps, {
      refsById: refsByStepId((await loadDraft(input.id))?.steps)
    })
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
    // QF-001: an auto-saved draft from before the fix carries the same broken
    // checkbox pair — resuming one must not reintroduce it.
    d.steps = migrateLegacyCheckSteps(d.steps as LegacyStep[]).steps
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
    // QF-001: a reusable block is steps too, and a legacy checkbox inside one
    // would otherwise be copied into every test that references it.
    parsed.steps = migrateLegacyCheckSteps(parsed.steps as LegacyStep[]).steps
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
    // A block made from a login would otherwise carry its password in plaintext.
    steps: (await stripSecrets(input.steps, {
      refsById: refsByStepId(previous?.steps)
    })) as unknown[]
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
