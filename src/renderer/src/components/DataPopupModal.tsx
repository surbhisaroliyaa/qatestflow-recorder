import React from 'react'
import type { DataRunEntry } from '../runTypes'

// =====================================================================
// DataPopupModal — lifted out of App.tsx verbatim.
//
// Was an inline {cond && (…)} block inside the workspace return. Props are
// destructured under the names the markup already used; the open condition is
// re-expressed as an early return, because a component that simply returns the
// JSX would render ALWAYS.
// =====================================================================

export interface DataPopupModalProps {
  dataPopupOpen: unknown
  dataRun: {
total: number
current: number
currentLabel: string
results: DataRunEntry[]
running: boolean
} | null
  setDataPopupDismissed: React.Dispatch<React.SetStateAction<boolean>>
}

export function DataPopupModal({
  dataPopupOpen,
  dataRun,
  setDataPopupDismissed
}: DataPopupModalProps): React.JSX.Element | null {
  if (!(dataPopupOpen && dataRun)) return null
  return (
        <div className="modal-backdrop" onClick={() => setDataPopupDismissed(true)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">
                Data run: {dataRun.results.filter((r) => r.status === 'passed').length} passed,{' '}
                {dataRun.results.filter((r) => r.status === 'failed').length} failed
              </span>
              <button
                className="modal-close"
                onClick={() => setDataPopupDismissed(true)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <ul className="suite-summary">
              {dataRun.results.map((r, ri) => (
                <li key={ri} className="suite-result">
                  <span className={`run-dot ${r.status}`} />
                  <span className="suite-result-name">{r.label}</span>
                  {r.status === 'failed' && (
                    // title: the CSS clamps at 5 lines, so a genuinely enormous error is
                    // still recoverable on hover rather than lost.
                    <span
                      className="suite-result-error"
                      title={`${r.failedAt !== undefined ? `step ${r.failedAt + 1} — ` : ''}${r.error ?? ''}`}
                    >
                      {r.failedAt !== undefined ? `step ${r.failedAt + 1} — ` : ''}
                      {r.error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <div className="modal-footer">
              <span className="data-popup-hint">
                Screenshots, recordings &amp; explanations are in the panel tabs.
              </span>
              <button className="modal-btn primary" onClick={() => setDataPopupDismissed(true)}>
                Close
              </button>
            </div>
          </div>
        </div>
  )
}
