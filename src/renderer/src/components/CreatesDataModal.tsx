import React from 'react'

// =====================================================================
// CreatesDataModal — lifted out of App.tsx verbatim.
//
// Props are destructured under the names the markup already used, so the move
// cannot change behaviour by renaming. Types were inferred from each value's
// declaration in App.tsx and then checked by tsc, which is the actual authority.
// =====================================================================

export interface CreatesDataModalProps {
  createsDataDraft: string
  createsDataIndex: number | null
  handleSaveCreatesData: () => void
  setCreatesDataDraft: React.Dispatch<React.SetStateAction<string>>
  setCreatesDataIndex: React.Dispatch<React.SetStateAction<number | null>>
}

export function CreatesDataModal({
  createsDataDraft,
  createsDataIndex,
  handleSaveCreatesData,
  setCreatesDataDraft,
  setCreatesDataIndex
}: CreatesDataModalProps): React.JSX.Element | null {
  if (!(createsDataIndex !== null)) return null
  return (
    <div className="modal-backdrop" onClick={() => setCreatesDataIndex(null)}>
      <div className="modal api-editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">🗃️ What does this step create?</span>
          <button
            className="modal-close"
            onClick={() => setCreatesDataIndex(null)}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="api-editor-body">
          <label className="api-field">
            <span>Data created by this step</span>
            <input
              type="text"
              placeholder='e.g. "user account", "order"'
              value={createsDataDraft}
              onChange={(e) => setCreatesDataDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveCreatesData()
                if (e.key === 'Escape') setCreatesDataIndex(null)
              }}
              autoFocus
            />
          </label>
          <p className="api-hint">
            Tracked so a suite can flag it if nothing cleans it up. A test that creates data but has
            no 🧹 teardown step is an orphan — its records pile up in the environment run after run,
            and eventually a later run fails on data its own suite left behind.
          </p>
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={() => setCreatesDataIndex(null)}>
            Cancel
          </button>
          <button
            className="modal-btn primary"
            onClick={handleSaveCreatesData}
            disabled={!createsDataDraft.trim()}
          >
            🗃️ Save
          </button>
        </div>
      </div>
    </div>
  )
}
