import { ElectronAPI } from '@electron-toolkit/preload'

interface BrowserAPI {
  navigate: (url: string) => Promise<string>
  goBack: () => Promise<boolean>
  goForward: () => Promise<boolean>
  reload: () => Promise<void>
  // Day 17: clear cookies + localStorage (log out / empty cart), then reload.
  clearData: () => Promise<void>
  home: () => Promise<void>
  setOverlay: (open: boolean) => Promise<void>
  onUrlChange: (callback: (url: string) => void) => () => void
  // Live URL + title of the embedded page — prefills page-level checks (Day 11).
  getPageInfo: () => Promise<{ url: string; title: string }>
  // Day 17 (multiple windows): make a given tab (by ordinal) the active one.
  switchTab: (ordinal: number) => Promise<void>
  // Day 17: close a tab (by ordinal). The original tab (0) can't be closed.
  closeTab: (ordinal: number) => Promise<void>
  // Day 17: the open-tabs list changed (opened/closed/switched/retitled).
  onTabsChanged: (callback: (tabs: TabInfo[]) => void) => () => void
  // Day 17 (viewport emulation): render at a fixed viewport, or null to fill.
  setViewport: (viewport: { width: number; height: number } | null) => Promise<void>
}

interface ReplayProgress {
  index: number
  status: 'running' | 'done' | 'error' | 'skipped' // 'skipped' = recovery skip (Day 12)
  error?: string
}

interface ReplayResult {
  ok: boolean
  failedAt?: number
  error?: string
  screenshotPath?: string // captured at the failing step (Day 11.5)
  aborted?: boolean // ended by Home mid-recovery — show nothing (Day 12)
  consoleErrors?: string[] // page JS errors during the run (Day 13)
  networkErrors?: string[] // failed / 4xx / 5xx requests during the run (Day 13)
  traceId?: string // Day 18: a recorded run trace was kept (open it in the viewer)
  // Day 20: every failed step in this run (not just the first) — surfaced when
  // Continue bypassed several, so each one's screenshot is reachable.
  failures?: { index: number; error: string; screenshotPath?: string }[]
  // F1: with a HAR in play, how many requests were served from it vs passed
  // through to the live network. Absent when no HAR was used.
  harServed?: number
  harPassthrough?: number
}

// Day 18: how aggressively to keep a run trace (mirrors Playwright's `trace`).
type TraceMode = 'always' | 'failure' | 'off'

interface TraceOptions {
  mode: TraceMode
  stepTexts?: string[] // the human sentence per step (renderer-computed)
  testName?: string
}

interface RecorderAPI {
  toggle: (resume?: boolean) => Promise<boolean>
  onStep: (callback: (step: RecorderStep) => void) => () => void
  // Day 17 (multiple windows): a recorded step gained an `opensWindow` tag
  // after it was sent — patch it in place (matched by `id`).
  onStepPatch: (callback: (patch: StepPatch) => void) => () => void
  exportTest: (
    code: string,
    fixturePaths?: string[],
    sessionFile?: string,
    pageObjectCode?: string,
    pageObjectFileName?: string,
    harFile?: string // F1: copy this .har into hars/ beside the exported spec
  ) => Promise<string | null>
  pickUploadFile: () => Promise<string | null>
  revealDownload: (path: string) => Promise<void>
  onDownloadStart: (callback: (info: { name: string }) => void) => () => void
  onDownloadDone: (callback: (info: DownloadInfo) => void) => () => void
  // Day 17: `storageState` (a saved session file) seeds the browser so the test
  // starts already logged in (skips re-login) instead of from a clean state.
  replay: (
    steps: RecorderStep[],
    interactive?: boolean,
    storageState?: string,
    traceOpts?: TraceOptions,
    // F1: serve responses from this HAR — a test's saved `har` filename, or
    // '__last' for the just-captured (unsaved) one. Absent = hit live network.
    harFile?: string
  ) => Promise<ReplayResult>
  onReplayProgress: (callback: (progress: ReplayProgress) => void) => () => void
  onReplayPaused: (callback: (info: ReplayPaused) => void) => () => void
  recovery: (decision: RecoveryDecision) => void
  setPicking: (active: boolean) => Promise<void>
  onPicked: (callback: (picked: PickedElement) => void) => () => void
  onPickCancel: (callback: () => void) => () => void
  // Day 19: capture the current page as a visual baseline + add a snapshot step.
  snapshot: () => Promise<void>
  // Day 20 (data-driven): resolve {{env:NAME}} tokens against the running
  // process environment, so a real secret never sits in the data table.
  resolveEnv: (names: string[]) => Promise<Record<string, string>>
}

// === Accessibility scan (F13) ===
interface A11yAPI {
  // Inject axe-core + run WCAG A/AA on the active tab. Never rejects — a page
  // it can't scan comes back as a result with `error` set.
  scan: () => Promise<A11yScanResult>
  // Open a rule's "how to fix" docs (helpUrl) in the user's real browser.
  openHelp: (url: string) => Promise<void>
}

// === Performance / Core Web Vitals (F14) ===
interface PerfAPI {
  // Measure the active tab's Core Web Vitals. Never rejects — a page it can't
  // measure comes back as a result with `error` set.
  measure: () => Promise<PerfResult>
}

// === HAR record & replay (F1) ===
interface HarAPI {
  // Turn network capture on/off (set before recording starts).
  setEnabled: (enabled: boolean) => Promise<void>
  // How many responses the last capture kept (0 = none).
  lastCount: () => Promise<number>
  // Recording stopped → the count captured. Returns an unsubscribe fn.
  onCaptured: (callback: (info: { count: number }) => void) => () => void
}

// === Visual regression (Day 19) ===
interface VisualAPI {
  // Adopt a current capture as the new baseline (a page legitimately changed).
  updateBaseline: (baselineId: string, currentPath: string) => Promise<boolean>
  // A baseline image as a data: URL (for the diff view).
  getBaseline: (id: string) => Promise<string | null>
}

interface LibraryAPI {
  save: (input: {
    name: string
    baseURL: string
    suite: string
    steps: RecorderStep[]
    storageState?: string
    viewport?: { width: number; height: number }
    dataRows?: Record<string, string>[] // Day 20: data-driven table rows
    captureHar?: boolean // F1: bank the captured network with this test
  }) => Promise<SavedTestSummary>
  list: () => Promise<SavedTestSummary[]>
  listSuites: () => Promise<string[]>
  load: (fileName: string) => Promise<SavedTestData | null>
  remove: (fileName: string) => Promise<void>
  recordRun: (fileName: string, run: RunInfo) => Promise<void>
  openScreenshot: (path: string) => Promise<void>
}

// Day 17 — saved browser sessions (storageState: cookies + localStorage) so a
// test can start already logged in.
interface SessionAPI {
  // Capture the embedded browser's current session as a named storageState file.
  // Returns the saved file name (e.g. "auth.json"), or null on failure.
  save: (name: string) => Promise<string | null>
  // List the saved session file names.
  list: () => Promise<string[]>
  // Day 17(+): seed a saved session into the LIVE browser so recording starts
  // logged in. Resolves { ok, url? } — the page it opened.
  apply: (file: string, url?: string) => Promise<{ ok: boolean; url?: string; error?: string }>
}

// === Failure translator (Day 13) ===
interface TranslatorAPI {
  explain: (evidence: FailureEvidence) => Promise<FailureAnalysis>
  saveReport: (markdown: string, defaultName: string) => Promise<string | null>
}

// === Drafts (Day 18) — auto-saved in-progress recordings ===
interface DraftAPI {
  save: (input: {
    id: string
    name: string
    baseURL: string
    suite: string
    storageState?: string
    viewport?: { width: number; height: number }
    steps: RecorderStep[]
    dataRows?: Record<string, string>[] // Day 20: data-driven table rows
  }) => Promise<void>
  list: () => Promise<DraftSummary[]>
  load: (id: string) => Promise<DraftData | null>
  delete: (id: string) => Promise<void>
}

// === Reusable step blocks (Pillar 4) ===
interface BlocksAPI {
  save: (input: { name: string; steps: RecorderStep[] }) => Promise<BlockSummary>
  list: () => Promise<BlockSummary[]>
  load: (fileName: string) => Promise<BlockData | null>
  delete: (fileName: string) => Promise<void>
}

// === Run trace (Day 18) ===
interface TraceAPI {
  // The manifest, with each step's thumbnail inlined as a data: URL for the
  // filmstrip. Null if the trace is missing.
  get: (id: string) => Promise<TraceManifest | null>
  // A full-size asset (screenshot) as a data: URL, loaded on demand.
  getImage: (id: string, file: string) => Promise<string | null>
  // Open an asset (full screenshot / DOM html) in the OS default app.
  openFile: (id: string, file: string) => Promise<void>
  // Copy the whole recording to a folder the user picks. Returns the path.
  export: (id: string) => Promise<string | null>
  // Save a whole-run HTML report (pass or fail). Returns the path.
  exportReport: (id: string) => Promise<string | null>
}

interface API {
  browser: BrowserAPI
  recorder: RecorderAPI
  library: LibraryAPI
  translator: TranslatorAPI
  session: SessionAPI
  trace: TraceAPI
  drafts: DraftAPI
  blocks: BlocksAPI
  visual: VisualAPI
  a11y: A11yAPI
  perf: PerfAPI
  har: HarAPI
}

declare global {
  // Day 16(+): a finished download — surfaced as a toast and (during replay)
  // the material a `download` step checks. `completed` = the transfer finished
  // (vs interrupted/cancelled); `bytes` then tells empty (0) from has-content.
  interface DownloadInfo {
    name: string
    path: string
    bytes: number
    completed: boolean
  }

  // === Test library (Day 11) ===
  // Outcome of a test's most recent replay — drives the green/red dot in the
  // library list.
  interface RunInfo {
    status: 'passed' | 'failed'
    at: string
    failedAt?: number
    error?: string
    screenshotPath?: string // page capture at the failing step (Day 11.5)
    traceId?: string // Day 18: the kept run trace, openable in the viewer
  }

  // === Accessibility scan (F13) ===
  // MIRROR: same shapes as A11yNode / A11yViolation / A11yScanResult in
  // src/main/a11y.ts.
  interface A11yNode {
    target: string // CSS selector path to the offending element
    html: string // truncated outerHTML snippet
    summary: string // axe's plain "how to fix" failureSummary
  }
  interface A11yViolation {
    id: string
    impact: 'critical' | 'serious' | 'moderate' | 'minor' | string
    help: string
    description: string
    helpUrl: string
    tags: string[]
    nodes: A11yNode[]
  }
  interface A11yScanResult {
    url: string
    title: string
    at: string
    violations: A11yViolation[]
    passCount: number
    incompleteCount: number
    nodeCount: number // total elements flagged (may exceed the nodes we keep)
    error?: string // set when the page couldn't be scanned
  }

  // === Performance / Core Web Vitals (F14) ===
  // MIRROR: same shapes as PerfMetric / PerfResult in src/main/perf.ts.
  type PerfRating = 'good' | 'needs-improvement' | 'poor'
  interface PerfMetric {
    key: string
    label: string
    value: number | null
    unit: string
    rating: PerfRating | null // null = informational (no CWV threshold)
    core: boolean // true = a Core Web Vital (LCP/CLS) — drives the gate
  }
  interface PerfResult {
    url: string
    title: string
    at: string
    metrics: PerfMetric[]
    error?: string
  }

  // === Run trace (Day 18) ===
  // One step inside a recorded run trace. Asset file names are relative to
  // the trace folder; `thumbData` is a data: URL the viewer can show inline.
  interface TraceStep {
    index: number
    type: string
    text: string
    status: 'done' | 'error' | 'skipped' | 'pending'
    durationMs: number
    error?: string
    url?: string
    screenshotFile?: string
    thumbFile?: string
    thumbData?: string
    domFile?: string
    consoleErrors: string[]
    networkErrors: string[]
  }

  interface TraceManifest {
    id: string
    testName?: string
    at: string
    ok: boolean
    failedAt?: number
    stepCount: number
    steps: TraceStep[]
  }

  // === Drafts (Day 18) — auto-saved in-progress recordings ===
  interface DraftSummary {
    id: string
    name: string
    stepCount: number
    updatedAt: string
    firstUrl?: string
  }
  interface DraftData {
    id: string
    name: string
    baseURL: string
    suite: string
    storageState?: string
    viewport?: { width: number; height: number }
    dataRows?: Record<string, string>[] // Day 20: data-driven table rows
    updatedAt: string
    steps: RecorderStep[]
  }

  // === Reusable step blocks (Pillar 4) — a named, saved step sequence ===
  interface BlockSummary {
    fileName: string
    name: string
    stepCount: number
    updatedAt: string
  }
  interface BlockData {
    version: 1
    name: string
    createdAt: string
    updatedAt: string
    steps: RecorderStep[]
  }

  // One row in the library list (no steps — kept light for listing).
  interface SavedTestSummary {
    // Relative path within the library — includes the section subfolder
    // when present (e.g. "E2E/login-flow.json").
    fileName: string
    suite: string // the section — '' for legacy root files
    name: string
    baseURL: string
    updatedAt: string
    stepCount: number
    storageState?: string // Day 17: attached session, if any
    har?: string // F1: a captured network archive, if any (drives a 🌐 badge)
    assertCount?: number // F5: how many checks the test makes
    selectorHealth?: number // F5: avg selector stability (0–100)
    lastRun?: RunInfo
    runs?: RunInfo[] // history, newest first, capped at 10
  }

  // F12: one past edit of a test — its steps as they were, and when it was
  // replaced. Lets the UI diff a past version against the current steps.
  interface TestVersion {
    at: string
    steps: RecorderStep[]
  }

  // A fully loaded test: the step model plus its metadata.
  interface SavedTestData {
    version: number
    name: string
    baseURL: string
    createdAt: string
    updatedAt: string
    storageState?: string // Day 17: attached session (start logged in)
    viewport?: { width: number; height: number } // Day 17: device emulation
    dataRows?: Record<string, string>[] // Day 20: data-driven table rows
    har?: string // F1: a captured network archive to replay against, if any
    versions?: TestVersion[] // F12: previous edits, newest first
    lastRun?: RunInfo
    steps: RecorderStep[]
  }

  // The checks an assertion step can make (Day 9). 'checked'/'unchecked' are
  // element checks for checkboxes/radios; 'url-contains'/'title' are PAGE
  // checks — they have no element, so no selector/candidates (Day 11).
  // 'hidden' passes when the element is invisible OR gone from the DOM;
  // 'count' asserts how many elements the selector matches (group check).
  // 'attribute' is the only two-part check: WHICH attribute (step.attrName)
  // plus its expected value (step.value).
  type AssertKind =
    | 'visible'
    | 'hidden'
    | 'text-equals'
    | 'text-contains'
    | 'value'
    | 'empty'
    | 'count'
    | 'enabled'
    | 'disabled'
    | 'editable'
    | 'focused'
    | 'checked'
    | 'unchecked'
    | 'attribute'
    | 'class'
    | 'url-contains'
    | 'title'

  // === Recovery (Day 12) ===
  // An interactive replay is paused at a failed step, waiting for a decision.
  interface ReplayPaused {
    index: number
    error: string
    screenshotPath?: string
    traceId?: string // Day 18: the run trace saved at the pause (openable now)
    // Day 18: the failure was a broken/missing selector (vs an assertion or
    // timing failure) — only then do self-heal / manual pick make sense.
    selectorBroke?: boolean
    // Day 18 (self-heal): an auto-found replacement element for the broken step
    // (matched by its recorded label) — offered as a one-click fix.
    suggestion?: PickedElement
    // Day 19: a visual-snapshot failure — the diff image + the baseline to
    // update if the new look is intended.
    visual?: {
      baselineId?: string
      currentPath: string
      diffPath?: string
      ratioPct: number
      thresholdPct: number
    }
    consoleErrors?: string[] // evidence so far — Explain works mid-pause (Day 13)
    networkErrors?: string[]
  }

  // === Failure translator (Day 13) ===
  // Everything known about a failure at the moment it happened — assembled by
  // the renderer (which owns the steps and their human sentences), enriched
  // with main's replay-time console/network capture.
  // MIRROR: same shape as FailureEvidence in src/main/translator.ts.
  interface FailureItem {
    index: number
    stepText: string
    error: string
    selector?: string
    screenshotPath?: string
  }
  interface FailureEvidence {
    testName?: string
    pageUrl: string
    pageTitle: string
    stepIndex: number
    stepText: string
    stepType: string
    selector?: string
    error: string
    consoleErrors: string[]
    networkErrors: string[]
    screenshotPath?: string
    allSteps: string[]
    // All failed steps when a test failed at more than one (whole-test analysis).
    failures?: FailureItem[]
  }

  // The diagnosis: WHO is at fault (the verdict) + the story + next action.
  // source says which backend answered — 'ai' (Claude CLI) or 'rules'.
  type FailureVerdict = 'app-bug' | 'test-bug' | 'timing' | 'environment' | 'unknown'
  interface FailureAnalysis {
    source: 'ai' | 'rules'
    verdict: FailureVerdict
    explanation: string
    suggestion: string
  }

  // The human's answer to a pause: retry the step (optionally swapped for a
  // re-picked, healed version), skip it for this run only, or stop the run.
  // 'abort' is internal — Home pressed mid-pause; the run ends silently.
  // 'continue' = DEBUG bypass: ignore this failure and keep going to check the
  // later steps; the run is still failed and the test is unchanged. 'skip' =
  // permanently skip the step (the renderer disables it in the test).
  interface RecoveryDecision {
    action: 'retry' | 'continue' | 'skip' | 'stop' | 'abort'
    step?: RecorderStep
  }

  // What the element picker hands back: the built selector ladder plus the
  // element's LIVE state, used to prefill assertion expectations (Day 9).
  interface PickedElement {
    label: string
    selector: string
    candidates: SelectorCandidate[]
    text?: string
    inputValue?: string
    disabled?: boolean
    // Only present when the picked element is a checkbox/radio — its live
    // ticked state. Absence means "not checkable" (hide the checked kinds).
    checked?: boolean
    // How many elements the primary selector strategy matched at pick time
    // (1 = unique) — prefills the expected number for a 'count' check.
    groupCount?: number
    // Day 12: the element has NO stable hooks — its only candidate is the
    // bare-tag last resort, which replay refuses. Warn instead of authoring
    // a step that can never replay.
    unreliable?: boolean
    // Day 15: set when the picked element is inside an <iframe>, so the
    // assertion step built from it replays in (and exports for) that frame.
    frame?: FrameRef
    // Day 21 (self-heal ambiguity guard): how many equally-good elements the
    // broken step's label matched during a heal search. >1 means the label is
    // ambiguous (e.g. many "Add to cart" buttons) — the panel warns and asks
    // for a manual pick instead of offering a one-click "Accept fix".
    ambiguousCount?: number
  }

  // === iframes (Day 15) ===
  // Which (i)frame a step happened in. A chain of frame descriptors from the
  // OUTERMOST iframe down to the target frame — one entry per nesting level
  // (usually just one). Absent/empty = the top page (the normal case).
  // `url` re-finds the frame at replay; `name` (the iframe's name/id) makes a
  // cleaner frameLocator in the exported Playwright code.
  type FrameRef = { url: string; name?: string }[]

  // One ranked way to locate an element, with a 0–100 stability score.
  interface SelectorCandidate {
    kind: 'testId' | 'id' | 'role' | 'name' | 'placeholder' | 'text' | 'css' | 'anchored'
    score: number
    locator: string // Playwright-style expression (Day 5 export)
    css: string | null // CSS selector when expressible (Day 6 replay)
    role?: string // for kind 'role' — ARIA role (Day 10 replay-by-role)
    name?: string // for kind 'role' — accessible name
    text?: string // for kind 'text' — visible text
    nth?: number // Day 10(b) — which of several matches is ours (0-based)
    pinned?: boolean // Day 10(c) — hand-picked in the ladder UI; replay tries it first
  }

  // One recorded action (the canonical step model). `navigate` carries `url`;
  // `click`/`type`/`select` carry a human `label` + a ranked selector ladder
  // (`selector` is the primary; `candidates` are the fallbacks). `type`/
  // `select` also carry the entered/chosen `value`.
  interface RecorderStep {
    type:
      | 'navigate'
      | 'back'
      | 'closeTab'
      | 'click'
      | 'type'
      | 'select'
      | 'press'
      | 'hover'
      | 'assert'
      | 'wait'
      | 'dialog'
      | 'upload'
      | 'download'
      | 'snapshot'
      | 'a11y'
      | 'perf'
      | 'block'
    label?: string
    // Pillar 4 (live-link blocks, v2): a 'block' step is a LIVE REFERENCE to a
    // saved block (its file name). It's one step in the array (moves/deletes as a
    // unit); the renderer EXPANDS it to the block's CURRENT steps at replay /
    // export / data-column time — so editing the block updates every test that
    // links it. `label` holds the block's display name.
    blockRef?: string
    // For type/select: the entered value. For assert text/value kinds: the
    // EXPECTED value. For wait: the seconds, as text (editable like any value).
    // For dialog: the response — prompt's answer text, or 'accept'/'dismiss'
    // for a confirm (alert has none). For an `a11y` step (F13): the budget —
    // the least severe impact that still FAILS the check
    // ('critical'|'serious'|'moderate'|'minor'; default 'serious'). For a
    // `perf` step (F14): the budget — the worst acceptable Core Web Vitals
    // rating ('good' = strict | 'needs-improvement' = default, fail on poor).
    value?: string
    key?: string // for `press` steps — the key pressed (e.g. 'Enter')
    // F3 (smart waits): what a `wait` step waits FOR. 'time' (default) = a fixed
    // pause of `value` seconds; 'network-idle' = until the page stops making
    // network requests; 'text' = until `value` text appears on the page. The
    // condition kinds replace guessy fixed sleeps with a precise wait.
    waitKind?: 'time' | 'network-idle' | 'text'
    // Day 16: which native dialog this step answers (alert/confirm/prompt). The
    // dialog's message is carried in `label`.
    dialogKind?: 'alert' | 'confirm' | 'prompt'
    assertKind?: AssertKind // for `assert` steps — which check to make
    attrName?: string // for `attribute` asserts — WHICH attribute to check
    secret?: boolean // password field — value masked on screen / in export
    disabled?: boolean // turned off in the editor — skipped by replay + export
    url?: string
    // Day 16(+): a `download` step's saved file path (for "Show in folder" and
    // the on-replay file check). The step's `value` holds the EXPECTED filename
    // substring to verify (defaults to the recorded name; editable).
    downloadPath?: string
    // Day 19 (visual regression): a `snapshot` step's baseline image id (file
    // in _baselines). `value` holds the allowed diff threshold as a percent.
    baselineId?: string
    selector?: string
    candidates?: SelectorCandidate[]
    // Day 15: set when the element lives inside an <iframe> — tells replay
    // which frame to run in, and export which frameLocator to wrap.
    frame?: FrameRef
    // Day 17: a transient correlation id stamped by main when the step is
    // emitted, so a later `recorder:step-patch` (which tab a click opened) can
    // target this exact step. Only meaningful during a live recording.
    id?: number
    // Day 17 (multiple windows): which browser tab this step happened in, as an
    // ORDINAL — 0 = the original tab, 1 = the first popup opened this session,
    // etc. Absent/undefined is read as 0 everywhere (back-compat with older
    // single-tab tests). Analogous to `frame`, one level up.
    windowId?: number
    // Day 17: set on the click/press step that OPENED a new tab — the value is
    // the ordinal of the tab it opened. Lets replay arm a wait-for-page before
    // the click, and export wrap it in Promise.all([waitForEvent('page'), …]).
    opensWindow?: number
  }

  // Day 17: one open browser tab, as the renderer's tab strip sees it.
  interface TabInfo {
    ordinal: number
    title: string
    url: string
    active: boolean
  }

  // Day 17: main tells the renderer a click opened a new tab — patch the
  // already-sent step (matched by `id`) with the ordinal it opened.
  interface StepPatch {
    id: number
    opensWindow: number
  }

  interface Window {
    electron: ElectronAPI
    api: API
  }
}
