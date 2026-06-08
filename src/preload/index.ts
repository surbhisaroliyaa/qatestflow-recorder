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

    // Subscribe to URL changes from the embedded browser.
    // Returns an unsubscribe function so React effects can clean up.
    onUrlChange: (callback: (url: string) => void): (() => void) => {
      const listener = (_event: unknown, url: string): void => callback(url)
      ipcRenderer.on('browser:url-changed', listener)
      return () => ipcRenderer.removeListener('browser:url-changed', listener)
    }
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
