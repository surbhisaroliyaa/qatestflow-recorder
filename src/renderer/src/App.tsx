import { useEffect, useState, type FormEvent } from 'react'

const EXAMPLE_URLS = ['saucedemo.com', 'google.com', 'github.com']

// Turn a recorded step into one readable line for the panel.
function stepText(step: RecorderStep): string {
  switch (step.type) {
    case 'navigate':
      return `Go to ${step.url}`
    case 'click':
      return `Click ${step.label}`
    case 'type':
      return `Type "${step.value}" into ${step.label}`
    case 'select':
      return `Select "${step.value}" in ${step.label}`
    default:
      return JSON.stringify(step)
  }
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
            Steps
            {steps.length > 0 && <span className="steps-count">{steps.length}</span>}
          </div>
          {steps.length === 0 ? (
            <p className="steps-empty">
              {isRecording
                ? 'Recording… interact with the page.'
                : 'Press Record, then use the page to capture steps.'}
            </p>
          ) : (
            <ol className="steps-list">
              {steps.map((step, i) => (
                <li key={i} className="step-item">
                  <span className="step-num">{i + 1}</span>
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
    </div>
  )
}

export default App
