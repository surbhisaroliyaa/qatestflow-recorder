import { useEffect, useState, type FormEvent } from 'react'
import { generatePlaywrightTest, stepText } from './playwrightExport'

const EXAMPLE_URLS = ['saucedemo.com', 'google.com', 'github.com']

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

  // Sync the URL bar whenever the embedded browser navigates.
  // Mark hasNavigated true so we switch from welcome -> chrome view.
  useEffect(() => {
    const unsubscribe = window.api.browser.onUrlChange((url) => {
      if (!url.startsWith('data:')) {
        setUrlInput(url)
        setHasNavigated(true)
      }
    })
    return unsubscribe
  }, [])

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

  // Toggle recording. Starting a fresh recording clears the previous steps.
  const handleRecordToggle = async (): Promise<void> => {
    if (!isRecording) setSteps([]) // clear synchronously, before the first step arrives
    const nowRecording = await window.api.recorder.toggle()
    setIsRecording(nowRecording)
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

  // A one-line summary of the last/current replay for the status banner.
  const replayBanner = ((): { tone: string; text: string } | null => {
    if (isReplaying) return { tone: 'running', text: 'Replaying…' }
    if (failedIndex !== null)
      return { tone: 'failed', text: `✗ Failed at step ${failedIndex + 1}: ${replayError}` }
    if (doneIndices.size > 0 && doneIndices.size === steps.length)
      return { tone: 'passed', text: `✓ All ${steps.length} steps passed` }
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
          className={`record-btn${isRecording ? ' recording' : ''}`}
          onClick={handleRecordToggle}
          title={isRecording ? 'Stop recording' : 'Start recording'}
        >
          <span className="record-dot" />
          {isRecording ? 'Stop' : 'Record'}
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
                  disabled={isReplaying || isRecording}
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
              </div>
            )}
          </div>
          {replayBanner && (
            <div className={`replay-status ${replayBanner.tone}`}>{replayBanner.text}</div>
          )}
          {steps.length === 0 ? (
            <p className="steps-empty">
              {isRecording
                ? 'Recording… interact with the page.'
                : 'Press Record, then use the page to capture steps.'}
            </p>
          ) : (
            <ol className="steps-list">
              {steps.map((step, i) => (
                <li
                  key={i}
                  className={`step-item${
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
                    <span className="step-text">{stepText(step)}</span>
                    {step.selector && (
                      <span className="step-selector" title={`stability ${step.candidates?.[0]?.score ?? '?'}/100`}>
                        <span className={`stability-dot ${stabilityClass(step.candidates?.[0]?.score)}`} />
                        <code>{step.selector}</code>
                      </span>
                    )}
                  </div>
                </li>
              ))}
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
