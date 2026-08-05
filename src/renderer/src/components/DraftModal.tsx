import React from 'react'

// =====================================================================
// DraftModal — lifted out of App.tsx verbatim.
//
// Props are destructured under the names the markup already used, so the move
// cannot change behaviour by renaming. Types were inferred from each value's
// declaration in App.tsx and then checked by tsc, which is the actual authority.
// =====================================================================

export interface DraftModalProps {
  draftOpen: boolean
  draftBusy: boolean
  draftDiff: { text: string; summary: string } | null
  draftNote: string
  draftStepIcon: (s: RecorderStep) => string
  draftStepKind: (s: RecorderStep) => string
  draftStory: string
  draftResult: { title: string; steps: RecorderStep[]; guessed: number[] } | null
  handleGenerateDraft: () => Promise<void>
  handleInsertDraft: () => void
  handleLoadDiff: () => Promise<void>
  setDraftDiff: React.Dispatch<React.SetStateAction<{ text: string; summary: string } | null>>
  setDraftNote: React.Dispatch<React.SetStateAction<string>>
  setDraftOpen: React.Dispatch<React.SetStateAction<boolean>>
  setDraftStory: React.Dispatch<React.SetStateAction<string>>
}

export function DraftModal({
  draftOpen,
  draftBusy,
  draftDiff,
  draftNote,
  draftStepIcon,
  draftStepKind,
  draftStory,
  draftResult,
  handleGenerateDraft,
  handleInsertDraft,
  handleLoadDiff,
  setDraftDiff,
  setDraftNote,
  setDraftOpen,
  setDraftStory
}: DraftModalProps): React.JSX.Element | null {
  if (!(draftOpen)) return null
  return (
    <div className="modal-backdrop" onClick={() => !draftBusy && setDraftOpen(false)}>
      <div className="modal api-editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">📝 Draft a test — from a story or PR diff</span>
          <button
            className="modal-close"
            onClick={() => setDraftOpen(false)}
            disabled={draftBusy}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="api-editor-body">
          <label className="api-field">
            <span>User story / acceptance criteria</span>
            <textarea
              className="api-body"
              rows={5}
              placeholder={
                'e.g. As a shopper I can sort products by price (low to high) on the inventory page, and the list re-orders so the cheapest item is first.'
              }
              value={draftStory}
              onChange={(e) => setDraftStory(e.target.value)}
              autoFocus
            />
          </label>
          <div className="draft-diff-row">
            <button className="modal-btn" onClick={handleLoadDiff} disabled={draftBusy}>
              📁 {draftDiff ? 'Change PR diff…' : 'Load PR diff from repo…'}
            </button>
            {draftDiff && (
              <span className="draft-diff-chip">
                {draftDiff.summary}
                <button
                  className="draft-diff-clear"
                  onClick={() => {
                    setDraftDiff(null)
                    setDraftNote('')
                  }}
                  title="Remove the diff"
                  aria-label="Remove the diff"
                >
                  ✕
                </button>
              </span>
            )}
          </div>
          <p className="api-hint">
            The AI turns your story into a draft: <strong>navigations</strong> and{' '}
            <strong>✅ checks</strong> run for real; <strong>⏸ actions</strong> are plain-English
            placeholders you ground by recording over them (there’s no live page to read selectors
            from yet). Optionally point at the app’s local git repo to steer the draft from its diff.
          </p>
          {draftNote && (
            <p
              className="api-hint"
              style={{ color: draftNote.startsWith('✓') ? '#7ee787' : '#f0b232' }}
            >
              {draftNote}
            </p>
          )}
          {draftResult && (
            <>
              <div className="ac-summary">
                Draft: <strong>{draftResult.title}</strong> · {draftResult.steps.length} steps
              </div>
              <ul className="ac-list">
                {draftResult.steps.map((s, i) => {
                  // The story named no address for this "Go to", so the URL below
                  // is our guess. Flag it here — at replay it would just look
                  // like the site is broken.
                  const guessedUrl = draftResult.guessed.includes(i)
                  return (
                    <li key={i} className="ac-row">
                      <span className="ac-mark">{guessedUrl ? '⚠' : draftStepIcon(s)}</span>
                      <span className="ac-text">
                        <strong>{draftStepKind(s)}</strong>
                        <span
                          className="mon-sub"
                          style={guessedUrl ? { color: '#f0b232' } : undefined}
                          title={
                            guessedUrl
                              ? 'The story didn’t say where to go — this address is a guess. Set it before you replay.'
                              : undefined
                          }
                        >
                          {s.type === 'navigate'
                            ? s.url || '(no address — set this before replaying)'
                            : s.value}
                          {guessedUrl && s.url ? ' — guessed' : ''}
                        </span>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={() => setDraftOpen(false)} disabled={draftBusy}>
            Close
          </button>
          {draftResult ? (
            <>
              <button className="modal-btn" onClick={handleGenerateDraft} disabled={draftBusy}>
                ↻ Regenerate
              </button>
              <button className="modal-btn primary" onClick={handleInsertDraft} disabled={draftBusy}>
                ＋ Insert {draftResult.steps.length} steps
              </button>
            </>
          ) : (
            <button
              className="modal-btn primary"
              onClick={handleGenerateDraft}
              disabled={draftBusy || (!draftStory.trim() && !draftDiff)}
            >
              {draftBusy ? '✨ Drafting…' : '✨ Generate draft'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
