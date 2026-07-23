import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs exposed to the React renderer as window.api
const api = {
  browser: {
    // Tell the embedded browser to load a URL. Returns the normalized URL.
    navigate: (url: string): Promise<string> => ipcRenderer.invoke('browser:navigate', url),

    // Navigation history controls. Return true if the action succeeded,
    // false if there was no history (in which case React can fall back to welcome).
    goBack: (): Promise<boolean> => ipcRenderer.invoke('browser:goBack'),
    goForward: (): Promise<boolean> => ipcRenderer.invoke('browser:goForward'),
    reload: (): Promise<void> => ipcRenderer.invoke('browser:reload'),

    // Day 17: clear cookies + localStorage (log out / empty cart), then reload.
    clearData: (): Promise<void> => ipcRenderer.invoke('browser:clearData'),

    // Reset straight to the welcome screen.
    home: (): Promise<void> => ipcRenderer.invoke('browser:home'),

    // Hide/show the embedded browser so React overlays (modals) aren't covered.
    setOverlay: (open: boolean): Promise<void> => ipcRenderer.invoke('browser:setOverlay', open),

    // The embedded page's live URL + title, for prefilling page-level checks.
    getPageInfo: (): Promise<{ url: string; title: string }> =>
      ipcRenderer.invoke('browser:getPageInfo'),

    // Subscribe to URL changes from the embedded browser.
    // Returns an unsubscribe function so React effects can clean up.
    onUrlChange: (callback: (url: string) => void): (() => void) => {
      const listener = (_event: unknown, url: string): void => callback(url)
      ipcRenderer.on('browser:url-changed', listener)
      return () => ipcRenderer.removeListener('browser:url-changed', listener)
    },

    // Day 17 (multiple windows): make the tab with this ordinal the active one.
    switchTab: (ordinal: number): Promise<void> => ipcRenderer.invoke('browser:switchTab', ordinal),

    // Day 17: close the tab with this ordinal (the original tab can't close).
    closeTab: (ordinal: number): Promise<void> => ipcRenderer.invoke('browser:closeTab', ordinal),

    // Day 17: subscribe to the open-tabs list. Returns an unsubscribe fn.
    onTabsChanged: (callback: (tabs: unknown[]) => void): (() => void) => {
      const listener = (_event: unknown, tabs: unknown[]): void => callback(tabs)
      ipcRenderer.on('browser:tabs-changed', listener)
      return () => ipcRenderer.removeListener('browser:tabs-changed', listener)
    },

    // Day 17 (viewport emulation): render at a fixed viewport, or null to fill.
    setViewport: (viewport: { width: number; height: number } | null): Promise<void> =>
      ipcRenderer.invoke('browser:setViewport', viewport)
  },

  recorder: {
    // Flip recording on/off. Resolves to the NEW recording state. `resume` true
    // means "continue an existing recording" — main then skips emitting the
    // starting Go-to step (the list already begins with one).
    toggle: (resume?: boolean): Promise<boolean> => ipcRenderer.invoke('recorder:toggle', resume),

    // Subscribe to recorded steps as they happen. Returns an unsubscribe fn.
    // (Step is typed structurally here; the renderer gets the named
    // RecorderStep type from index.d.ts.)
    onStep: (callback: (step: unknown) => void): (() => void) => {
      const listener = (_event: unknown, step: unknown): void => callback(step)
      ipcRenderer.on('recorder:step', listener)
      return () => ipcRenderer.removeListener('recorder:step', listener)
    },

    // Day 17 (multiple windows): a previously-sent step gained an `opensWindow`
    // tag (it opened a new tab). Returns an unsubscribe fn.
    onStepPatch: (callback: (patch: unknown) => void): (() => void) => {
      const listener = (_event: unknown, patch: unknown): void => callback(patch)
      ipcRenderer.on('recorder:step-patch', listener)
      return () => ipcRenderer.removeListener('recorder:step-patch', listener)
    },

    // Save the generated Playwright code to a .ts file the user picks.
    // Resolves to the saved file path, or null if cancelled. `fixturePaths`
    // (Day 16+) are the upload files to copy into a fixtures/ folder next to
    // the saved spec, so the exported test is portable.
    exportTest: (
      code: string,
      fixturePaths?: string[],
      sessionFile?: string,
      pageObjectCode?: string,
      pageObjectFileName?: string,
      harFile?: string,
      ciWorkflow?: string,
      configFile?: string
    ): Promise<string | null> =>
      ipcRenderer.invoke(
        'recorder:export',
        code,
        fixturePaths,
        sessionFile,
        pageObjectCode,
        pageObjectFileName,
        harFile,
        ciWorkflow,
        configFile
      ),

    // Day 16(+): pick a different file for an upload step. Shows an OS open
    // dialog; resolves to the chosen file's stored path, or null if cancelled.
    pickUploadFile: (): Promise<string | null> => ipcRenderer.invoke('recorder:pickUploadFile'),

    // Day 16(+): reveal a downloaded file in the OS file explorer.
    revealDownload: (path: string): Promise<void> =>
      ipcRenderer.invoke('recorder:revealDownload', path),

    // Day 16(+): a download STARTED — for an immediate "downloading…" toast.
    onDownloadStart: (callback: (info: unknown) => void): (() => void) => {
      const listener = (_event: unknown, info: unknown): void => callback(info)
      ipcRenderer.on('recorder:download-start', listener)
      return () => ipcRenderer.removeListener('recorder:download-start', listener)
    },

    // Day 16(+): a download finished (during recording or replay) — for the
    // confirmation toast. Returns an unsubscribe fn.
    onDownloadDone: (callback: (info: unknown) => void): (() => void) => {
      const listener = (_event: unknown, info: unknown): void => callback(info)
      ipcRenderer.on('recorder:download-done', listener)
      return () => ipcRenderer.removeListener('recorder:download-done', listener)
    },

    // Replay the given steps in the embedded browser. Resolves when done
    // (or at the first failed step). `interactive` true (Day 12) makes a
    // failure PAUSE for a recovery decision instead of ending the run.
    replay: (
      steps: unknown[],
      interactive?: boolean,
      storageState?: string,
      traceOpts?: unknown,
      harFile?: string,
      chaos?: { slowNetwork?: boolean; locale?: string }
    ): Promise<{ ok: boolean; failedAt?: number; error?: string }> =>
      ipcRenderer.invoke(
        'recorder:replay',
        steps,
        interactive,
        storageState,
        traceOpts,
        harFile,
        chaos
      ),

    // === Recovery (Day 12) ===
    // An interactive replay paused at a failed step — main's loop is holding,
    // waiting for a decision.
    onReplayPaused: (callback: (info: unknown) => void): (() => void) => {
      const listener = (_event: unknown, info: unknown): void => callback(info)
      ipcRenderer.on('recorder:replay-paused', listener)
      return () => ipcRenderer.removeListener('recorder:replay-paused', listener)
    },

    // F4 (self-heal 2.0): main auto-healed a broken selector mid-run and re-ran
    // the step — swap in the healed step + show a "fixed by AI" badge.
    onAutoHealed: (callback: (info: unknown) => void): (() => void) => {
      const listener = (_event: unknown, info: unknown): void => callback(info)
      ipcRenderer.on('recorder:auto-healed', listener)
      return () => ipcRenderer.removeListener('recorder:auto-healed', listener)
    },

    // Answer the pause: retry (optionally with a healed step), skip, or stop.
    recovery: (decision: unknown): void => ipcRenderer.send('recorder:recovery', decision),

    // F30: replay paused at a manual (wait-for-human) step — the message to show.
    onManualPause: (callback: (info: unknown) => void): (() => void) => {
      const listener = (_event: unknown, info: unknown): void => callback(info)
      ipcRenderer.on('recorder:manual-pause', listener)
      return () => ipcRenderer.removeListener('recorder:manual-pause', listener)
    },
    // F30: the human finished the manual step — resume the run.
    manualContinue: (): void => ipcRenderer.send('recorder:manual-continue'),

    // Subscribe to per-step replay progress. Returns an unsubscribe fn.
    onReplayProgress: (callback: (progress: unknown) => void): (() => void) => {
      const listener = (_event: unknown, progress: unknown): void => callback(progress)
      ipcRenderer.on('recorder:replay-progress', listener)
      return () => ipcRenderer.removeListener('recorder:replay-progress', listener)
    },

    // F24: an API step's HTTP exchange, pushed as soon as the call returns —
    // pass OR fail — so the step row can show its status/timing and open the
    // response panel. Secrets are already masked in main.
    onApiResponse: (callback: (info: unknown) => void): (() => void) => {
      const listener = (_event: unknown, info: unknown): void => callback(info)
      ipcRenderer.on('recorder:api-response', listener)
      return () => ipcRenderer.removeListener('recorder:api-response', listener)
    },

    // === Element picker (Day 9) ===
    // Turn pick mode on/off in the embedded page.
    setPicking: (active: boolean): Promise<void> =>
      ipcRenderer.invoke('recorder:setPicking', active),

    // A picked element arrives with its built selector ladder + live state
    // (text / input value / disabled) for prefitting assertion expectations.
    onPicked: (callback: (picked: unknown) => void): (() => void) => {
      const listener = (_event: unknown, picked: unknown): void => callback(picked)
      ipcRenderer.on('recorder:picked', listener)
      return () => ipcRenderer.removeListener('recorder:picked', listener)
    },

    // The user pressed Esc in the page — pick mode ended without a pick.
    onPickCancel: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('recorder:pick-cancel', listener)
      return () => ipcRenderer.removeListener('recorder:pick-cancel', listener)
    },

    // Day 19: capture the current page as a visual baseline + add a snapshot step.
    snapshot: (): Promise<void> => ipcRenderer.invoke('recorder:snapshot'),

    // Day 20 (data-driven): resolve {{env:NAME}} tokens for a run — the active
    // F25 environment's vars first, then the real process environment (renderer
    // can't read arbitrary env vars itself).
    resolveEnv: (names: string[]): Promise<Record<string, string>> =>
      ipcRenderer.invoke('env:get', names)
  },

  // === Environment / config manager (F25) ===
  // Named { baseURL + credentials } environments; pick one active to run the
  // whole suite against dev / staging / prod. Every mutation resolves to the
  // full new state.
  environments: {
    list: (): Promise<unknown> => ipcRenderer.invoke('env:listEnvironments'),
    save: (env: unknown): Promise<unknown> => ipcRenderer.invoke('env:saveEnvironment', env),
    delete: (id: string): Promise<unknown> => ipcRenderer.invoke('env:deleteEnvironment', id),
    setActive: (id: string | null): Promise<unknown> => ipcRenderer.invoke('env:setActive', id),
    // F25 guard "don't ask again" — persisted in userData, not renderer
    // localStorage (which the test-isolation storage clear wipes each run).
    rememberRetarget: (keys: string[], choice: 'run' | 'noenv'): Promise<unknown> =>
      ipcRenderer.invoke('env:rememberRetarget', keys, choice),
    forgetRetarget: (): Promise<unknown> => ipcRenderer.invoke('env:forgetRetarget')
  },

  // === Cross-browser replay (F17) ===
  // Run the current test on real WebKit/Firefox/Chromium via Playwright (shelled
  // out — the embedded engine is Chromium only). `check` reports install state.
  xbrowser: {
    check: (): Promise<{ installed: boolean; root: string | null }> =>
      ipcRenderer.invoke('xbrowser:check'),
    run: (
      specCode: string,
      browsers: string[],
      envOverride?: Record<string, string>,
      sessionFile?: string
    ): Promise<unknown> =>
      ipcRenderer.invoke('xbrowser:run', specCode, browsers, envOverride, sessionFile)
  },

  // === Scheduled monitors (F32) ===
  // Persisted monitor config/history + a native failure alert. The scheduler
  // itself runs in the renderer (App.tsx) using xbrowser.run.
  monitors: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke('monitors:list'),
    save: (mon: unknown): Promise<unknown[]> => ipcRenderer.invoke('monitors:save', mon),
    delete: (id: string): Promise<unknown[]> => ipcRenderer.invoke('monitors:delete', id),
    recordRun: (id: string, run: unknown): Promise<unknown[]> =>
      ipcRenderer.invoke('monitors:recordRun', id, run)
  },
  notify: {
    show: (title: string, body: string): Promise<void> =>
      ipcRenderer.invoke('notify:show', title, body)
  },

  // === Coverage gap map (F23) ===
  // Crawl the app from the current page; onProgress streams the running count.
  coverage: {
    crawl: (): Promise<unknown> => ipcRenderer.invoke('coverage:crawl'),
    onProgress: (cb: (data: { found: number }) => void): (() => void) => {
      const listener = (_e: unknown, data: { found: number }): void => cb(data)
      ipcRenderer.on('coverage:progress', listener)
      return () => ipcRenderer.removeListener('coverage:progress', listener)
    }
  },

  // === Accessibility scan (F13) ===
  // Run axe-core on the current page → WCAG A/AA violations. openHelp opens a
  // rule's docs in the real browser. (Result shape typed in index.d.ts.)
  a11y: {
    scan: (): Promise<unknown> => ipcRenderer.invoke('a11y:scan'),
    openHelp: (url: string): Promise<void> => ipcRenderer.invoke('a11y:openHelp', url)
  },

  // === Performance / Core Web Vitals (F14) ===
  // Measure the current page's Core Web Vitals. (Result shape in index.d.ts.)
  perf: {
    measure: (): Promise<unknown> => ipcRenderer.invoke('perf:measure')
  },

  // === HAR record & replay (F1) ===
  har: {
    // Turn capture on/off (set before recording). Count arrives via onCaptured.
    setEnabled: (enabled: boolean): Promise<void> => ipcRenderer.invoke('har:setEnabled', enabled),
    lastCount: (): Promise<number> => ipcRenderer.invoke('har:lastCount'),
    // Recording stopped → how many network responses were captured.
    onCaptured: (callback: (info: { count: number }) => void): (() => void) => {
      const listener = (_e: unknown, info: { count: number }): void => callback(info)
      ipcRenderer.on('har:captured', listener)
      return () => ipcRenderer.removeListener('har:captured', listener)
    }
  },

  // === Visual regression (Day 19) ===
  // F18: turn a plain-English intent into draft steps grounded to the current page.
  ai: {
    generateSteps: (intent: string): Promise<{ steps: unknown[]; note: string } | null> =>
      ipcRenderer.invoke('ai:generateSteps', intent),
    // F21: bug repro + expected result → reproduce steps + a verification assertion.
    generateRegressionTest: (
      repro: string,
      expected: string
    ): Promise<{ steps: unknown[]; note: string } | null> =>
      ipcRenderer.invoke('ai:generateRegressionTest', repro, expected)
  },
  // F31: acceptance-criteria checklist — persist the ACs + map them to tests.
  ac: {
    load: (): Promise<string> => ipcRenderer.invoke('ac:load'),
    save: (text: string): Promise<void> => ipcRenderer.invoke('ac:save', text),
    map: (
      acs: string[],
      tests: { name: string; summary: string }[]
    ): Promise<{ ac: string; tests: string[] }[] | null> =>
      ipcRenderer.invoke('ac:map', acs, tests)
  },
  // F28: inspect the current page for localization issues (overflow / dir / text).
  i18n: {
    inspect: (): Promise<{
      dir: string
      overflow: string[]
      overflowCount: number
      texts: string[]
    }> => ipcRenderer.invoke('i18n:inspect')
  },
  visual: {
    updateBaseline: (baselineId: string, currentPath: string): Promise<boolean> =>
      ipcRenderer.invoke('visual:updateBaseline', baselineId, currentPath),
    // F15: re-capture the baseline from the current page with mask + freeze applied.
    recaptureBaseline: (
      baselineId: string,
      maskSelectors: string | undefined,
      freeze: boolean | undefined
    ): Promise<boolean> =>
      ipcRenderer.invoke('visual:recaptureBaseline', baselineId, maskSelectors, freeze),
    getBaseline: (id: string): Promise<string | null> =>
      ipcRenderer.invoke('visual:getBaseline', id)
  },

  // === Failure translator + bug report (Day 13) ===
  // Evidence in, plain-English analysis out. Main decides which backend
  // answers (Claude CLI when available, built-in rules otherwise).
  translator: {
    explain: (evidence: unknown): Promise<unknown> =>
      ipcRenderer.invoke('translator:explain', evidence),
    // F9 Stage 3: deep root-cause over a whole run trace (by trace id).
    deepRca: (traceId: string): Promise<unknown> =>
      ipcRenderer.invoke('translator:deepRca', traceId),
    // Save a generated bug report; resolves to the path or null on cancel.
    saveReport: (markdown: string, defaultName: string): Promise<string | null> =>
      ipcRenderer.invoke('report:save', markdown, defaultName)
  },

  // === Test library (Day 11) — saved tests as JSON files on disk. ===
  // (Shapes typed structurally as unknown here; the renderer gets the named
  // types from index.d.ts — same pattern as recorder.onStep.)
  library: {
    save: (input: {
      name: string
      baseURL: string
      suite: string
      steps: unknown[]
      storageState?: string
      viewport?: { width: number; height: number }
      dataRows?: Record<string, string>[]
      captureHar?: boolean // F1: bank the captured network with this test
    }): Promise<unknown> => ipcRenderer.invoke('library:save', input),
    list: (): Promise<unknown[]> => ipcRenderer.invoke('library:list'),
    listSuites: (): Promise<string[]> => ipcRenderer.invoke('library:listSuites'),
    load: (fileName: string): Promise<unknown> => ipcRenderer.invoke('library:load', fileName),
    remove: (fileName: string): Promise<void> => ipcRenderer.invoke('library:delete', fileName),
    recordRun: (fileName: string, run: unknown): Promise<void> =>
      ipcRenderer.invoke('library:recordRun', fileName, run),
    openScreenshot: (path: string): Promise<void> =>
      ipcRenderer.invoke('library:openScreenshot', path),
    // F20 (Option 2): persist / list / re-open edge-case batches per test.
    saveEdgeRun: (input: unknown): Promise<unknown> =>
      ipcRenderer.invoke('library:saveEdgeRun', input),
    listEdgeRuns: (testFile: string): Promise<unknown[]> =>
      ipcRenderer.invoke('library:listEdgeRuns', testFile),
    loadEdgeRun: (id: string): Promise<unknown> => ipcRenderer.invoke('library:loadEdgeRun', id),
    deleteEdgeRun: (id: string): Promise<void> =>
      ipcRenderer.invoke('library:deleteEdgeRun', id)
  },

  // === Saved sessions (Day 17) — cookies + localStorage as storageState. ===
  session: {
    save: (name: string): Promise<string | null> => ipcRenderer.invoke('session:save', name),
    list: (): Promise<string[]> => ipcRenderer.invoke('session:list'),
    // Day 17(+): seed a saved session into the LIVE browser so recording starts
    // logged in. Resolves { ok, url? } — the page it opened.
    apply: (file: string, url?: string): Promise<{ ok: boolean; url?: string; error?: string }> =>
      ipcRenderer.invoke('session:apply', file, url)
  },

  // === Drafts (Day 18) — auto-saved in-progress recordings ===
  drafts: {
    save: (input: unknown): Promise<void> => ipcRenderer.invoke('drafts:save', input),
    list: (): Promise<unknown> => ipcRenderer.invoke('drafts:list'),
    load: (id: string): Promise<unknown> => ipcRenderer.invoke('drafts:load', id),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('drafts:delete', id)
  },

  // === Reusable step blocks (Pillar 4) — named, saved step sequences ===
  blocks: {
    save: (input: { name: string; steps: unknown[] }): Promise<unknown> =>
      ipcRenderer.invoke('blocks:save', input),
    list: (): Promise<unknown[]> => ipcRenderer.invoke('blocks:list'),
    load: (fileName: string): Promise<unknown> => ipcRenderer.invoke('blocks:load', fileName),
    delete: (fileName: string): Promise<void> => ipcRenderer.invoke('blocks:delete', fileName),
    // F7 (blast-radius): map of block fileName → the tests that link it.
    usage: (): Promise<unknown> => ipcRenderer.invoke('blocks:usage')
  },

  // === Run trace (Day 18) ===
  trace: {
    get: (id: string): Promise<unknown> => ipcRenderer.invoke('trace:get', id),
    getImage: (id: string, file: string): Promise<string | null> =>
      ipcRenderer.invoke('trace:getImage', id, file),
    openFile: (id: string, file: string): Promise<void> =>
      ipcRenderer.invoke('trace:openFile', id, file),
    export: (id: string): Promise<string | null> => ipcRenderer.invoke('trace:export', id),
    // Save a whole-run HTML report (pass or fail) — the "📄 report" button.
    exportReport: (id: string): Promise<string | null> =>
      ipcRenderer.invoke('trace:exportReport', id)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
