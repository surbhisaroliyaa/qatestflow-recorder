import React from 'react'
import { PERF_METRIC_HELP } from '../uiLabels'

// =====================================================================
// PerfPanel — lifted out of App.tsx verbatim.
//
// Was an inline {cond && (…)} block inside the workspace return. Props are
// destructured under the names the markup already used; the open condition is
// re-expressed as an early return, because a component that simply returns the
// JSX would render ALWAYS.
// =====================================================================

export interface PerfPanelProps {
  handleAddPerfStep: () => void
  handleMeasurePerf: () => Promise<void>
  perfAddLevel: string
  perfMeasuring: boolean
  perfPanelOpen: unknown
  perfResult: PerfResult | null
  setPerfAddLevel: React.Dispatch<React.SetStateAction<string>>
  setPerfResult: React.Dispatch<React.SetStateAction<PerfResult | null>>
}

export function PerfPanel({
  handleAddPerfStep,
  handleMeasurePerf,
  perfAddLevel,
  perfMeasuring,
  perfPanelOpen,
  perfResult,
  setPerfAddLevel,
  setPerfResult
}: PerfPanelProps): React.JSX.Element | null {
  if (!(perfPanelOpen)) return null
  return (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!perfMeasuring) setPerfResult(null)
          }}
        >
          <div className="a11y-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">⚡ Performance — Core Web Vitals</span>
              <button
                className="modal-close"
                onClick={() => setPerfResult(null)}
                disabled={perfMeasuring}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {perfMeasuring ? (
              <div className="a11y-body a11y-loading">
                <span className="a11y-spinner" />
                <p>Measuring load speed and layout stability on this page…</p>
              </div>
            ) : perfResult?.error ? (
              <div className="a11y-body">
                <p className="a11y-error">{perfResult.error}</p>
              </div>
            ) : perfResult ? (
              <>
                <div className="a11y-summary">
                  <span className="a11y-summary-url" title={perfResult.url}>
                    {perfResult.title || perfResult.url || 'this page'}
                  </span>
                  <span className="a11y-summary-stats">measured from this page load</span>
                </div>
                <div className="a11y-body">
                  <div className="perf-grid">
                    {perfResult.metrics.map((m) => (
                      <div className={`perf-metric${m.core ? ' core' : ''}`} key={m.key}>
                        <span className="perf-metric-main">
                          <span className="perf-metric-label">
                            {m.label}
                            {m.core && <span className="perf-core-tag">core</span>}
                          </span>
                          {PERF_METRIC_HELP[m.key] && (
                            <span className="perf-metric-desc">{PERF_METRIC_HELP[m.key]}</span>
                          )}
                        </span>
                        <span className="perf-metric-value">
                          {m.value == null ? '—' : `${m.value.toLocaleString()}${m.unit}`}
                        </span>
                        {m.rating ? (
                          <span className={`perf-rating ${m.rating}`}>
                            {m.rating === 'needs-improvement' ? 'needs work' : m.rating}
                          </span>
                        ) : (
                          <span className="perf-rating info">info</span>
                        )}
                      </div>
                    ))}
                  </div>
                  {/* F14: sticky note — what the grades mean + what to edit. */}
                  <div className="help-note">
                    <span className="help-note-title">📌 How to read this &amp; what to edit</span>
                    <ul>
                      <li>
                        <strong>CORE</strong> (LCP, CLS) = Google&apos;s Core Web Vitals — these are
                        the <strong>only</strong> two that pass/fail the test. The rest are context.
                      </li>
                      <li>
                        <strong>Grades</strong> use Google&apos;s official limits — LCP: good ≤2.5s,
                        poor &gt;4s · CLS: good ≤0.1, poor &gt;0.25.
                      </li>
                      <li>
                        <strong>To edit the gate</strong> (dropdown below, or the ✎ on the step):{' '}
                        <em>&ldquo;a vital is poor&rdquo;</em> = lenient ·{' '}
                        <em>&ldquo;a vital is not good&rdquo;</em> = strict.
                      </li>
                      <li>
                        <strong>INFO</strong> = shown for context, no official pass/fail line, so
                        not graded.
                      </li>
                    </ul>
                  </div>
                </div>
              </>
            ) : null}

            <div className="modal-footer">
              {perfResult && !perfResult.error && (
                <span className="a11y-add">
                  <label htmlFor="perf-level" className="a11y-add-label">
                    Fail replay when
                  </label>
                  <select
                    id="perf-level"
                    className="a11y-level-select"
                    value={perfAddLevel}
                    onChange={(e) => setPerfAddLevel(e.target.value)}
                    title="How strict the performance gate should be when added as a test step"
                  >
                    <option value="needs-improvement">a vital is poor</option>
                    <option value="good">a vital is not good</option>
                  </select>
                  <button
                    className="modal-btn"
                    onClick={handleAddPerfStep}
                    title="Add this as a test step — replay fails if a Core Web Vital regresses"
                  >
                    ➕ Add as test step
                  </button>
                </span>
              )}
              <button
                className="modal-btn"
                onClick={() => setPerfResult(null)}
                disabled={perfMeasuring}
              >
                Close
              </button>
              <button
                className="modal-btn primary"
                onClick={handleMeasurePerf}
                disabled={perfMeasuring}
              >
                ↻ Re-measure
              </button>
            </div>
          </div>
        </div>
  )
}
