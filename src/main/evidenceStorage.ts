// =====================================================================
// EVIDENCE STORAGE — the disk half  (audit: "no explicit privacy management
// for trace/HAR/DOM/upload artifact retention")
// =====================================================================
// Sizes, deletion and after-run retention for the evidence folders. The
// decisions (which folders, what a test still needs, what a rule deletes) are
// pure and tested in src/shared/evidenceStorage.ts; this file only touches the
// disk, and is written so that it cannot touch anything else:
//
//   · the renderer sends a CATEGORY ID and a number, never a path. The folder
//     comes from the fixed table; item names come from readdir right here.
//   · every path is still resolved and checked to sit strictly inside its
//     category folder before rm() sees it (confinedPath) — belt and braces,
//     because this is the one IPC in the app whose job is deleting files.
//   · symlinks/junctions are removed as links and never followed, for sizing
//     or deletion: a junction in _uploads pointing at C:\Users must cost one
//     link, not the user's home folder.
//
// Everything is async and sequential per folder, so a library with thousands
// of traces is walked without blocking the main process' event loop.
// =====================================================================

import { lstat, readdir, rm } from 'fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { evidenceRefs, libraryDir } from './library'
import { protectedEdgeTraceIds } from './edgeRuns'
import { isSafeTraceId, pruneTraces } from './trace'
import {
  EVIDENCE_CATEGORIES,
  collectTestRefs,
  emptyRefs,
  planDeletion,
  sweptBy,
  type EvidenceCategory,
  type EvidenceCategoryId,
  type EvidenceDeleteResult,
  type EvidenceItem,
  type EvidenceRefs,
  type EvidenceUsage
} from '../shared/evidenceStorage'
import type { PrivacySettings } from '../shared/evidencePrivacy'

/**
 * `dir/name`, or null if that resolves anywhere other than STRICTLY inside
 * `dir` — the folder itself, its parent, a sibling, another drive. Exported
 * for the tests.
 */
export function confinedPath(dir: string, name: string): string | null {
  if (typeof name !== 'string' || !name || name.includes('\0')) return null
  const base = resolve(dir)
  const target = resolve(base, name)
  const rel = relative(base, target)
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null
  // Only a DIRECT child: an item is a top-level entry of its category folder,
  // and nothing this module lists is ever deeper than that.
  if (rel.includes(sep)) return null
  return target
}

/** Bytes on disk under `p`, not following links. */
async function sizeOf(p: string): Promise<number> {
  try {
    const st = await lstat(p)
    if (!st.isDirectory()) return st.size
    let total = 0
    for (const name of await readdir(p)) total += await sizeOf(join(p, name))
    return total
  } catch {
    return 0 // vanished mid-walk — not worth failing the whole screen over
  }
}

function categoryDir(cat: EvidenceCategory): string {
  return join(libraryDir(), cat.folder)
}

// A trace's age comes from its id (trace-<ms>) where it can: a library copied
// to a new machine has every mtime reset to the day of the copy, and "older
// than 30 days" must not quietly become "nothing".
function traceTime(name: string): number | null {
  const m = /^trace-(\d{10,})/.exec(name)
  return m ? Number(m[1]) : null
}

async function listItems(cat: EvidenceCategory): Promise<EvidenceItem[]> {
  const dir = categoryDir(cat)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return [] // folder not created yet — nothing stored
  }
  const out: EvidenceItem[] = []
  for (const name of names) {
    // _traces holds only our own trace-<id> folders; anything else in there
    // was not put there by a run, and is not this screen's to delete.
    if (cat.id === 'traces' && !isSafeTraceId(name)) continue
    // Same for the saved-login and edge-run folders: only the file shape the
    // app writes there is ever listed, so only that can ever be deleted.
    if (cat.only && !cat.only.test(name)) continue
    const p = confinedPath(dir, name)
    if (!p) continue
    try {
      const st = await lstat(p)
      // A saved login or edge-run record is a FILE. A folder (or a junction
      // someone made) with a matching name is not ours — skip it.
      if (cat.only && !st.isFile()) continue
      out.push({
        name,
        bytes: await sizeOf(p),
        mtimeMs: (cat.id === 'traces' && traceTime(name)) || st.mtimeMs
      })
    } catch {
      // vanished between readdir and lstat
    }
  }
  return out
}

// What the workspace that is open RIGHT NOW uses — its login, upload files,
// HAR. The library walk only sees SAVED tests, so a login picked for a
// recording that hasn't been saved yet looked unused and could be deleted out
// from under it (the next replay quietly started logged out). The renderer
// reports the open test whenever it changes; held here, not sent with each
// delete, so the automatic after-run sweep — which has no renderer in the
// loop — protects it too.
let openWorkspace: Required<EvidenceRefs> = emptyRefs()

/** The renderer's open test (saved or not). Only ever ADDS protection — a
 *  bogus value can keep a file, never cause one to be deleted. */
export function setOpenWorkspace(data: unknown): void {
  const refs = emptyRefs()
  collectTestRefs(data, refs)
  openWorkspace = refs
}

/** Only the categories that CAN hold something a test needs pay for the
 *  library walk — deleting old reports must not read 500 tests. */
async function inUseFor(ids: EvidenceCategoryId[]): Promise<Required<EvidenceRefs>> {
  const refs = ids.some(
    (id) => id === 'hars' || id === 'uploads' || id === 'failures' || id === 'sessions'
  )
    ? await evidenceRefs()
    : emptyRefs()
  for (const id of ids) {
    for (const name of openWorkspace[id]) refs[id].add(name)
  }
  if (ids.includes('traces')) {
    // A saved edge-case run replays from its recordings — the same protection
    // pruneTraces has always given them.
    for (const id of await protectedEdgeTraceIds().catch(() => new Set<string>())) {
      refs.traces.add(id)
    }
  }
  return refs
}

/** Size, count and in-use count per evidence folder, for the storage screen. */
export async function scanEvidence(): Promise<EvidenceUsage[]> {
  const refs = await inUseFor(EVIDENCE_CATEGORIES.map((c) => c.id))
  const out: EvidenceUsage[] = []
  for (const cat of EVIDENCE_CATEGORIES) {
    const items = await listItems(cat)
    out.push({
      id: cat.id,
      count: items.length,
      bytes: items.reduce((n, it) => n + it.bytes, 0),
      inUse: items.filter((it) => refs[cat.id].has(it.name)).length
    })
  }
  return out
}

/**
 * Delete evidence in one category (or 'all'), optionally only what is older
 * than `olderThanDays`. Anything a saved test or edge run still uses is kept
 * and counted. The category folders themselves are never removed — a
 * background run's report writer expects its folder to exist.
 */
export async function deleteEvidence(
  which: EvidenceCategoryId | 'all',
  olderThanDays?: number
): Promise<EvidenceDeleteResult> {
  // 'all' (the age button, and applyRetention below) never includes saved
  // logins or saved edge-case runs — see sweptBy.
  const cats = sweptBy(which)
  const result: EvidenceDeleteResult = { deleted: 0, freedBytes: 0, keptInUse: 0, failed: 0 }
  if (!cats.length) return result
  const age =
    olderThanDays === undefined || !Number.isFinite(olderThanDays)
      ? undefined
      : Math.max(0, olderThanDays)
  const refs = await inUseFor(cats.map((c) => c.id))
  const now = Date.now()
  for (const cat of cats) {
    const dir = categoryDir(cat)
    const plan = planDeletion(await listItems(cat), { olderThanDays: age }, refs[cat.id], now)
    result.keptInUse += plan.keptInUse
    for (const it of plan.delete) {
      const p = confinedPath(dir, it.name)
      if (!p) {
        result.failed++
        continue
      }
      try {
        await rm(p, { recursive: true, force: true })
        result.deleted++
        result.freedBytes += it.bytes
      } catch {
        // Locked (a video still open in a player, a report open in Excel).
        // Counted, not thrown: the rest of the sweep still happens.
        result.failed++
      }
    }
  }
  return result
}

// The age sweep reads the whole library to know what is in use, so it runs at
// most this often however many runs a suite makes — a 500-test suite must not
// walk the library 500 times.
const AGE_SWEEP_EVERY_MS = 60 * 60 * 1000
let lastAgeSweep = 0

/**
 * After a run, apply the retention policy: keep the last N traces (what the
 * hardcoded pruneTraces(40) did), then — at most hourly, and without holding
 * the run's result up — delete evidence older than the configured age.
 * Saved logins and saved edge-case runs are never swept here: 'all' excludes
 * them (sweptBy), so a policy of "30 days" can't log a test out behind the
 * user's back.
 */
export async function applyRetention(
  settings: Pick<PrivacySettings, 'keepTraces' | 'maxAgeDays'>
): Promise<void> {
  // F20 (Option 2): never prune a recording a saved edge run owns.
  await pruneTraces(settings.keepTraces, await protectedEdgeTraceIds())
  if (settings.maxAgeDays > 0 && Date.now() - lastAgeSweep > AGE_SWEEP_EVERY_MS) {
    lastAgeSweep = Date.now()
    deleteEvidence('all', settings.maxAgeDays).catch(() => {
      // retried after the next run an hour on
    })
  }
}
