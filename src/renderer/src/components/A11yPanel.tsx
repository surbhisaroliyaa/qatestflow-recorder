import React from 'react'
import { a11yImpactRank } from '../uiFormat'

// =====================================================================
// A11yPanel — lifted out of App.tsx verbatim.
//
// Was an inline {cond && (…)} block inside the workspace return. Props are
// destructured under the names the markup already used; the open condition is
// re-expressed as an early return, because a component that simply returns the
// JSX would render ALWAYS.
// =====================================================================

export interface A11yPanelProps {
  a11yAddLevel: string
  a11yPanelOpen: unknown
  a11yScan: A11yScanResult | null
  a11yScanning: boolean
  handleA11yScan: () => Promise<void>
  handleAddA11yStep: () => void
  setA11yAddLevel: React.Dispatch<React.SetStateAction<string>>
  setA11yScan: React.Dispatch<React.SetStateAction<A11yScanResult | null>>
}

export function A11yPanel({
  a11yAddLevel,
  a11yPanelOpen,
  a11yScan,
  a11yScanning,
  handleA11yScan,
  handleAddA11yStep,
  setA11yAddLevel,
  setA11yScan
}: A11yPanelProps): React.JSX.Element | null {
  if (!(a11yPanelOpen)) return null
  return (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!a11yScanning) setA11yScan(null)
          }}
        >
          <div className="a11y-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">
                ♿ Accessibility
                {a11yScan && !a11yScan.error && a11yScan.violations.length > 0 && (
                  <span className="a11y-title-count">
                    {a11yScan.violations.length} rule
                    {a11yScan.violations.length === 1 ? '' : 's'} · {a11yScan.nodeCount} element
                    {a11yScan.nodeCount === 1 ? '' : 's'}
                  </span>
                )}
              </span>
              <button
                className="modal-close"
                onClick={() => setA11yScan(null)}
                disabled={a11yScanning}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {a11yScanning ? (
              <div className="a11y-body a11y-loading">
                <span className="a11y-spinner" />
                <p>Injecting axe-core and checking this page for WCAG A/AA violations…</p>
              </div>
            ) : a11yScan?.error ? (
              <div className="a11y-body">
                <p className="a11y-error">{a11yScan.error}</p>
              </div>
            ) : a11yScan ? (
              <>
                <div className="a11y-summary">
                  <span className="a11y-summary-url" title={a11yScan.url}>
                    {a11yScan.title || a11yScan.url || 'this page'}
                  </span>
                  <span className="a11y-summary-stats">
                    {a11yScan.passCount} checks passed
                    {a11yScan.incompleteCount > 0 && ` · ${a11yScan.incompleteCount} need review`}
                  </span>
                </div>
                <div className="a11y-body">
                  {a11yScan.violations.length === 0 ? (
                    <p className="a11y-clean">🎉 No WCAG A/AA violations found on this page.</p>
                  ) : (
                    [...a11yScan.violations]
                      .sort((a, b) => a11yImpactRank(a.impact) - a11yImpactRank(b.impact))
                      .map((v) => (
                        <details className="a11y-rule" key={v.id}>
                          <summary>
                            <span className={`a11y-impact ${v.impact}`}>{v.impact}</span>
                            <span className="a11y-help">{v.help}</span>
                            <span className="a11y-node-count">
                              {v.nodes.length}
                              {v.nodes.length === 1 ? ' element' : ' elements'}
                            </span>
                          </summary>
                          <div className="a11y-rule-body">
                            <p className="a11y-desc">{v.description}</p>
                            {v.nodes.map((n, i) => (
                              <div className="a11y-node" key={i}>
                                <code className="a11y-target">{n.target}</code>
                                <pre className="a11y-html">{n.html}</pre>
                                {n.summary && <p className="a11y-fix">{n.summary}</p>}
                              </div>
                            ))}
                            <button
                              className="a11y-learn"
                              onClick={() => window.api.a11y.openHelp(v.helpUrl)}
                            >
                              Learn how to fix ↗
                            </button>
                          </div>
                        </details>
                      ))
                  )}
                  {/* F13: sticky note — what the severities mean + what to edit. */}
                  <div className="help-note">
                    <span className="help-note-title">
                      📌 What the severities mean &amp; what to edit
                    </span>
                    <ul>
                      <li>
                        <strong>critical</strong> blocks a disabled user entirely ·{' '}
                        <strong>serious</strong> major barrier · <strong>moderate</strong>{' '}
                        noticeable · <strong>minor</strong> cosmetic.
                      </li>
                      <li>
                        Each is <strong>axe-core&apos;s</strong> own rating of how much the issue
                        blocks someone using a screen reader / keyboard.
                      </li>
                      <li>
                        <strong>To edit the gate</strong> (dropdown below, or the ✎ on the step):
                        it&apos;s the <em>least severe</em> issue that still fails — e.g.{' '}
                        <em>&ldquo;serious + critical&rdquo;</em> ignores moderate/minor,{' '}
                        <em>&ldquo;any violation&rdquo;</em> fails on everything.
                      </li>
                    </ul>
                  </div>
                </div>
              </>
            ) : null}

            <div className="modal-footer">
              {a11yScan && !a11yScan.error && (
                <span className="a11y-add">
                  <label htmlFor="a11y-level" className="a11y-add-label">
                    Fail replay on
                  </label>
                  <select
                    id="a11y-level"
                    className="a11y-level-select"
                    value={a11yAddLevel}
                    onChange={(e) => setA11yAddLevel(e.target.value)}
                    title="Which severities should fail a replay when added as a test step"
                  >
                    <option value="critical">critical only</option>
                    <option value="serious">serious + critical</option>
                    <option value="moderate">moderate and up</option>
                    <option value="minor">any violation</option>
                  </select>
                  <button
                    className="modal-btn"
                    onClick={handleAddA11yStep}
                    title="Add this as a test step — replay fails if the page regresses on accessibility"
                  >
                    ➕ Add as test step
                  </button>
                </span>
              )}
              <button
                className="modal-btn"
                onClick={() => setA11yScan(null)}
                disabled={a11yScanning}
              >
                Close
              </button>
              <button
                className="modal-btn primary"
                onClick={handleA11yScan}
                disabled={a11yScanning}
              >
                ↻ Re-scan
              </button>
            </div>
          </div>
        </div>
  )
}
