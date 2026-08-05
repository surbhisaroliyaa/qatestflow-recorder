import React from 'react'

// =====================================================================
// TraceViewerModal — lifted out of App.tsx verbatim.
//
// Was an inline {cond && (…)} block inside the workspace return. Props are
// destructured under the names the markup already used; the open condition is
// re-expressed as an early return, because a component that simply returns the
// JSX would render ALWAYS.
// =====================================================================

export interface TraceViewerModalProps {
  closeTrace: () => void
  saveTraceRecording: () => Promise<void>
  selectTraceStep: (pos: number) => void
  traceImg: string | null
  traceSavedAt: string | null
  traceStepIdx: number
  traceView: TraceManifest | null
}

export function TraceViewerModal({
  closeTrace,
  saveTraceRecording,
  selectTraceStep,
  traceImg,
  traceSavedAt,
  traceStepIdx,
  traceView
}: TraceViewerModalProps): React.JSX.Element | null {
  if (!(traceView)) return null
  return (
        <div className="modal-backdrop" onClick={closeTrace}>
          <div className="trace-modal" onClick={(e) => e.stopPropagation()}>
            <div className="trace-header">
              <span className="trace-title">
                ⏺ Run recording{traceView.testName ? ` — ${traceView.testName}` : ''}
              </span>
              <span className={`trace-result ${traceView.ok ? 'ok' : 'fail'}`}>
                {traceView.ok ? '✓ passed' : '✗ failed'}
              </span>
              <span className="trace-when">{new Date(traceView.at).toLocaleString()}</span>
              {traceSavedAt ? (
                <span className="trace-saved" title={traceSavedAt}>
                  ✓ saved
                </span>
              ) : (
                <button
                  type="button"
                  className="trace-save"
                  onClick={saveTraceRecording}
                  title="Copy this recording to a folder you choose"
                >
                  💾 Save recording
                </button>
              )}
              <button className="trace-close" onClick={closeTrace} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="trace-body">
              <ol className="trace-steps">
                {traceView.steps.map((s, pos) => (
                  <li
                    key={pos}
                    className={`trace-step ${s.status}${pos === traceStepIdx ? ' active' : ''}`}
                    onClick={() => selectTraceStep(pos)}
                  >
                    <span className="trace-step-num">{s.index + 1}</span>
                    {s.thumbData ? (
                      <img className="trace-thumb" src={s.thumbData} alt="" />
                    ) : (
                      <span className="trace-thumb empty" />
                    )}
                    <span className="trace-step-text">{s.text}</span>
                    <span className={`trace-dot ${s.status}`} />
                  </li>
                ))}
              </ol>
              <div className="trace-preview">
                {(() => {
                  const step = traceView.steps[traceStepIdx]
                  if (!step) return null
                  return (
                    <>
                      <div className="trace-preview-head">
                        <span className="trace-preview-title">
                          Step {step.index + 1}: {step.text}
                        </span>
                        <span className="trace-preview-meta">
                          {step.durationMs} ms · {step.status}
                        </span>
                      </div>
                      {step.error && <div className="trace-error">{step.error}</div>}
                      <div className="trace-shot">
                        {traceImg ? (
                          <img src={traceImg} alt="step screenshot" />
                        ) : (
                          <span className="trace-shot-loading">
                            {step.screenshotFile
                              ? 'Loading screenshot…'
                              : step.status === 'pending'
                                ? "This step didn't run — the run stopped before reaching it."
                                : step.status === 'skipped'
                                  ? 'This step was skipped — it did not run.'
                                  : 'No screenshot for this step'}
                          </span>
                        )}
                      </div>
                      {(step.consoleErrors.length > 0 || step.networkErrors.length > 0) && (
                        <div className="trace-evidence">
                          {step.consoleErrors.length > 0 && (
                            <div className="trace-ev-block">
                              <div className="trace-ev-label">Console</div>
                              {step.consoleErrors.map((l, i) => (
                                <div key={i} className="trace-ev-line">
                                  {l}
                                </div>
                              ))}
                            </div>
                          )}
                          {step.networkErrors.length > 0 && (
                            <div className="trace-ev-block">
                              <div className="trace-ev-label">Network</div>
                              {step.networkErrors.map((l, i) => (
                                <div key={i} className="trace-ev-line">
                                  {l}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      <div className="trace-file-actions">
                        {step.screenshotFile && (
                          <button
                            type="button"
                            onClick={() =>
                              window.api.trace.openFile(traceView.id, step.screenshotFile!)
                            }
                          >
                            🖼 Open full image
                          </button>
                        )}
                        {step.domFile && (
                          <button
                            type="button"
                            onClick={() => window.api.trace.openFile(traceView.id, step.domFile!)}
                          >
                            {'</>'} Open page HTML
                          </button>
                        )}
                      </div>
                    </>
                  )
                })()}
              </div>
            </div>
          </div>
        </div>
  )
}
