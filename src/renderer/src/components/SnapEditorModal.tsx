import React from 'react'

// =====================================================================
// SnapEditorModal — lifted out of App.tsx verbatim.
//
// Props are destructured under the names the markup already used, so the move
// cannot change behaviour by renaming. Types were inferred from each value's
// declaration in App.tsx and then checked by tsc, which is the actual authority.
// =====================================================================

export interface SnapEditorModalProps {
  closeSnapEditor: () => void
  patchSnapDraft: (patch: Partial<RecorderStep>) => void
  saveSnapEditor: () => Promise<void>
  snapDraft: RecorderStep | null
  snapEditIndex: number | null
  snapStatus: string
}

export function SnapEditorModal({
  closeSnapEditor,
  patchSnapDraft,
  saveSnapEditor,
  snapDraft,
  snapEditIndex,
  snapStatus
}: SnapEditorModalProps): React.JSX.Element | null {
  if (!(snapDraft && snapEditIndex !== null)) return null
  return (
    <div className="modal-backdrop" onClick={closeSnapEditor}>
      <div className="modal api-editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">📸 Visual snapshot settings</span>
          <button className="modal-close" onClick={closeSnapEditor} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="api-editor-body">
          <label className="api-field">
            <span>Ignore these regions (mask) — CSS selectors, one per line</span>
            <textarea
              className="api-headers"
              rows={3}
              placeholder={'.timestamp\n#carousel\n.ad-banner'}
              value={snapDraft.maskSelectors ?? ''}
              onChange={(e) => patchSnapDraft({ maskSelectors: e.target.value })}
            />
            <span className="api-hint">
              A clock, ad, or carousel that changes every run would otherwise fail the diff. Masked
              areas are painted over identically on both baseline and current, so they’re excluded.
            </span>
          </label>
          <label className="api-field api-field-inline" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={snapDraft.freezeAnimations !== false}
              onChange={(e) => patchSnapDraft({ freezeAnimations: e.target.checked })}
            />
            <span>Freeze animations &amp; transitions before capture (recommended)</span>
          </label>
          <label className="api-field api-field-inline">
            <span>Allowed difference (%)</span>
            <input
              type="text"
              placeholder="1"
              value={snapDraft.value ?? '1'}
              onChange={(e) => patchSnapDraft({ value: e.target.value })}
            />
          </label>
          <label className="api-field api-field-inline">
            <span>Also fail past N changed pixels</span>
            <input
              type="text"
              placeholder="200"
              value={snapDraft.maxDiffPixels ?? ''}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10)
                patchSnapDraft({ maxDiffPixels: Number.isFinite(n) && n >= 0 ? n : undefined })
              }}
            />
          </label>
          <p className="api-hint">
            On a big full-page snapshot, a small change (one button, a badge) can stay under the %
            bar. This also fails once more than N real pixels change — so localized regressions
            aren&apos;t diluted. Blank = 200.
          </p>
          {snapStatus && <p className="api-hint" style={{ color: '#8ab4f8' }}>{snapStatus}</p>}
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={closeSnapEditor}>
            Cancel
          </button>
          <button
            className="modal-btn primary"
            onClick={saveSnapEditor}
            title="Save these settings AND re-capture the baseline from the current page with them applied"
          >
            Save &amp; re-capture baseline
          </button>
        </div>
      </div>
    </div>
  )
}
