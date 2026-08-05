import React from 'react'

// =====================================================================
// AiPromptModal — lifted out of App.tsx verbatim.
//
// Props are destructured under the names the markup already used, so the move
// cannot change behaviour by renaming. Types were inferred from each value's
// declaration in App.tsx and then checked by tsc, which is the actual authority.
// =====================================================================

export interface AiPromptModalProps {
  aiPromptNote: string
  aiPromptOpen: boolean
  aiPromptText: string
  handleGenerateAiSteps: () => Promise<void>
  setAiPromptOpen: React.Dispatch<React.SetStateAction<boolean>>
  setAiPromptText: React.Dispatch<React.SetStateAction<string>>
}

export function AiPromptModal({
  aiPromptNote,
  aiPromptOpen,
  aiPromptText,
  handleGenerateAiSteps,
  setAiPromptOpen,
  setAiPromptText,
}: AiPromptModalProps): React.JSX.Element | null {
  if (!(aiPromptOpen)) return null
  return (
    <div className="modal-backdrop" onClick={() => setAiPromptOpen(false)}>
      <div className="modal api-editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">🪄 AI step — describe what to do</span>
          <button className="modal-close" onClick={() => setAiPromptOpen(false)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="api-editor-body">
          <label className="api-field">
            <span>Plain English — what should happen on THIS page?</span>
            <textarea
              className="api-body"
              rows={3}
              placeholder={'e.g. log in as standard_user with password secret_sauce'}
              value={aiPromptText}
              onChange={(e) => setAiPromptText(e.target.value)}
              autoFocus
            />
          </label>
          <p className="api-hint">
            The AI reads the elements on the page you’re viewing and turns your intent into steps —
            grounded to real elements, so it can’t invent selectors. It sees one page at a time, so
            for a multi-page flow, generate on each page. Always review + Replay the result.
          </p>
          {aiPromptNote && (
            <p
              className="api-hint"
              style={{ color: aiPromptNote.startsWith('✓') ? '#7ee787' : '#f0b232' }}
            >
              {aiPromptNote}
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={() => setAiPromptOpen(false)}>
            Close
          </button>
          <button
            className="modal-btn primary"
            onClick={handleGenerateAiSteps}
            disabled={!aiPromptText.trim()}
          >
            🪄 Generate steps
          </button>
        </div>
      </div>
    </div>
  )
}
