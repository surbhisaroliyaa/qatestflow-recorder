import React from 'react'

// =====================================================================
// MockModal — lifted out of App.tsx verbatim.
//
// Props are destructured under the names the markup already used, so the move
// cannot change behaviour by renaming. Types were inferred from each value's
// declaration in App.tsx and then checked by tsc, which is the actual authority.
// =====================================================================

export interface MockModalProps {
  copyMockSnippet: () => void
  mockBody: string
  mockCopied: boolean
  mockEntries: Awaited<ReturnType<typeof window.api.har.mockList>>['entries']
  mockNote: string
  mockOpen: boolean
  mockSel: number | null
  mockSnippet: () => string
  mockStatus: string
  selectMock: (i: number) => void
  setMockBody: React.Dispatch<React.SetStateAction<string>>
  setMockOpen: React.Dispatch<React.SetStateAction<boolean>>
  setMockStatus: React.Dispatch<React.SetStateAction<string>>
}

export function MockModal({
  copyMockSnippet,
  mockBody,
  mockCopied,
  mockEntries,
  mockNote,
  mockOpen,
  mockSel,
  mockSnippet,
  mockStatus,
  selectMock,
  setMockBody,
  setMockOpen,
  setMockStatus
}: MockModalProps): React.JSX.Element | null {
  if (!(mockOpen)) return null
  return (
    <div className="modal-backdrop" onClick={() => setMockOpen(false)}>
      <div className="modal api-editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">🎭 Mock Studio — edit a captured response into a scenario</span>
          <button className="modal-close" onClick={() => setMockOpen(false)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="api-editor-body">
          {!mockEntries.length ? (
            <p className="api-hint">
              {mockNote ||
                'No mockable API responses captured yet. Record a flow with 🌐 Net capture ON, then reopen Mock Studio.'}
            </p>
          ) : (
            <>
              <p className="api-hint">
                Pick a captured API call, edit its <strong>status</strong> and{' '}
                <strong>body</strong> into the scenario you want to test (sold-out, a server error,
                an empty list), then copy the Playwright mock. Paste it into your test to force that
                exact response — no backend needed.
              </p>
              <div className="ac-summary">Captured responses ({mockEntries.length})</div>
              <ul className="ac-list mock-list">
                {mockEntries.map((e, i) => (
                  <li
                    key={i}
                    className={`ac-row mock-row${mockSel === i ? ' selected' : ''}`}
                    onClick={() => selectMock(i)}
                  >
                    <span className={`mock-verb verb-${e.method.toLowerCase()}`}>{e.method}</span>
                    <span className="ac-text">
                      <strong>{(() => { try { return new URL(e.url).pathname } catch { return e.url } })()}</strong>
                      <span className="mon-sub">
                        {e.status} {e.statusText} · {e.mimeType || '—'}
                        {e.resourceType ? ` · ${e.resourceType}` : ''}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              {mockSel != null && mockEntries[mockSel] && (
                <div className="mock-editor">
                  <div className="mock-controls">
                    <label className="mock-status-field">
                      <span>Status</span>
                      <input
                        className="mock-status-input"
                        value={mockStatus}
                        onChange={(e) => setMockStatus(e.target.value.replace(/[^\d]/g, ''))}
                      />
                    </label>
                    <div className="mock-quick">
                      <button className="modal-btn" onClick={() => { setMockStatus('500'); setMockBody('{"error":"Internal Server Error"}') }}>
                        Force 500
                      </button>
                      <button className="modal-btn" onClick={() => { setMockStatus('404'); setMockBody('{"error":"Not Found"}') }}>
                        Force 404
                      </button>
                      <button className="modal-btn" onClick={() => setMockBody('[]')}>
                        Empty list []
                      </button>
                      <button className="modal-btn" onClick={() => { const e = mockEntries[mockSel]; setMockStatus(String(e.status)); setMockBody(e.body) }}>
                        ↺ Reset
                      </button>
                    </div>
                  </div>
                  <label className="api-field">
                    <span>Response body (edit into your scenario)</span>
                    <textarea
                      className="api-body mock-body"
                      rows={7}
                      value={mockBody}
                      onChange={(e) => setMockBody(e.target.value)}
                      spellCheck={false}
                    />
                  </label>
                  <div className="ac-summary">Playwright mock (paste into your test)</div>
                  <pre className="mock-snippet"><code>{mockSnippet()}</code></pre>
                </div>
              )}
            </>
          )}
          {mockNote && mockEntries.length > 0 && (
            <p className="api-hint" style={{ color: mockNote.startsWith('✓') ? '#7ee787' : '#f0b232' }}>
              {mockNote}
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={() => setMockOpen(false)}>
            Close
          </button>
          {mockSel != null && (
            <button className="modal-btn primary" onClick={copyMockSnippet}>
              {mockCopied ? '✓ Copied!' : '📋 Copy Playwright mock'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
