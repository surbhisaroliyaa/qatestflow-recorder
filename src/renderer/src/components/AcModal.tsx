import React from 'react'

// =====================================================================
// AcModal — lifted out of App.tsx verbatim.
//
// Props are destructured under the names the markup already used, so the move
// cannot change behaviour by renaming. Types were inferred from each value's
// declaration in App.tsx and then checked by tsc, which is the actual authority.
// =====================================================================

export interface AcModalProps {
  acBusy: boolean
  acFailed: boolean
  acOpen: boolean
  acResult: { ac: string; tests: string[] }[] | null
  acText: string
  closeAcChecklist: () => void
  handleMatchAcs: () => Promise<void>
  savedTests: SavedTestSummary[]
  setAcText: React.Dispatch<React.SetStateAction<string>>
}

export function AcModal({
  acBusy,
  acFailed,
  acOpen,
  acResult,
  acText,
  closeAcChecklist,
  handleMatchAcs,
  savedTests,
  setAcText
}: AcModalProps): React.JSX.Element | null {
  if (!(acOpen)) return null
  return (
    <div className="modal-backdrop" onClick={closeAcChecklist}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">✅ AC checklist — which tests cover each requirement</span>
          <button className="modal-close" onClick={closeAcChecklist} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="ac-body">
          <label className="api-field">
            <span>Acceptance criteria — one per line</span>
            <textarea
              className="api-body"
              rows={5}
              placeholder={
                'e.g. A user can log in with valid credentials\nInvalid login shows an error message\nThe cart shows the number of items added'
              }
              value={acText}
              onChange={(e) => setAcText(e.target.value)}
            />
          </label>
          <p className="api-hint">
            The AI reads your {savedTests.length} saved test{savedTests.length === 1 ? '' : 's'} and
            marks which cover each criterion — an <strong>uncovered AC is a real coverage gap</strong>.
            It judges coverage (needs the Claude CLI), so sanity-check the matches. Your criteria are
            saved between sessions.
          </p>
          {acFailed && (
            <p className="api-hint" style={{ color: '#f0b232' }}>
              ⚠ The AI is unavailable (needs the Claude CLI). Try again.
            </p>
          )}
          {acResult &&
            (() => {
              const covered = acResult.filter((r) => r.tests.length).length
              const gaps = acResult.length - covered
              return (
                <div className="ac-results">
                  <div className="ac-summary">
                    {covered} of {acResult.length} covered
                    {gaps > 0 ? ` · ${gaps} gap${gaps === 1 ? '' : 's'} ⚠` : ' · full coverage ✓'}
                  </div>
                  <ul className="ac-list">
                    {acResult.map((r, i) => (
                      <li key={i} className={`ac-row ${r.tests.length ? 'covered' : 'uncovered'}`}>
                        <span className="ac-mark">{r.tests.length ? '✓' : '⚠'}</span>
                        <span className="ac-text">{r.ac}</span>
                        <span className="ac-tests">
                          {r.tests.length
                            ? `covered by ${r.tests.join(', ')}`
                            : 'NOT covered by any test'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })()}
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={closeAcChecklist}>
            Close
          </button>
          <button
            className="modal-btn primary"
            onClick={handleMatchAcs}
            disabled={acBusy || !acText.trim()}
          >
            {acBusy ? 'Matching…' : '🤖 Match to tests'}
          </button>
        </div>
      </div>
    </div>
  )
}
