import { ElectronAPI } from '@electron-toolkit/preload'

interface BrowserAPI {
  navigate: (url: string) => Promise<string>
  goBack: () => Promise<boolean>
  goForward: () => Promise<boolean>
  reload: () => Promise<void>
  home: () => Promise<void>
  onUrlChange: (callback: (url: string) => void) => () => void
}

interface RecorderAPI {
  toggle: () => Promise<boolean>
  onStep: (callback: (step: RecorderStep) => void) => () => void
}

interface API {
  browser: BrowserAPI
  recorder: RecorderAPI
}

declare global {
  // One ranked way to locate an element, with a 0–100 stability score.
  interface SelectorCandidate {
    kind: 'testId' | 'id' | 'role' | 'name' | 'placeholder' | 'text' | 'css'
    score: number
    locator: string // Playwright-style expression (Day 5 export)
    css: string | null // CSS selector when expressible (Day 6 replay)
  }

  // One recorded action (the canonical step model). `navigate` carries `url`;
  // `click`/`type`/`select` carry a human `label` + a ranked selector ladder
  // (`selector` is the primary; `candidates` are the fallbacks). `type`/
  // `select` also carry the entered/chosen `value`.
  interface RecorderStep {
    type: 'navigate' | 'click' | 'type' | 'select'
    label?: string
    value?: string
    url?: string
    selector?: string
    candidates?: SelectorCandidate[]
  }

  interface Window {
    electron: ElectronAPI
    api: API
  }
}
