import { useEffect, useRef, useState, type FormEvent } from 'react'
import { generatePlaywrightTest, generatePageObjectTest, stepText } from './playwrightExport'
import { generateBugReport, bugReportFileName } from './bugReport'

const EXAMPLE_URLS = ['saucedemo.com', 'google.com', 'github.com']

// Day 16(+): human-friendly byte size for the download toast.
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

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
  // Day 17 (multiple windows): the open browser tabs. Empty/one = strip hidden.
  const [tabs, setTabs] = useState<TabInfo[]>([])
  // The generated Playwright code shown in the export modal (null = closed).
  const [exportCode, setExportCode] = useState<string | null>(null)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  // Day 17 (page-object export): toggle between inline and full POM output.
  const [poExport, setPoExport] = useState(false)
  // POM mode produces a SECOND file (the page class). Null = inline (one file).
  const [exportPage, setExportPage] = useState<string | null>(null)
  const [exportPageFileName, setExportPageFileName] = useState('')
  const [exportTab, setExportTab] = useState<'spec' | 'page'>('spec')
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
  // Day 18 — auto-saved drafts (unsaved in-progress recordings). `draftIdRef`
  // is the current recording's draft id; the timer debounces the auto-save.
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const draftIdRef = useRef<string | null>(null)
  const draftSaveTimer = useRef<number | null>(null)
  const [draftDismissed, setDraftDismissed] = useState(false)
  // Welcome screen: which test's last-run error detail is expanded (by fileName).
  const [errorOpenFor, setErrorOpenFor] = useState<string | null>(null)
  const [testName, setTestName] = useState('')
  const [testFileName, setTestFileName] = useState<string | null>(null)
  const [baseURL, setBaseURL] = useState('')
  // Day 17 — session reuse: the storageState file attached to this test (start
  // logged in), and the list of saved sessions to pick from.
  const [storageState, setStorageState] = useState<string | undefined>(undefined)
  const [sessions, setSessions] = useState<string[]>([])
  // Day 17 — viewport emulation: the device viewport this test renders at
  // (undefined = desktop / fill the window).
  const [viewport, setViewport] = useState<{ width: number; height: number } | undefined>(undefined)
  const [savePanelOpen, setSavePanelOpen] = useState(false)
  const [saveNameInput, setSaveNameInput] = useState('')
  // Day 17 (session reuse): the name to save the current browser session under.
  const [sessionNameInput, setSessionNameInput] = useState('')
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
  // Day 18 — run trace. `traceMode` mirrors Playwright's retain policy; the
  // viewer opens a saved trace (manifest + the selected step's full image).
  const [traceMode, setTraceMode] = useState<'always' | 'failure' | 'off'>(
    () => (localStorage.getItem('qaflow.traceMode') as 'always' | 'failure' | 'off') || 'failure'
  )
  const [lastTraceId, setLastTraceId] = useState<string | null>(null)
  const [traceView, setTraceView] = useState<TraceManifest | null>(null)
  const [traceStepIdx, setTraceStepIdx] = useState(0)
  const [traceImg, setTraceImg] = useState<string | null>(null)
  const [traceSavedAt, setTraceSavedAt] = useState<string | null>(null)
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
  // A re-pick whose element looks DIFFERENT from the original step — held back
  // for a "heal anyway?" confirm so a wrong pick can't silently heal (Day 17).
  const [repickPending, setRepickPending] = useState<{
    picked: PickedElement
    healIndex: number
    message: string
  } | null>(null)
  // Day 16(+): a transient download toast (record + replay). 'downloading' is
  // shown immediately on start; it resolves to 'done' (ok/empty/failed).
  const [downloadToast, setDownloadToast] = useState<
    { name: string; phase: 'downloading' } | (DownloadInfo & { phase: 'done' }) | null
  >(null)
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
  // Day 18: is this a multi-tab recording? If so, EVERY step shows which tab it
  // runs on (incl. the original "main tab") — otherwise the original tab is the
  // only one with no badge, which reads as missing/confusing.
  const multiWindow = steps.some((s) => (s.windowId ?? 0) > 0 || s.opensWindow !== undefined)

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

  // Refresh the library list + section list + drafts whenever welcome shows.
  useEffect(() => {
    if (!hasNavigated) {
      window.api.library.list().then(setSavedTests)
      window.api.library.listSuites().then(setSuites)
      window.api.drafts.list().then(setDrafts)
    }
  }, [hasNavigated])

  // Day 18: auto-save the current UNSAVED recording as a draft (debounced), so
  // a forgotten Save never loses work. Saved tests persist via the library, so
  // they're skipped here. Once steps exist, a draft id is minted and reused.
  useEffect(() => {
    if (testFileName !== null || steps.length === 0) return
    if (!draftIdRef.current) draftIdRef.current = `draft-${Date.now()}`
    const id = draftIdRef.current
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current)
    draftSaveTimer.current = window.setTimeout(() => {
      window.api.drafts.save({
        id,
        name: testName,
        baseURL,
        suite: testSuite,
        storageState,
        viewport,
        steps
      })
    }, 700)
    return () => {
      if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current)
    }
  }, [steps, testFileName, testName, baseURL, testSuite, storageState, viewport])

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

  // Day 17 (multiple windows): keep the tab strip in sync with main.
  useEffect(() => {
    const unsubscribe = window.api.browser.onTabsChanged((t) => setTabs(t))
    return unsubscribe
  }, [])

  // Day 17 (session reuse): load the saved-session list once.
  const refreshSessions = (): void => {
    window.api.session.list().then(setSessions)
  }
  useEffect(() => {
    refreshSessions()
  }, [])

  // Apply a re-pick heal: same step, new eyes — keep what it DOES (type/value/
  // check), replace how it FINDS the element (label + ladder + frame), and retry.
  const applyHeal = (picked: PickedElement, healIndex: number): void => {
    const next = stepsRef.current.map((s, idx) =>
      idx === healIndex
        ? {
            ...s,
            label: picked.label,
            selector: picked.selector,
            candidates: picked.candidates,
            // Day 15: the re-picked element may now live in a different frame
            // (or none) — carry its frame so replay routes correctly.
            frame: picked.frame
          }
        : s
    )
    setSteps(next)
    setHealedIndices((prev) => new Set(prev).add(healIndex))
    setRecovery(null)
    setRepickPending(null)
    window.api.recorder.recovery({ action: 'retry', step: next[healIndex] })
  }

  // Day 17: does the re-picked element look DIFFERENT from the original step's
  // element? A click succeeds on almost anything, so without this a wrong pick
  // would silently "heal" + pass. Compare visible label (unrelated words) and
  // ARIA role. Returns a warning to confirm, or null when it's a clean match.
  const repickMismatch = (original: RecorderStep, picked: PickedElement): string | null => {
    const norm = (s?: string): string =>
      (s ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
    const a = norm(original.label)
    const b = norm(picked.label)
    // A clean heal needs a STRONG label match — not just one shared word (the
    // page is full of links like "Dynamic Loading" that share "Dynamic" with
    // "Dynamic Controls"). Clean = exact, OR one contains the other, OR most of
    // the original's words appear in the pick. Everything else (a different
    // element, or an empty/unrelated pick) is a mismatch → confirm before heal.
    let labelDiffers = false
    if (a) {
      const exactOrContains = !!b && (a === b || a.includes(b) || b.includes(a))
      if (!exactOrContains) {
        const aTokens = a.split(' ').filter(Boolean)
        const bTokens = new Set(b.split(' ').filter(Boolean))
        const shared = aTokens.filter((t) => bTokens.has(t)).length
        labelDiffers = aTokens.length === 0 ? !!b : shared / aTokens.length < 0.6
      }
    }
    const oRole = primaryCandidate(original)?.role
    const pRole = picked.candidates.find((c) => c.locator === picked.selector)?.role
    const roleDiffers = !!oRole && !!pRole && oRole !== pRole
    if (!labelDiffers && !roleDiffers) return null
    const origDesc = original.label ? `"${original.label}"${oRole ? ` (${oRole})` : ''}` : 'it'
    const gotDesc = picked.label ? `"${picked.label}"${pRole ? ` (${pRole})` : ''}` : 'that element'
    return `You picked ${gotDesc}, but the original step targeted ${origDesc} — they look different. Heal anyway?`
  }

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
        // Day 17: if the pick looks different from the original element, hold it
        // for a "heal anyway?" confirm instead of silently healing.
        const original = stepsRef.current[healIndex]
        const mismatch = original ? repickMismatch(original, picked) : null
        if (mismatch) {
          setRepickPending({ picked, healIndex, message: mismatch })
          return
        }
        applyHeal(picked, healIndex)
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
      setRepickPending(null)
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

  // Day 17 (multiple windows): main tells us a click opened a new tab AFTER the
  // step was already sent — patch that step (matched by id) with `opensWindow`.
  useEffect(() => {
    const unsubscribe = window.api.recorder.onStepPatch((patch) => {
      setSteps((prev) =>
        prev.map((s) => (s.id === patch.id ? { ...s, opensWindow: patch.opensWindow } : s))
      )
    })
    return unsubscribe
  }, [])

  // Day 16(+): download toast — show "downloading…" the instant it starts, then
  // resolve to the finished state. Works during record AND replay. A finished
  // toast auto-dismisses; the in-progress one stays until 'done' arrives.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const clearTimer = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
    }
    const unsubStart = window.api.recorder.onDownloadStart((info) => {
      clearTimer()
      setDownloadToast({ name: info.name, phase: 'downloading' })
    })
    const unsubDone = window.api.recorder.onDownloadDone((info) => {
      clearTimer()
      setDownloadToast({ ...info, phase: 'done' })
      timer = setTimeout(() => setDownloadToast(null), 4500)
    })
    return () => {
      clearTimer()
      unsubStart()
      unsubDone()
    }
  }, [])

  // The embedded browser is a native pane that paints over our UI, so while
  // any full-window overlay is open (export modal, suite summary) we ask main
  // to hide it (else it covers the modal).
  const suiteSummaryOpen = suiteRun !== null && !suiteRun.running
  useEffect(() => {
    window.api.browser.setOverlay(
      exportCode !== null || suiteSummaryOpen || analysisOpen || traceView !== null
    )
  }, [exportCode, suiteSummaryOpen, analysisOpen, traceView])

  // Day 18: remember the trace policy across sessions.
  useEffect(() => {
    localStorage.setItem('qaflow.traceMode', traceMode)
  }, [traceMode])

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
    // Day 18: "start over" discards the current draft too.
    if (draftIdRef.current) {
      window.api.drafts.delete(draftIdRef.current)
      draftIdRef.current = null
    }
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
    // Day 18: flush the current unsaved recording to its draft NOW (the
    // debounced auto-save may not have fired yet), so leaving never loses it.
    // It then lives in the Recent list; mint a fresh draft for the next take.
    if (draftIdRef.current && steps.length > 0 && testFileName === null) {
      window.api.drafts.save({
        id: draftIdRef.current,
        name: testName,
        baseURL,
        suite: testSuite,
        storageState,
        viewport,
        steps
      })
    }
    draftIdRef.current = null
    setDraftDismissed(true) // don't nag with the recover banner after an explicit Home
    await window.api.browser.home()
    setHasNavigated(false)
    setUrlInput('')
    setIsRecording(false)
    setSteps([])
    // Fresh start drops the current test identity too (steps are gone).
    setTestName('')
    setTestFileName(null)
    setBaseURL('')
    setStorageState(undefined)
    applyViewport(undefined)
    setTestSuite('')
    setSavePanelOpen(false)
    setSuiteRun(null)
    setLastScreenshotPath(null)
    // Day 12: main answers any paused replay with a silent abort on Home —
    // mirror that here so no recovery UI survives the trip to welcome.
    setRecovery(null)
    setRecoveryWarning(null)
    setRepickPending(null)
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
  // Generate the export and show it. Inline = one file; Page Object = two files
  // (a spec + a page class), unless the test is multi-tab/iframe/dialog/download
  // (POM falls back to inline, since those don't fit a clean auto-POM).
  const showExport = (pageObject: boolean): void => {
    const opts = {
      name: testName || undefined,
      baseURL: baseURL || deriveBaseURL(steps) || undefined,
      storageState,
      viewport
    }
    if (pageObject) {
      const pom = generatePageObjectTest(steps, opts)
      if (pom) {
        setExportCode(pom.spec)
        setExportPage(pom.page)
        setExportPageFileName(pom.pageFileName)
        setExportTab('spec')
        return
      }
      // Unsupported for POM — fall back to inline so the user still gets output.
    }
    setExportCode(generatePlaywrightTest(steps, opts))
    setExportPage(null)
  }

  const handleExport = (): void => {
    setSavedPath(null)
    showExport(poExport)
  }

  // Day 17: flip between inline and Page Object output, regenerating the preview.
  const handleTogglePoExport = (po: boolean): void => {
    setPoExport(po)
    showExport(po)
  }

  // Save the previewed code to .ts file(s) (main shows the OS save dialog). In
  // Page Object mode the page class is written to a pages/ folder beside the spec.
  const handleSaveExport = async (): Promise<void> => {
    if (!exportCode) return
    // Day 16(+): gather the upload files this test references so main can copy
    // them into a fixtures/ folder next to the saved spec (portable export).
    const fixturePaths = Array.from(
      new Set(
        steps
          .filter((s) => s.type === 'upload' && !s.disabled && s.value)
          .flatMap((s) => (s.value ?? '').split('\n').filter(Boolean))
      )
    )
    const path = await window.api.recorder.exportTest(
      exportCode,
      fixturePaths,
      storageState,
      exportPage ?? undefined,
      exportPage ? exportPageFileName : undefined
    )
    if (path) setSavedPath(path)
  }

  const handleCopyExport = (): void => {
    const code = exportTab === 'page' && exportPage ? exportPage : exportCode
    if (code) navigator.clipboard.writeText(code)
  }

  // One replay of one steps-list, with outcome recorded for saved tests.
  // Shared by the single Replay button AND the Day 11.5 suite runner.
  // `interactive` (Day 12): a failure pauses for Retry / Re-pick / Skip / Stop
  // — only the single Replay button uses it; suite runs stay unattended.
  const runOnce = async (
    list: RecorderStep[],
    fileName: string | null,
    interactive = false,
    sessionFile: string | undefined = storageState
  ): Promise<{
    ok: boolean
    failedAt?: number
    error?: string
    screenshotPath?: string
    aborted?: boolean
    traceId?: string
  }> => {
    setFailedIndex(null)
    setReplayError(null)
    setDoneIndices(new Set())
    setReplayingIndex(null)
    setLastScreenshotPath(null)
    setLastTraceId(null)
    setSkippedIndices(new Set())
    setRecovery(null)
    setLastConsoleErrors([])
    setLastNetworkErrors([])
    setIsReplaying(true)
    // Day 18: hand main the trace policy + the human step sentences (so the
    // saved trace is self-contained) + the test name for the manifest.
    const result = await window.api.recorder.replay(list, interactive, sessionFile, {
      mode: traceMode,
      stepTexts: list.map((s) => stepText(s)),
      testName: testName || undefined
    })
    setIsReplaying(false)
    setReplayingIndex(null)
    setRecovery(null)
    // Aborted = Home was pressed mid-recovery. The run is moot — no failure
    // banner, no run recorded.
    if (result.aborted) return result
    setLastTraceId(result.traceId ?? null)
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
        screenshotPath: result.screenshotPath,
        traceId: result.traceId
      })
    }
    return result
  }

  // === Day 18: run-trace viewer ======================================
  // Open a saved trace: load its manifest (thumbnails inlined), jump to the
  // failed step if any, and fetch that step's full screenshot.
  const loadTraceImage = async (manifest: TraceManifest, pos: number): Promise<void> => {
    setTraceImg(null)
    const step = manifest.steps[pos]
    if (step?.screenshotFile) {
      const img = await window.api.trace.getImage(manifest.id, step.screenshotFile)
      setTraceImg(img)
    }
  }
  const openTrace = async (id: string): Promise<void> => {
    const manifest = await window.api.trace.get(id)
    if (!manifest) return
    setTraceView(manifest)
    const failPos = manifest.steps.findIndex((s) => s.status === 'error')
    const pos = failPos >= 0 ? failPos : 0
    setTraceStepIdx(pos)
    loadTraceImage(manifest, pos)
  }
  const selectTraceStep = (pos: number): void => {
    if (!traceView) return
    setTraceStepIdx(pos)
    loadTraceImage(traceView, pos)
  }
  const closeTrace = (): void => {
    setTraceView(null)
    setTraceImg(null)
    setTraceSavedAt(null)
  }
  const saveTraceRecording = async (): Promise<void> => {
    if (!traceView) return
    const dest = await window.api.trace.export(traceView.id)
    if (dest) setTraceSavedAt(dest)
  }

  // Replay: run all recorded steps in the embedded browser and watch them go.
  // Interactive — a failed step pauses for recovery instead of ending the run.
  const handleReplay = async (): Promise<void> => {
    await runOnce(steps, testFileName, true)
  }

  // === Day 12: recovery — answer a paused replay ====================
  const answerRecovery = (action: 'retry' | 'continue' | 'skip' | 'stop'): void => {
    setRecovery(null)
    setRecoveryWarning(null)
    setRepickPending(null)
    window.api.recorder.recovery({ action })
  }

  // Day 18: PERMANENT skip — disable the failed step (skipped now and in future
  // runs) and continue. setSteps directly (like a re-pick heal) to keep the
  // live replay marks; 💾 Save persists the disable.
  const handleRecoverySkipStep = (): void => {
    if (!recovery) return
    const i = recovery.index
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, disabled: true } : s)))
    answerRecovery('skip')
  }

  // Re-pick: open the Day 9 element picker; the onPicked handler above heals
  // the failed step with the fresh ladder and retries it.
  const handleRecoveryRepick = async (): Promise<void> => {
    if (!recovery) return
    setRecoveryWarning(null)
    setRepickPending(null)
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

  // Day 17 (viewport emulation): set the device viewport and apply it live so
  // the embedded browser re-renders at that size immediately.
  const applyViewport = (vp: { width: number; height: number } | undefined): void => {
    setViewport(vp)
    window.api.browser.setViewport(vp ?? null)
  }

  // Day 17 (session reuse): capture the embedded browser's CURRENT state (after
  // logging in) as a named session, then auto-attach it to this test.
  const handleSaveSession = async (): Promise<void> => {
    const name = sessionNameInput.trim()
    if (!name) return
    const file = await window.api.session.save(name)
    if (file) {
      setSessionNameInput('')
      setStorageState(file)
      refreshSessions()
    }
  }

  const handleSaveTest = async (): Promise<void> => {
    const name = saveNameInput.trim()
    if (!name) return
    // A typed new section name wins over the chosen chip.
    const suite = newSuiteInput.trim() || saveSuite || 'Daily'
    const base = baseURL || deriveBaseURL(steps)
    const summary = await window.api.library.save({
      name,
      baseURL: base,
      suite,
      steps,
      storageState,
      viewport
    })
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
    // Day 18: it's a real test now — drop the auto-saved draft.
    if (draftIdRef.current) {
      window.api.drafts.delete(draftIdRef.current)
      draftIdRef.current = null
    }
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
    setStorageState(test.storageState)
    applyViewport(test.viewport)
    setHasNavigated(true)
    const firstNav = test.steps.find((s) => s.type === 'navigate' && s.url)
    if (firstNav?.url) {
      setUrlInput(firstNav.url)
      window.api.browser.navigate(firstNav.url)
    }
  }

  // Day 18: restore an auto-saved draft (an unsaved recording). Like opening a
  // test, but it has no fileName — it stays a draft until explicitly saved, and
  // editing it keeps updating the SAME draft.
  const handleLoadDraft = async (id: string): Promise<void> => {
    const d = await window.api.drafts.load(id)
    if (!d) return
    editSteps(d.steps)
    setTestName(d.name || '')
    setTestFileName(null)
    setTestSuite(d.suite || '')
    setBaseURL(d.baseURL || '')
    setStorageState(d.storageState)
    applyViewport(d.viewport)
    draftIdRef.current = d.id
    setDraftDismissed(true)
    setHasNavigated(true)
    const firstNav = d.steps.find((s) => s.type === 'navigate' && s.url)
    if (firstNav?.url) {
      setUrlInput(firstNav.url)
      window.api.browser.navigate(firstNav.url)
    }
  }

  const handleDeleteDraft = async (id: string): Promise<void> => {
    await window.api.drafts.delete(id)
    setDrafts((prev) => prev.filter((d) => d.id !== id))
    if (draftIdRef.current === id) draftIdRef.current = null
  }

  // A friendly label for a draft: its name if it was given one, else the site
  // it's recording (the first URL's domain), else a fallback.
  const draftLabel = (d: DraftSummary): string => {
    if (d.name) return d.name
    if (d.firstUrl) {
      try {
        return new URL(d.firstUrl).hostname.replace(/^www\./, '')
      } catch {
        return d.firstUrl
      }
    }
    return 'Untitled recording'
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
        const result = await runOnce(data.steps, t.fileName, false, data.storageState)
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
    // Day 16: a prompt's answer text, or a confirm's 'accept'/'dismiss', is
    // editable; an alert has no answer to edit.
    if (step.type === 'dialog' && step.dialogKind !== 'alert') {
      return step.value ?? ''
    }
    // Day 16(+): a download step's expected filename to verify (non-empty is
    // always checked; this is the "correct file" part).
    if (step.type === 'download') return step.value ?? step.label ?? ''
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
        attrName: assertKind === 'attribute' ? assertAttr.trim() : undefined,
        // Day 15: assert in the same frame the element was picked from.
        frame: pickedElement.frame
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

  const handleStartEdit = async (i: number): Promise<void> => {
    // Day 16(+): an upload step isn't text-editable — its "value" is a file
    // path. The ✎ instead opens an OS file picker; the chosen file is copied
    // into the library and swapped into the step (label = the new filename).
    if (steps[i].type === 'upload') {
      const newPath = await window.api.recorder.pickUploadFile()
      if (!newPath) return
      const name = newPath.split(/[\\/]/).pop() ?? 'file'
      editSteps(steps.map((s, idx) => (idx === i ? { ...s, value: newPath, label: name } : s)))
      return
    }
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

          {/* Day 18: recover the most recent unsaved recording (until dismissed). */}
          {!draftDismissed && drafts.length > 0 && (
            <div className="recover-banner">
              <span className="recover-text">
                ↩ Unsaved recording — <strong>{draftLabel(drafts[0])}</strong> ·{' '}
                {drafts[0].stepCount} step{drafts[0].stepCount === 1 ? '' : 's'} ·{' '}
                {new Date(drafts[0].updatedAt).toLocaleString()}
              </span>
              <div className="recover-actions">
                <button
                  type="button"
                  className="recover-btn primary"
                  onClick={() => handleLoadDraft(drafts[0].id)}
                >
                  Restore
                </button>
                <button
                  type="button"
                  className="recover-btn"
                  onClick={() => setDraftDismissed(true)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {/* Day 18: Recent recordings — auto-saved unsaved drafts, newest first. */}
          {drafts.length > 0 && (
            <div className="test-library recent-drafts">
              <div className="library-heading">
                <span className="library-heading-title">Recent recordings</span>
                <span className="library-heading-sub">
                  unsaved — auto-kept so you don’t lose work
                </span>
              </div>
              <ul className="library-list">
                {drafts.map((d) => (
                  <li key={d.id} className="library-item">
                    <div className="library-item-head">
                      <button
                        type="button"
                        className="library-row"
                        onClick={() => handleLoadDraft(d.id)}
                        title="Restore this recording"
                      >
                        <span className="run-dot none" />
                        <span className="library-name" title={d.firstUrl || draftLabel(d)}>
                          {draftLabel(d)}
                        </span>
                        <span className="library-meta">
                          {d.stepCount} step{d.stepCount === 1 ? '' : 's'} ·{' '}
                          {new Date(d.updatedAt).toLocaleString()}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="library-delete"
                        onClick={() => handleDeleteDraft(d.id)}
                        title="Delete this draft"
                        aria-label="Delete draft"
                      >
                        ✕
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

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
                          {tests.map((test) => {
                            // Every recorded run (newest-first). Older files kept
                            // only `lastRun`; treat that as a one-run history.
                            const allRuns =
                              test.runs && test.runs.length
                                ? test.runs
                                : test.lastRun
                                  ? [test.lastRun]
                                  : []
                            // Each failure can be a DIFFERENT error at a different
                            // time — keep them all so the user sees why AND when.
                            const failedRuns = allRuns.filter((r) => r.status === 'failed')
                            const currentlyFailing = test.lastRun?.status === 'failed'
                            return (
                            <li key={test.fileName} className="library-item">
                              <div className="library-item-head">
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
                              {/* Any failure — current OR past — is inspectable
                                  here. A test that passes now but failed before
                                  gets a calmer "Past fail(s)" label so it doesn't
                                  read as currently broken. */}
                              {failedRuns.length > 0 && (
                                <button
                                  type="button"
                                  className={`library-why${errorOpenFor === test.fileName ? ' open' : ''}${currentlyFailing ? '' : ' past'}`}
                                  onClick={() =>
                                    setErrorOpenFor(
                                      errorOpenFor === test.fileName ? null : test.fileName
                                    )
                                  }
                                  title={currentlyFailing ? 'Why did it fail?' : 'Past failures'}
                                >
                                  ⚠{' '}
                                  {failedRuns.length > 1
                                    ? `${failedRuns.length} fails`
                                    : currentlyFailing
                                      ? 'Why?'
                                      : 'Past fail'}
                                </button>
                              )}
                              <button
                                type="button"
                                className="library-delete"
                                onClick={() => handleDeleteTest(test)}
                                title="Delete test"
                                aria-label={`Delete ${test.name}`}
                              >
                                ✕
                              </button>
                              </div>
                              {errorOpenFor === test.fileName && failedRuns.length > 0 && (
                                <div className="run-error-detail">
                                  {/* One entry per failed run — each shows WHEN it
                                      failed and WHY (the errors can differ run to
                                      run), with a jump to that run's screenshot. */}
                                  {failedRuns.map((run, ri) => (
                                    <div key={ri} className="run-fail-entry">
                                      <div className="run-fail-when">
                                        {new Date(run.at).toLocaleString()}
                                        {run.failedAt !== undefined
                                          ? ` · step ${run.failedAt + 1}`
                                          : ''}
                                      </div>
                                      <div className="run-error-msg">
                                        {run.error || 'No error message was recorded.'}
                                      </div>
                                      <div className="run-fail-actions">
                                        {run.screenshotPath && (
                                          <button
                                            type="button"
                                            className="run-error-shot"
                                            onClick={() =>
                                              window.api.library.openScreenshot(run.screenshotPath!)
                                            }
                                          >
                                            📷 View failure screenshot
                                          </button>
                                        )}
                                        {run.traceId && (
                                          <button
                                            type="button"
                                            className="run-error-shot"
                                            onClick={() => openTrace(run.traceId!)}
                                          >
                                            ⏺ Open recording
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </li>
                            )
                          })}
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
      {/* Day 16(+): download confirmation toast — auto-clears after a few sec.
          Three states: ok (has content), empty (downloaded but 0 bytes), and
          failed (transfer didn't finish). */}
      {downloadToast &&
        (() => {
          if (downloadToast.phase === 'downloading') {
            return (
              <div className="download-toast progress">⬇ Downloading {downloadToast.name}…</div>
            )
          }
          const empty = downloadToast.completed && downloadToast.bytes <= 0
          const tone = !downloadToast.completed ? 'fail' : empty ? 'warn' : 'ok'
          const message = !downloadToast.completed
            ? `✗ Download failed: ${downloadToast.name}`
            : empty
              ? `⚠ Downloaded ${downloadToast.name}, but it's empty (0 bytes)`
              : `✓ Downloaded ${downloadToast.name} — ${formatBytes(downloadToast.bytes)}`
          return <div className={`download-toast ${tone}`}>{message}</div>
        })()}
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
        <button
          className="nav-btn"
          onClick={() => window.api.browser.clearData()}
          title="Clear cookies & site data (log out, empty cart) and reload"
          aria-label="Clear browser data"
        >
          🧹
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

      {/* Day 17: the tab strip — shown only with 2+ tabs (a popup opened one).
          Its height must match TAB_STRIP_HEIGHT in main so the native browser
          view, which starts just below it, lines up exactly. */}
      {tabs.length > 1 && (
        <div className="tab-strip">
          {tabs.map((t) => (
            <div
              key={t.ordinal}
              className={`browser-tab${t.active ? ' active' : ''}`}
              onClick={() => window.api.browser.switchTab(t.ordinal)}
              title={t.url}
            >
              <span className="browser-tab-title">{t.title || 'New Tab'}</span>
              {t.ordinal > 0 && (
                <button
                  className="browser-tab-close"
                  title="Close tab"
                  aria-label="Close tab"
                  onClick={(e) => {
                    e.stopPropagation()
                    window.api.browser.closeTab(t.ordinal)
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}

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
                {/* Day 18: when to keep a full run recording (trace), like
                    Playwright's trace: retain-on-failure. */}
                <select
                  className="trace-mode"
                  value={traceMode}
                  onChange={(e) =>
                    setTraceMode(e.target.value as 'always' | 'failure' | 'off')
                  }
                  disabled={isReplaying || isRecording}
                  title="When to keep a full run recording (every step's screenshot, console & network)"
                >
                  <option value="failure">⏺ on failure</option>
                  <option value="always">⏺ always</option>
                  <option value="off">⏺ off</option>
                </select>
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
              {/* Day 18: open the full run recording (trace) for this run */}
              {!isReplaying && lastTraceId && (
                <button
                  type="button"
                  className="shot-link trace-link"
                  onClick={() => openTrace(lastTraceId)}
                  title="Open the full run recording (every step's screenshot, console & network)"
                >
                  ⏺ recording
                </button>
              )}
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
                      the broken step by its label — one click to accept it. */}
                  {recovery.suggestion && (
                    <div className="self-heal">
                      <span className="self-heal-text">
                        🔧 Self-heal found{' '}
                        <strong>“{recovery.suggestion.label}”</strong> — use it to fix this step?
                      </span>
                      <button
                        type="button"
                        className="modal-btn primary self-heal-accept"
                        onClick={() => applyHeal(recovery.suggestion!, recovery.index)}
                      >
                        ✓ Accept fix
                      </button>
                    </div>
                  )}
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
              {/* Day 17: session reuse — start this test already logged in */}
              <div className="session-block">
                <label className="session-label">Start logged in (session):</label>
                <select
                  className="session-select"
                  value={storageState ?? ''}
                  onChange={(e) => setStorageState(e.target.value || undefined)}
                >
                  <option value="">None — fresh login each run</option>
                  {sessions.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
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
              {/* Day 17: viewport / device emulation */}
              <div className="session-block">
                <label className="session-label">Viewport (device):</label>
                <div className="assert-kinds">
                  {[
                    {
                      label: 'Desktop',
                      vp: undefined as { width: number; height: number } | undefined
                    },
                    { label: 'Tablet · 768×1024', vp: { width: 768, height: 1024 } },
                    { label: 'Mobile · 375×667', vp: { width: 375, height: 667 } }
                  ].map((p) => {
                    const active =
                      (!viewport && !p.vp) ||
                      (!!viewport &&
                        !!p.vp &&
                        viewport.width === p.vp.width &&
                        viewport.height === p.vp.height)
                    return (
                      <button
                        key={p.label}
                        type="button"
                        className={`assert-kind${active ? ' chosen' : ''}`}
                        onClick={() => applyViewport(p.vp)}
                      >
                        {p.label}
                      </button>
                    )
                  })}
                </div>
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
                // Day 16(+): upload steps aren't text-editable but DO get a ✎ —
                // it opens a file picker to swap the uploaded file.
                const editable = editableValue(step) !== null || step.type === 'upload'
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
                      {/* Day 17/18: tab provenance. In a multi-tab recording EVERY
                          step shows which tab it RUNS ON — the original is "main
                          tab", popups are tab 1, 2, 3… (Day 18: original was
                          previously unbadged, which read as "never shows tab 0"). */}
                      {multiWindow && (
                        <span
                          className="window-badge"
                          title={
                            (step.windowId ?? 0) === 0
                              ? 'Runs on the main (original) tab'
                              : `Runs on tab ${step.windowId} — a stable id = the order this tab was opened in the recording (like Playwright's page0/page1…). Ids never repeat, so a number can be higher than the count of tabs open right now.`
                          }
                        >
                          ⧉ {(step.windowId ?? 0) === 0 ? 'main tab' : `tab ${step.windowId}`}
                        </span>
                      )}
                      {step.opensWindow !== undefined && (
                        <span
                          className="window-badge opens"
                          title={`This click opens tab ${step.opensWindow} — a new browser tab. Tab numbers are stable open-order ids and never reuse, so they can climb past the number of tabs currently open.`}
                        >
                          ↗ opens tab {step.opensWindow}
                        </span>
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
                      {/* Day 16(+): downloads auto-save silently — give a one-click
                          way to confirm/open the saved file in its folder. */}
                      {step.type === 'download' && step.downloadPath && (
                        <button
                          type="button"
                          className="step-selector"
                          onClick={() => window.api.recorder.revealDownload(step.downloadPath!)}
                          title={`Show "${step.label}" in its folder`}
                        >
                          📂 Show in folder
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
                            title={step.type === 'upload' ? 'Change file' : 'Edit value'}
                            aria-label={step.type === 'upload' ? 'Change file' : 'Edit value'}
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

      {/* === Day 18: run-trace viewer — filmstrip of every step on the left,
           the selected step's screenshot + console/network on the right. === */}
      {traceView && (
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
            {/* Day 17: choose inline vs full Page Object Model output */}
            <div className="export-modes">
              <button
                type="button"
                className={`export-mode${!poExport ? ' chosen' : ''}`}
                onClick={() => handleTogglePoExport(false)}
              >
                Inline
              </button>
              <button
                type="button"
                className={`export-mode${poExport ? ' chosen' : ''}`}
                onClick={() => handleTogglePoExport(true)}
                title="Full Page Object Model: a page class (locators + methods) + a spec that drives it. Single-page tests only."
              >
                Page Object
              </button>
              {/* In POM mode, two files — tabs to switch between spec and page class */}
              {exportPage && (
                <div className="export-file-tabs">
                  <button
                    type="button"
                    className={`export-file-tab${exportTab === 'spec' ? ' chosen' : ''}`}
                    onClick={() => setExportTab('spec')}
                  >
                    spec.ts
                  </button>
                  <button
                    type="button"
                    className={`export-file-tab${exportTab === 'page' ? ' chosen' : ''}`}
                    onClick={() => setExportTab('page')}
                  >
                    {exportPageFileName}
                  </button>
                </div>
              )}
            </div>
            <pre className="modal-code">
              <code>{exportTab === 'page' && exportPage ? exportPage : exportCode}</code>
            </pre>
            <div className="modal-footer">
              {savedPath && <span className="saved-path">Saved to {savedPath}</span>}
              <button className="modal-btn" onClick={handleCopyExport}>
                Copy
              </button>
              <button className="modal-btn primary" onClick={handleSaveExport}>
                {exportPage ? 'Save files' : 'Save .ts'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
