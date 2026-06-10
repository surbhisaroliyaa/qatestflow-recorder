import { useEffect, useState, type FormEvent } from 'react'
import { generatePlaywrightTest, stepText } from './playwrightExport'

const EXAMPLE_URLS = ['saucedemo.com', 'google.com', 'github.com']

// Day 9: the checks offered by the assertion chooser, in display order.
const ASSERT_KINDS: AssertKind[] = [
  'visible',
  'text-equals',
  'text-contains',
  'value',
  'enabled',
  'disabled'
]
const ASSERT_LABELS: Record<AssertKind, string> = {
  visible: 'Visible',
  'text-equals': 'Text =',
  'text-contains': 'Contains',
  value: 'Value',
  enabled: 'Enabled',
  disabled: 'Disabled'
}
// These kinds compare against an expected value the user can edit.
const assertNeedsValue = (kind: AssertKind): boolean =>
  kind === 'text-equals' || kind === 'text-contains' || kind === 'value'

// The candidate the step's primary selector points at. After a hand-pick the
// primary is no longer necessarily the top-scored candidates[0].
function primaryCandidate(step: RecorderStep): SelectorCandidate | undefined {
  return step.candidates?.find((c) => c.locator === step.selector) ?? step.candidates?.[0]
}

// Map a stability score (0–100) to a traffic-light class for the dot.
function stabilityClass(score: number | undefined): string {
  if (score === undefined) return ''
  if (score >= 80) return 'high'
  if (score >= 50) return 'med'
  return 'low'
}

function App(): React.JSX.Element {
  const [urlInput, setUrlInput] = useState('')
  const [hasNavigated, setHasNavigated] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [steps, setSteps] = useState<RecorderStep[]>([])
  // The generated Playwright code shown in the export modal (null = closed).
  const [exportCode, setExportCode] = useState<string | null>(null)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  // Replay state: which step is running, which finished, which failed + why.
  const [isReplaying, setIsReplaying] = useState(false)
  const [replayingIndex, setReplayingIndex] = useState<number | null>(null)
  const [doneIndices, setDoneIndices] = useState<Set<number>>(new Set())
  const [failedIndex, setFailedIndex] = useState<number | null>(null)
  const [replayError, setReplayError] = useState<string | null>(null)
  // Step editor: which step's value is being edited inline (null = none) + its
  // working text. Editing is only allowed when not recording / not replaying.
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')
  // Candidate transparency (Day 10c): which step's full selector ladder is
  // expanded under its row (null = all collapsed).
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)
  // Day 9: element picking + assertion authoring. `insertAt` is where the new
  // step will land (null = append at the end); `pickedElement` being non-null
  // opens the assertion chooser panel.
  const [isPicking, setIsPicking] = useState(false)
  const [pickedElement, setPickedElement] = useState<PickedElement | null>(null)
  const [assertKind, setAssertKind] = useState<AssertKind>('visible')
  const [assertValue, setAssertValue] = useState('')
  const [insertAt, setInsertAt] = useState<number | null>(null)
  // Which row's "insert here" mini-menu is open (null = none).
  const [insertMenuIndex, setInsertMenuIndex] = useState<number | null>(null)

  // Steps left ON (disabled steps are skipped by replay + export).
  const enabledCount = steps.filter((s) => !s.disabled).length

  // Sync the URL bar whenever the embedded browser navigates.
  // Mark hasNavigated true so we switch from welcome -> chrome view.
  useEffect(() => {
    const unsubscribe = window.api.browser.onUrlChange((url) => {
      if (!url.startsWith('data:')) {
        setUrlInput(url)
        setHasNavigated(true)
        // A navigation reloads the page — and with it, the observer's pick
        // flag. Whatever we were pointing at no longer exists; end pick mode.
        setIsPicking(false)
      }
    })
    return unsubscribe
  }, [])

  // Day 9: a picked element arrives — close pick mode, open the assertion
  // chooser prefilled with the element's live text.
  useEffect(() => {
    const unsubscribe = window.api.recorder.onPicked((picked) => {
      setIsPicking(false)
      setPickedElement(picked)
      setAssertKind('visible')
      setAssertValue(picked.text ?? '')
    })
    return unsubscribe
  }, [])

  // The user pressed Esc inside the page — pick mode ended without a pick.
  useEffect(() => window.api.recorder.onPickCancel(() => setIsPicking(false)), [])

  // Append every recorded step to the live list as it arrives from main.
  useEffect(() => {
    const unsubscribe = window.api.recorder.onStep((step) => {
      setSteps((prev) => [...prev, step])
    })
    return unsubscribe
  }, [])

  // The embedded browser is a native pane that paints over our UI, so while the
  // export modal is open we ask main to hide it (else it covers the modal).
  useEffect(() => {
    window.api.browser.setOverlay(exportCode !== null)
  }, [exportCode])

  // Follow replay progress so we can highlight running / done / failed steps.
  useEffect(() => {
    const unsubscribe = window.api.recorder.onReplayProgress((p) => {
      if (p.status === 'running') setReplayingIndex(p.index)
      else if (p.status === 'done') setDoneIndices((prev) => new Set(prev).add(p.index))
      else if (p.status === 'error') setFailedIndex(p.index)
    })
    return unsubscribe
  }, [])

  // Toggle recording. We no longer wipe on start — if steps already exist we
  // RESUME (append new steps to the end). Use the 🗑 Clear button to start over.
  // Starting any recording clears the previous replay's pass/fail marks.
  const handleRecordToggle = async (): Promise<void> => {
    const resume = !isRecording && steps.length > 0
    if (!isRecording) {
      setDoneIndices(new Set())
      setFailedIndex(null)
      setReplayError(null)
      setReplayingIndex(null)
      setEditingIndex(null)
    }
    const nowRecording = await window.api.recorder.toggle(resume)
    setIsRecording(nowRecording)
  }

  // Wipe the whole step list for a genuinely fresh start (asks first, since
  // it can't be undone). Only offered when not recording / replaying.
  const handleClearSteps = (): void => {
    if (steps.length === 0) return
    if (!window.confirm(`Clear all ${steps.length} steps and start over?`)) return
    editSteps([])
  }

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault()
    const trimmed = urlInput.trim()
    if (!trimmed) return
    setHasNavigated(true)
    window.api.browser.navigate(trimmed)
  }

  // Click a suggested example chip to navigate immediately
  const handleExampleClick = (url: string): void => {
    setUrlInput(url)
    setHasNavigated(true)
    window.api.browser.navigate(url)
  }

  // Smart back: if the embedded browser has no more history, go to welcome
  const handleBack = async (): Promise<void> => {
    const didGoBack = await window.api.browser.goBack()
    if (!didGoBack) {
      setHasNavigated(false)
      setUrlInput('')
    }
  }

  // Home: one click straight back to the welcome screen — a fresh start, so
  // stop recording and clear the captured steps too.
  const handleHome = async (): Promise<void> => {
    await window.api.browser.home()
    setHasNavigated(false)
    setUrlInput('')
    setIsRecording(false)
    setSteps([])
  }

  // Export: generate the Playwright code and open the preview modal.
  const handleExport = (): void => {
    setSavedPath(null)
    setExportCode(generatePlaywrightTest(steps))
  }

  // Save the previewed code to a .ts file (main shows the OS save dialog).
  const handleSaveExport = async (): Promise<void> => {
    if (!exportCode) return
    const path = await window.api.recorder.exportTest(exportCode)
    if (path) setSavedPath(path)
  }

  const handleCopyExport = (): void => {
    if (exportCode) navigator.clipboard.writeText(exportCode)
  }

  // Replay: run all recorded steps in the embedded browser and watch them go.
  const handleReplay = async (): Promise<void> => {
    setFailedIndex(null)
    setReplayError(null)
    setDoneIndices(new Set())
    setReplayingIndex(null)
    setIsReplaying(true)
    const result = await window.api.recorder.replay(steps)
    setIsReplaying(false)
    setReplayingIndex(null)
    if (!result.ok) {
      setFailedIndex(result.failedAt ?? null)
      setReplayError(result.error ?? 'Replay failed')
    }
  }

  // === No-code step editor ==========================================
  // Every edit changes the single source of truth — the `steps` array. It also
  // clears the last replay's pass/fail marks (they no longer describe the new
  // list) and closes any open inline edit.
  const editSteps = (next: RecorderStep[]): void => {
    setSteps(next)
    setEditingIndex(null)
    setExpandedIndex(null) // rows may have shifted — an open ladder would lie
    setInsertMenuIndex(null) // same for an open insert-here menu
    setDoneIndices(new Set())
    setFailedIndex(null)
    setReplayError(null)
    setReplayingIndex(null)
  }

  // Day 10(c): hand-pick a selector candidate as the step's primary. The pick
  // is recorded as `pinned` — replay tries the pinned candidate FIRST (before
  // higher-scored ones), and export emits its locator. Picking again later
  // simply moves the pin.
  const handlePickCandidate = (stepIdx: number, candIdx: number): void => {
    const step = steps[stepIdx]
    if (!step.candidates) return
    const candidates = step.candidates.map((c, idx) => ({
      ...c,
      pinned: idx === candIdx || undefined
    }))
    setSteps(
      steps.map((s, idx) =>
        idx === stepIdx ? { ...s, selector: candidates[candIdx].locator, candidates } : s
      )
    )
    // Changing the selector invalidates the last replay's pass/fail marks.
    setDoneIndices(new Set())
    setFailedIndex(null)
    setReplayError(null)
  }

  // Move a step one slot up (dir -1) or down (dir +1) by swapping neighbours.
  const handleMoveStep = (i: number, dir: -1 | 1): void => {
    const j = i + dir
    if (j < 0 || j >= steps.length) return
    const next = steps.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    editSteps(next)
  }

  const handleDeleteStep = (i: number): void => {
    editSteps(steps.filter((_, idx) => idx !== i))
  }

  // Turn a step off/on. A disabled step stays in the list (so you don't lose it)
  // but is skipped by both replay and export.
  const handleToggleDisabled = (i: number): void => {
    editSteps(steps.map((s, idx) => (idx === i ? { ...s, disabled: !s.disabled } : s)))
  }

  // The text an inline edit would change: a navigate edits its URL; a type /
  // select edits its value; a wait edits its seconds; a valued assertion edits
  // its expected text. Clicks have nothing to edit; passwords are never
  // surfaced in a text box. Returns null when the step isn't editable.
  const editableValue = (step: RecorderStep): string | null => {
    if (step.type === 'navigate') return step.url ?? ''
    if (step.secret) return null
    if (step.type === 'type' || step.type === 'select' || step.type === 'wait') {
      return step.value ?? ''
    }
    if (step.type === 'assert' && step.assertKind && assertNeedsValue(step.assertKind)) {
      return step.value ?? ''
    }
    return null
  }

  // === Day 9: picking + assertion authoring =========================
  const handleStartPick = async (at: number | null): Promise<void> => {
    setInsertMenuIndex(null)
    setPickedElement(null)
    setInsertAt(at)
    setIsPicking(true)
    await window.api.recorder.setPicking(true)
  }

  const handleCancelPick = async (): Promise<void> => {
    setIsPicking(false)
    await window.api.recorder.setPicking(false)
  }

  // Insert a finished step at the requested position (null = append).
  const insertStep = (step: RecorderStep, at: number | null): void => {
    const i = at ?? steps.length
    editSteps([...steps.slice(0, i), step, ...steps.slice(i)])
  }

  // Switching check type re-prefills the expected value from the element's
  // live state (its text for text checks, its value for the value check).
  const handleChooseKind = (kind: AssertKind): void => {
    setAssertKind(kind)
    if (!pickedElement) return
    if (kind === 'value') setAssertValue(pickedElement.inputValue ?? '')
    else if (kind === 'text-equals' || kind === 'text-contains') {
      setAssertValue(pickedElement.text ?? '')
    }
  }

  const handleAddAssert = (): void => {
    if (!pickedElement) return
    insertStep(
      {
        type: 'assert',
        assertKind,
        label: pickedElement.label,
        selector: pickedElement.selector,
        candidates: pickedElement.candidates,
        value: assertNeedsValue(assertKind) ? assertValue : undefined
      },
      insertAt
    )
    setPickedElement(null)
    setInsertAt(null)
  }

  const handleAddWait = (at: number | null): void => {
    setInsertMenuIndex(null)
    insertStep({ type: 'wait', value: '2' }, at)
  }

  const handleStartEdit = (i: number): void => {
    const current = editableValue(steps[i])
    if (current === null) return
    setEditValue(current)
    setEditingIndex(i)
  }

  const handleCommitEdit = (): void => {
    if (editingIndex === null) return
    const i = editingIndex
    editSteps(
      steps.map((s, idx) =>
        idx !== i ? s : s.type === 'navigate' ? { ...s, url: editValue } : { ...s, value: editValue }
      )
    )
  }

  // A one-line summary of the last/current replay for the status banner.
  const replayBanner = ((): { tone: string; text: string } | null => {
    if (isReplaying) return { tone: 'running', text: 'Replaying…' }
    if (failedIndex !== null)
      return { tone: 'failed', text: `✗ Failed at step ${failedIndex + 1}: ${replayError}` }
    if (doneIndices.size > 0 && doneIndices.size === enabledCount)
      return { tone: 'passed', text: `✓ All ${enabledCount} steps passed` }
    return null
  })()

  // === Welcome view — shown before any navigation ===
  if (!hasNavigated) {
    return (
      <div className="welcome">
        <div className="welcome-content">
          <h1 className="logo-text">QATestFlow Recorder</h1>
          <p className="tagline">No-code QA test recorder with AI-powered selectors</p>
          <form className="welcome-form" onSubmit={handleSubmit}>
            <input
              type="text"
              className="welcome-input"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="Enter a website URL to test (e.g., saucedemo.com)"
              autoFocus
              spellCheck={false}
            />
            <button type="submit" className="welcome-go-btn">
              Open
            </button>
          </form>
          <div className="examples">
            <span className="examples-label">Try:</span>
            {EXAMPLE_URLS.map((url) => (
              <button
                key={url}
                className="example-chip"
                onClick={() => handleExampleClick(url)}
                type="button"
              >
                {url}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // === Chrome view — shown once user has navigated ===
  return (
    <div className="app">
      <div className="chrome">
        <button className="nav-btn" onClick={handleBack} title="Back" aria-label="Back">
          ←
        </button>
        <button
          className="nav-btn"
          onClick={() => window.api.browser.goForward()}
          title="Forward"
          aria-label="Forward"
        >
          →
        </button>
        <button
          className="nav-btn"
          onClick={() => window.api.browser.reload()}
          title="Reload"
          aria-label="Reload"
        >
          ⟳
        </button>
        <button className="nav-btn" onClick={handleHome} title="Home" aria-label="Home">
          ⌂
        </button>
        <form className="url-form" onSubmit={handleSubmit}>
          <input
            className="url-input"
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="Enter URL or domain..."
            spellCheck={false}
          />
          <button type="submit" className="go-btn">
            Go
          </button>
        </form>
        <button
          className={`check-btn${isPicking ? ' picking' : ''}`}
          onClick={() => (isPicking ? handleCancelPick() : handleStartPick(null))}
          disabled={isReplaying}
          title={
            isPicking
              ? 'Cancel picking (or press Esc)'
              : 'Add a check: pick an element on the page'
          }
        >
          ✓ {isPicking ? 'Picking…' : 'Check'}
        </button>
        <button
          className={`record-btn${isRecording ? ' recording' : ''}`}
          onClick={handleRecordToggle}
          title={
            isRecording
              ? 'Stop recording'
              : steps.length > 0
                ? 'Resume recording — new steps are added to the end'
                : 'Start recording'
          }
        >
          <span className="record-dot" />
          {isRecording ? 'Stop' : steps.length > 0 ? 'Resume' : 'Record'}
        </button>
      </div>

      {/* The browser area is left empty — the native embedded browser is
          painted over it. Only the steps panel on the right shows through. */}
      <div className="workspace">
        <div className="browser-area" />
        <aside className="steps-panel">
          <div className="steps-header">
            <span className="steps-title">
              Steps
              {steps.length > 0 && <span className="steps-count">{steps.length}</span>}
            </span>
            {steps.length > 0 && (
              <div className="steps-actions">
                <button
                  className="replay-btn"
                  onClick={handleReplay}
                  disabled={isReplaying || isRecording || enabledCount === 0}
                  title="Replay these steps in the browser"
                >
                  ▶ {isReplaying ? 'Replaying…' : 'Replay'}
                </button>
                <button
                  className="export-btn"
                  onClick={handleExport}
                  title="Export as Playwright test"
                >
                  {'</>'} Export
                </button>
                <button
                  className="clear-btn"
                  onClick={handleClearSteps}
                  disabled={isReplaying || isRecording}
                  title="Clear all steps and start over"
                  aria-label="Clear all steps"
                >
                  🗑
                </button>
              </div>
            )}
          </div>
          {replayBanner && (
            <div className={`replay-status ${replayBanner.tone}`}>{replayBanner.text}</div>
          )}
          {isPicking && (
            <div className="replay-status running">
              Click an element in the page to check it (Esc cancels)
            </div>
          )}

          {/* === Assertion chooser — opens when an element was picked === */}
          {pickedElement && (
            <div className="assert-panel">
              <div className="assert-target">
                <span className="assert-title">Add check:</span>
                <span className="assert-label">{pickedElement.label}</span>
              </div>
              <code className="assert-selector">{pickedElement.selector}</code>
              <div className="assert-kinds">
                {ASSERT_KINDS.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={`assert-kind${assertKind === kind ? ' chosen' : ''}`}
                    onClick={() => handleChooseKind(kind)}
                  >
                    {ASSERT_LABELS[kind]}
                  </button>
                ))}
              </div>
              {assertNeedsValue(assertKind) && (
                <input
                  className="assert-value"
                  value={assertValue}
                  onChange={(e) => setAssertValue(e.target.value)}
                  placeholder="expected value…"
                  spellCheck={false}
                />
              )}
              <div className="assert-actions">
                <button
                  className="modal-btn"
                  onClick={() => {
                    setPickedElement(null)
                    setInsertAt(null)
                  }}
                >
                  Cancel
                </button>
                <button className="modal-btn primary" onClick={handleAddAssert}>
                  Add check
                </button>
              </div>
            </div>
          )}
          {steps.length === 0 ? (
            <p className="steps-empty">
              {isRecording
                ? 'Recording… interact with the page.'
                : 'Press Record, then use the page to capture steps.'}
            </p>
          ) : (
            <ol className="steps-list">
              {steps.map((step, i) => {
                const editable = editableValue(step) !== null
                const canEdit = !isRecording && !isReplaying
                return (
                  <li
                    key={i}
                    className={`step-item${step.disabled ? ' disabled' : ''}${
                      i === failedIndex
                        ? ' failed'
                        : i === replayingIndex
                          ? ' running'
                          : doneIndices.has(i)
                            ? ' done'
                            : ''
                    }`}
                  >
                    <span className="step-num">{doneIndices.has(i) ? '✓' : i + 1}</span>
                    <div className="step-body">
                      {editingIndex === i ? (
                        <input
                          className="step-edit-input"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={handleCommitEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleCommitEdit()
                            else if (e.key === 'Escape') setEditingIndex(null)
                          }}
                          autoFocus
                          spellCheck={false}
                        />
                      ) : (
                        <span className="step-text">{stepText(step)}</span>
                      )}
                      {step.selector && (
                        <button
                          type="button"
                          className="step-selector"
                          onClick={() => setExpandedIndex(expandedIndex === i ? null : i)}
                          title={`stability ${primaryCandidate(step)?.score ?? '?'}/100 — click to see all ways to find this element`}
                        >
                          <span
                            className={`stability-dot ${stabilityClass(primaryCandidate(step)?.score)}`}
                          />
                          <code>{step.selector}</code>
                          <span className="selector-caret">{expandedIndex === i ? '▾' : '▸'}</span>
                        </button>
                      )}
                      {insertMenuIndex === i && canEdit && (
                        <div className="insert-menu">
                          <button type="button" onClick={() => handleStartPick(i + 1)}>
                            ✓ Add check here
                          </button>
                          <button type="button" onClick={() => handleAddWait(i + 1)}>
                            ⏱ Add 2s wait here
                          </button>
                        </div>
                      )}
                      {expandedIndex === i && step.candidates && step.candidates.length > 0 && (
                        <ul className="candidate-list">
                          {step.candidates
                            // Hide the bare-tag last resort (kind 'css', e.g.
                            // locator('a')): replay refuses to use it, so
                            // offering it as a pick would be a false choice.
                            .map((c, ci) => ({ c, ci }))
                            .filter(({ c }) => c.kind !== 'css')
                            .map(({ c, ci }) => (
                              <li key={ci}>
                                <button
                                  type="button"
                                  className={`candidate${step.selector === c.locator ? ' chosen' : ''}`}
                                  onClick={() => handlePickCandidate(i, ci)}
                                  disabled={!canEdit}
                                  title={
                                    step.selector === c.locator
                                      ? 'Current primary selector'
                                      : 'Use this selector instead'
                                  }
                                >
                                  <span className={`stability-dot ${stabilityClass(c.score)}`} />
                                  <span className="candidate-kind">{c.kind}</span>
                                  <code className="candidate-locator">{c.locator}</code>
                                  <span className="candidate-score">{c.score}</span>
                                  {step.selector === c.locator && (
                                    <span className="candidate-check">✓</span>
                                  )}
                                </button>
                              </li>
                            ))}
                        </ul>
                      )}
                    </div>
                    {canEdit && editingIndex !== i && (
                      <div className="step-actions">
                        <button
                          className="step-action"
                          onClick={() => handleMoveStep(i, -1)}
                          disabled={i === 0}
                          title="Move up"
                          aria-label="Move up"
                        >
                          ↑
                        </button>
                        <button
                          className="step-action"
                          onClick={() => handleMoveStep(i, 1)}
                          disabled={i === steps.length - 1}
                          title="Move down"
                          aria-label="Move down"
                        >
                          ↓
                        </button>
                        {editable && (
                          <button
                            className="step-action"
                            onClick={() => handleStartEdit(i)}
                            title="Edit value"
                            aria-label="Edit value"
                          >
                            ✎
                          </button>
                        )}
                        <button
                          className="step-action"
                          onClick={() => handleToggleDisabled(i)}
                          title={step.disabled ? 'Enable step' : 'Disable step'}
                          aria-label={step.disabled ? 'Enable step' : 'Disable step'}
                        >
                          {step.disabled ? '↺' : '⊘'}
                        </button>
                        <button
                          className="step-action"
                          onClick={() => setInsertMenuIndex(insertMenuIndex === i ? null : i)}
                          title="Insert a step below this one"
                          aria-label="Insert below"
                        >
                          ＋
                        </button>
                        <button
                          className="step-action danger"
                          onClick={() => handleDeleteStep(i)}
                          title="Delete step"
                          aria-label="Delete step"
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
        </aside>
      </div>

      {/* === Export preview modal === */}
      {exportCode !== null && (
        <div className="modal-backdrop" onClick={() => setExportCode(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Playwright test</span>
              <button className="modal-close" onClick={() => setExportCode(null)} aria-label="Close">
                ✕
              </button>
            </div>
            <pre className="modal-code">
              <code>{exportCode}</code>
            </pre>
            <div className="modal-footer">
              {savedPath && <span className="saved-path">Saved to {savedPath}</span>}
              <button className="modal-btn" onClick={handleCopyExport}>
                Copy
              </button>
              <button className="modal-btn primary" onClick={handleSaveExport}>
                Save .ts
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
