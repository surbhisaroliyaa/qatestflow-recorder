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
      pageObjectFileName?: string
    ): Promise<string | null> =>
      ipcRenderer.invoke(
        'recorder:export',
        code,
        fixturePaths,
        sessionFile,
        pageObjectCode,
        pageObjectFileName
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
      traceOpts?: unknown
    ): Promise<{ ok: boolean; failedAt?: number; error?: string }> =>
      ipcRenderer.invoke('recorder:replay', steps, interactive, storageState, traceOpts),

    // === Recovery (Day 12) ===
    // An interactive replay paused at a failed step — main's loop is holding,
    // waiting for a decision.
    onReplayPaused: (callback: (info: unknown) => void): (() => void) => {
      const listener = (_event: unknown, info: unknown): void => callback(info)
      ipcRenderer.on('recorder:replay-paused', listener)
      return () => ipcRenderer.removeListener('recorder:replay-paused', listener)
    },

    // Answer the pause: retry (optionally with a healed step), skip, or stop.
    recovery: (decision: unknown): void => ipcRenderer.send('recorder:recovery', decision),

    // Subscribe to per-step replay progress. Returns an unsubscribe fn.
    onReplayProgress: (callback: (progress: unknown) => void): (() => void) => {
      const listener = (_event: unknown, progress: unknown): void => callback(progress)
      ipcRenderer.on('recorder:replay-progress', listener)
      return () => ipcRenderer.removeListener('recorder:replay-progress', listener)
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

    // Day 20 (data-driven): resolve {{env:NAME}} tokens from the real process
    // environment for a run (renderer can't read arbitrary env vars itself).
    resolveEnv: (names: string[]): Promise<Record<string, string>> =>
      ipcRenderer.invoke('env:get', names)
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

  // === Visual regression (Day 19) ===
  visual: {
    updateBaseline: (baselineId: string, currentPath: string): Promise<boolean> =>
      ipcRenderer.invoke('visual:updateBaseline', baselineId, currentPath),
    getBaseline: (id: string): Promise<string | null> =>
      ipcRenderer.invoke('visual:getBaseline', id)
  },

  // === Failure translator + bug report (Day 13) ===
  // Evidence in, plain-English analysis out. Main decides which backend
  // answers (Claude CLI when available, built-in rules otherwise).
  translator: {
    explain: (evidence: unknown): Promise<unknown> =>
      ipcRenderer.invoke('translator:explain', evidence),
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
    }): Promise<unknown> => ipcRenderer.invoke('library:save', input),
    list: (): Promise<unknown[]> => ipcRenderer.invoke('library:list'),
    listSuites: (): Promise<string[]> => ipcRenderer.invoke('library:listSuites'),
    load: (fileName: string): Promise<unknown> => ipcRenderer.invoke('library:load', fileName),
    remove: (fileName: string): Promise<void> => ipcRenderer.invoke('library:delete', fileName),
    recordRun: (fileName: string, run: unknown): Promise<void> =>
      ipcRenderer.invoke('library:recordRun', fileName, run),
    openScreenshot: (path: string): Promise<void> =>
      ipcRenderer.invoke('library:openScreenshot', path)
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
    delete: (fileName: string): Promise<void> => ipcRenderer.invoke('blocks:delete', fileName)
  },

  // === Run trace (Day 18) ===
  trace: {
    get: (id: string): Promise<unknown> => ipcRenderer.invoke('trace:get', id),
    getImage: (id: string, file: string): Promise<string | null> =>
      ipcRenderer.invoke('trace:getImage', id, file),
    openFile: (id: string, file: string): Promise<void> =>
      ipcRenderer.invoke('trace:openFile', id, file),
    export: (id: string): Promise<string | null> => ipcRenderer.invoke('trace:export', id)
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
