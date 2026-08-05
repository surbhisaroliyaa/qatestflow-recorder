import React from 'react'

// =====================================================================
// XbrowserModal — lifted out of App.tsx verbatim.
//
// Was an inline {cond && (…)} block inside the workspace return. Props are
// destructured under the names the markup already used; the open condition is
// re-expressed as an early return, because a component that simply returns the
// JSX would render ALWAYS.
// =====================================================================

export interface XbrowserModalProps {
  handleCancelInstall: () => Promise<void>
  handleInstallBrowsers: (which: ('chromium' | 'firefox' | 'webkit')[]) => Promise<void>
  handleRunXbrowser: () => Promise<void>
  setXbInstalled: React.Dispatch<React.SetStateAction<boolean | null>>
  setXbOpen: React.Dispatch<React.SetStateAction<boolean>>
  setXbSel: React.Dispatch<React.SetStateAction<Set<string>>>
  xbBrowsers: { chromium: boolean; all: boolean } | null
  xbInstallLog: string
  xbInstalled: boolean | null
  xbInstalling: boolean
  xbNeedDownload: boolean
  xbOpen: boolean
  xbResult: Awaited<
ReturnType<typeof window.api.xbrowser.run>
> | null
  xbRunning: boolean
  xbSel: Set<string>
}

export function XbrowserModal({
  handleCancelInstall,
  handleInstallBrowsers,
  handleRunXbrowser,
  setXbInstalled,
  setXbOpen,
  setXbSel,
  xbBrowsers,
  xbInstallLog,
  xbInstalled,
  xbInstalling,
  xbNeedDownload,
  xbOpen,
  xbResult,
  xbRunning,
  xbSel
}: XbrowserModalProps): React.JSX.Element | null {
  if (!(xbOpen)) return null
  return (
        <div className="modal-backdrop" onClick={() => !xbRunning && setXbOpen(false)}>
          <div className="env-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">🧭 Cross-browser</span>
              <button
                className="modal-close"
                onClick={() => setXbOpen(false)}
                disabled={xbRunning}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {xbInstalled === false ? (
              <div className="env-list">
                <div className="edge-warn">
                  ⚠ Cross-browser needs real Playwright (the embedded engine is Chromium only).
                  Install it once, then reopen this:
                  <pre className="xb-install">npm i -D @playwright/test{'\n'}npx playwright install</pre>
                  Tip: you can run these right here by typing{' '}
                  <code>! npm i -D @playwright/test</code> then{' '}
                  <code>! npx playwright install</code>.
                </div>
                <div className="modal-footer">
                  <button className="modal-btn" onClick={() => setXbOpen(false)}>
                    Close
                  </button>
                  <button
                    className="modal-btn"
                    onClick={async () => setXbInstalled((await window.api.xbrowser.check()).installed)}
                  >
                    Re-check
                  </button>
                </div>
              </div>
            ) : xbBrowsers && (!xbBrowsers.chromium || xbNeedDownload) ? (
              // The runner shipped with the app, but the engines it drives are a
              // separate ~400 MB download that no installer should carry. This
              // is a first-run state on a teammate's machine, so it has to be
              // self-explanatory and fixable from right here.
              <div className="env-list">
                <div className="edge-warn">
                  ⚠ The test browsers aren&rsquo;t downloaded yet.
                  <p className="env-list-intro">
                    QATestFlow ships the Playwright test runner, but the browser engines it
                    drives (Chromium, Firefox, WebKit) are about 400 MB, so they&rsquo;re
                    fetched once on first use and shared with any other Playwright project on
                    this machine. Recording and in-app replay work without them &mdash; headless
                    runs, parallel suite runs and cross-browser need them.
                  </p>
                  {xbInstalling && <pre className="xb-install">{xbInstallLog}</pre>}
                  {!xbInstalling && xbInstallLog && <p className="env-list-intro">{xbInstallLog}</p>}
                </div>
                <div className="modal-footer">
                  {xbInstalling ? (
                    // Mid-download the only useful control is a way OUT. A few
                    // hundred MB with no escape is a trap on a slow or metered
                    // connection — and a first-time user is exactly who mis-clicks.
                    <button className="modal-btn danger" onClick={handleCancelInstall}>
                      Cancel download
                    </button>
                  ) : (
                    <>
                      <button className="modal-btn" onClick={() => setXbOpen(false)}>
                        Close
                      </button>
                      <button
                        className="modal-btn"
                        onClick={() => handleInstallBrowsers(['chromium'])}
                      >
                        Chromium only (~150 MB)
                      </button>
                      <button
                        className="modal-btn primary"
                        onClick={() => handleInstallBrowsers(['chromium', 'firefox', 'webkit'])}
                      >
                        ⬇ Download all three (~400 MB)
                      </button>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="env-edit">
                <p className="env-list-intro">
                  Run this test on real browser engines via Playwright. Chromium is what the app
                  already uses; Firefox &amp; WebKit catch engine-specific bugs. Session / HAR /
                  upload assets aren&rsquo;t included in this run (v1).
                </p>

                <div className="edge-section">
                  <span className="env-field-label">Browsers</span>
                  {(['chromium', 'firefox', 'webkit'] as const).map((b) => (
                    <label key={b} className="edge-check">
                      <input
                        type="checkbox"
                        checked={xbSel.has(b)}
                        onChange={(e) => {
                          const next = new Set(xbSel)
                          if (e.target.checked) next.add(b)
                          else next.delete(b)
                          setXbSel(next)
                        }}
                      />
                      {b === 'chromium' ? 'Chromium' : b === 'firefox' ? 'Firefox' : 'WebKit (Safari)'}
                    </label>
                  ))}
                </div>

                {xbResult && (
                  <div className="xb-results">
                    {xbResult.message && <div className="edge-warn">{xbResult.message}</div>}
                    {xbResult.results.map((r) => (
                      <div key={r.browser} className={`xb-result ${r.ok ? 'pass' : 'fail'}`}>
                        <span className="xb-result-icon">{r.ok ? '✓' : '✗'}</span>
                        <span className="xb-result-name">{r.browser}</span>
                        {/* HOW MANY tests ran, not just whether they passed. A
                            data-driven test contributes one test PER ROW, and a
                            single green tick looks the same whether it ran six
                            rows or silently collapsed them into one — which is
                            exactly what this path used to do before the data
                            table travelled with the spec. */}
                        {r.total > 0 && (
                          <span className="xb-result-count">
                            {r.passed}/{r.total} {r.total === 1 ? 'test' : 'tests'}
                          </span>
                        )}
                        {!r.ok && r.error && <span className="xb-result-error">{r.error}</span>}
                      </div>
                    ))}
                  </div>
                )}

                <div className="modal-footer">
                  {xbRunning && (
                    <span className="edge-count">
                      Running on {xbSel.size} engine{xbSel.size === 1 ? '' : 's'}… (first WebKit run
                      can take a minute)
                    </span>
                  )}
                  <button className="modal-btn" onClick={() => setXbOpen(false)} disabled={xbRunning}>
                    Close
                  </button>
                  <button
                    className="modal-btn primary"
                    onClick={handleRunXbrowser}
                    disabled={xbRunning || xbSel.size === 0}
                  >
                    {xbRunning ? 'Running…' : `▶ Run on ${xbSel.size}`}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
  )
}
