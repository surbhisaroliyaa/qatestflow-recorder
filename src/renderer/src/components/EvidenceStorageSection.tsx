import React, { useEffect, useState } from 'react'
import {
  EVIDENCE_CATEGORIES,
  formatBytes,
  type EvidenceCategory
} from '../../../shared/evidenceStorage'

// =====================================================================
// EVIDENCE STORAGE — the section of the privacy screen that shows what run
// evidence is on disk and deletes it  (audit: "deletion UX should be explicit")
// =====================================================================
// Lives INSIDE the privacy screen rather than as its own modal: retention is
// half of evidence privacy (redaction limits what is written, this limits how
// long it stays), and one screen for "what happens to my evidence" is easier
// to find than two.
//
// Four things it has to get right:
//
//  1. SIZES FROM MAIN, ASYNC. A big library has thousands of trace folders;
//     main walks them without blocking, and this shows "Measuring…" meanwhile.
//
//  2. NO NATIVE CONFIRM. Electron has no usable window.confirm here, so a
//     delete uses the app's arm-then-confirm pattern (as block delete does):
//     the first click arms the button and says exactly what will go, a second
//     click within a few seconds does it, and it disarms itself otherwise.
//
//  3. SAY WHAT WAS KEPT. Files a saved test needs (an upload fixture, a HAR it
//     replays from, the login it starts from) are never deleted. Deleting
//     "everything" and then quietly leaving files behind reads as a bug, so the
//     result says how many were kept, and why.
//
//  4. SAVED ≠ EVIDENCE. Saved logins and saved edge-case runs get rows here so
//     they CAN be deleted, but in their own table below the age rule, because
//     no age rule ever touches them (manualOnly — see shared/evidenceStorage).
//     Redaction settings above don't apply to them either; this is storage only.
// =====================================================================

interface Usage {
  id: string
  count: number
  bytes: number
  inUse: number
}

const ARM_MS = 6000

export interface EvidenceStorageSectionProps {
  /** After any delete: the app re-reads its saved-login list and the loaded
   *  test's edge-run list, so neither offers something that is now gone. */
  onDeleted?: () => void
}

export function EvidenceStorageSection({
  onDeleted
}: EvidenceStorageSectionProps = {}): React.JSX.Element {
  const [usage, setUsage] = useState<Usage[] | null>(null)
  const [busy, setBusy] = useState(false)
  // Which delete is armed: a category id, or 'age' for "older than N days".
  const [armed, setArmed] = useState<string | null>(null)
  const [days, setDays] = useState('30')
  const [message, setMessage] = useState<string | null>(null)

  const rescan = async (): Promise<void> => {
    try {
      setUsage(await window.api.evidence.scan())
    } catch {
      setUsage([])
    }
  }

  // Measured once when the screen opens. `live` stops a slow scan of a big
  // library from writing into a screen that has already been closed.
  useEffect(() => {
    let live = true
    window.api.evidence
      .scan()
      .then((u) => live && setUsage(u))
      .catch(() => live && setUsage([]))
    return () => {
      live = false
    }
  }, [])

  const arm = (key: string): void => {
    setArmed(key)
    setTimeout(() => setArmed((cur) => (cur === key ? null : cur)), ARM_MS)
  }

  const run = async (which: string, olderThanDays?: number): Promise<void> => {
    setArmed(null)
    setBusy(true)
    setMessage(null)
    try {
      const r = await window.api.evidence.delete(which, olderThanDays)
      const parts = [`Deleted ${r.deleted} item${r.deleted === 1 ? '' : 's'}`]
      if (r.freedBytes) parts[0] += `, freed ${formatBytes(r.freedBytes)}`
      if (r.keptInUse) {
        parts.push(
          `${r.keptInUse} kept because a saved test uses ${r.keptInUse === 1 ? 'it' : 'them'}`
        )
      }
      if (r.failed) {
        parts.push(`${r.failed} couldn’t be removed (open in another program?)`)
      }
      setMessage(parts.join(' · ') + '.')
    } catch {
      setMessage('Delete failed — nothing was reported back.')
    } finally {
      setBusy(false)
      onDeleted?.()
      await rescan()
    }
  }

  const dayCount = Math.round(Number(days))
  const daysValid = Number.isFinite(dayCount) && dayCount >= 1

  const evidenceCats = EVIDENCE_CATEGORIES.filter((c) => !c.manualOnly)
  const savedCats = EVIDENCE_CATEGORIES.filter((c) => c.manualOnly)
  const bytesOf = (cats: EvidenceCategory[]): number =>
    (usage ?? []).filter((u) => cats.some((c) => c.id === u.id)).reduce((n, u) => n + u.bytes, 0)
  // The age button only reaches run evidence, so only run evidence decides
  // whether it has anything to do.
  const evidenceBytes = bytesOf(evidenceCats)
  const totalBytes = bytesOf(EVIDENCE_CATEGORIES)

  const table = (cats: EvidenceCategory[]): React.JSX.Element => (
    <table className="evidence-table">
      <tbody>
        {cats.map((cat) => {
          const u = usage?.find((x) => x.id === cat.id)
          const count = u?.count ?? 0
          const deletable = count - (u?.inUse ?? 0)
          return (
            <tr key={cat.id}>
              <td>
                <strong>{cat.label}</strong>
                <br />
                <span className="privacy-hint">{cat.hint}</span>
              </td>
              <td className="evidence-num">
                {count} item{count === 1 ? '' : 's'}
                {u?.inUse ? (
                  <>
                    <br />
                    <span className="privacy-hint">{u.inUse} in use by tests</span>
                  </>
                ) : null}
              </td>
              <td className="evidence-num">{formatBytes(u?.bytes ?? 0)}</td>
              <td className="evidence-act">
                <button
                  className="modal-btn danger"
                  disabled={busy || deletable <= 0}
                  onClick={() => (armed === cat.id ? run(cat.id) : arm(cat.id))}
                >
                  {armed === cat.id ? `Delete ${deletable}? Click again` : 'Delete…'}
                </button>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )

  return (
    <div className="evidence-storage">
      <div className="privacy-label">Evidence storage</div>
      <p className="privacy-hint">
        What past runs have left in your Tests folder. Deleting happens straight away and can’t be
        undone — Cancel below doesn’t bring anything back. Files a saved test needs to run (upload
        files, network captures it replays from) are always kept.
      </p>

      {usage === null ? <p className="privacy-hint">Measuring…</p> : table(evidenceCats)}

      {/* Sits between the two tables on purpose: it belongs to the run
          evidence above, and never to the saved things below. */}
      <div className="evidence-age">
        <span>Delete run evidence older than</span>
        <input
          type="number"
          min={1}
          className="evidence-days"
          value={days}
          onChange={(e) => setDays(e.target.value)}
          aria-label="Days"
        />
        <span>days</span>
        <button
          className="modal-btn danger"
          disabled={busy || !daysValid || !usage || evidenceBytes === 0}
          onClick={() => (armed === 'age' ? run('all', dayCount) : arm('age'))}
        >
          {armed === 'age' ? 'Sure? Click again to delete' : 'Delete…'}
        </button>
      </div>

      <div className="privacy-label">Saved logins and edge-case runs</div>
      <p className="privacy-hint">
        Not run evidence — things you chose to keep. Each is deleted only when you press its own
        Delete… here; the age rule above and the clean-up after runs never touch them. A login a
        saved test starts from is always kept.
      </p>
      {usage === null ? null : table(savedCats)}

      {usage && <p className="privacy-hint">Total: {formatBytes(totalBytes)}</p>}
      {busy && <p className="privacy-hint">Deleting…</p>}
      {message && <p className="privacy-summary">{message}</p>}
    </div>
  )
}
