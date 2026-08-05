import React from 'react'

// =====================================================================
// BugPromptModal — lifted out of App.tsx verbatim.
//
// Props are destructured under the names the markup already used, so the move
// cannot change behaviour by renaming. Types were inferred from each value's
// declaration in App.tsx and then checked by tsc, which is the actual authority.
// =====================================================================

export interface BugPromptModalProps {
  bugExpectedText: string
  bugPromptOpen: boolean
  bugReproText: string
  handleGenerateRegressionTest: () => Promise<void>
  setBugExpectedText: React.Dispatch<React.SetStateAction<string>>
  setBugPromptOpen: React.Dispatch<React.SetStateAction<boolean>>
  setBugReproText: React.Dispatch<React.SetStateAction<string>>
}

export function BugPromptModal({
  bugExpectedText,
  bugPromptOpen,
  bugReproText,
  handleGenerateRegressionTest,
  setBugExpectedText,
  setBugPromptOpen,
  setBugReproText
}: BugPromptModalProps): React.JSX.Element | null {
  if (!(bugPromptOpen)) return null
  return (
    <div className="modal-backdrop" onClick={() => setBugPromptOpen(false)}>
      <div className="modal api-editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">🐛 Bug check — this page</span>
          <button className="modal-close" onClick={() => setBugPromptOpen(false)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="api-editor-body">
          <label className="api-field">
            <span>Steps to reproduce (plain English)</span>
            <textarea
              className="api-body"
              rows={4}
              placeholder={
                'e.g. log in as standard_user, add the backpack to the cart, then open the cart'
              }
              value={bugReproText}
              onChange={(e) => setBugReproText(e.target.value)}
              autoFocus
            />
          </label>
          <label className="api-field">
            <span>Expected result (what SHOULD happen)</span>
            <textarea
              className="api-body"
              rows={2}
              placeholder={'e.g. the cart shows 1 item and the backpack is listed'}
              value={bugExpectedText}
              onChange={(e) => setBugExpectedText(e.target.value)}
            />
          </label>
          <p className="api-hint">
            Adds a smart check for <strong>the page you’re on right now</strong>. The AI reproduces
            your steps (grounded to real elements on THIS page, so it can’t invent selectors), then
            adds a plain-English check of the expected result — one it reasons about like a human,
            not a rigid selector match. Replay it BEFORE the fix — the check fails; AFTER the fix —
            it passes. It only covers this one page: for a bug that spans several pages, record the
            navigation to reach each page, then run this on the page where the check belongs. Always
            review + Replay.
          </p>
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={() => setBugPromptOpen(false)}>
            Close
          </button>
          <button
            className="modal-btn primary"
            onClick={handleGenerateRegressionTest}
            disabled={!bugReproText.trim()}
          >
            🐛 Build check
          </button>
        </div>
      </div>
    </div>
  )
}
