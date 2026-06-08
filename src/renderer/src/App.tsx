import { useEffect, useState, type FormEvent } from 'react'

const EXAMPLE_URLS = ['saucedemo.com', 'google.com', 'github.com']

function App(): React.JSX.Element {
  const [urlInput, setUrlInput] = useState('')
  const [hasNavigated, setHasNavigated] = useState(false)

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
    <div className="chrome">
      <button
        className="nav-btn"
        onClick={handleBack}
        title="Back"
        aria-label="Back"
      >
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
    </div>
  )
}

export default App
