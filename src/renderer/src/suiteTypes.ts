// =====================================================================
// SUITE-RUN TYPES
//
// These three interfaces were declared INSIDE the App component, which meant
// nothing else could name them — so the suite report had to live inside that
// component too, however large it grew. Moved out verbatim so the report can be
// its own file.
// =====================================================================

export interface SuiteRunEntry {
  fileName: string
  name: string
  status: 'passed' | 'failed'
  failedAt?: number
  error?: string
  screenshotPath?: string
  category?: FailureCategory // B: failure type (for the by-category breakdown)
  healed?: number // B: selectors auto-healed in this test's run
  // F25: {{env:NAME}} tokens that resolved to NOTHING for this test. A suite
  // run is `silent`, so the workspace panel that normally reports this is never
  // touched — and the reader is looking at the suite report anyway. Without it
  // here, a test that typed an empty username fails several steps later as
  // "stale data", an explanation that points at the test rather than the
  // environment. Carried per-test because a suite can mix tests that need
  // different variables.
  unresolvedEnv?: string[]
  // F39: this result came from the headless parallel batch, not the in-app
  // replay engine. Shown in the report because the two aren't equivalent —
  // no self-heal, no recovery pause — so the reader should know which ran it.
  ranParallel?: boolean
}

// B: a test whose selectors auto-healed this run, with the repaired steps ready
// to persist — "Save all healed" in the report writes them all at once.
export interface HealedSave {
  fileName: string
  name: string
  saveInput: {
    name: string
    baseURL: string
    suite: string
    steps: RecorderStep[]
    storageState?: string
    viewport?: { width: number; height: number }
    deviceId?: string // F36: a healed save must not drop the test's device
    tags?: string[] // F38: …nor its labels
    dataRows?: Record<string, string>[]
  }
}

// Option 2: a failed test whose selector self-heal COULD fix (found but not
// confident) — surfaced in the report for human review & one-click accept.
export interface HealableFail {
  fileName: string
  name: string
  suite: string
  hasBlocks: boolean // block tests: index may not map to display steps — review only
  healable: { index: number; label: string; signals: string[]; score: number; step: RecorderStep }
}

/** The whole in-flight/finished suite run. `null` when no suite has been run. */
export interface SuiteRunState {
  suite: string
  total: number
  current: number // 1-based index of the test running now
  currentName: string
  results: SuiteRunEntry[]
  running: boolean
  healedSaves?: HealedSave[] // B: healed tests captured this run (for Save all)
  healedSaved?: boolean // B: the user already clicked Save all healed
  healables?: HealableFail[] // Option 2: failed-but-healable tests to review
  accepted?: string[] // Option 2: fileNames whose healable fix was accepted
  // F39: how many tests are in flight in the parallel batch. While this is
  // set, the "X of Y" counter is meaningless — one Playwright process runs
  // them ALL AT ONCE and reports back only at the end, so there is no
  // step-by-step progress to show. Displaying "0 of 4" the whole time reads
  // as "nothing is happening", so the progress line switches wording instead.
  parallelBatch?: number
}
