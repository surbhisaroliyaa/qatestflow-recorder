import React from 'react'
import type { HealableFail, SuiteRunState } from '../suiteTypes'
import { CATEGORY_LABELS, CATEGORY_WHY } from '../uiLabels'
import { collidesWithOsEnv } from '../../../shared/osEnvNames'

// =====================================================================
// The suite-run report — the summary shown after a Run All / parallel batch.
//
// Lifted out of App.tsx verbatim: every prop is destructured under the name the
// markup already used, so the move cannot change behaviour by renaming. At ~380
// lines it was the single largest block in that file.
//
// It is a fragment (<>…</>) rather than a modal because it renders several
// sibling pieces — the summary dialog, the healed-selectors prompt and the
// review list — each with its own open/closed condition.
// =====================================================================

export interface SuiteReportProps {
  suiteRun: SuiteRunState | null
  setSuiteRun: React.Dispatch<React.SetStateAction<SuiteRunState | null>>
  suiteSummaryOpen: boolean
  savedTests: SavedTestSummary[]
  parallelMode: boolean
  parallelWorkers: number
  parallelNote: string | null
  parallelSkipReasons: React.MutableRefObject<Map<string, string>>
  sessionAge: (file?: string) => { expired: boolean; text: string } | null
  handleLoadTest: (fileName: string) => Promise<void>
  handleRunSuite: (
    suite: string,
    tests: SavedTestSummary[],
    opts?: { forceSequential?: boolean }
  ) => Promise<void>
  handleCopySuiteReport: () => void
  handleSaveSuiteReport: () => Promise<void>
  handleSaveAllHealed: () => Promise<void>
  handleAcceptHealable: (hf: HealableFail) => Promise<void>
  handleAcceptAllHealable: () => Promise<void>
}

export function SuiteReport({
  suiteRun,
  setSuiteRun,
  suiteSummaryOpen,
  savedTests,
  parallelMode,
  parallelWorkers,
  parallelNote,
  parallelSkipReasons,
  sessionAge,
  handleLoadTest,
  handleRunSuite,
  handleCopySuiteReport,
  handleSaveSuiteReport,
  handleSaveAllHealed,
  handleAcceptHealable,
  handleAcceptAllHealable
}: SuiteReportProps): React.JSX.Element {
  return (
    <>
        {
          /* Day 11.5 + B: the suite-run REPORT — only once the run has FINISHED
             (suiteSummaryOpen). Without that gate it pops open mid-run and covers
             the live progress. */
          suiteSummaryOpen &&
          suiteRun &&
          (() => {
            const r = suiteRun.results
            const passed = r.filter((x) => x.status === 'passed').length
            const failed = r.length - passed
            const healedCount = r.reduce((s, x) => s + (x.healed ?? 0), 0)
            const healedSaves = suiteRun.healedSaves ?? []
            const byCat = new Map<string, number>()
            for (const x of r) {
              if (x.status === 'failed') {
                const c = x.category ?? 'unknown'
                byCat.set(c, (byCat.get(c) ?? 0) + 1)
              }
            }
            const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1])
            return (
              <div className="modal-backdrop" onClick={() => setSuiteRun(null)}>
                <div className="modal" onClick={(e) => e.stopPropagation()}>
                  <div className="modal-header">
                    <span className="modal-title">
                      {suiteRun.suite}: {passed} passed, {failed} failed
                      {healedCount ? ` · ${healedCount} auto-healed` : ''}
                    </span>
                    <button
                      className="modal-close"
                      onClick={() => setSuiteRun(null)}
                      aria-label="Close"
                    >
                      ✕
                    </button>
                  </div>

                  {/* F39: which engine ran what. A parallel result comes from the
                      exported spec, so it carries none of the in-app resilience —
                      the reader has to be able to tell the two apart. */}
                  {(() => {
                    const par = r.filter((x) => x.ranParallel).length
                    const skipped = r.filter(
                      (x) => !x.ranParallel && parallelSkipReasons.current.has(x.fileName)
                    )
                    // F39.1: the failures that came from the HEADLESS runner, as
                    // library entries so they can be handed straight back to
                    // handleRunSuite. A test missing from the library (deleted
                    // mid-run) is dropped rather than crashing the report.
                    const parFailedFiles = new Set(
                      r.filter((x) => x.ranParallel && x.status === 'failed').map((x) => x.fileName)
                    )
                    const parFailed = savedTests.filter((t) => parFailedFiles.has(t.fileName))
                    if (!parallelMode && !parallelNote) return null
                    return (
                      <div className="parallel-summary">
                        {parallelNote ? (
                          <div className="parallel-warn">⚠ {parallelNote}</div>
                        ) : (
                          <div>
                            ⚡ <strong>{par}</strong> ran in parallel ({parallelWorkers} at a time,
                            headless Playwright) · <strong>{r.length - par}</strong> ran in the app.
                          </div>
                        )}
                        {skipped.length > 0 && (
                          <details className="parallel-skips">
                            <summary>
                              {skipped.length} test{skipped.length === 1 ? '' : 's'} couldn’t run in
                              parallel — why?
                            </summary>
                            <ul>
                              {skipped.map((x) => (
                                <li key={x.fileName}>
                                  <strong>{x.name}</strong> —{' '}
                                  {parallelSkipReasons.current.get(x.fileName)}
                                </li>
                              ))}
                            </ul>
                            <p>
                              These ran the normal way instead. Running them headless would have
                              skipped those checks and still come back green — a false pass.
                            </p>
                          </details>
                        )}
                        {/* F39.1: the OTHER direction — a false FAIL.
                            headlessBlockers catches steps that would silently
                            check nothing headless. It cannot catch a test that
                            depends on SELF-HEAL, because healing happens when a
                            selector misses at RUNTIME — nothing static can
                            predict it. Surbhi's three F4 heal demos passed in the
                            app and timed out here, for exactly that reason.
                            So instead of pretending we can filter them out up
                            front, say it plainly and make re-checking one click. */}
                        {parFailed.length > 0 && (
                          <div className="parallel-recheck">
                            <div>
                              ⚠ <strong>{parFailed.length}</strong> failed headless. The headless
                              runner has <strong>no self-heal and no recovery pause</strong> — a
                              test that leans on either fails here but passes in the app.
                            </div>
                            <button
                              type="button"
                              className="modal-btn"
                              onClick={() => {
                                setSuiteRun(null)
                                handleRunSuite(
                                  `${parFailed.length} failed test${parFailed.length === 1 ? '' : 's'}`,
                                  parFailed,
                                  { forceSequential: true }
                                )
                              }}
                              title="Replay just these in the app, where self-heal and the recovery pause exist"
                            >
                              ↻ Re-run {parFailed.length} in the app
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })()}

                  {/* F39.2: any test in this run that started from a session
                      which has already expired. Shown whether it passed or
                      failed — a PASS is the dangerous case, because in the app
                      it rides on the embedded browser still being logged in
                      from ordinary use, and nothing else will be. */}
                  {(() => {
                    const stale = r
                      .map((x) => savedTests.find((t) => t.fileName === x.fileName))
                      .filter(
                        (t): t is SavedTestSummary =>
                          !!t?.storageState && !!sessionAge(t.storageState)?.expired
                      )
                    if (!stale.length) return null
                    const files = [...new Set(stale.map((t) => t.storageState!))]
                    return (
                      <div className="parallel-recheck session-stale">
                        <div>
                          ⚠ <strong>{stale.length}</strong> test
                          {stale.length === 1 ? '' : 's'} started from a session that has{' '}
                          <strong>{sessionAge(files[0])?.text}</strong> ({files.join(', ')}). In the
                          app these can still pass on the browser&apos;s leftover login — headless
                          and in CI they will not. Log in again and save over the session.
                        </div>
                      </div>
                    )
                  })()}

                  {/* B: failures grouped by cause (the suite-level triage view). */}
                  {cats.length > 0 && (
                    <div className="failure-breakdown">
                      <span className="failure-breakdown-label">Failures by type:</span>
                      {cats.map(([c, n]) => (
                        <span
                          key={c}
                          className={`category-chip cat-${c}`}
                          title={CATEGORY_WHY[c as FailureCategory] ?? ''}
                        >
                          {CATEGORY_LABELS[c as FailureCategory] ?? c} <strong>{n}</strong>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* F25: {{env:NAME}} tokens that resolved to nothing in this run.
                      ABOVE the per-test rows on purpose — it explains failures the
                      classifier can only describe. A test whose username token was
                      empty fails as "Expected URL to contain /inventory.html" and
                      gets tagged "stale data": plausible, and pointing at entirely
                      the wrong thing. Listed once with the affected tests rather
                      than repeated on every row. */}
                  {(() => {
                    const byVar = new Map<string, string[]>()
                    for (const r of suiteRun.results) {
                      for (const v of r.unresolvedEnv ?? []) {
                        byVar.set(v, [...(byVar.get(v) ?? []), r.name])
                      }
                    }
                    if (!byVar.size) return null
                    return (
                      <div className="edge-warn edge-warn-block">
                        ⚠ {byVar.size} environment {byVar.size === 1 ? 'variable' : 'variables'} had
                        no value in this run — every step using{' '}
                        {byVar.size === 1 ? 'it' : 'them'} typed an{' '}
                        <strong>empty string</strong>, so a failure below may be about the
                        environment rather than the test.
                        <ul className="env-missing-list">
                          {[...byVar.entries()].map(([v, tests]) => (
                            <li key={v}>
                              <code>{`{{env:${v}}}`}</code> — {tests.length}{' '}
                              {tests.length === 1 ? 'test' : 'tests'}: {tests.join(', ')}
                              {collidesWithOsEnv(v) && (
                                <>
                                  {' '}
                                  <em>
                                    (never read from the operating system, which defines this name
                                    too — that would supply your account name instead of a test
                                    value)
                                  </em>
                                </>
                              )}
                            </li>
                          ))}
                        </ul>
                        Set {byVar.size === 1 ? 'it' : 'them'} in the environment you ran against,
                        or pick one that defines {byVar.size === 1 ? 'it' : 'them'}.
                      </div>
                    )
                  })()}

                  {/* B: heal review — persist every auto-healed selector in one click. */}
                  {healedSaves.length > 0 && (
                    <div className={`blast-radius${suiteRun.healedSaved ? ' blast-radius-safe' : ''}`}>
                      {suiteRun.healedSaved ? (
                        <span className="blast-radius-head">
                          ✓ Saved {healedCount} repaired selector{healedCount > 1 ? 's' : ''} across{' '}
                          {healedSaves.length} test{healedSaves.length > 1 ? 's' : ''}.
                        </span>
                      ) : (
                        <>
                          <span className="blast-radius-head">
                            🤖 {healedCount} selector{healedCount > 1 ? 's' : ''} auto-healed across{' '}
                            {healedSaves.length} test{healedSaves.length > 1 ? 's' : ''} — keep the
                            fixes:
                          </span>
                          <ul className="blast-list">
                            {healedSaves.map((h) => (
                              <li key={h.fileName}>{h.name}</li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  )}

                  {/* Option 2: failed tests self-heal COULD fix — review & accept.
                      We never auto-applied these (a low-confidence heal that "works"
                      could be a false pass); a human confirms before they go green. */}
                  {(suiteRun.healables ?? []).length > 0 && (
                    <div className="healable-review">
                      <div className="healable-head">
                        🔧 {suiteRun.healables!.length} failed test
                        {suiteRun.healables!.length > 1 ? 's' : ''} could be self-healed — review before
                        accepting (a low-confidence heal may target the wrong element):
                      </div>
                      <ul className="blast-list">
                        {suiteRun.healables!.map((hf) => {
                          const accepted = suiteRun.accepted?.includes(hf.fileName)
                          return (
                            <li key={hf.fileName} className="healable-row">
                              <span>
                                <strong>{hf.name}</strong> → suggests “{hf.healable.label}”{' '}
                                <span className="healable-meta">
                                  ({hf.healable.signals.join(' + ')} · {hf.healable.score}/100)
                                </span>
                              </span>
                              {accepted ? (
                                <span className="healable-accepted">✓ accepted</span>
                              ) : (
                                <span className="healable-actions">
                                  <button
                                    type="button"
                                    className="modal-btn"
                                    onClick={() => handleLoadTest(hf.fileName)}
                                    title="Open the test to replay + verify the fix yourself"
                                  >
                                    Open
                                  </button>
                                  {!hf.hasBlocks && (
                                    <button
                                      type="button"
                                      className="modal-btn"
                                      onClick={() => handleAcceptHealable(hf)}
                                      title="Trust this heal — patch the selector and save"
                                    >
                                      Accept &amp; save
                                    </button>
                                  )}
                                </span>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                      {suiteRun.healables!.some(
                        (hf) => !hf.hasBlocks && !suiteRun.accepted?.includes(hf.fileName)
                      ) && (
                        <button
                          type="button"
                          className="modal-btn"
                          onClick={handleAcceptAllHealable}
                        >
                          Accept &amp; save all
                        </button>
                      )}
                    </div>
                  )}

                  <ul className="suite-summary">
                    {r.map((x) => (
                      <li key={x.fileName} className="suite-result">
                        <span className={`run-dot ${x.status}`} />
                        <span className="suite-result-name">{x.name}</span>
                        {/* Only when the name is ambiguous — two sections can
                            hold a test with the SAME name, and without this one
                            passing and one failing reads as a contradiction. */}
                        {r.filter((o) => o.name === x.name).length > 1 &&
                          x.fileName.includes('/') && (
                            <span className="suite-result-section">
                              {x.fileName.slice(0, x.fileName.lastIndexOf('/'))}
                            </span>
                          )}
                        {x.healed ? (
                          <span className="healed-tag ai-healed-tag">🤖 {x.healed}</span>
                        ) : null}
                        {x.status === 'failed' && x.category && (
                          <span
                            className={`category-chip cat-${x.category}`}
                            title={CATEGORY_WHY[x.category] ?? ''}
                          >
                            {CATEGORY_LABELS[x.category] ?? x.category}
                          </span>
                        )}
                        {/* F39.1: a red from the headless runner is NOT the same
                            claim as a red from the app — no self-heal, no
                            recovery pause. Mark it on the row, so the reader
                            never has to remember which engine ran what. */}
                        {x.status === 'failed' && x.ranParallel && (
                          <span
                            className="headless-tag"
                            title="Ran headless in the parallel batch — no self-heal, no recovery pause. Re-run it in the app to confirm."
                          >
                            ⚡ headless
                          </span>
                        )}
                        {x.status === 'failed' && (
                          <span className="suite-result-error">
                            {x.failedAt !== undefined ? `step ${x.failedAt + 1} — ` : ''}
                            {x.error}
                          </span>
                        )}
                        {x.screenshotPath && (
                          <button
                            type="button"
                            className="shot-link"
                            onClick={() => window.api.library.openScreenshot(x.screenshotPath!)}
                            title="Open the failure screenshot"
                          >
                            📷
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>

                  <div className="modal-footer">
                    {/* Both numbers, because they differ and the banner above shows
                        the other one: N selectors were repaired, spread across M
                        test FILES, and saving writes the files. A bare "(3)" under
                        a "10 selectors auto-healed" heading reads like 7 fixes are
                        being dropped. */}
                    {healedSaves.length > 0 && !suiteRun.healedSaved && (
                      <button className="modal-btn primary" onClick={handleSaveAllHealed}>
                        💾 Save {healedSaves.length} test{healedSaves.length > 1 ? 's' : ''} (
                        {healedCount} fix{healedCount > 1 ? 'es' : ''})
                      </button>
                    )}
                    <button className="modal-btn" onClick={handleCopySuiteReport}>
                      Copy report
                    </button>
                    <button className="modal-btn" onClick={handleSaveSuiteReport}>
                      Save .md
                    </button>
                    <button className="modal-btn" onClick={() => setSuiteRun(null)}>
                      Close
                    </button>
                  </div>
                </div>
              </div>
            )
          })()}
    </>
  )
}
