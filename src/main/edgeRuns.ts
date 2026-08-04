// =====================================================================
// EDGE-CASE RUN HISTORY (F20 — Option 2)
// A finished edge-case batch is negative-testing EVIDENCE: which hostile
// values the app accepted vs rejected, each with its own screenshot + run
// recording. Unlike a normal replay, it is NOT a pass/fail of the test, so it
// is stored SEPARATELY from the test's green/red run history — one JSON record
// per batch under `_edgeRuns/`, keyed by the saved test it belongs to.
//
// The per-variant recordings are ordinary traces (`_traces/<id>/`), which are
// otherwise auto-pruned to the newest N. `protectedEdgeTraceIds()` lists every
// traceId any saved edge run references so pruneTraces() never deletes them —
// the whole point of persisting a run is that its recordings stay openable.
// =====================================================================
import { join } from 'path'
import { mkdir, writeFile, readFile, readdir, rm, unlink } from 'fs/promises'
import { libraryDir } from './library'
import { traceDir, isSafeTraceId } from './trace'

// One generated variant's outcome within a batch.
export interface EdgeRunVariant {
  baseline: boolean
  fieldLabel: string
  edgeLabel: string
  group: string | null
  value: string
  hint: string
  ok: boolean
  screenshotPath?: string
  traceId?: string
  // Where this variant's flow ENDED. The verdict's automatic fallback compares
  // it against the baseline's: valid input lands on the post-login page, so a
  // variant that ends somewhere else was rejected. Absent on runs saved before
  // this existed.
  finalUrl?: string
  // The judged outcome, decided in the renderer where the full context lives
  // (the test's own check, the user's success rule, the baseline URL). Stored so
  // a re-opened run and the history summary can never disagree with the report
  // that was shown when it ran. Absent on older records — see acceptedCount.
  verdict?: 'accepted' | 'rejected' | 'unknown'
  // The variant's flattened steps (one field swapped for the hostile value) —
  // persisted so a re-opened saved run can still export its negative suite.
  steps?: unknown[]
}

// A whole batch, persisted.
export interface EdgeRunRecord {
  id: string // 'edge-<timestamp>'
  testFile: string // the saved test this belongs to (keys the per-test list)
  testName: string
  at: string // ISO timestamp
  hasAssertion: boolean // was there a success check? (drives verdict honesty)
  baselineOk: boolean
  variantCount: number
  acceptedCount: number // ⚠ variants the app accepted (bugs to review)
  results: EdgeRunVariant[]
}

// The lightweight shape the library list needs (no per-variant detail).
export interface EdgeRunSummary {
  id: string
  testFile: string
  at: string
  hasAssertion: boolean
  baselineOk: boolean
  variantCount: number
  acceptedCount: number
}

// Keep at most this many batches PER TEST — old evidence is pruned (with its
// traces + screenshots) so the folder can't grow without bound.
const PER_TEST_LIMIT = 15
const SAFE_ID = /^edge-[a-zA-Z0-9_-]+$/

function edgeRunsDir(): string {
  return join(libraryDir(), '_edgeRuns')
}

function summarize(rec: EdgeRunRecord): EdgeRunSummary {
  return {
    id: rec.id,
    testFile: rec.testFile,
    at: rec.at,
    hasAssertion: rec.hasAssertion,
    baselineOk: rec.baselineOk,
    variantCount: rec.variantCount,
    acceptedCount: rec.acceptedCount
  }
}

async function readAll(): Promise<EdgeRunRecord[]> {
  try {
    const files = (await readdir(edgeRunsDir())).filter((f) => f.endsWith('.json'))
    const out: EdgeRunRecord[] = []
    for (const f of files) {
      try {
        out.push(JSON.parse(await readFile(join(edgeRunsDir(), f), 'utf-8')) as EdgeRunRecord)
      } catch {
        // skip a corrupt record
      }
    }
    return out
  } catch {
    return [] // no dir yet
  }
}

// Delete a record's file AND the assets it owns (its variant recordings +
// failure screenshots) so pruning an old batch reclaims real disk.
async function deleteRecordAssets(rec: EdgeRunRecord): Promise<void> {
  for (const v of rec.results) {
    if (v.traceId && isSafeTraceId(v.traceId)) {
      await rm(traceDir(v.traceId), { recursive: true, force: true }).catch(() => {})
    }
    if (v.screenshotPath) {
      await unlink(v.screenshotPath).catch(() => {})
    }
  }
}

// Persist a finished batch and enforce the per-test cap.
export async function saveEdgeRun(
  input: Omit<EdgeRunRecord, 'id' | 'at' | 'variantCount' | 'acceptedCount'>
): Promise<EdgeRunSummary> {
  await mkdir(edgeRunsDir(), { recursive: true })
  const variants = input.results.filter((r) => !r.baseline)
  // Tally the verdicts the renderer already judged. The old rule here was
  // `r.ok === accepted`, which is only true when the test HAS a success check —
  // without one, `ok` just means "the steps completed", so a run where the app
  // correctly rejected all 14 hostile inputs was summarised as 14 accepted.
  // Fall back to the old rule only for records saved before verdicts existed.
  const acceptedCount = variants.some((r) => r.verdict)
    ? variants.filter((r) => r.verdict === 'accepted').length
    : input.baselineOk
      ? variants.filter((r) => r.ok).length
      : 0
  const rec: EdgeRunRecord = {
    ...input,
    id: `edge-${Date.now()}`,
    at: new Date().toISOString(),
    variantCount: variants.length,
    acceptedCount
  }
  await writeFile(join(edgeRunsDir(), `${rec.id}.json`), JSON.stringify(rec, null, 2), 'utf-8')

  // Prune older batches for THIS test beyond the cap (delete their assets too).
  const mine = (await readAll())
    .filter((r) => r.testFile === rec.testFile)
    .sort((a, b) => (a.at < b.at ? 1 : -1)) // newest first
  for (const old of mine.slice(PER_TEST_LIMIT)) {
    await deleteRecordAssets(old)
    await unlink(join(edgeRunsDir(), `${old.id}.json`)).catch(() => {})
  }
  return summarize(rec)
}

// The batches for one test, newest first — for the "🧨 Edge runs" list.
export async function listEdgeRuns(testFile: string): Promise<EdgeRunSummary[]> {
  return (await readAll())
    .filter((r) => r.testFile === testFile)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .map(summarize)
}

// The full record, to re-open the report with all its variants.
export async function loadEdgeRun(id: string): Promise<EdgeRunRecord | null> {
  if (!SAFE_ID.test(id)) return null
  try {
    return JSON.parse(await readFile(join(edgeRunsDir(), `${id}.json`), 'utf-8')) as EdgeRunRecord
  } catch {
    return null
  }
}

export async function deleteEdgeRun(id: string): Promise<void> {
  if (!SAFE_ID.test(id)) return
  const rec = await loadEdgeRun(id)
  if (rec) await deleteRecordAssets(rec)
  await unlink(join(edgeRunsDir(), `${id}.json`)).catch(() => {})
}

// Every traceId referenced by any saved edge run — pruneTraces() must never
// delete these, or a persisted batch would lose its recordings.
export async function protectedEdgeTraceIds(): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const rec of await readAll()) {
    for (const v of rec.results) {
      if (v.traceId) ids.add(v.traceId)
    }
  }
  return ids
}
