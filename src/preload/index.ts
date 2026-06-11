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
    }
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

    // Save the generated Playwright code to a .ts file the user picks.
    // Resolves to the saved file path, or null if cancelled.
    exportTest: (code: string): Promise<string | null> =>
      ipcRenderer.invoke('recorder:export', code),

    // Replay the given steps in the embedded browser. Resolves when done
    // (or at the first failed step).
    replay: (steps: unknown[]): Promise<{ ok: boolean; failedAt?: number; error?: string }> =>
      ipcRenderer.invoke('recorder:replay', steps),

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
    }
  },

  // === Test library (Day 11) — saved tests as JSON files on disk. ===
  // (Shapes typed structurally as unknown here; the renderer gets the named
  // types from index.d.ts — same pattern as recorder.onStep.)
  library: {
    save: (input: { name: string; baseURL: string; steps: unknown[] }): Promise<unknown> =>
      ipcRenderer.invoke('library:save', input),
    list: (): Promise<unknown[]> => ipcRenderer.invoke('library:list'),
    load: (fileName: string): Promise<unknown> => ipcRenderer.invoke('library:load', fileName),
    remove: (fileName: string): Promise<void> => ipcRenderer.invoke('library:delete', fileName),
    recordRun: (fileName: string, run: unknown): Promise<void> =>
      ipcRenderer.invoke('library:recordRun', fileName, run)
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
