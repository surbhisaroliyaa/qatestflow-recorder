import { useEffect, useRef, useState, type FormEvent } from 'react'
import { generatePlaywrightTest, stepText } from './playwrightExport'
import { generateBugReport, bugReportFileName } from './bugReport'

const EXAMPLE_URLS = ['saucedemo.com', 'google.com', 'github.com']

// Day 9: the checks offered by the assertion chooser, in display order.
// checked/unchecked only make sense on a checkbox/radio — the chooser hides
// them unless the picked element reported a live `checked` state (Day 11).
const ASSERT_KINDS: AssertKind[] = [
  'visible',
  'hidden',
  'text-equals',
  'text-contains',
  'value',
  'empty',
  'count',
  'enabled',
  'disabled',
  'editable',
  'focused',
  'checked',
  'unchecked',
  'attribute',
  'class'
]
const ASSERT_LABELS: Record<AssertKind, string> = {
  visible: 'Visible',
  hidden: 'Hidden',
  'text-equals': 'Text =',
  'text-contains': 'Contains',
  value: 'Value',
  empty: 'Empty',
  count: 'Count',
  enabled: 'Enabled',
  disabled: 'Disabled',
  editable: 'Editable',
  focused: 'Focused',
  checked: 'Checked',
  unchecked: 'Unchecked',
  attribute: 'Attribute',
  class: 'Has class',
  'url-contains': 'URL contains',
  title: 'Page title'
}
// Day 13: network evidence lines carry [site] / [third-party] tags (whose
// server failed — stamped at capture in main). Third-party noise is shown
// DIMMED and sorted last, never hidden: the tag is a fact, not a judgment.
// MIRROR WARNING: tag text + ordering must match relationTag (main/index.ts)
// and siteFirst (main/translator.ts).
const isThirdPartyLine = (l: string): boolean => l.includes('[third-party]')
const siteFirstLines = (lines: string[]): string[] =>
  [...lines].sort((a, b) => Number(isThirdPartyLine(a)) - Number(isThirdPartyLine(b)))

// Day 13: how the analysis modal names each verdict.
const VERDICT_LABELS: Record<FailureVerdict, string> = {
  'app-bug': 'App bug',
  'test-bug': 'Test bug',
  timing: 'Timing',
  environment: 'Environment',
  unknown: 'Unclassified'
}

// These kinds compare against an expected value the user can edit.
const assertNeedsValue = (kind: AssertKind): boolean =>
  kind === 'text-equals' ||
  kind === 'text-contains' ||
  kind === 'value' ||
  kind === 'count' ||
  kind === 'attribute' ||
  kind === 'class' ||
  kind === 'url-contains' ||
  kind === 'title'

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
  // For the two-part 'attribute' check: WHICH attribute to read (e.g. href).
  const [assertAttr, setAssertAttr] = useState('')
  const [insertAt, setInsertAt] = useState<number | null>(null)
  // Which row's "insert here" mini-menu is open (null = none).
  const [insertMenuIndex, setInsertMenuIndex] = useState<number | null>(null)
  // Day 11 — test library. The current test's identity (empty/null = an
  // unsaved recording) + the saved-tests list shown on the welcome screen.
  const [savedTests, setSavedTests] = useState<SavedTestSummary[]>([])
  const [testName, setTestName] = useState('')
  const [testFileName, setTestFileName] = useState<string | null>(null)
  const [baseURL, setBaseURL] = useState('')
  const [savePanelOpen, setSavePanelOpen] = useState(false)
  const [saveNameInput, setSaveNameInput] = useState('')
  // Inline editing of the test's base URL (the environment switch).
  const [editingBase, setEditingBase] = useState(false)
  const [baseEditValue, setBaseEditValue] = useState('')
  // Day 11.5 — sections (suites). The section list, the current test's
  // section, and the save panel's chosen/typed section.
  const [suites, setSuites] = useState<string[]>([])
  const [testSuite, setTestSuite] = useState('')
  const [saveSuite, setSaveSuite] = useState('Daily')
  const [newSuiteInput, setNewSuiteInput] = useState('')
  // Day 11.5 — failure screenshot of the LAST replay (📷 in the banner).
  const [lastScreenshotPath, setLastScreenshotPath] = useState<string | null>(null)
  // Day 11.5 — suite runner: which section is running, per-test outcomes so
  // far, and whether the run has finished (summary shows then).
  interface SuiteRunEntry {
    fileName: string
    name: string
    status: 'passed' | 'failed'
    failedAt?: number
    error?: string
    screenshotPath?: string
  }
  const [suiteRun, setSuiteRun] = useState<{
    suite: string
    total: number
    current: number // 1-based index of the test running now
    currentName: string
    results: SuiteRunEntry[]
    running: boolean
  } | null>(null)

  // Welcome-screen accordion: which sections are EXPANDED. Starts empty, so
  // every launch begins compact — section headers only (Surbhi's call);
  // whatever you open stays open for the rest of the session.
  const [openSuites, setOpenSuites] = useState<Set<string>>(new Set())
  const toggleSuite = (key: string): void => {
    const next = new Set(openSuites)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setOpenSuites(next)
  }

  // Day 13 — failure translator + bug report. Console/network evidence of the
  // LAST failed run (from main's replay-time capture); the analysis modal's
  // state: open, thinking, the diagnosis, and the generated report (non-null
  // = the modal is showing the report view instead of the analysis view).
  const [lastConsoleErrors, setLastConsoleErrors] = useState<string[]>([])
  const [lastNetworkErrors, setLastNetworkErrors] = useState<string[]>([])
  const [analysisOpen, setAnalysisOpen] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysis, setAnalysis] = useState<FailureAnalysis | null>(null)
  // The evidence bundle the open analysis was built from — the bug report
  // generator reuses it so both documents describe the same failure.
  const [lastEvidence, setLastEvidence] = useState<FailureEvidence | null>(null)
  const [bugReport, setBugReport] = useState<string | null>(null)
  const [reportSavedPath, setReportSavedPath] = useState<string | null>(null)

  // Day 12 — recovery. Non-null while a replay is PAUSED at a failed step
  // (main's loop is holding for our decision: retry / re-pick / skip / stop).
  const [recovery, setRecovery] = useState<ReplayPaused | null>(null)
  // Which step a re-pick is healing (null = the picker is for an assertion).
  const [repickIndex, setRepickIndex] = useState<number | null>(null)
  // Steps bypassed via Skip THIS run (amber rows) — cleared on the next run.
  const [skippedIndices, setSkippedIndices] = useState<Set<number>>(new Set())
  // Steps whose selector was healed by a re-pick and not yet saved (🔧 hint).
  const [healedIndices, setHealedIndices] = useState<Set<number>>(new Set())
  // A re-pick landed on an element with no stable hooks — explain why the
  // heal was refused (shown inside the recovery panel).
  const [recoveryWarning, setRecoveryWarning] = useState<string | null>(null)
  // Mirrors for the onPicked subscription: it's registered once (empty deps),
  // so it reads CURRENT values through refs instead of stale closed-over state.
  const repickIndexRef = useRef<number | null>(null)
  const stepsRef = useRef<RecorderStep[]>([])
  // Mirror state into the refs AFTER render (React forbids touching refs
  // during render). The onPicked subscriber only reads them when an IPC
  // event arrives, which is always after the effect has run.
  useEffect(() => {
    repickIndexRef.current = repickIndex
    stepsRef.current = steps
  }, [repickIndex, steps])

  // Steps left ON (disabled steps are skipped by replay + export).
  const enabledCount = steps.filter((s) => !s.disabled).length

  // The test's base URL when none was set yet: the ORIGIN of the first
  // navigation (https://site.com/login -> https://site.com).
  const deriveBaseURL = (list: RecorderStep[]): string => {
    const nav = list.find((s) => s.type === 'navigate' && s.url)
    if (!nav?.url) return ''
    try {
      return new URL(nav.url).origin
    } catch {
      return ''
    }
  }

  // Refresh the library list + section list whenever the welcome screen shows.
  useEffect(() => {
    if (!hasNavigated) {
      window.api.library.list().then(setSavedTests)
      window.api.library.listSuites().then(setSuites)
    }
  }, [hasNavigated])

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
  // Day 12: unless this pick is a RE-PICK for a paused replay — then it heals
  // the failed step's selector ladder and retries it, no chooser involved.
  useEffect(() => {
    const unsubscribe = window.api.recorder.onPicked((picked) => {
      setIsPicking(false)
      const healIndex = repickIndexRef.current
      if (healIndex !== null) {
        setRepickIndex(null)
        // A bare element can't heal anything — its ladder is the same bare
        // tag replay just refused. Stay paused and explain.
        if (picked.unreliable) {
          setRecoveryWarning(
            `"${picked.label}" has no stable hooks (no id / role / text) — ` +
              'replay would refuse it too. Try a more specific element.'
          )
          return
        }
        // Same step, new eyes: keep what it DOES (type/value/check), replace
        // how it FINDS the element (label + full candidate ladder, rebuilt
        // from the freshly picked element).
        const next = stepsRef.current.map((s, idx) =>
          idx === healIndex
            ? {
                ...s,
                label: picked.label,
                selector: picked.selector,
                candidates: picked.candidates
              }
            : s
        )
        setSteps(next)
        setHealedIndices((prev) => new Set(prev).add(healIndex))
        setRecovery(null)
        window.api.recorder.recovery({ action: 'retry', step: next[healIndex] })
        return
      }
      setPickedElement(picked)
      setAssertKind('visible')
      setAssertValue(picked.text ?? '')
      setAssertAttr('')
    })
    return unsubscribe
  }, [])

  // The user pressed Esc inside the page — pick mode ended without a pick.
  // If it was a re-pick, fall back to the recovery panel's buttons.
  useEffect(
    () =>
      window.api.recorder.onPickCancel(() => {
        setIsPicking(false)
        setRepickIndex(null)
      }),
    []
  )

  // Day 12: a replay hit a failed step and is now paused, waiting on us.
  useEffect(() => {
    const unsubscribe = window.api.recorder.onReplayPaused((info) => {
      setRecovery(info)
      setRecoveryWarning(null)
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

  // The embedded browser is a native pane that paints over our UI, so while
  // any full-window overlay is open (export modal, suite summary) we ask main
  // to hide it (else it covers the modal).
  const suiteSummaryOpen = suiteRun !== null && !suiteRun.running
  useEffect(() => {
    window.api.browser.setOverlay(exportCode !== null || suiteSummaryOpen || analysisOpen)
  }, [exportCode, suiteSummaryOpen, analysisOpen])

  // Follow replay progress so we can highlight running / done / failed steps.
  useEffect(() => {
    const unsubscribe = window.api.recorder.onReplayProgress((p) => {
      if (p.status === 'running') {
        setReplayingIndex(p.index)
        // A recovery retry re-runs a step that just failed — drop its red mark.
        setFailedIndex((prev) => (prev === p.index ? null : prev))
      } else if (p.status === 'done') setDoneIndices((prev) => new Set(prev).add(p.index))
      else if (p.status === 'error') setFailedIndex(p.index)
      else if (p.status === 'skipped') {
        setSkippedIndices((prev) => new Set(prev).add(p.index))
        setFailedIndex((prev) => (prev === p.index ? null : prev))
      }
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
    // Fresh start drops the current test identity too (steps are gone).
    setTestName('')
    setTestFileName(null)
    setBaseURL('')
    setTestSuite('')
    setSavePanelOpen(false)
    setSuiteRun(null)
    setLastScreenshotPath(null)
    // Day 12: main answers any paused replay with a silent abort on Home —
    // mirror that here so no recovery UI survives the trip to welcome.
    setRecovery(null)
    setRecoveryWarning(null)
    setRepickIndex(null)
    setSkippedIndices(new Set())
    setHealedIndices(new Set())
    // Day 13: the analysis described a run that no longer exists.
    closeAnalysis()
    setLastEvidence(null)
    setLastConsoleErrors([])
    setLastNetworkErrors([])
  }

  // Export: generate the Playwright code and open the preview modal. The
  // test's name becomes the test title; its base URL becomes test.use({...})
  // (derived from the first navigation when the test was never saved).
  const handleExport = (): void => {
    setSavedPath(null)
    setExportCode(
      generatePlaywrightTest(steps, {
        name: testName || undefined,
        baseURL: baseURL || deriveBaseURL(steps) || undefined
      })
    )
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

  // One replay of one steps-list, with outcome recorded for saved tests.
  // Shared by the single Replay button AND the Day 11.5 suite runner.
  // `interactive` (Day 12): a failure pauses for Retry / Re-pick / Skip / Stop
  // — only the single Replay button uses it; suite runs stay unattended.
  const runOnce = async (
    list: RecorderStep[],
    fileName: string | null,
    interactive = false
  ): Promise<{
    ok: boolean
    failedAt?: number
    error?: string
    screenshotPath?: string
    aborted?: boolean
  }> => {
    setFailedIndex(null)
    setReplayError(null)
    setDoneIndices(new Set())
    setReplayingIndex(null)
    setLastScreenshotPath(null)
    setSkippedIndices(new Set())
    setRecovery(null)
    setLastConsoleErrors([])
    setLastNetworkErrors([])
    setIsReplaying(true)
    const result = await window.api.recorder.replay(list, interactive)
    setIsReplaying(false)
    setReplayingIndex(null)
    setRecovery(null)
    // Aborted = Home was pressed mid-recovery. The run is moot — no failure
    // banner, no run recorded.
    if (result.aborted) return result
    if (!result.ok) {
      setFailedIndex(result.failedAt ?? null)
      setReplayError(result.error ?? 'Replay failed')
      setLastScreenshotPath(result.screenshotPath ?? null)
      setLastConsoleErrors(result.consoleErrors ?? [])
      setLastNetworkErrors(result.networkErrors ?? [])
    }
    // A SAVED test remembers its outcomes — the library shows the latest as
    // a green/red dot and the last 10 as a history row (mini CI dashboard).
    if (fileName) {
      window.api.library.recordRun(fileName, {
        status: result.ok ? 'passed' : 'failed',
        at: new Date().toISOString(),
        failedAt: result.failedAt,
        error: result.error,
        screenshotPath: result.screenshotPath
      })
    }
    return result
  }

  // Replay: run all recorded steps in the embedded browser and watch them go.
  // Interactive — a failed step pauses for recovery instead of ending the run.
  const handleReplay = async (): Promise<void> => {
    await runOnce(steps, testFileName, true)
  }

  // === Day 12: recovery — answer a paused replay ====================
  const answerRecovery = (action: 'retry' | 'skip' | 'stop'): void => {
    setRecovery(null)
    setRecoveryWarning(null)
    window.api.recorder.recovery({ action })
  }

  // Re-pick: open the Day 9 element picker; the onPicked handler above heals
  // the failed step with the fresh ladder and retries it.
  const handleRecoveryRepick = async (): Promise<void> => {
    if (!recovery) return
    setRecoveryWarning(null)
    setRepickIndex(recovery.index)
    setIsPicking(true)
    await window.api.recorder.setPicking(true)
  }

  const handleRecoveryRepickCancel = async (): Promise<void> => {
    setRepickIndex(null)
    setIsPicking(false)
    await window.api.recorder.setPicking(false)
  }

  // === Day 13: failure translator + bug report ======================
  // The renderer assembles the evidence bundle — it owns the steps and their
  // human sentences; main contributed the console/network capture and the
  // screenshot. Then main's translator turns it into a verdict + explanation
  // (Claude CLI when available, built-in rules otherwise — same shape back).
  const handleExplain = async (
    index: number,
    error: string,
    screenshotPath: string | null | undefined,
    consoleErrors: string[],
    networkErrors: string[]
  ): Promise<void> => {
    setBugReport(null)
    setReportSavedPath(null)
    setAnalysis(null)
    setAnalysisOpen(true)
    setAnalyzing(true)
    // The page's live URL + title live inside the native browser view — only
    // main can read them (same reason as the Day 11 title-check prefill).
    let pageUrl = urlInput
    let pageTitle = ''
    try {
      const info = await window.api.browser.getPageInfo()
      pageUrl = info.url || urlInput
      pageTitle = info.title
    } catch {
      // keep the URL-bar fallback
    }
    const step = steps[index] as RecorderStep | undefined
    const evidence: FailureEvidence = {
      testName: testName || undefined,
      pageUrl,
      pageTitle,
      stepIndex: index,
      stepText: step ? stepText(step) : `Step ${index + 1}`,
      stepType: step?.type ?? 'unknown',
      selector: step?.selector,
      error,
      consoleErrors,
      networkErrors,
      screenshotPath: screenshotPath ?? undefined,
      allSteps: steps.map((s) => stepText(s))
    }
    setLastEvidence(evidence)
    try {
      setAnalysis(await window.api.translator.explain(evidence))
    } catch {
      setAnalysis({
        source: 'rules',
        verdict: 'unknown',
        explanation: 'The translator could not run — see the raw evidence below.',
        suggestion: ''
      })
    }
    setAnalyzing(false)
  }

  const closeAnalysis = (): void => {
    setAnalysisOpen(false)
    setAnalyzing(false)
    setAnalysis(null)
    setBugReport(null)
    setReportSavedPath(null)
  }

  // Bug report = the SAME evidence formatted for humans (plus the verdict,
  // when an analysis ran). Generated in place, inside the analysis modal.
  const handleGenerateReport = (): void => {
    if (!lastEvidence) return
    setBugReport(generateBugReport(lastEvidence, analysis))
    setReportSavedPath(null)
  }

  const handleCopyReport = (): void => {
    if (bugReport) navigator.clipboard.writeText(bugReport)
  }

  const handleSaveReport = async (): Promise<void> => {
    if (!bugReport || !lastEvidence) return
    const path = await window.api.translator.saveReport(bugReport, bugReportFileName(lastEvidence))
    if (path) setReportSavedPath(path)
  }

  // === Day 11: test library =========================================
  const handleOpenSavePanel = async (): Promise<void> => {
    const base = baseURL || deriveBaseURL(steps)
    let suggested = testName
    if (!suggested && base) {
      try {
        suggested = `${new URL(base).hostname.replace(/^www\./, '')} flow`
      } catch {
        suggested = ''
      }
    }
    setSaveNameInput(suggested)
    setSaveSuite(testSuite || 'Daily')
    setNewSuiteInput('')
    setSuites(await window.api.library.listSuites())
    setSavePanelOpen(true)
  }

  const handleSaveTest = async (): Promise<void> => {
    const name = saveNameInput.trim()
    if (!name) return
    // A typed new section name wins over the chosen chip.
    const suite = newSuiteInput.trim() || saveSuite || 'Daily'
    const base = baseURL || deriveBaseURL(steps)
    const summary = await window.api.library.save({ name, baseURL: base, suite, steps })
    // Renaming or re-sectioning = a MOVE: the save created the new file, so
    // drop the old one (otherwise stale copies pile up under the old name).
    if (testFileName && testFileName !== summary.fileName) {
      await window.api.library.remove(testFileName)
    }
    setTestName(name)
    setTestFileName(summary.fileName)
    setTestSuite(summary.suite)
    setBaseURL(base)
    setSavePanelOpen(false)
    setHealedIndices(new Set()) // healed selectors are on disk now — hint done
  }

  // Open a saved test: its steps become the working list (the single source
  // of truth, same as after recording), and the browser shows its start page.
  const handleLoadTest = async (fileName: string): Promise<void> => {
    const test = await window.api.library.load(fileName)
    if (!test) return
    editSteps(test.steps)
    setTestName(test.name)
    setTestFileName(fileName)
    setTestSuite(fileName.includes('/') ? fileName.split('/')[0] : '')
    setBaseURL(test.baseURL)
    setHasNavigated(true)
    const firstNav = test.steps.find((s) => s.type === 'navigate' && s.url)
    if (firstNav?.url) {
      setUrlInput(firstNav.url)
      window.api.browser.navigate(firstNav.url)
    }
  }

  // === Day 11.5: suite runner =======================================
  // Run every test in a section, one after another, CONTINUING past failures
  // (each test starts from a clean browser state, so one red can't poison the
  // next) — then show the full picture, like a CI run.
  const handleRunSuite = async (suite: string, tests: SavedTestSummary[]): Promise<void> => {
    if (tests.length === 0) return
    setHasNavigated(true)
    setSuiteRun({
      suite,
      total: tests.length,
      current: 0,
      currentName: '',
      results: [],
      running: true
    })
    for (let i = 0; i < tests.length; i++) {
      const t = tests[i]
      setSuiteRun((prev) => (prev ? { ...prev, current: i + 1, currentName: t.name } : prev))
      const data = await window.api.library.load(t.fileName)
      let entry: SuiteRunEntry
      if (!data) {
        entry = {
          fileName: t.fileName,
          name: t.name,
          status: 'failed',
          error: 'Could not read the test file'
        }
      } else {
        // Show this test in the panel while it runs (steps + live marks).
        editSteps(data.steps)
        setTestName(data.name)
        setTestFileName(t.fileName)
        setTestSuite(suite)
        setBaseURL(data.baseURL)
        const result = await runOnce(data.steps, t.fileName)
        entry = {
          fileName: t.fileName,
          name: data.name,
          status: result.ok ? 'passed' : 'failed',
          failedAt: result.failedAt,
          error: result.error,
          screenshotPath: result.screenshotPath
        }
      }
      setSuiteRun((prev) => (prev ? { ...prev, results: [...prev.results, entry] } : prev))
    }
    setSuiteRun((prev) => (prev ? { ...prev, running: false } : prev))
  }

  const handleDeleteTest = async (test: SavedTestSummary): Promise<void> => {
    if (!window.confirm(`Delete "${test.name}"? This cannot be undone.`)) return
    await window.api.library.remove(test.fileName)
    setSavedTests(await window.api.library.list())
  }

  // Retarget the test at another environment: rewrite every navigation that
  // lives under the OLD base so it lives under the NEW one. Visible in the
  // step list immediately — no hidden state.
  const handleCommitBaseURL = (): void => {
    setEditingBase(false)
    let next = baseEditValue.trim().replace(/\/+$/, '')
    if (!next) return
    if (!/^https?:\/\//i.test(next)) next = `https://${next}`
    try {
      new URL(next)
    } catch {
      return // not a usable URL — keep the old base
    }
    const old = baseURL
    if (next === old) return
    if (old) {
      editSteps(
        steps.map((s) =>
          s.type === 'navigate' && s.url?.startsWith(old)
            ? { ...s, url: next + s.url.slice(old.length) }
            : s
        )
      )
    }
    setBaseURL(next)
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
    setSkippedIndices(new Set()) // skip marks describe the old order too
    setHealedIndices(new Set()) // healed indices may have shifted — drop the hint
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
    } else if (kind === 'count') {
      // How many elements the primary selector matched at pick time.
      setAssertValue(String(pickedElement.groupCount ?? 1))
    } else if (kind === 'attribute' || kind === 'class') {
      // No live prefill for these — clear the stale text prefill so the user
      // isn't asserting the element's text as an attribute value by accident.
      setAssertValue('')
    }
  }

  // === Day 11: PAGE-level checks (no element to pick) =================
  // Offered as shortcuts inside the picking banner: they end pick mode and
  // insert directly at the position picking was started for.

  // URL check, prefilled with the current page's PATH — the stable, meaningful
  // part (the full URL would make "contains" behave like "equals").
  const handleAddUrlCheck = async (): Promise<void> => {
    await handleCancelPick()
    let prefill = urlInput
    try {
      const u = new URL(urlInput)
      prefill = u.pathname !== '/' ? u.pathname : u.host
    } catch {
      // not a parseable URL — keep the raw text, the user can edit it
    }
    insertStep({ type: 'assert', assertKind: 'url-contains', value: prefill }, insertAt)
    setInsertAt(null)
  }

  // Title check, prefilled with the live page title (only main can read it —
  // the title lives inside the native browser view).
  const handleAddTitleCheck = async (): Promise<void> => {
    await handleCancelPick()
    const info = await window.api.browser.getPageInfo()
    insertStep({ type: 'assert', assertKind: 'title', value: info.title }, insertAt)
    setInsertAt(null)
  }

  const handleAddAssert = (): void => {
    if (!pickedElement) return
    // An attribute check without an attribute name can never pass — hold the
    // panel open until one is entered.
    if (assertKind === 'attribute' && !assertAttr.trim()) return
    insertStep(
      {
        type: 'assert',
        assertKind,
        label: pickedElement.label,
        selector: pickedElement.selector,
        candidates: pickedElement.candidates,
        value: assertNeedsValue(assertKind) ? assertValue : undefined,
        attrName: assertKind === 'attribute' ? assertAttr.trim() : undefined
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
        idx !== i
          ? s
          : s.type === 'navigate'
            ? { ...s, url: editValue }
            : { ...s, value: editValue }
      )
    )
  }

  // A one-line summary of the last/current replay for the status banner.
  // While PAUSED for recovery (Day 12), the recovery panel carries the story.
  const replayBanner = ((): { tone: string; text: string } | null => {
    if (recovery) return null
    if (isReplaying) return { tone: 'running', text: 'Replaying…' }
    if (failedIndex !== null)
      return { tone: 'failed', text: `✗ Failed at step ${failedIndex + 1}: ${replayError}` }
    if (doneIndices.size > 0 && doneIndices.size + skippedIndices.size === enabledCount) {
      return skippedIndices.size > 0
        ? {
            tone: 'passed',
            text: `✓ Finished: ${doneIndices.size} passed, ${skippedIndices.size} skipped`
          }
        : { tone: 'passed', text: `✓ All ${enabledCount} steps passed` }
    }
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

          {/* === Day 11 + 11.5: saved-test library, grouped into sections === */}
          {(savedTests.length > 0 || suites.length > 0) && (
            <div className="test-library">
              <div className="library-heading">
                <span className="library-heading-title">Test Library</span>
                <span className="library-heading-sub">
                  {savedTests.length === 0
                    ? 'your saved test flows will appear here'
                    : `${savedTests.length} saved test flow${savedTests.length === 1 ? '' : 's'}`}
                </span>
              </div>
              {(() => {
                // Sections in display order: E2E + Daily always shown (even
                // empty, so they're discoverable), customs after, legacy
                // root-level tests last under "Unsorted".
                const groups = [...suites]
                for (const t of savedTests) {
                  if (t.suite && !groups.includes(t.suite)) groups.push(t.suite)
                }
                if (savedTests.some((t) => !t.suite)) groups.push('')
                return groups.map((suite) => {
                  const tests = savedTests.filter((t) => t.suite === suite)
                  const suiteKey = suite || '(unsorted)'
                  const isOpen = openSuites.has(suiteKey)
                  return (
                    <div key={suiteKey} className="library-section">
                      <div className="library-section-header">
                        <button
                          type="button"
                          className="section-toggle"
                          onClick={() => toggleSuite(suiteKey)}
                          aria-expanded={isOpen}
                          title={isOpen ? 'Collapse section' : 'Expand section'}
                        >
                          <span className="section-caret">{isOpen ? '▾' : '▸'}</span>
                          <span className="library-title">
                            {suite ? `${suite} test flows` : 'Unsorted'}
                          </span>
                          <span className="library-count">{tests.length}</span>
                          {/* Collapsed: one dot per test — suite health at a
                              glance without expanding */}
                          {!isOpen && tests.length > 0 && (
                            <span className="suite-health">
                              {tests.slice(0, 10).map((t) => (
                                <span
                                  key={t.fileName}
                                  className={`history-dot ${t.lastRun?.status ?? 'none'}`}
                                  title={`${t.name}: ${t.lastRun ? `last replay ${t.lastRun.status}` : 'never replayed'}`}
                                />
                              ))}
                              {tests.length > 10 && (
                                <span className="suite-health-more">+{tests.length - 10}</span>
                              )}
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          className="run-suite-btn"
                          onClick={() => handleRunSuite(suite || 'Unsorted', tests)}
                          disabled={tests.length === 0}
                          title={
                            tests.length === 0
                              ? 'No tests in this section yet'
                              : `Replay all ${tests.length} test(s) in ${suite || 'Unsorted'}`
                          }
                        >
                          ▶ Run all
                        </button>
                      </div>
                      {!isOpen ? null : tests.length === 0 ? (
                        <p className="library-empty">No tests yet — save one with 💾</p>
                      ) : (
                        <ul className="library-list">
                          {tests.map((test) => (
                            <li key={test.fileName} className="library-item">
                              <button
                                type="button"
                                className="library-row"
                                onClick={() => handleLoadTest(test.fileName)}
                                title={`Open "${test.name}"`}
                              >
                                <span
                                  className={`run-dot ${test.lastRun?.status ?? 'none'}`}
                                  title={
                                    test.lastRun
                                      ? `Last replay ${test.lastRun.status} — ${new Date(test.lastRun.at).toLocaleString()}`
                                      : 'Never replayed'
                                  }
                                />
                                <span className="library-name">{test.name}</span>
                                {/* Day 11.5: last runs, oldest → newest — flakiness at a glance */}
                                {test.runs && test.runs.length > 1 && (
                                  <span className="history-dots">
                                    {test.runs
                                      .slice()
                                      .reverse()
                                      .map((run, i) => (
                                        <span
                                          key={i}
                                          className={`history-dot ${run.status}`}
                                          title={`${run.status} — ${new Date(run.at).toLocaleString()}`}
                                        />
                                      ))}
                                  </span>
                                )}
                                <span className="library-meta">
                                  {test.stepCount} steps ·{' '}
                                  {new Date(test.updatedAt).toLocaleDateString()}
                                </span>
                              </button>
                              <button
                                type="button"
                                className="library-delete"
                                onClick={() => handleDeleteTest(test)}
                                title="Delete test"
                                aria-label={`Delete ${test.name}`}
                              >
                                ✕
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )
                })
              })()}
            </div>
          )}
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
            isPicking ? 'Cancel picking (or press Esc)' : 'Add a check: pick an element on the page'
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
          {/* === Day 11: current test identity (name + editable base URL) === */}
          {testName && (
            <div className="test-bar">
              {testSuite && <span className="test-suite-tag">{testSuite}</span>}
              <span className="test-name" title={testName}>
                {testName}
              </span>
              {editingBase ? (
                <input
                  className="test-base-input"
                  value={baseEditValue}
                  onChange={(e) => setBaseEditValue(e.target.value)}
                  onBlur={handleCommitBaseURL}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCommitBaseURL()
                    else if (e.key === 'Escape') setEditingBase(false)
                  }}
                  autoFocus
                  spellCheck={false}
                />
              ) : (
                <button
                  type="button"
                  className="test-base"
                  onClick={() => {
                    setBaseEditValue(baseURL)
                    setEditingBase(true)
                  }}
                  title="Base URL — click to edit. Changing it retargets every navigation step (e.g. staging vs production)."
                >
                  {baseURL || 'no base URL'}
                </button>
              )}
            </div>
          )}
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
                  className="save-test-btn"
                  onClick={handleOpenSavePanel}
                  disabled={isReplaying || isRecording}
                  title={testName ? `Save changes to "${testName}"` : 'Save test to library'}
                  aria-label="Save test"
                >
                  💾
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
          {/* Day 11.5: suite-run progress line ("test 2 of 5") */}
          {suiteRun?.running && (
            <div className="replay-status running">
              Running section {suiteRun.suite} — test {suiteRun.current} of {suiteRun.total}
              {suiteRun.currentName ? `: ${suiteRun.currentName}` : ''}
            </div>
          )}
          {replayBanner && (
            <div className={`replay-status ${replayBanner.tone}`}>
              {replayBanner.text}
              {/* Day 11.5: the page photographed at the failing step */}
              {replayBanner.tone === 'failed' && lastScreenshotPath && (
                <button
                  type="button"
                  className="shot-link"
                  onClick={() => window.api.library.openScreenshot(lastScreenshotPath)}
                  title="Open the failure screenshot"
                >
                  📷 view screenshot
                </button>
              )}
              {/* Day 13: turn the failure into a plain-English diagnosis */}
              {replayBanner.tone === 'failed' && failedIndex !== null && replayError && (
                <button
                  type="button"
                  className="shot-link explain-link"
                  onClick={() =>
                    handleExplain(
                      failedIndex,
                      replayError,
                      lastScreenshotPath,
                      lastConsoleErrors,
                      lastNetworkErrors
                    )
                  }
                  title="Explain this failure: app bug, test bug, or just timing?"
                >
                  💡 explain
                </button>
              )}
            </div>
          )}

          {/* === Day 12: recovery panel — the replay is paused on a failed
              step, browser frozen at the scene. Not a modal: the page must
              stay visible (and clickable, for Re-pick). === */}
          {recovery && (
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
              {repickIndex !== null ? (
                <div className="assert-actions recovery-actions">
                  <span className="recovery-hint">
                    Click the correct element in the page (Esc cancels)
                  </span>
                  <button className="modal-btn" onClick={handleRecoveryRepickCancel}>
                    Cancel re-pick
                  </button>
                </div>
              ) : (
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
                        recovery.networkErrors ?? []
                      )
                    }
                    title="Explain this failure: app bug, test bug, or just timing?"
                  >
                    💡
                  </button>
                  <button
                    className="modal-btn"
                    onClick={() => answerRecovery('retry')}
                    title="Run the same step again (maybe the page was just slow)"
                  >
                    🔁 Retry
                  </button>
                  <button
                    className="modal-btn"
                    onClick={handleRecoveryRepick}
                    disabled={!steps[recovery.index]?.selector}
                    title={
                      steps[recovery.index]?.selector
                        ? 'Point at the right element — heals the selector, then retries'
                        : 'This step has no element to re-pick'
                    }
                  >
                    🎯 Re-pick
                  </button>
                  <button
                    className="modal-btn"
                    onClick={() => answerRecovery('skip')}
                    title="Skip this step for THIS run and continue"
                  >
                    ⏭ Skip
                  </button>
                  <button
                    className="modal-btn danger"
                    onClick={() => answerRecovery('stop')}
                    title="End the run as failed"
                  >
                    ⏹ Stop
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Day 12: re-picked selectors live only in the panel until saved */}
          {healedIndices.size > 0 && !isReplaying && (
            <div className="replay-status healed">
              🔧 {healedIndices.size} selector{healedIndices.size > 1 ? 's' : ''} healed by re-pick
              — 💾 save to keep the fix
            </div>
          )}

          {/* === Day 11: save panel (reuses the assert-panel look) === */}
          {savePanelOpen && (
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
              <div className="assert-actions">
                <button className="modal-btn" onClick={() => setSavePanelOpen(false)}>
                  Cancel
                </button>
                <button className="modal-btn primary" onClick={handleSaveTest}>
                  Save
                </button>
              </div>
            </div>
          )}
          {isPicking && repickIndex === null && (
            <div className="replay-status running">
              Click an element in the page to check it (Esc cancels)
              <div className="page-checks">
                <span className="page-checks-label">or check the page itself:</span>
                <button type="button" className="page-check-chip" onClick={handleAddUrlCheck}>
                  URL
                </button>
                <button type="button" className="page-check-chip" onClick={handleAddTitleCheck}>
                  Title
                </button>
              </div>
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
              {/* Day 12: warn NOW about an element replay will refuse later */}
              {pickedElement.unreliable && (
                <div className="pick-warning">
                  ⚠ This element has no stable hooks (no id / role / text) — a check on it cannot
                  replay reliably. Pick a more specific element instead (its label, or a container
                  with an id).
                </div>
              )}
              <div className="assert-kinds">
                {ASSERT_KINDS.filter(
                  (kind) =>
                    (kind !== 'checked' && kind !== 'unchecked') ||
                    pickedElement.checked !== undefined
                ).map((kind) => (
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
              {assertKind === 'attribute' && (
                <input
                  className="assert-value"
                  value={assertAttr}
                  onChange={(e) => setAssertAttr(e.target.value)}
                  placeholder="attribute name (e.g. href, src, alt)…"
                  spellCheck={false}
                />
              )}
              {assertNeedsValue(assertKind) && (
                <input
                  className="assert-value"
                  value={assertValue}
                  onChange={(e) => setAssertValue(e.target.value)}
                  placeholder={
                    assertKind === 'count'
                      ? 'expected number of matches…'
                      : assertKind === 'class'
                        ? 'class name (one token, e.g. error)…'
                        : assertKind === 'attribute'
                          ? 'expected attribute value…'
                          : 'expected value…'
                  }
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
                <button
                  className="modal-btn primary"
                  onClick={handleAddAssert}
                  disabled={pickedElement.unreliable}
                  title={
                    pickedElement.unreliable
                      ? 'No reliable selector — this check would always fail on replay'
                      : undefined
                  }
                >
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
                          : skippedIndices.has(i)
                            ? ' skipped'
                            : doneIndices.has(i)
                              ? ' done'
                              : ''
                    }`}
                  >
                    <span className="step-num">
                      {doneIndices.has(i) ? '✓' : skippedIndices.has(i) ? '»' : i + 1}
                    </span>
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
                      {healedIndices.has(i) && (
                        <span
                          className="healed-tag"
                          title="Selector healed by re-pick — 💾 save to keep it"
                        >
                          🔧 healed
                        </span>
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

      {/* === Day 11.5: suite-run summary (shown when the run finishes) === */}
      {suiteSummaryOpen && suiteRun && (
        <div className="modal-backdrop" onClick={() => setSuiteRun(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">
                {suiteRun.suite}: {suiteRun.results.filter((r) => r.status === 'passed').length}{' '}
                passed, {suiteRun.results.filter((r) => r.status === 'failed').length} failed
              </span>
              <button className="modal-close" onClick={() => setSuiteRun(null)} aria-label="Close">
                ✕
              </button>
            </div>
            <ul className="suite-summary">
              {suiteRun.results.map((r) => (
                <li key={r.fileName} className="suite-result">
                  <span className={`run-dot ${r.status}`} />
                  <span className="suite-result-name">{r.name}</span>
                  {r.status === 'failed' && (
                    <span className="suite-result-error">
                      {r.failedAt !== undefined ? `step ${r.failedAt + 1} — ` : ''}
                      {r.error}
                    </span>
                  )}
                  {r.screenshotPath && (
                    <button
                      type="button"
                      className="shot-link"
                      onClick={() => window.api.library.openScreenshot(r.screenshotPath!)}
                      title="Open the failure screenshot"
                    >
                      📷
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <div className="modal-footer">
              <button className="modal-btn primary" onClick={() => setSuiteRun(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* === Day 13: failure analysis + bug report modal. One overlay, two
          views: the diagnosis first, the generated report after the button.
          A modal is safe here even mid-recovery — setOverlay hides the
          native pane while it's open and restores it on close. === */}
      {analysisOpen && (
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
                  Analyzing the failure… asking Claude first — if it isn&apos;t available, this
                  falls back to the built-in rules automatically.
                </p>
              </div>
            ) : analysis ? (
              <div className="analysis-body">
                <div className="analysis-meta">
                  <span className={`verdict-chip ${analysis.verdict}`}>
                    {VERDICT_LABELS[analysis.verdict] ?? analysis.verdict}
                  </span>
                  <span className="analysis-source">
                    {analysis.source === 'ai'
                      ? 'analyzed by Claude'
                      : 'built-in rules (Claude unavailable)'}
                  </span>
                </div>
                <p className="analysis-text">{analysis.explanation}</p>
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
                  <button className="modal-btn primary" onClick={handleSaveReport}>
                    Save .md
                  </button>
                </>
              ) : (
                <>
                  <button className="modal-btn" onClick={closeAnalysis}>
                    Close
                  </button>
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
      )}

      {/* === Export preview modal === */}
      {exportCode !== null && (
        <div className="modal-backdrop" onClick={() => setExportCode(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Playwright test</span>
              <button
                className="modal-close"
                onClick={() => setExportCode(null)}
                aria-label="Close"
              >
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
