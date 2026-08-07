import React from 'react'

// =====================================================================
// RecoveryPanel — lifted out of App.tsx verbatim.
//
// Was an inline {cond && (…)} block inside the workspace return. Props are
// destructured under the names the markup already used; the open condition is
// re-expressed as an early return, because a component that simply returns the
// JSX would render ALWAYS.
// =====================================================================

export interface RecoveryPanelProps {
  answerRecovery: (action: 'retry' | 'continue' | 'skip' | 'stop') => void
  applyHeal: (picked: PickedElement, healIndex: number) => void
  handleExplain: (
    index: number,
    error: string,
    screenshotPath: string | null | undefined,
    consoleErrors: string[],
    networkErrors: string[],
    apiEvidence?: ApiEvidence
  ) => Promise<void>
  handleRecoveryRepick: () => Promise<void>
  handleRecoveryRepickCancel: () => Promise<void>
  handleRecoveryRetry: () => void
  handleRecoverySkipStep: () => void
  openTrace: (id: string) => Promise<void>
  recovery: ReplayPaused | null
  recoveryWarning: string | null
  repickIndex: number | null
  repickPending: {
picked: PickedElement
healIndex: number
message: string
} | null
  retryIsUnsafe: (i: number) => boolean
  setRepickPending: React.Dispatch<React.SetStateAction<{
picked: PickedElement
healIndex: number
message: string
} | null>>
  steps: RecorderStep[]
}

export function RecoveryPanel({
  answerRecovery,
  applyHeal,
  handleExplain,
  handleRecoveryRepick,
  handleRecoveryRepickCancel,
  handleRecoveryRetry,
  handleRecoverySkipStep,
  openTrace,
  recovery,
  recoveryWarning,
  repickIndex,
  repickPending,
  retryIsUnsafe,
  setRepickPending,
  steps
}: RecoveryPanelProps): React.JSX.Element | null {
  if (!(recovery)) return null
  return (
            <div className="assert-panel recovery-panel">
              <div className="assert-target">
                <span className="assert-title recovery-title">
                  ✗ Step {recovery.index + 1} failed — paused
                </span>
                {steps[recovery.index]?.label && (
                  <span className="assert-label">{steps[recovery.index].label}</span>
                )}
              </div>
              <code className="assert-selector recovery-error">{recovery.error}</code>
              {recoveryWarning && <div className="pick-warning">⚠ {recoveryWarning}</div>}
              {repickPending ? (
                <>
                  {/* Day 17: the pick looks different from the original — confirm */}
                  <div className="pick-warning">⚠ {repickPending.message}</div>
                  <div className="assert-actions recovery-actions">
                    <button className="modal-btn" onClick={() => setRepickPending(null)}>
                      Cancel
                    </button>
                    <button
                      className="modal-btn primary"
                      onClick={() => applyHeal(repickPending.picked, repickPending.healIndex)}
                    >
                      Heal anyway
                    </button>
                  </div>
                </>
              ) : repickIndex !== null ? (
                <div className="assert-actions recovery-actions">
                  <span className="recovery-hint">
                    Click the correct element in the page (Esc cancels)
                  </span>
                  <button className="modal-btn" onClick={handleRecoveryRepickCancel}>
                    Cancel re-pick
                  </button>
                </div>
              ) : (
                <>
                  {/* Day 18 (self-heal): the app auto-found a likely match for
                      the broken step by its label — one click to accept it.
                      Day 21 (ambiguity guard): if that label matched SEVERAL
                      equally-good elements (e.g. many "Add to cart" buttons),
                      "the best match" is just the first in DOM order and may be
                      the wrong one — so we DECLINE the one-click fix and ask for
                      a manual pick instead of silently healing to a guess. */}
                  {recovery.suggestion &&
                    ((recovery.suggestion.ambiguousCount ?? 1) > 1 ? (
                      <div className="self-heal self-heal-ambiguous">
                        <span className="self-heal-text">
                          🔧 Self-heal found <strong>{recovery.suggestion.ambiguousCount}</strong>{' '}
                          elements labelled <strong>“{recovery.suggestion.label}”</strong> — too
                          ambiguous to fix automatically. Use <strong>🎯 Pick manually</strong>{' '}
                          below to choose the right one.
                        </span>
                      </div>
                    ) : (
                      <div className="self-heal">
                        <span className="self-heal-text">
                          🔧 Self-heal found <strong>“{recovery.suggestion.label}”</strong> — use it
                          to fix this step?
                        </span>
                        <button
                          type="button"
                          className="modal-btn primary self-heal-accept"
                          onClick={() => applyHeal(recovery.suggestion!, recovery.index)}
                        >
                          ✓ Accept fix
                        </button>
                      </div>
                    ))}
                  <div className="assert-actions recovery-actions">
                    {recovery.screenshotPath && (
                      <button
                        type="button"
                        className="shot-link"
                        onClick={() => window.api.library.openScreenshot(recovery.screenshotPath!)}
                        title="Open the failure screenshot"
                      >
                        📷
                      </button>
                    )}
                    {/* Day 18: open the full run recording captured up to here */}
                    {recovery.traceId && (
                      <button
                        type="button"
                        className="shot-link trace-link"
                        onClick={() => openTrace(recovery.traceId!)}
                        title="Open the full run recording (every step's screenshot, console & network)"
                      >
                        ⏺
                      </button>
                    )}
                    {/* Day 13: ask for a diagnosis while deciding what to do */}
                    <button
                      type="button"
                      className="shot-link explain-link"
                      onClick={() =>
                        handleExplain(
                          recovery.index,
                          recovery.error,
                          recovery.screenshotPath,
                          recovery.consoleErrors ?? [],
                          recovery.networkErrors ?? [],
                          recovery.apiEvidence // F24: the HTTP exchange, mid-pause
                        )
                      }
                      title="Explain this failure: app bug, test bug, or just timing?"
                    >
                      💡
                    </button>
                    <button
                      className="modal-btn"
                      onClick={handleRecoveryRetry}
                      title={
                        retryIsUnsafe(recovery.index)
                          ? 'Re-sends this POST/PATCH — it may create a duplicate record, so it asks first'
                          : 'Run the same step again (maybe the page was just slow)'
                      }
                    >
                      🔁 Retry{retryIsUnsafe(recovery.index) ? ' ⚠' : ''}
                    </button>
                    {/* Day 19: a visual snapshot differs — if the new look is
                      intended, adopt it as the new baseline, then retry (passes). */}
                    {recovery.visual?.baselineId && (
                      <button
                        className="modal-btn"
                        onClick={async () => {
                          const v = recovery.visual!
                          const ok = await window.api.visual.updateBaseline(
                            v.baselineId!,
                            v.currentPath
                          )
                          if (ok) answerRecovery('retry')
                        }}
                        title="Adopt the current look as the new baseline (the visual change is intended), then retry"
                      >
                        📸 Update baseline
                      </button>
                    )}
                    {/* Day 18: manual pick heals a SELECTOR — only offer it when
                      the selector actually broke (not for assertion/timing
                      failures, where re-picking wouldn't help). */}
                    {recovery.selectorBroke && steps[recovery.index]?.selector && (
                      <button
                        className="modal-btn"
                        onClick={handleRecoveryRepick}
                        title="Point at the right element yourself — heals the selector, then retries"
                      >
                        🎯 Pick manually
                      </button>
                    )}
                    <button
                      className="modal-btn"
                      onClick={() => answerRecovery('continue')}
                      title="Ignore this failure and continue, to check the later steps. The run is still marked failed; the test isn't changed."
                    >
                      ⤵ Continue
                    </button>
                    <button
                      className="modal-btn"
                      onClick={handleRecoverySkipStep}
                      title="Permanently skip this step — disable it now and in future runs. 💾 Save to keep it."
                    >
                      ⊘ Skip step
                    </button>
                    <button
                      className="modal-btn danger"
                      onClick={() => answerRecovery('stop')}
                      title="End the run as failed"
                    >
                      ⏹ Stop
                    </button>
                  </div>
                </>
              )}
            </div>
  )
}
