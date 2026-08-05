import React from 'react'
import { CATEGORY_LABELS, VERDICT_LABELS } from '../uiLabels'
import { isThirdPartyLine, siteFirstLines } from '../uiFormat'

// =====================================================================
// AnalysisModal — lifted out of App.tsx verbatim.
//
// Was an inline {cond && (…)} block inside the workspace return. Props are
// destructured under the names the markup already used; the open condition is
// re-expressed as an early return, because a component that simply returns the
// JSX would render ALWAYS.
// =====================================================================

export interface AnalysisModalProps {
  analysis: FailureAnalysis | null
  analysisOpen: boolean
  analyzing: boolean
  bugReport: string | null
  closeAnalysis: () => void
  handleCopyReport: () => void
  handleDeepRca: () => Promise<void>
  handleGenerateReport: () => void
  handleOpenJira: () => void
  handleSaveReport: () => Promise<void>
  isDeep: boolean
  lastEvidence: FailureEvidence | null
  lastTraceId: string | null
  reportSavedPath: string | null
  setBugReport: React.Dispatch<React.SetStateAction<string | null>>
}

export function AnalysisModal({
  analysis,
  analysisOpen,
  analyzing,
  bugReport,
  closeAnalysis,
  handleCopyReport,
  handleDeepRca,
  handleGenerateReport,
  handleOpenJira,
  handleSaveReport,
  isDeep,
  lastEvidence,
  lastTraceId,
  reportSavedPath,
  setBugReport
}: AnalysisModalProps): React.JSX.Element | null {
  if (!(analysisOpen)) return null
  return (
        <div className="modal-backdrop" onClick={closeAnalysis}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">
                {bugReport ? '🐞 Bug report' : '💡 Failure analysis'}
              </span>
              <button className="modal-close" onClick={closeAnalysis} aria-label="Close">
                ✕
              </button>
            </div>
            {bugReport ? (
              <pre className="modal-code">
                <code>{bugReport}</code>
              </pre>
            ) : analyzing ? (
              <div className="analysis-body">
                <p className="analysis-waiting">
                  {isDeep
                    ? '🔬 Deep RCA — reading the whole trace and every step screenshot to find the root cause. This takes longer than a normal explain…'
                    : 'Analyzing the failure… asking Claude first — if it isn’t available, this falls back to the built-in rules automatically.'}
                </p>
              </div>
            ) : analysis ? (
              <div className="analysis-body">
                <div className="analysis-meta">
                  <span className={`verdict-chip ${analysis.verdict}`}>
                    {VERDICT_LABELS[analysis.verdict] ?? analysis.verdict}
                  </span>
                  {analysis.category && (
                    <span className={`category-chip cat-${analysis.category}`}>
                      {CATEGORY_LABELS[analysis.category] ?? analysis.category}
                    </span>
                  )}
                  <span className="analysis-source">
                    {isDeep && <span className="deep-badge">🔬 Deep RCA · </span>}
                    {analysis.source === 'ai'
                      ? 'analyzed by Claude'
                      : 'built-in rules (Claude unavailable)'}
                  </span>
                </div>
                <p className="analysis-text">{analysis.explanation}</p>
                {analysis.impact && (
                  <p className="analysis-impact">
                    <strong>Impact:</strong> {analysis.impact}
                  </p>
                )}
                {analysis.suggestion && (
                  <p className="analysis-suggestion">→ {analysis.suggestion}</p>
                )}
                {lastEvidence &&
                (lastEvidence.consoleErrors.length > 0 || lastEvidence.networkErrors.length > 0) ? (
                  <div className="analysis-evidence">
                    {lastEvidence.consoleErrors.length > 0 && (
                      <>
                        <span className="evidence-title">
                          Console errors ({lastEvidence.consoleErrors.length})
                        </span>
                        <pre className="evidence-lines">
                          {lastEvidence.consoleErrors.slice(0, 6).join('\n')}
                        </pre>
                      </>
                    )}
                    {lastEvidence.networkErrors.length > 0 && (
                      <>
                        <span className="evidence-title">
                          Network problems ({lastEvidence.networkErrors.length})
                        </span>
                        <div className="evidence-lines">
                          {siteFirstLines(lastEvidence.networkErrors)
                            .slice(0, 6)
                            .map((line, li) => (
                              <div
                                key={li}
                                className={`evidence-line${isThirdPartyLine(line) ? ' dim' : ''}`}
                              >
                                {line}
                              </div>
                            ))}
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <p className="analysis-noevidence">
                    No console or network errors were captured during this run.
                  </p>
                )}
              </div>
            ) : null}
            <div className="modal-footer">
              {bugReport ? (
                <>
                  {reportSavedPath && (
                    <span className="saved-path">Saved to {reportSavedPath}</span>
                  )}
                  <button className="modal-btn" onClick={() => setBugReport(null)}>
                    ← Analysis
                  </button>
                  <button className="modal-btn" onClick={handleCopyReport}>
                    Copy
                  </button>
                  {/* F34: turn this failure into a Jira ticket. */}
                  <button
                    className="modal-btn"
                    onClick={handleOpenJira}
                    title="Create a Jira ticket from this failure — pre-filled summary + the whole report as the description. Push it via API, or copy + open Jira's create page."
                  >
                    🎫 Jira
                  </button>
                  <button
                    className="modal-btn primary"
                    onClick={handleSaveReport}
                    title="Save as Markdown — paste into GitHub, Jira, Slack, a wiki, or Claude"
                  >
                    Save .md
                  </button>
                </>
              ) : (
                <>
                  <button className="modal-btn" onClick={closeAnalysis}>
                    Close
                  </button>
                  {/* F9 Stage 3: opt-in deep root-cause over the whole trace —
                      only when a run trace was kept, and not mid-analysis. */}
                  {lastTraceId && !analyzing && (
                    <button
                      className="modal-btn"
                      onClick={handleDeepRca}
                      title="Deep RCA: feed the WHOLE run trace — every step's screenshot, DOM, console/network — to Claude to find a root cause that may be earlier than where it failed. Slower; uses the saved trace."
                    >
                      🔬 Deep RCA
                    </button>
                  )}
                  <button
                    className="modal-btn primary"
                    onClick={handleGenerateReport}
                    disabled={analyzing || !lastEvidence}
                    title="Turn this failure into a ready-to-paste markdown bug report"
                  >
                    🐞 Generate bug report
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
  )
}
