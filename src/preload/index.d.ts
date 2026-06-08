import { ElectronAPI } from '@electron-toolkit/preload'

interface BrowserAPI {
  navigate: (url: string) => Promise<string>
  goBack: () => Promise<boolean>
  goForward: () => Promise<boolean>
  reload: () => Promise<void>
  onUrlChange: (callback: (url: string) => void) => () => void
}

interface API {
  browser: BrowserAPI
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: API
  }
}
