import { ElectronAPI } from '@electron-toolkit/preload'

interface BrowserAPI {
  navigate: (url: string) => Promise<string>
  goBack: () => Promise<boolean>
  goForward: () => Promise<boolean>
  reload: () => Promise<void>
  home: () => Promise<void>
  setOverlay: (open: boolean) => Promise<void>
  onUrlChange: (callback: (url: string) => void) => () => void
}

interface ReplayProgress {
  index: number
  status: 'running' | 'done' | 'error'
  error?: string
}

interface ReplayResult {
  ok: boolean
  failedAt?: number
  error?: string
}

interface RecorderAPI {
  toggle: (resume?: boolean) => Promise<boolean>
  onStep: (callback: (step: RecorderStep) => void) => () => void
  exportTest: (code: string) => Promise<string | null>
  replay: (steps: RecorderStep[]) => Promise<ReplayResult>
  onReplayProgress: (callback: (progress: ReplayProgress) => void) => () => void
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
    type: 'navigate' | 'click' | 'type' | 'select' | 'press' | 'hover'
    label?: string
    value?: string
    key?: string // for `press` steps — the key pressed (e.g. 'Enter')
    secret?: boolean // password field — value masked on screen / in export
    disabled?: boolean // turned off in the editor — skipped by replay + export
    url?: string
    selector?: string
    candidates?: SelectorCandidate[]
  }

  interface Window {
    electron: ElectronAPI
    api: API
  }
}
