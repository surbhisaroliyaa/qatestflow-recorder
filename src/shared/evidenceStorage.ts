// =====================================================================
// EVIDENCE STORAGE — what is on disk, and what may be deleted  (audit:
// "no explicit privacy management for trace/HAR/DOM/upload retention")
// =====================================================================
// Every run leaves files behind in the library folder: traces (with their
// videos), failure images, network captures, uploaded fixtures, reports.
// Before this, only traces were ever pruned, and there was no way to see how
// much was there or to delete it short of opening Explorer on a folder whose
// name starts with an underscore.
//
// This file is the PURE half — which folders count as evidence, what a saved
// test still needs, and what a given rule would delete. It has no fs and no
// Electron, so the part that decides what gets DELETED is the part that is
// unit-tested. The disk half is src/main/evidenceStorage.ts.
//
// == The one rule that matters ==
//
// Never delete a file a saved test needs to run. An upload fixture, a HAR a
// test replays from, a saved session: those are not evidence of a past run,
// they are inputs to the next one, and deleting them breaks the test the next
// time anyone opens it — silently, possibly weeks later. So "what is still
// referenced" is computed from the library itself, and anything in it is kept
// and COUNTED, so the screen can say why it didn't delete them.
//
// Deliberately NOT categories here (never touched by this feature):
//   _baselines — visual baselines are the EXPECTED picture, not evidence
//   _blocks, _drafts, _backups — the user's own work
//
// == Saved logins and saved edge-case runs: listed, but MANUAL ONLY ==
//
// `_sessions` and `_edgeRuns` are not run evidence — one is a login the user
// chose to keep, the other a result they chose to keep — but they sit on disk,
// they grow, and a saved login is a live cookie jar the user may want gone. So
// each gets a row and a Delete… button, and nothing else: `manualOnly` keeps
// them out of "Delete everything older than N days" AND out of the automatic
// after-run sweep. An age rule that quietly logs every "starts logged in" test
// out, or throws away last month's negative-testing verdicts, is not what
// anyone means by "clean up old evidence" — and they would only find out when
// a test bounced to the login page. See sweptBy().
// =====================================================================

import { portableBasename } from './portablePath'

export type EvidenceCategoryId =
  | 'traces'
  | 'failures'
  | 'hars'
  | 'uploads'
  | 'reports'
  | 'downloads'
  | 'nlchecks'
  | 'sessions'
  | 'edgeRuns'

export interface EvidenceCategory {
  id: EvidenceCategoryId
  /** The folder under the library root. Fixed here, never taken from IPC. */
  folder: string
  label: string
  hint: string
  /** Only entries whose name matches are listed (and so deletable). For
   *  folders the app writes one known file shape into — anything else in there
   *  was not put there by us, and is not this screen's to delete. */
  only?: RegExp
  /** Deleted only by this row's own Delete… button — never by an age rule,
   *  manual or automatic. For things the user saved, not things a run left. */
  manualOnly?: boolean
}

export const EVIDENCE_CATEGORIES: EvidenceCategory[] = [
  {
    id: 'traces',
    folder: '_traces',
    label: 'Run recordings',
    hint: 'Screenshots, page HTML, console, network and video of each run'
  },
  {
    id: 'failures',
    folder: '_failures',
    label: 'Failure images',
    hint: 'Failure screenshots and visual-check differences'
  },
  {
    id: 'hars',
    folder: '_hars',
    label: 'Network captures (HAR)',
    hint: 'Recorded API traffic, including response bodies'
  },
  {
    id: 'uploads',
    folder: '_uploads',
    label: 'Upload files',
    hint: 'Copies of files picked for upload steps'
  },
  { id: 'reports', folder: '_reports', label: 'Reports', hint: 'Background-run reports' },
  {
    id: 'downloads',
    folder: '_downloads',
    label: 'Downloads',
    hint: 'Files the site downloaded during runs'
  },
  {
    id: 'nlchecks',
    folder: '_nlchecks',
    label: 'AI-check screenshots',
    hint: 'Left behind if a run stopped mid-check'
  },
  {
    id: 'sessions',
    folder: '_sessions',
    label: 'Saved logins',
    hint:
      'Logins saved for tests that start logged in — they hold your cookies. ' +
      'Only deleted when you press Delete here, never by age.',
    // session:save writes `<slug>.json`, and session:list shows only .json.
    only: /\.json$/i,
    manualOnly: true
  },
  {
    id: 'edgeRuns',
    folder: '_edgeRuns',
    label: 'Saved edge-case runs',
    hint:
      'Results of past edge-case batches. Only deleted when you press Delete here, ' +
      'never by age. Their recordings then count as ordinary run recordings.',
    // edgeRuns.ts names every record `edge-<id>.json` (its SAFE_ID).
    only: /^edge-[a-zA-Z0-9_-]+\.json$/,
    manualOnly: true
  }
]

/**
 * The categories one delete request covers. A single category's Delete…
 * covers exactly that category. 'all' — sent only by the "older than N days"
 * button and the automatic after-run sweep — covers every category EXCEPT the
 * manual-only ones, so no age rule can ever reach a saved login or a saved
 * edge-case run.
 */
export function sweptBy(
  which: EvidenceCategoryId | 'all',
  cats: EvidenceCategory[] = EVIDENCE_CATEGORIES
): EvidenceCategory[] {
  return which === 'all' ? cats.filter((c) => !c.manualOnly) : cats.filter((c) => c.id === which)
}

export function isEvidenceCategory(id: unknown): id is EvidenceCategoryId {
  return EVIDENCE_CATEGORIES.some((c) => c.id === id)
}

/** One top-level entry in an evidence folder: a file, or (for traces) a
 *  whole run's folder, video included. */
export interface EvidenceItem {
  name: string
  bytes: number
  mtimeMs: number
}

/** Per category, the entry names that must never be deleted. */
export type EvidenceRefs = Partial<Record<EvidenceCategoryId, Set<string>>>

export function emptyRefs(): Required<EvidenceRefs> {
  return {
    traces: new Set(),
    failures: new Set(),
    hars: new Set(),
    uploads: new Set(),
    reports: new Set(),
    downloads: new Set(),
    nlchecks: new Set(),
    sessions: new Set(),
    // Nothing on disk points AT an edge-run record (the record points at its
    // test), so this stays empty: a saved edge run is never "in use", only
    // deleted when asked.
    edgeRuns: new Set()
  }
}

/** Upload steps' fixture file names. An upload step's value is one path per
 *  line (a multi-file pick), so every line counts — taking only the last
 *  would keep one file of a three-file upload and delete the other two. */
function collectUploads(steps: unknown, into: Set<string>): void {
  if (!Array.isArray(steps)) return
  for (const raw of steps) {
    const s = raw as Record<string, unknown> | null
    if (s?.type !== 'upload' || typeof s.value !== 'string') continue
    for (const line of s.value.split('\n')) {
      const name = portableBasename(line.trim())
      if (name) into.add(name)
    }
  }
}

/**
 * Add what ONE saved test (or draft, block, backup — anything shaped like
 * one) needs on disk to `into`.
 *
 * Over-inclusive on purpose: being wrong in the "keep" direction costs some
 * disk, being wrong in the other breaks a test. So version history counts (a
 * rollback must still find its fixture), and so does every data-table cell —
 * an upload step whose value is a {{token}} gets its file name from the
 * table, and this can't know which column that is.
 */
export function collectTestRefs(data: unknown, into: Required<EvidenceRefs>): void {
  if (!data || typeof data !== 'object') return
  const t = data as Record<string, unknown>
  if (typeof t.har === 'string' && t.har) into.hars.add(t.har)
  // The saved login a "starts logged in" test seeds from — a bare file name in
  // _sessions. Any test, draft or backup naming it keeps it: deleting it would
  // bounce that test to the login page on its next run. (A monitor runs a
  // saved test, so it is covered by that test's own field.)
  if (typeof t.storageState === 'string' && t.storageState) {
    const name = portableBasename(t.storageState)
    if (name) into.sessions.add(name)
  }
  // The LAST run's failure screenshot is what the library card shows; deleting
  // it leaves a broken thumbnail on a red test. Older runs' images are history
  // nobody is looking at, so they stay deletable — protecting all of them would
  // make "Delete failure images" free almost nothing on a busy library.
  const last = t.lastRun as { screenshotPath?: unknown } | undefined
  if (typeof last?.screenshotPath === 'string' && last.screenshotPath) {
    const name = portableBasename(last.screenshotPath)
    if (name) into.failures.add(name)
  }
  collectUploads(t.steps, into.uploads)
  for (const v of Array.isArray(t.versions) ? t.versions : []) {
    collectUploads((v as { steps?: unknown } | null)?.steps, into.uploads)
  }
  for (const row of Array.isArray(t.dataRows) ? t.dataRows : []) {
    for (const cell of Object.values((row as Record<string, unknown>) ?? {})) {
      if (typeof cell === 'string' && cell) {
        for (const line of cell.split('\n')) {
          const name = portableBasename(line.trim())
          if (name) into.uploads.add(name)
        }
      }
    }
  }
}

export interface DeleteRule {
  /** Delete only items last changed more than this many days ago. Absent =
   *  every item in the category (the "Delete…" button). */
  olderThanDays?: number
}

export interface DeletePlan {
  delete: EvidenceItem[]
  /** Would have been deleted, but a saved test (or edge run) uses it. */
  keptInUse: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Which items a rule deletes. Pure, so the decision that removes files is the
 * part that is tested without a disk.
 *
 * `keptInUse` counts only referenced items the rule would otherwise have
 * taken — "3 kept because a test uses them" must not count a fixture that was
 * never old enough to be at risk.
 */
export function planDeletion(
  items: EvidenceItem[],
  rule: DeleteRule,
  inUse: Set<string> | undefined,
  now: number
): DeletePlan {
  const cutoff = rule.olderThanDays === undefined ? Infinity : now - rule.olderThanDays * DAY_MS
  const out: EvidenceItem[] = []
  let keptInUse = 0
  for (const it of items) {
    if (!(it.mtimeMs < cutoff)) continue
    if (inUse?.has(it.name)) keptInUse++
    else out.push(it)
  }
  return { delete: out, keptInUse }
}

/**
 * The "keep the last N run recordings" rule — what pruneTraces deletes.
 *
 * Trace ids are `trace-<timestamp>`, so their names sort oldest-first; the
 * name is used rather than the folder's modified time because copying a
 * library to a new machine resets every mtime to the day of the copy.
 * Protected ids (a saved edge run owns them) are left out BEFORE counting, so
 * protecting old evidence never evicts a fresh run's trace.
 */
export function tracesBeyondKeep(
  ids: string[],
  keep: number,
  protectedIds?: Set<string>
): string[] {
  const prunable = [...ids].sort().filter((id) => !protectedIds?.has(id))
  return prunable.slice(0, Math.max(0, prunable.length - Math.max(0, keep)))
}

/** What the storage screen shows for one category. */
export interface EvidenceUsage {
  id: EvidenceCategoryId
  count: number
  bytes: number
  /** Items a saved test needs — never deleted from this screen. */
  inUse: number
}

export interface EvidenceDeleteResult {
  deleted: number
  freedBytes: number
  keptInUse: number
  /** Items that could not be removed (locked by another program, etc). */
  failed: number
}

/** "12.4 MB" — for the storage screen. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}
