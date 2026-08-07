import React from 'react'

// =====================================================================
// ExportCodeModal — lifted out of App.tsx verbatim.
//
// Was an inline {cond && (…)} block inside the workspace return. Props are
// destructured under the names the markup already used; the open condition is
// re-expressed as an early return, because a component that simply returns the
// JSX would render ALWAYS.
// =====================================================================

export interface ExportCodeModalProps {
  exportCi: boolean
  exportCode: string | null
  exportEnvWarning: string[]
  exportPages: { fileName: string; source: string }[]
  exportTab: string
  exportXbrowser: boolean
  handleCopyExport: () => void
  handleSaveExport: () => Promise<void>
  handleTogglePoExport: (po: boolean) => void
  poExport: boolean
  savedExtras: string[]
  savedPageOverwritten: boolean
  savedPath: string | null
  setExportCi: React.Dispatch<React.SetStateAction<boolean>>
  setExportCode: React.Dispatch<React.SetStateAction<string | null>>
  setExportTab: React.Dispatch<React.SetStateAction<string>>
  setExportXbrowser: React.Dispatch<React.SetStateAction<boolean>>
  testName: string
}

export function ExportCodeModal({
  exportCi,
  exportCode,
  exportEnvWarning,
  exportPages,
  exportTab,
  exportXbrowser,
  handleCopyExport,
  handleSaveExport,
  handleTogglePoExport,
  poExport,
  savedExtras,
  savedPageOverwritten,
  savedPath,
  setExportCi,
  setExportCode,
  setExportTab,
  setExportXbrowser,
  testName
}: ExportCodeModalProps): React.JSX.Element | null {
  if (!(exportCode !== null)) return null
  return (
        <div className="modal-backdrop" onClick={() => setExportCode(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Playwright test</span>
              <button
                className="modal-close"
                onClick={() => setExportCode(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            {/* An {{env:…}} token whose name the OS also defines. Warned HERE
                because this is the last moment the name can be changed — once the
                spec is in CI the symptom is a credentials failure that points
                nowhere near the cause. */}
            {exportEnvWarning.length > 0 && (
              <div className="edge-warn edge-warn-block">
                ⚠ <strong>{exportEnvWarning.join(', ')}</strong>{' '}
                {exportEnvWarning.length === 1 ? 'is also an' : 'are also'} operating-system
                environment variable{exportEnvWarning.length === 1 ? '' : 's'} — on Windows{' '}
                <code>USERNAME</code> is your login name. Read directly, the test would silently use
                that instead of your value. This export reads{' '}
                <code>QA_{exportEnvWarning[0]}</code> instead and fails fast if it isn&rsquo;t set.
                To remove the guard, rename the token to something app-specific (e.g.{' '}
                <code>{'{{env:APP_' + exportEnvWarning[0] + '}}'}</code>).
              </div>
            )}
            {/* Day 17: choose inline vs full Page Object Model output */}
            <div className="export-modes">
              <button
                type="button"
                className={`export-mode${!poExport ? ' chosen' : ''}`}
                onClick={() => handleTogglePoExport(false)}
              >
                Inline
              </button>
              <button
                type="button"
                className={`export-mode${poExport ? ' chosen' : ''}`}
                onClick={() => handleTogglePoExport(true)}
                title="Full Page Object Model: a page class (locators + methods) per page + a spec that drives them. Handles iframes, dialogs, downloads and multiple tabs — a flow that opens a tab gets a class per tab, one per file."
              >
                Page Object
              </button>
              {/* In POM mode: the spec, plus one tab per page-object file. A
                  multi-tab flow has a class per browser tab, each in its own
                  file, so this is no longer a fixed pair. */}
              {exportPages.length > 0 && (
                <div className="export-file-tabs">
                  <button
                    type="button"
                    className={`export-file-tab${exportTab === 'spec' ? ' chosen' : ''}`}
                    onClick={() => setExportTab('spec')}
                  >
                    spec.ts
                  </button>
                  {exportPages.map((f) => (
                    <button
                      key={f.fileName}
                      type="button"
                      className={`export-file-tab${exportTab === f.fileName ? ' chosen' : ''}`}
                      onClick={() => setExportTab(f.fileName)}
                    >
                      {f.fileName}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <pre className="modal-code">
              <code>{exportPages.find((f) => f.fileName === exportTab)?.source ?? exportCode}</code>
            </pre>
            <div className="modal-footer">
              {savedPath && (
                <span className="saved-path">
                  {/* Every file, named. This used to list the CI workflow and the
                      config but NOT the page class — the one file that lands in a
                      folder the user never picked, so it looked like the POM
                      export had saved only half of itself. */}
                  Saved to {savedPath}
                  {savedExtras.map((p) => (
                    <span key={p} className="saved-path-extra">
                      + {p}
                    </span>
                  ))}
                  {savedPageOverwritten && (
                    <span className="saved-path-warn">
                      ⚠ A different page class already existed at that path and was replaced. The
                      class name comes from the TEST name, so another test called “{testName ||
                        'recorded flow'}” shares this file — its spec now imports a class that no
                      longer matches it. Rename one of the tests and re-export.
                    </span>
                  )}
                </span>
              )}
              {/* F33: opt-in — write a GitHub Actions workflow beside the spec so
                  the exported tests run on every PR. */}
              <label
                className="export-ci-toggle"
                title="Also write .github/workflows/playwright.yml — runs these tests on every push / PR"
              >
                <input
                  type="checkbox"
                  checked={exportCi}
                  onChange={(e) => setExportCi(e.target.checked)}
                />
                ⚙️ CI workflow
              </label>
              {/* F17: opt-in — write a cross-browser playwright.config.ts beside
                  the spec so `npx playwright test` runs on all three engines. */}
              <label
                className="export-ci-toggle"
                title="Also write playwright.config.ts — runs the exported test on Chromium + Firefox + WebKit"
              >
                <input
                  type="checkbox"
                  checked={exportXbrowser}
                  onChange={(e) => setExportXbrowser(e.target.checked)}
                />
                🧭 Cross-browser config
              </label>
              <button className="modal-btn" onClick={handleCopyExport}>
                Copy
              </button>
              <button className="modal-btn primary" onClick={handleSaveExport}>
                {exportPages.length || exportCi || exportXbrowser ? 'Save files' : 'Save .ts'}
              </button>
            </div>
          </div>
        </div>
  )
}
