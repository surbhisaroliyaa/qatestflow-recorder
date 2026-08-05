import React from 'react'
import { LOCALE_PRESETS } from '../uiLabels'

// =====================================================================
// LocalePickerModal — lifted out of App.tsx verbatim.
//
// Was an inline {cond && (…)} block inside the workspace return. Props are
// destructured under the names the markup already used; the open condition is
// re-expressed as an early return, because a component that simply returns the
// JSX would render ALWAYS.
// =====================================================================

export interface LocalePickerModalProps {
  handleRunLocaleSweep: () => Promise<void>
  localeOpen: boolean
  localeSel: Set<string>
  setLocaleOpen: React.Dispatch<React.SetStateAction<boolean>>
  setLocaleSel: React.Dispatch<React.SetStateAction<Set<string>>>
}

export function LocalePickerModal({
  handleRunLocaleSweep,
  localeOpen,
  localeSel,
  setLocaleOpen,
  setLocaleSel
}: LocalePickerModalProps): React.JSX.Element | null {
  if (!(localeOpen)) return null
  return (
        <div className="modal-backdrop" onClick={() => setLocaleOpen(false)}>
          <div className="modal api-editor" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">🌐 Localization sweep</span>
              <button className="modal-close" onClick={() => setLocaleOpen(false)} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="api-editor-body">
              <p className="api-hint">
                Replays this flow under each language and flags <strong>text overflow</strong>,{' '}
                <strong>RTL layout</strong>, and strings that never changed from the base (likely{' '}
                <strong>untranslated</strong>). The first selected locale is the base for comparison.
              </p>
              <div className="edge-section">
                <span className="env-field-label">Languages</span>
                {LOCALE_PRESETS.map((l) => (
                  <label key={l.code} className="edge-check">
                    <input
                      type="checkbox"
                      checked={localeSel.has(l.code)}
                      onChange={(e) => {
                        const next = new Set(localeSel)
                        if (e.target.checked) next.add(l.code)
                        else next.delete(l.code)
                        setLocaleSel(next)
                      }}
                    />
                    {l.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button className="modal-btn" onClick={() => setLocaleOpen(false)}>
                Close
              </button>
              <button
                className="modal-btn primary"
                onClick={handleRunLocaleSweep}
                disabled={localeSel.size === 0}
              >
                ▶ Run on {localeSel.size} locale{localeSel.size === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </div>
  )
}
