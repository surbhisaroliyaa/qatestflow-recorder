import React from 'react'
import { diffSteps, diffCounts } from '../stepDiff'

// =====================================================================
// HistoryModal — lifted out of App.tsx verbatim.
//
// Was an inline {cond && (…)} block inside the workspace return. Props are
// destructured under the names the markup already used; the open condition is
// re-expressed as an early return, because a component that simply returns the
// JSX would render ALWAYS.
// =====================================================================

export interface HistoryModalProps {
  handleRestoreVersion: () => void
  historyIdx: number
  historyOpen: boolean
  setHistoryIdx: React.Dispatch<React.SetStateAction<number>>
  setHistoryOpen: React.Dispatch<React.SetStateAction<boolean>>
  steps: RecorderStep[]
  testName: string
  testVersions: TestVersion[]
}

export function HistoryModal({
  handleRestoreVersion,
  historyIdx,
  historyOpen,
  setHistoryIdx,
  setHistoryOpen,
  steps,
  testName,
  testVersions
}: HistoryModalProps): React.JSX.Element | null {
  if (!(historyOpen)) return null
  return (
        <div className="modal-backdrop" onClick={() => setHistoryOpen(false)}>
          <div className="history-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">🕘 Version history — {testName || 'this test'}</span>
              <button
                className="modal-close"
                onClick={() => setHistoryOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="history-body">
              <div className="history-versions">
                {testVersions.map((v, vi) => {
                  const c = diffCounts(v.steps as RecorderStep[], steps)
                  return (
                    <button
                      key={vi}
                      className={`history-version${vi === historyIdx ? ' active' : ''}`}
                      onClick={() => setHistoryIdx(vi)}
                    >
                      <span className="history-version-when">
                        {vi === 0 ? 'Previous edit' : `Edit −${vi}`} ·{' '}
                        {new Date(v.at).toLocaleString()}
                      </span>
                      <span className="history-version-counts">
                        {(v.steps as RecorderStep[]).length} steps
                        {c.added > 0 && <span className="diff-add"> +{c.added}</span>}
                        {c.removed > 0 && <span className="diff-del"> −{c.removed}</span>}
                      </span>
                    </button>
                  )
                })}
              </div>
              <div className="history-diff">
                <div className="history-diff-head">
                  This version → <strong>current</strong> (green = added since, red = removed)
                </div>
                {testVersions[historyIdx] &&
                  diffSteps(testVersions[historyIdx].steps as RecorderStep[], steps).map(
                    (line, li) => (
                      <div key={li} className={`diff-line ${line.kind}`}>
                        <span className="diff-mark">
                          {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                        </span>
                        {line.text}
                      </div>
                    )
                  )}
              </div>
            </div>
            <div className="modal-footer">
              <button className="modal-btn" onClick={() => setHistoryOpen(false)}>
                Close
              </button>
              <button
                className="modal-btn primary"
                onClick={handleRestoreVersion}
                title="Replace the current steps with this version (your current steps are saved as a new version when you next save)"
              >
                ↩ Restore this version
              </button>
            </div>
          </div>
        </div>
  )
}
