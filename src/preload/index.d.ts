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
    pageObjectFileName?: string
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
    traceOpts?: TraceOptions
  ) => Promise<ReplayResult>
  onReplayProgress: (callback: (progress: ReplayProgress) => void) => () => void
  onReplayPaused: (callback: (info: ReplayPaused) => void) => () => void
  recovery: (decision: RecoveryDecision) => void
  setPicking: (active: boolean) => Promise<void>
  onPicked: (callback: (picked: PickedElement) => void) => () => void
  onPickCancel: (callback: () => void) => () => void
}

interface LibraryAPI {
  save: (input: {
    name: string
    baseURL: string
    suite: string
    steps: RecorderStep[]
    storageState?: string
    viewport?: { width: number; height: number }
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
  }) => Promise<void>
  list: () => Promise<DraftSummary[]>
  load: (id: string) => Promise<DraftData | null>
  delete: (id: string) => Promise<void>
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
}

interface API {
  browser: BrowserAPI
  recorder: RecorderAPI
  library: LibraryAPI
  translator: TranslatorAPI
  session: SessionAPI
  trace: TraceAPI
  drafts: DraftAPI
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
    lastRun?: RunInfo
    runs?: RunInfo[] // history, newest first, capped at 10
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
    consoleErrors?: string[] // evidence so far — Explain works mid-pause (Day 13)
    networkErrors?: string[]
  }

  // === Failure translator (Day 13) ===
  // Everything known about a failure at the moment it happened — assembled by
  // the renderer (which owns the steps and their human sentences), enriched
  // with main's replay-time console/network capture.
  // MIRROR: same shape as FailureEvidence in src/main/translator.ts.
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
    kind: 'testId' | 'id' | 'role' | 'name' | 'placeholder' | 'text' | 'css'
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
    label?: string
    // For type/select: the entered value. For assert text/value kinds: the
    // EXPECTED value. For wait: the seconds, as text (editable like any value).
    // For dialog: the response — prompt's answer text, or 'accept'/'dismiss'
    // for a confirm (alert has none).
    value?: string
    key?: string // for `press` steps — the key pressed (e.g. 'Enter')
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
