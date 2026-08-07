import React from 'react'
import { SUGGESTED_TAGS, parseTags, normalizeTag } from '../tags'
import { DEVICES, deviceById, deviceSummary } from '../devices'

// =====================================================================
// SavePanel — lifted out of App.tsx verbatim.
//
// Was an inline {cond && (…)} block inside the workspace return. Props are
// destructured under the names the markup already used; the open condition is
// re-expressed as an early return, because a component that simply returns the
// JSX would render ALWAYS.
// =====================================================================

export interface SavePanelProps {
  applyDevice: (id: string | undefined) => void
  baseURL: string
  deriveBaseURL: (list: RecorderStep[]) => string
  deviceId: string | undefined
  handleSaveSession: () => Promise<void>
  handleSaveTest: () => Promise<void>
  newSuiteInput: string
  saveNameInput: string
  savePanelOpen: boolean
  saveSuite: string
  sessionAge: (file?: string) => { expired: boolean; text: string } | null
  sessionNameInput: string
  sessions: string[]
  setNewSuiteInput: React.Dispatch<React.SetStateAction<string>>
  setSaveNameInput: React.Dispatch<React.SetStateAction<string>>
  setSavePanelOpen: React.Dispatch<React.SetStateAction<boolean>>
  setSaveSuite: React.Dispatch<React.SetStateAction<string>>
  setSessionNameInput: React.Dispatch<React.SetStateAction<string>>
  setStorageState: React.Dispatch<React.SetStateAction<string | undefined>>
  setTagInput: React.Dispatch<React.SetStateAction<string>>
  setTags: React.Dispatch<React.SetStateAction<string[]>>
  steps: RecorderStep[]
  storageState: string | undefined
  suites: string[]
  tagInput: string
  tags: string[]
  viewport: { width: number; height: number } | undefined
}

export function SavePanel({
  applyDevice,
  baseURL,
  deriveBaseURL,
  deviceId,
  handleSaveSession,
  handleSaveTest,
  newSuiteInput,
  saveNameInput,
  savePanelOpen,
  saveSuite,
  sessionAge,
  sessionNameInput,
  sessions,
  setNewSuiteInput,
  setSaveNameInput,
  setSavePanelOpen,
  setSaveSuite,
  setSessionNameInput,
  setStorageState,
  setTagInput,
  setTags,
  steps,
  storageState,
  suites,
  tagInput,
  tags,
  viewport
}: SavePanelProps): React.JSX.Element | null {
  if (!(savePanelOpen)) return null
  return (
            <div className="assert-panel">
              <div className="assert-target">
                <span className="assert-title">Save test</span>
              </div>
              <input
                className="assert-value"
                value={saveNameInput}
                onChange={(e) => setSaveNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveTest()
                  else if (e.key === 'Escape') setSavePanelOpen(false)
                }}
                placeholder="test name…"
                autoFocus
                spellCheck={false}
              />
              {/* Day 11.5: which section this test belongs to */}
              <div className="assert-kinds">
                {suites.map((suite) => (
                  <button
                    key={suite}
                    type="button"
                    className={`assert-kind${
                      saveSuite === suite && !newSuiteInput.trim() ? ' chosen' : ''
                    }`}
                    onClick={() => {
                      setSaveSuite(suite)
                      setNewSuiteInput('')
                    }}
                  >
                    {suite}
                  </button>
                ))}
              </div>
              <input
                className="assert-value"
                value={newSuiteInput}
                onChange={(e) => setNewSuiteInput(e.target.value)}
                placeholder="…or type a new section name"
                spellCheck={false}
              />
              <code className="assert-selector">
                {baseURL || deriveBaseURL(steps)
                  ? `base URL: ${baseURL || deriveBaseURL(steps)}`
                  : 'no base URL detected'}
              </code>
              {/* Day 17: session reuse — start this test already logged in */}
              <div className="session-block">
                <label className="session-label">Start logged in (session):</label>
                <select
                  className="session-select"
                  value={storageState ?? ''}
                  onChange={(e) => setStorageState(e.target.value || undefined)}
                >
                  <option value="">None — fresh login each run</option>
                  {sessions.map((s) => {
                    // F39.2: an expired login is the single most misleading thing
                    // a test can carry, so it's named right in the picker.
                    const age = sessionAge(s)
                    return (
                      <option key={s} value={s}>
                        {s}
                        {age ? ` — ⚠ ${age.text}` : ''}
                      </option>
                    )
                  })}
                </select>
                {(() => {
                  const age = sessionAge(storageState)
                  if (!age) return null
                  return (
                    <p className="session-expiry-warn">
                      ⚠ This session <strong>{age.text}</strong>.
                      {age.expired
                        ? ' A run in the app may still pass — the embedded browser is probably still logged in from ordinary use — but the saved file no longer works, so this test will fail headless, in a parallel run, and in CI. Log in again and save over it.'
                        : ' Save it again before it lapses, or this test starts failing everywhere except in the app.'}
                    </p>
                  )
                })()}
                <div className="session-save-row">
                  <input
                    className="assert-value"
                    value={sessionNameInput}
                    onChange={(e) => setSessionNameInput(e.target.value)}
                    placeholder="name to save the CURRENT logged-in browser as…"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="modal-btn"
                    onClick={handleSaveSession}
                    disabled={!sessionNameInput.trim()}
                    title="Capture the embedded browser's current cookies + storage as a reusable session"
                  >
                    Save session
                  </button>
                </div>
              </div>
              {/* F38: tags. Sits BELOW the section chips deliberately — the two
                  look similar but mean different things, and the note spells the
                  difference out so they don't get used interchangeably. */}
              <div className="session-block">
                <label className="session-label">Tags:</label>
                <div className="tag-row">
                  {tags.map((t) => (
                    <span key={t} className="tag-chip editable">
                      {t}
                      <button
                        type="button"
                        className="tag-x"
                        onClick={() => setTags(tags.filter((x) => x !== t))}
                        title={`Remove ${t}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    className="tag-input"
                    value={tagInput}
                    placeholder="@smoke…"
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter / comma commits; comma too because typing a list is
                      // the natural thing to do in a box that shows several.
                      if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault()
                        const added = parseTags(tagInput).filter((t) => !tags.includes(t))
                        if (added.length) setTags([...tags, ...added])
                        setTagInput('')
                      } else if (e.key === 'Backspace' && !tagInput && tags.length) {
                        setTags(tags.slice(0, -1))
                      }
                    }}
                    onBlur={() => {
                      const added = parseTags(tagInput).filter((t) => !tags.includes(t))
                      if (added.length) setTags([...tags, ...added])
                      setTagInput('')
                    }}
                    spellCheck={false}
                  />
                </div>
                <div className="tag-suggest">
                  {SUGGESTED_TAGS.filter((t) => !tags.includes(t)).map((t) => (
                    <button
                      key={t}
                      type="button"
                      className="tag-add"
                      onClick={() => setTags([...tags, normalizeTag(t)])}
                    >
                      + {t}
                    </button>
                  ))}
                </div>
                <p className="tag-note">
                  A test lives in <strong>one section</strong> but can carry{' '}
                  <strong>many tags</strong> — that&apos;s the difference. The section is where it
                  files; tags are what it&apos;s <em>for</em>. Tag the fast, critical ones{' '}
                  <code>@smoke</code> and you can run just those before a merge, then{' '}
                  <code>npx playwright test --grep @smoke</code> does the same in CI.
                </p>
              </div>

              {/* Day 17 viewport → F36 device emulation. Desktop and the two
                  "size only" presets are Day-17 behaviour, unchanged. The real
                  devices below them add userAgent + touch + pixel density. */}
              <div className="session-block">
                <label className="session-label">Device:</label>
                <div className="assert-kinds">
                  <button
                    type="button"
                    className={`assert-kind${!viewport && !deviceId ? ' chosen' : ''}`}
                    onClick={() => applyDevice(undefined)}
                  >
                    Desktop
                  </button>
                  {DEVICES.filter((d) => d.group === 'Basic').map((d) => {
                    // A pre-F36 test has no deviceId — match it on SIZE so its
                    // saved viewport still lights up the right chip.
                    const active =
                      deviceId === d.id ||
                      (!deviceId &&
                        !!viewport &&
                        viewport.width === d.viewport.width &&
                        viewport.height === d.viewport.height)
                    return (
                      <button
                        key={d.id}
                        type="button"
                        className={`assert-kind${active ? ' chosen' : ''}`}
                        onClick={() => applyDevice(d.id)}
                        title="Resizes the window only — the page still sees a desktop browser, with no touch and a desktop user-agent."
                      >
                        {/* "(size only)" used to be stripped here to keep the chip
                            short. That hid the single most important fact about
                            these presets: the page is NOT told it's a phone. The
                            grey note below said so, but a label you read every
                            time beats a paragraph you read once (Surbhi, Test 10). */}
                        {d.label}
                      </button>
                    )
                  })}
                </div>
                <div className="assert-kinds device-real">
                  {DEVICES.filter((d) => d.group !== 'Basic').map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className={`assert-kind${deviceId === d.id ? ' chosen' : ''}`}
                      onClick={() => applyDevice(d.id)}
                      title={deviceSummary(d)}
                    >
                      {d.group === 'Tablet' ? '📲' : '📱'} {d.label}
                    </button>
                  ))}
                </div>
                <p className="device-note">
                  {deviceId && deviceById(deviceId)?.userAgent ? (
                    <>
                      <strong>{deviceSummary(deviceById(deviceId))}</strong>
                      <br />
                      The page sees a real phone: mobile user-agent, touch events, and{' '}
                      {deviceById(deviceId)?.deviceScaleFactor}× pixel density — so layouts that
                      switch on UA or <code>pointer: coarse</code> switch here too.
                      {deviceById(deviceId)?.realEngine === 'webkit' && (
                        // Its own line, not a trailing clause. This is the most
                        // important sentence in the box — the one place the app
                        // admits the emulation isn't the real engine — and buried
                        // at the end of a dense paragraph the eye slid past it.
                        <span className="device-caveat">
                          ⚠ In-app this is Chromium wearing an iOS costume — the embedded browser is
                          Chromium-only. The export and 🧭 cross-browser run it on real WebKit.
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      &ldquo;Size only&rdquo; resizes the window and nothing else — the page still
                      sees a desktop browser with no touch. Pick a real device below to test the
                      mobile path properly.
                    </>
                  )}
                </p>
              </div>
              <div className="assert-actions">
                <button className="modal-btn" onClick={() => setSavePanelOpen(false)}>
                  Cancel
                </button>
                <button className="modal-btn primary" onClick={handleSaveTest}>
                  Save
                </button>
              </div>
            </div>
  )
}
