import { app, shell, BrowserWindow, ipcMain, WebContentsView, dialog, webFrameMain } from 'electron'
import { join, basename, dirname } from 'path'
import { writeFile, mkdir, copyFile, readFile, readdir, rm } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { buildSelectors, labelFrom, type ElementFacts } from './selector'
import {
  buildActionScript,
  buildFailureMarkScript,
  buildLocateRectScript,
  removeFailureMarkScript,
  type ReplayStep
} from './replay'
import {
  saveTest,
  listTests,
  listSuites,
  loadTest,
  deleteTest,
  recordRun,
  saveDraft,
  listDrafts,
  loadDraft,
  deleteDraft,
  saveBlock,
  listBlocks,
  loadBlock,
  deleteBlock,
  blockUsage,
  libraryDir,
  slugify,
  loadHar,
  type RunInfo,
  type DraftFile
} from './library'
import {
  explainFailure,
  evaluateNlAssertion,
  categorizeFailure,
  deepRcaFailure,
  type FailureEvidence,
  type FailureCategory
} from './translator'
import { diffSnapshots, type PageSnapshot, type DomDiff } from './domDiff'
import {
  baselineKeyFor,
  saveBaseline as saveDomBaseline,
  loadBaseline as loadDomBaseline,
  type Baseline as DomBaseline,
  type ElementFingerprint
} from './baselines'
import { observerProgram } from './observerSource'
import {
  saveBaseline,
  loadBaseline,
  isSafeBaselineId,
  diffImages,
  toCropPng,
  cropSimilarity
} from './visual'
import { scanAccessibility, a11yImpactRank, a11yThresholdLevel, type A11yScanResult } from './a11y'
import {
  measurePerformance,
  PERF_RATING_RANK,
  perfBudgetRank,
  perfBudgetLabel,
  type PerfResult
} from './perf'
import {
  newHarLog,
  buildEntry,
  shouldCaptureType,
  matchEntry,
  serveHeaders,
  entryBodyBase64,
  type HarLog
} from './har'
import {
  saveTrace,
  loadTrace,
  readTraceAsset,
  deleteTrace,
  isSafeTraceId,
  generateTraceHtml,
  generateReportHtml,
  traceDir,
  pruneTraces,
  type TraceManifest,
  type TraceStepRecord
} from './trace'
import {
  getEnvState,
  saveEnvironment,
  deleteEnvironment,
  setActiveEnvironment,
  activeEnvVars,
  activeEnvironment,
  type Environment
} from './environments'
import { checkPlaywright, runCrossBrowser, type BrowserName } from './xbrowser'

// Small pause so a human can watch each replayed step happen.
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Day 19: a visual snapshot must be captured when the page is STABLE, or a
// half-loaded page (images still arriving) gets compared against a fully
// rendered baseline. Wait for document-complete + every image finished, then a
// short settle for fonts/layout. Used for BOTH baseline + replay captures so
// they're taken under identical conditions. Best-effort (never throws).
async function waitForVisualStable(wc: Electron.WebContents): Promise<void> {
  try {
    const deadline = Date.now() + 4000
    for (;;) {
      const ready = await wc
        .executeJavaScript(
          'document.readyState === "complete" && Array.prototype.every.call(document.images, function(i){return i.complete})'
        )
        .catch(() => true)
      if (ready === true || Date.now() > deadline) break
      await wait(150)
    }
    await wait(350) // settle for fonts / layout / late paints
  } catch {
    // best-effort — capture anyway
  }
}

// Height in pixels reserved at the top of the window for our React chrome
// (URL bar + back/forward/reload buttons). Everything below this is the
// embedded browser showing the website under test.
const CHROME_HEIGHT = 60

// Day 17 (multiple windows): height reserved for the tab strip, shown ONLY when
// more than one tab is open. When visible, the embedded browser starts this
// much further down. The renderer renders the same-height strip under the same
// condition, so the React strip and the native view line up exactly. MUST match
// the .tab-strip height in main.css.
const TAB_STRIP_HEIGHT = 34

// Width in pixels reserved on the RIGHT for our React "steps" panel (the live
// recording list). Once the user has navigated, the embedded browser shrinks
// by this much so the panel showing through underneath stays uncovered.
const PANEL_WIDTH = 340

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    title: 'QATestFlow Recorder',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // === The embedded browser tabs (Day 17: multiple windows) ===========
  // What used to be a SINGLE embedded view is now a SET of tabs. Exactly one is
  // active (sized to fill the browser area); the rest are zero-bound (hidden).
  // Each tab is a real Chrome view loading a website. The "recorder" preload is
  // a RELAY (top frame only); the observer is INJECTED into every frame by main
  // (see injectObserver), because Electron's preload-into-sub-frames was flaky.
  // A popup (window.open / target=_blank) becomes a new tab in Phase 2; for now
  // there is always exactly one tab.
  interface Tab {
    id: string
    // 0 = the original tab; popups get 1, 2, … in open order, NEVER reused.
    // This ordinal is the step's `windowId` — identical at record, replay, and
    // export time (a raw webContents.id changes on replay; a UUID isn't
    // reproducible). Mirrors Playwright handing you pages in creation order.
    ordinal: number
    view: WebContentsView
  }
  const tabs: Tab[] = []
  let activeTabId = ''
  let tabOrdinalSeq = 0 // next ordinal to hand out
  // Day 17 (Phase 4): a one-shot hook so replay can capture the next popup tab
  // (the replay-time window-open handler still creates the tab via openTabWith;
  // this lets replay await it and bind it to the step's `opensWindow` ordinal).
  let onPopupOpened: ((tab: Tab) => void) | null = null

  const activeTab = (): Tab => tabs.find((t) => t.id === activeTabId) ?? tabs[0]
  // The active tab's webContents — the target of every "current page" operation.
  // During replay this is repointed per step (Phase 4) so it always means "the
  // tab this step runs in".
  const activeWC = (): Electron.WebContents => activeTab().view.webContents
  const tabByOrdinal = (n: number): Tab | undefined => tabs.find((t) => t.ordinal === n)
  const tabOfWC = (wc: Electron.WebContents): Tab | undefined =>
    tabs.find((t) => t.view.webContents.id === wc.id)

  // Day 17 (multiple windows): a step's `windowId` is RECORDING-LOCAL, NOT the
  // global Tab.ordinal. The tab a recording starts in is 0; each tab the
  // recording newly touches/opens gets 1, 2, … So a clean recording always reads
  // tab 0 / tab 1 / tab 2 regardless of how many tabs were opened earlier in the
  // session. (The global Tab.ordinal still drives the live tab strip.) Reset at
  // the start of a fresh recording (see recorder:toggle).
  const recWindowIdByTabId = new Map<string, number>()
  let nextRecWindowId = 0
  const recWindowIdOf = (tab: Tab): number => {
    let id = recWindowIdByTabId.get(tab.id)
    if (id === undefined) {
      id = nextRecWindowId++
      recWindowIdByTabId.set(tab.id, id)
    }
    return id
  }
  // The recording-local windowId of a step's IPC SENDER — race-proof: it's the
  // tab that actually fired the event, not whichever tab is currently visible.
  const recWindowIdOfWC = (wc: Electron.WebContents): number => {
    const tab = tabOfWC(wc)
    return tab ? recWindowIdOf(tab) : 0
  }

  // Tell the renderer the current set of open tabs (for the tab strip). Built
  // fresh each call from the live views so titles/urls are current.
  const emitTabs = (): void => {
    if (mainWindow.isDestroyed()) return
    // Skip any tab whose webContents is mid-teardown (reading it would throw).
    const list = tabs.flatMap((t) => {
      try {
        const w = t.view.webContents
        if (w.isDestroyed()) return []
        return [
          {
            ordinal: t.ordinal,
            title: w.getTitle() || w.getURL() || 'New Tab',
            url: w.getURL(),
            active: t.id === activeTabId
          }
        ]
      } catch {
        return []
      }
    })
    try {
      mainWindow.webContents.send('browser:tabs-changed', list)
    } catch {
      // window gone — nothing to update
    }
  }

  // === iframe plumbing (Day 15) ======================================
  // The observer is injected into every frame and reports WHICH frame each
  // event came from (a URL chain). These helpers describe a frame's identity
  // and re-find it at replay time.

  // Describe the frame an observer event arrived from, as a chain of
  // { url, name } from the OUTERMOST iframe down to it. Returns undefined for
  // the top page (its steps need no frame routing). Frame internal ids change
  // on every load, so we record the stable URL (+ name) to re-find it later.
  const frameRefOf = (
    frame: Electron.WebFrameMain | null
  ): { url: string; name?: string }[] | undefined => {
    if (!frame || frame.parent === null) return undefined
    const chain: { url: string; name?: string }[] = []
    for (let f: Electron.WebFrameMain | null = frame; f && f.parent !== null; f = f.parent) {
      chain.unshift({ url: f.url, name: f.name || undefined })
    }
    return chain.length ? chain : undefined
  }

  // Re-find the live frame a step was recorded in, by matching the recorded URL
  // chain (ignoring the hash and a trailing slash, which churn harmlessly).
  // Returns the top frame when there's no frame ref (the normal case).
  // framesInSubtree can momentarily be null / non-iterable while a frame is
  // navigating or being torn down — which happens nonstop on ad-heavy pages
  // that spin up and drop many iframes (LetCode's Google ads). Reading it
  // unguarded crashed the main process. Treat any failure as "no frames now".
  const subtreeFrames = (frame: Electron.WebFrameMain | null): Electron.WebFrameMain[] => {
    if (!frame) return []
    try {
      const list = frame.framesInSubtree
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  const findFrameNow = (
    wc: Electron.WebContents,
    ref?: { url: string; name?: string }[]
  ): Electron.WebFrameMain | null => {
    const main = wc.mainFrame
    if (!ref || !ref.length) return main
    if (!main) return null
    const norm = (u: string): string => u.replace(/#.*$/, '').replace(/\/$/, '')
    // Match a live frame to a recorded one by URL, falling back to the frame
    // name when the recorded url is missing/blank (older recordings) or the
    // live url hasn't committed yet — so a blank url can't strand replay.
    const levelMatches = (
      live: { url: string; name: string },
      want: { url: string; name?: string }
    ): boolean => {
      if (want.url && norm(live.url) === norm(want.url)) return true
      if (want.name && live.name === want.name) return true
      return false
    }
    for (const frame of subtreeFrames(main)) {
      try {
        if (frame.parent === null) continue // skip the top frame
        const chain: { url: string; name: string }[] = []
        for (let f: Electron.WebFrameMain | null = frame; f && f.parent !== null; f = f.parent) {
          chain.unshift({ url: f.url, name: f.name })
        }
        if (chain.length === ref.length && chain.every((c, i) => levelMatches(c, ref[i]))) {
          return frame
        }
      } catch {
        // frame went away mid-walk — skip it
      }
    }
    return null
  }

  // An iframe may still be loading when replay reaches its step, so poll for
  // it (same idea as the element finder waiting for an element to appear).
  const resolveFrame = async (
    wc: Electron.WebContents,
    ref?: { url: string; name?: string }[]
  ): Promise<Electron.WebFrameMain | null> => {
    const deadline = Date.now() + 8000
    for (;;) {
      const frame = findFrameNow(wc, ref)
      if (frame) return frame
      if (Date.now() > deadline) return null
      await wait(150)
    }
  }

  // Day 16: tell a frame's injected dialog override how to answer the NEXT
  // native dialog (when the upcoming step is a `dialog`), and flag that a replay
  // is in progress so any UNEXPECTED dialog auto-accepts instead of blocking the
  // run. `frame` is the frame whose action is about to fire the dialog.
  const armNextDialog = async (
    frame: Electron.WebFrameMain,
    nextStep?: ReplayStep
  ): Promise<void> => {
    const next = nextStep && !nextStep.disabled && nextStep.type === 'dialog' ? nextStep : null
    const pending = next
      ? {
          kind: next.dialogKind,
          accept: next.dialogKind === 'confirm' ? next.value !== 'dismiss' : true,
          text: next.dialogKind === 'prompt' ? (next.value ?? '') : undefined
        }
      : null
    try {
      await frame.executeJavaScript(
        `window.__qaflowReplaying=true;window.__qaflowNextDialog=${JSON.stringify(pending)};`
      )
    } catch {
      // frame navigated away mid-step — the replay flag / safety net still apply
    }
  }

  // Recording on/off lives here in main, because main is the hub that merges
  // page events (from the observer) with navigation events (which main owns).
  let isRecording = false

  // === F1 (HAR) network capture ======================================
  // When ON, recording also captures the page's network (requests + response
  // bodies) into a HAR via a CDP debugger attached to the active tab. On stop
  // the finished log is kept in `lastCapturedHar` for the Save panel to bank.
  let harCaptureEnabled = false
  let lastCapturedHar: HarLog | null = null
  // The shape of a CDP debugger 'message' listener (event, method, params).
  type CdpListener = (event: unknown, method: string, params: Record<string, unknown>) => void
  let harCapture: { wc: Electron.WebContents; onMessage: CdpListener } | null = null

  const startHarCapture = (wc: Electron.WebContents): void => {
    if (harCapture) return // already capturing
    const log = newHarLog()
    // Per-requestId scratch: the request facts, and the response meta, joined
    // when the body arrives (loadingFinished).
    const reqs = new Map<
      string,
      {
        method: string
        url: string
        headers?: Record<string, string>
        postData?: string
        startedDateTime: string
      }
    >()
    const resps = new Map<
      string,
      {
        status: number
        statusText?: string
        mimeType?: string
        headers?: Record<string, string>
        type?: string
      }
    >()
    const d = wc.debugger
    try {
      if (!d.isAttached()) d.attach('1.3')
    } catch {
      return // can't attach (DevTools open?) — capture silently unavailable
    }
    const onMessage = (_e: unknown, method: string, params: Record<string, unknown>): void => {
      if (method === 'Network.requestWillBeSent') {
        const r = params.request as
          | { method?: string; url?: string; headers?: Record<string, string>; postData?: string }
          | undefined
        if (typeof params.requestId === 'string' && r?.url) {
          reqs.set(params.requestId, {
            method: r.method ?? 'GET',
            url: r.url,
            headers: r.headers,
            postData: r.postData,
            startedDateTime: new Date(0).toISOString()
          })
        }
      } else if (method === 'Network.responseReceived') {
        const res = params.response as
          | {
              status?: number
              statusText?: string
              mimeType?: string
              headers?: Record<string, string>
            }
          | undefined
        if (typeof params.requestId === 'string' && res) {
          resps.set(params.requestId, {
            status: res.status ?? 0,
            statusText: res.statusText,
            mimeType: res.mimeType,
            headers: res.headers,
            type: String(params.type ?? '')
          })
        }
      } else if (method === 'Network.loadingFinished') {
        const id = String(params.requestId)
        const req = reqs.get(id)
        const res = resps.get(id)
        reqs.delete(id)
        resps.delete(id)
        if (!req || !res || !shouldCaptureType(res.type)) return
        // Pull the (decoded) body, then assemble a standard HAR entry.
        d.sendCommand('Network.getResponseBody', { requestId: id })
          .then((b: { body?: string; base64Encoded?: boolean }) => {
            log.log.entries.push(
              buildEntry({
                method: req.method,
                url: req.url,
                requestHeaders: req.headers,
                postData: req.postData,
                status: res.status,
                statusText: res.statusText,
                mimeType: res.mimeType,
                responseHeaders: res.headers,
                body: b.body ?? '',
                base64: !!b.base64Encoded,
                resourceType: res.type,
                startedDateTime: req.startedDateTime
              })
            )
          })
          .catch(() => {
            // body already evicted (navigation) — skip this one entry
          })
      } else if (method === 'Network.loadingFailed') {
        const id = String(params.requestId)
        reqs.delete(id)
        resps.delete(id)
      }
    }
    d.on('message', onMessage)
    d.sendCommand('Network.enable').catch(() => {})
    harCapture = { wc, onMessage }
    lastCapturedHar = log // grows live; finalized (kept or discarded) on stop
  }

  const stopHarCapture = (): number => {
    if (!harCapture) return 0
    const { wc, onMessage } = harCapture
    harCapture = null
    try {
      wc.debugger.removeListener('message', onMessage)
      if (wc.debugger.isAttached()) wc.debugger.detach()
    } catch {
      // already detached — fine
    }
    const count = lastCapturedHar?.log.entries.length ?? 0
    if (!count) lastCapturedHar = null // nothing captured → nothing to offer
    return count
  }

  // Pick mode on/off, mirrored here too so a frame can be injected already in
  // the right state, and so toggling pick updates frames that are already live.
  let isPicking = false

  // === Observer injection (Day 15) ===================================
  // We inject the observer into every frame ourselves (executeJavaScript is
  // reliable on any frame, any origin — unlike preload-into-sub-frames). The
  // observer runs in the page world and posts its events up to the top frame,
  // where the relay preload forwards them to main. Arming + this frame's
  // identity are handed in as globals set right before the program runs.
  //
  // Frames are tracked by frameTreeNodeId so we inject each one once; a frame
  // that navigates (fresh document) is dropped from the set and re-injected.
  const injectedFrames = new Set<number>()

  const injectObserver = (frame: Electron.WebFrameMain | null): void => {
    if (!frame) return
    let id: number
    try {
      id = frame.frameTreeNodeId
    } catch {
      return // frame already gone
    }
    if (injectedFrames.has(id)) return
    // Bake in this frame's identity + the CURRENT record/pick state, so a frame
    // that loads mid-recording comes up already armed (no race).
    const ref = frameRefOf(frame)
    // Don't commit an identity until EVERY frame in the chain has a real url.
    // A first injection that wins while a url is still uncommitted ('') would
    // bake an empty-url FrameRef that replay could never re-find. Leaving it
    // out of the injected set lets the next load event re-inject once the urls
    // are in place. (Top frame has no ref — nothing to guard.)
    if (ref && ref.some((r) => r.url === '')) return
    injectedFrames.add(id)
    const boot =
      `window.__qaflowFrame=${JSON.stringify(ref ?? null)};` +
      `window.__qaflowInitActive=${isRecording};` +
      `window.__qaflowInitPicking=${isPicking};` +
      `(${observerProgram.toString()})();`
    frame.executeJavaScript(boot).catch(() => {
      // injection can fail on a frame that's navigating — allow a retry later
      injectedFrames.delete(id)
    })
  }

  // (Re)inject every frame currently in the tree. Cheap to call often: already-
  // injected frames are skipped by the set.
  const injectAllFrames = (wc: Electron.WebContents): void => {
    for (const frame of subtreeFrames(wc.mainFrame)) {
      injectObserver(frame)
    }
  }

  // Push a record/pick state change into EVERY live frame's observer by
  // re-injecting from scratch. Re-injection is the one channel that reliably
  // reaches deeply-nested frames (a one-off setActive call via executeJavaScript
  // silently missed grandchild frames). Each boot bakes in the current
  // isRecording/isPicking, and the observer re-asserts that state when it sees
  // it's already installed — so listeners are never registered twice.
  // Re-inject EVERY tab's frames from scratch — used when a global state change
  // (record on/off, pick on/off) must reach every live tab, not just the active
  // one. With one tab this is the old single-view behavior.
  const reinjectAllFrames = (): void => {
    injectedFrames.clear()
    for (const t of tabs) injectAllFrames(t.view.webContents)
  }

  // Until the user navigates to a real URL, we keep the embedded browser
  // hidden (zero size) so the React welcome page is visible across the
  // whole window. After first navigation, it expands to fill below the chrome.
  let hasNavigated = false

  // The embedded browser is a NATIVE pane painted ON TOP of our React screen,
  // so it covers any React pop-up (e.g. the export modal). While an overlay is
  // open we hide the browser by shrinking it to nothing, then restore it.
  let overlayOpen = false

  // Day 17 (viewport emulation): when set, the active tab renders at this FIXED
  // size (device emulation) instead of filling the browser area, so the page's
  // window.innerWidth = this width and responsive layouts switch. Null = fill.
  let viewportOverride: { width: number; height: number } | null = null

  const resizeEmbedded = (): void => {
    if (mainWindow.isDestroyed()) return
    // getContentBounds = the drawable area inside the window frame, so the
    // native browser view and the CSS panel measure from the same ruler and
    // meet exactly at width - PANEL_WIDTH (no overlap, no gap at the seam).
    const { width, height } = mainWindow.getContentBounds()
    // The tab strip is shown only with 2+ tabs; when shown, the browser view
    // starts that much lower (the renderer reserves the same band).
    const top = CHROME_HEIGHT + (tabs.length > 1 ? TAB_STRIP_HEIGHT : 0)
    const areaWidth = Math.max(0, width - PANEL_WIDTH)
    const areaHeight = Math.max(0, height - top)
    const hidden = { x: 0, y: 0, width: 0, height: 0 }
    // With a viewport override, clamp it to the available area so it never spills
    // under the panel/chrome; the leftover area shows the dark React backdrop
    // (like a browser's device-emulation mode).
    const shown = viewportOverride
      ? {
          x: 0,
          y: top,
          width: Math.min(viewportOverride.width, areaWidth),
          height: Math.min(viewportOverride.height, areaHeight)
        }
      : { x: 0, y: top, width: areaWidth, height: areaHeight }
    // Only the ACTIVE tab is sized to fill the browser area; every other tab is
    // zero-bound (hidden). Before first navigation, or while a React overlay is
    // open, even the active tab is hidden so the welcome/modal shows through.
    for (const t of tabs) {
      const visible = t.id === activeTabId && hasNavigated && !overlayOpen
      try {
        t.view.setBounds(visible ? shown : hidden)
      } catch {
        // view mid-teardown — skip it
      }
    }
  }

  mainWindow.on('resize', resizeEmbedded)
  mainWindow.on('ready-to-show', () => {
    resizeEmbedded()
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Load the React UI (the chrome at the top)
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // === IPC handlers — the React UI sends messages here ===

  // loadURL() rejects with ERR_ABORTED whenever the original request is
  // superseded — a server redirect, a retry, a second navigation while the
  // first is in flight (Heroku cold starts trigger this constantly). The
  // page that's actually loading still arrives via did-finish-load, so
  // ERR_ABORTED is noise, not failure. Real load errors (DNS, refused,
  // timeout) are swallowed too at this level: the embedded browser shows
  // its own error page; an exception here would just crash the caller.
  const loadUrlTolerantly = async (
    url: string,
    wc: Electron.WebContents = activeWC()
  ): Promise<void> => {
    try {
      await wc.loadURL(url)
    } catch {
      // superseded or failed — either way the webContents tells the story
    }
  }

  // "Navigate to this URL" — adds https:// if user typed a bare domain
  ipcMain.handle('browser:navigate', async (_event, rawUrl: string) => {
    const url = normalizeUrl(rawUrl)
    hasNavigated = true
    resizeEmbedded() // unhide the embedded browser
    // Navigating via the URL bar is itself a step worth recording.
    if (isRecording) sendStep({ type: 'navigate', url })
    await loadUrlTolerantly(url)
    return url
  })

  // Returns true if we actually went back; false if there was no history
  // left (in that case the React UI returns to the welcome screen).
  ipcMain.handle('browser:goBack', (): boolean => {
    const history = activeWC().navigationHistory
    if (history.canGoBack()) {
      // Going Back is a real user action with no click standing in for it, so
      // it deserves its own recorded step (unlike a link nav, which is treated
      // as a consequence of the recorded click). Record it BEFORE we move, so
      // it lands in order; replay re-walks history one entry back (Day 18).
      if (isRecording) sendStep({ type: 'back' })
      history.goBack()
      return true
    }
    // No more history — reset to the welcome state
    hasNavigated = false
    resizeEmbedded() // hide the embedded browser
    try {
      history.clear() // forget old URLs so future navigations start fresh
    } catch {
      // older Electron versions might not have clear(); safe to ignore
    }
    return false
  })

  ipcMain.handle('browser:goForward', (): boolean => {
    const history = activeWC().navigationHistory
    if (history.canGoForward()) {
      history.goForward()
      return true
    }
    return false
  })

  ipcMain.handle('browser:reload', () => {
    activeWC().reload()
  })

  // Day 17: wipe the browser's cookies + localStorage on demand (like Chrome's
  // "clear site data") so you can record from a clean, logged-out state. We wait
  // for the clear to actually settle (clearStorageData resolves early) before
  // reloading, so the reloaded page reflects the cleared state.
  ipcMain.handle('browser:clearData', async () => {
    const wc = activeWC()
    try {
      await wc.session.clearStorageData({ storages: ['cookies', 'localstorage'] })
    } catch {
      // best-effort
    }
    for (let i = 0; i < 20; i++) {
      try {
        if ((await wc.session.cookies.get({})).length === 0) break
      } catch {
        break
      }
      await wait(50)
    }
    wc.reload()
  })

  // When the React UI opens a full-window overlay (e.g. the export modal), hide
  // the native embedded browser so it doesn't cover the overlay; restore after.
  ipcMain.handle('browser:setOverlay', (_event, open: boolean) => {
    overlayOpen = open
    resizeEmbedded()
  })

  // Day 17 (viewport emulation): render at a fixed viewport (or null = fill).
  ipcMain.handle(
    'browser:setViewport',
    (_event, viewport: { width: number; height: number } | null) => {
      viewportOverride = viewport && viewport.width > 0 && viewport.height > 0 ? viewport : null
      resizeEmbedded()
    }
  )

  // The embedded page's live URL + title — the renderer can't see inside the
  // native browser view, so page-level checks (Day 11) ask main for prefills.
  ipcMain.handle('browser:getPageInfo', (): { url: string; title: string } => ({
    url: activeWC().getURL(),
    title: activeWC().getTitle()
  }))

  // "Home" — jump straight back to the welcome screen in one click, instead of
  // walking Back through the whole history. A fresh start: also stop recording
  // (disarm the observer) so nothing is captured on the way out. Hide the
  // embedded browser and forget its history so the next navigation starts clean.
  ipcMain.handle('browser:home', () => {
    hasNavigated = false
    isRecording = false
    // A replay paused for recovery (Day 12) can't continue once we've left —
    // answer it with a silent abort so its loop doesn't hang forever.
    resolveRecovery({ action: 'abort' })
    reinjectAllFrames() // disarm every frame (isRecording is now false)
    resizeEmbedded() // hide the embedded browser
    try {
      activeWC().navigationHistory.clear()
    } catch {
      // older Electron versions might not have clear(); safe to ignore
    }
  })

  // === Tell the React UI whenever the embedded browser changes URL ===
  const notifyUrlChange = (url: string): void => {
    mainWindow.webContents.send('browser:url-changed', url)
  }

  // === Tab wiring (Day 17: multiple windows) =========================
  // Install every per-view listener on a tab's webContents. Called for the
  // initial tab and (Phase 2) for each popup tab, so every tab behaves
  // identically: it reports URL changes (when active), arms its frames with the
  // observer as they load, and handles popups.
  let tabIdSeq = 0
  const wireTab = (view: WebContentsView, ordinal: number): Tab => {
    const tab: Tab = { id: `tab-${++tabIdSeq}`, ordinal, view }
    tabs.push(tab)
    const wc = view.webContents

    // The active tab drives the URL bar; any tab's navigation refreshes the
    // strip (titles / urls change).
    const onNav = (_e: unknown, url: string): void => {
      if (tab.id === activeTabId) notifyUrlChange(url)
      emitTabs()
    }
    wc.on('did-navigate', onNav)
    wc.on('did-navigate-in-page', onNav)
    // Titles arrive a beat after navigation — keep the strip label current.
    wc.on('page-title-updated', () => emitTabs())

    // Popups (window.open / target=_blank). Phase 2: deny the OS popup and open
    // a REAL new tab in our strip, made active, loading the requested URL.
    wc.setWindowOpenHandler((details) => {
      const url = details.url
      if (url && url !== 'about:blank') openTabWith(url, tab)
      return { action: 'deny' }
    })

    // The page (or our close button) closed this view — drop it from the strip
    // and fall back to another tab if it was active. The original tab (the only
    // one that can't be a popup) is never auto-removed out from under the user.
    // Skip during app/window teardown (the whole window is going away anyway).
    wc.on('destroyed', () => {
      if (!mainWindow.isDestroyed()) closeTab(tab)
    })

    // Inject the observer into every frame as pages/iframes load.
    wc.on('did-finish-load', () => injectAllFrames(wc))
    wc.on('did-frame-finish-load', () => injectAllFrames(wc))
    wc.on(
      'did-frame-navigate',
      (_e, _url, _code, _status, _isMain, frameProcessId, frameRoutingId) => {
        // A frame navigated to a fresh document — its old observer is gone. Drop
        // it from the injected set so it gets the observer again, then inject now.
        const frame = webFrameMain.fromId(frameProcessId, frameRoutingId)
        if (frame) {
          try {
            injectedFrames.delete(frame.frameTreeNodeId)
          } catch {
            // frame gone — nothing to drop
          }
        }
        injectAllFrames(wc)
      }
    )

    return tab
  }

  // Make a brand-new tab: a Chrome view with the recorder relay preload, added
  // to the window and fully wired. Does NOT change the active tab or load a URL.
  const createTab = (): Tab => {
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/recorder.js'),
        sandbox: false
      }
    })
    mainWindow.contentView.addChildView(view)
    return wireTab(view, tabOrdinalSeq++)
  }

  // The initial tab (ordinal 0) — always present.
  const firstTab = createTab()
  activeTabId = firstTab.id

  // Open a popup as a new tab: create it, make it active (on top), load the URL,
  // and tell the renderer the tab set changed. `openerTab` is the tab that
  // opened it — while recording we tag THAT tab's last click with `opensWindow`
  // (both as RECORDING-LOCAL windowIds) so replay/export know which action spawns
  // the popup.
  const openTabWith = (url: string, openerTab?: Tab): Tab => {
    const tab = createTab()
    activeTabId = tab.id
    hasNavigated = true
    loadUrlTolerantly(url, tab.view.webContents)
    resizeEmbedded()
    emitTabs()
    // Phase 4: hand the new tab to a waiting replay (one-shot), so it can bind it
    // to the opening step's `opensWindow` ordinal.
    if (onPopupOpened) {
      const notify = onPopupOpened
      onPopupOpened = null
      notify(tab)
    }
    if (isRecording && openerTab) {
      // Order matters: number the OPENER first so it always gets the lower id,
      // THEN the popup — otherwise a popup whose opener isn't numbered yet would
      // grab the smaller number ("tab 2 opens tab 1", backwards).
      const openerWindowId = recWindowIdOf(openerTab)
      const newWindowId = recWindowIdOf(tab)
      const last = lastInteractiveStepIdByTab.get(openerWindowId)
      if (last && Date.now() - last.at < 500) {
        // The opener click ALREADY arrived this same gesture — it's the opener;
        // patch it after the fact. Day 18: widened 250→500ms because the click
        // IPC can land that much before window.open under load, and the tighter
        // window was silently dropping the tag (orphan "tab N never opened").
        // `last` is the tab's MOST RECENT click, which for a popup is virtually
        // always the opener; and replay now recovers even if this still misses.
        mainWindow.webContents.send('recorder:step-patch', {
          id: last.id,
          opensWindow: newWindowId
        })
      } else {
        // The opener click hasn't landed yet (the usual case) — tag the NEXT
        // click for this tab inline when sendStep emits it.
        pendingOpenerByTab.set(openerWindowId, { ordinal: newWindowId, at: Date.now() })
      }
    }
    return tab
  }

  // Remove a tab from the strip. Never removes the last remaining tab (there is
  // always at least the original tab). If the closed tab was active, fall back
  // to the highest remaining ordinal. Idempotent (a self-close + our removal can
  // both fire). Closing the webContents is best-effort — it may already be gone.
  const closeTab = (tab: Tab): void => {
    const idx = tabs.findIndex((t) => t.id === tab.id)
    if (idx === -1 || tabs.length <= 1) return
    tabs.splice(idx, 1)
    try {
      mainWindow.contentView.removeChildView(tab.view)
    } catch {
      // view already detached — fine
    }
    // The webContents may ALREADY be destroyed (a self-closing popup, or app
    // teardown) — in which case even reading `.webContents` throws "Object has
    // been destroyed". Guard the whole access, not just the close() call.
    try {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    } catch {
      // already destroyed — nothing to close
    }
    if (activeTabId === tab.id) {
      activeTabId = tabs[tabs.length - 1].id
      try {
        mainWindow.contentView.addChildView(activeTab().view) // bring to top
        notifyUrlChange(activeWC().getURL())
      } catch {
        // the fallback tab is mid-teardown too — the UI refresh below copes
      }
    }
    resizeEmbedded()
    emitTabs()
  }

  // === Tab strip IPC (Day 17) ========================================
  // Make a given tab (by ordinal) the active, visible one.
  ipcMain.handle('browser:switchTab', (_event, ordinal: number) => {
    const tab = tabByOrdinal(ordinal)
    if (!tab) return
    activeTabId = tab.id
    mainWindow.contentView.addChildView(tab.view) // re-add = move to top z-order
    resizeEmbedded()
    notifyUrlChange(tab.view.webContents.getURL())
    emitTabs()
  })

  // Close a tab from the strip's ✕ (the original tab can't be closed).
  ipcMain.handle('browser:closeTab', (_event, ordinal: number) => {
    const tab = tabByOrdinal(ordinal)
    if (!tab) return
    // Day 18: a USER closing a tab via ✕ is a real action — record it (tagged
    // with that tab's recording-local windowId) so replay closes it too. Only
    // the explicit ✕ is recorded here; self-closing popups (page window.close)
    // come through the wc 'destroyed' handler and aren't recorded — replay
    // reproduces those naturally when the page closes itself.
    if (isRecording) {
      const wid = recWindowIdOf(tab)
      if (wid !== 0) sendStep({ type: 'closeTab' }, wid)
    }
    closeTab(tab)
  })

  // === Recording =====================================================
  // One door for steps: whether a step came from the observer (a click/type
  // inside the page) or from main itself (a navigation), it leaves through
  // here on its way to the React panel.
  // Day 17 (multiple windows): every emitted step gets a unique, increasing id
  // so a later `recorder:step-patch` (e.g. "this click opened tab 1") can target
  // the exact step after it was already sent to the renderer.
  let nextStepId = 1
  // Day 17 (multiple windows): correlating the click that opened a popup with the
  // popup, despite the two arriving on different channels at almost the same time.
  // The popup's window-open handler fires in-process; the opening click travels a
  // longer path (observer → relay preload → IPC), so it usually arrives AFTER.
  // Two maps cover both orderings:
  //  - lastInteractiveStepIdByTab: the most recent click/press per tab (+ when),
  //    for the rare case the click ALREADY arrived this same gesture (patch it).
  //  - pendingOpenerByTab: "the NEXT click in this tab opens tab N" — set when a
  //    popup opens before its click lands, so that click is tagged inline.
  const lastInteractiveStepIdByTab = new Map<number, { id: number; at: number }>()
  const pendingOpenerByTab = new Map<number, { ordinal: number; at: number }>()
  // `windowId` defaults to the active tab (for main-initiated steps like a URL
  // bar navigate); observer-sourced steps pass the SENDER's id explicitly.
  const sendStep = (step: Record<string, unknown>, windowId = recWindowIdOf(activeTab())): void => {
    const id = nextStepId++
    if (step.type === 'click' || step.type === 'press') {
      // If a popup was opened by (what we now know is) THIS click, tag it inline.
      const pending = pendingOpenerByTab.get(windowId)
      if (pending && Date.now() - pending.at < 2000) {
        step.opensWindow = pending.ordinal
        pendingOpenerByTab.delete(windowId)
      }
      lastInteractiveStepIdByTab.set(windowId, { id, at: Date.now() })
    }
    mainWindow.webContents.send('recorder:step', { id, windowId, ...step })
  }

  // Start/stop recording. Returns the new state so React stays in sync.
  // `resume` = continue an existing recording: we DON'T log a starting Go-to
  // step (the existing list already begins with one), we just append more.
  ipcMain.handle('recorder:toggle', (_event, resume?: boolean): boolean => {
    isRecording = !isRecording
    // Arm or disarm the observer in every live frame (top page + all iframes).
    reinjectAllFrames()
    // When a FRESH recording begins, start from a clean SINGLE tab (like a fresh
    // browser context — and symmetric with replay, which also resets to one
    // tab). Close any leftover popup tabs so old tabs can't pollute the
    // recording-local numbering, then reset it so this run starts at tab 0.
    // (Resume keeps the existing tabs + numbering.)
    if (isRecording && !resume) {
      for (const t of tabs.filter((t) => t.id !== activeTabId)) closeTab(t)
      recWindowIdByTabId.clear()
      lastInteractiveStepIdByTab.clear()
      pendingOpenerByTab.clear()
      nextRecWindowId = 0
      recWindowIdOf(activeTab()) // the tab we start in becomes windowId 0
      const url = activeWC().getURL()
      if (url && !url.startsWith('data:')) sendStep({ type: 'navigate', url })
    }
    // F1: capture network while recording (opt-in). Start on a fresh record;
    // stop + report the count when recording ends.
    if (isRecording) {
      if (harCaptureEnabled && !resume) {
        lastCapturedHar = null
        startHarCapture(activeWC())
      }
    } else if (harCapture) {
      const count = stopHarCapture()
      mainWindow.webContents.send('har:captured', { count })
    }
    return isRecording
  })

  // The observer reports a click/type/select with the RAW facts of the
  // element. Here we run those facts through the selector engine to build the
  // canonical step (a human label + a ranked selector ladder) before sending
  // it to React. We only forward while recording (the observer self-gates too).
  ipcMain.on(
    'recorder:event',
    (
      event,
      raw: {
        type: string
        facts: ElementFacts
        value?: string
        secret?: boolean
        key?: string
        // Day 15: which frame this fired in, baked in by the injected observer
        // (every event is relayed through the top frame, so we can't read it
        // from the IPC sender — it travels in the payload).
        frame?: { url: string; name?: string }[] | null
      }
    ) => {
      if (!isRecording) return
      const { primary, candidates } = buildSelectors(raw.facts)
      sendStep(
        {
          type: raw.type,
          label: labelFrom(raw.facts),
          value: raw.value,
          secret: raw.secret,
          key: raw.key,
          selector: primary,
          candidates,
          frame: raw.frame ?? undefined
        },
        recWindowIdOfWC(event.sender)
      )
    }
  )

  // Day 16: a native dialog (alert/confirm/prompt) the page tried to open. The
  // injected override auto-answered it; here we record it as a `dialog` step so
  // it replays/exports as a pre-armed dialog handler. The default answer is
  // accept (confirm) / the prompt's own default text — both editable after.
  ipcMain.on(
    'recorder:dialog',
    (
      event,
      raw: {
        kind: 'alert' | 'confirm' | 'prompt'
        message?: string
        value?: string
        accept?: boolean // confirm: what the user actually chose
      }
    ) => {
      if (!isRecording) return
      sendStep(
        {
          type: 'dialog',
          dialogKind: raw.kind,
          label: raw.message ?? '',
          value:
            raw.kind === 'confirm'
              ? raw.accept === false
                ? 'dismiss'
                : 'accept'
              : raw.kind === 'prompt'
                ? (raw.value ?? '')
                : undefined
        },
        recWindowIdOfWC(event.sender)
      )
    }
  )

  // Day 16(+): a picked upload file is COPIED into the library's _uploads folder
  // so the TEST owns its fixture. The step then points at our copy, not your
  // loose file — so replay never fails if you move or delete the original, and
  // export can ship the file alongside the spec. Returns the copy's absolute
  // path (or the original if the copy fails, so an upload is never lost).
  const uploadsDir = join(libraryDir(), '_uploads')
  mkdir(uploadsDir, { recursive: true }).catch(() => {})
  const copyIntoUploads = async (src: string): Promise<string> => {
    try {
      const dest = join(uploadsDir, basename(src))
      await copyFile(src, dest)
      return dest
    } catch {
      return src
    }
  }

  // Day 16: a file <input type=file> the user picked file(s) for. The relay
  // preload resolved the real disk path(s) via webUtils (the page world can't)
  // plus the input's identifying facts; build the selector with the normal
  // engine and record an `upload` step. value = the COPIED path(s), one per line
  // — replay sets them via CDP DOM.setFileInputFiles; export → .setInputFiles().
  ipcMain.on(
    'recorder:upload',
    async (event, raw: { facts: ElementFacts; paths: string[]; names?: string[] }) => {
      if (!isRecording) return
      const ordinal = recWindowIdOfWC(event.sender)
      const { primary, candidates } = buildSelectors(raw.facts)
      const stored: string[] = []
      for (const p of raw.paths ?? []) stored.push(await copyIntoUploads(p))
      sendStep(
        {
          type: 'upload',
          label: (raw.names ?? []).join(', ') || 'file',
          value: stored.join('\n'),
          selector: primary,
          candidates
        },
        ordinal
      )
    }
  )

  // Day 16(+): change an upload step's file. Show an OS open dialog, copy the
  // chosen file into _uploads (same as recording), and return the copy's path so
  // the renderer can swap it into the step. null = the user cancelled.
  ipcMain.handle('recorder:pickUploadFile', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a file to upload',
      properties: ['openFile']
    })
    if (result.canceled || !result.filePaths.length) return null
    return copyIntoUploads(result.filePaths[0])
  })

  // Day 17: saved sessions (storageState) — cookies + localStorage captured from
  // the logged-in browser, so a test can start already logged in. Stored as
  // Playwright-format storageState JSON in _sessions (the same format export
  // emits, and a real Playwright run consumes directly).
  const sessionsDir = join(libraryDir(), '_sessions')
  mkdir(sessionsDir, { recursive: true }).catch(() => {})

  interface PWStorageState {
    cookies: {
      name: string
      value: string
      domain: string
      path: string
      expires: number
      httpOnly: boolean
      secure: boolean
      sameSite: 'Strict' | 'Lax' | 'None'
    }[]
    origins: { origin: string; localStorage: { name: string; value: string }[] }[]
  }

  // Capture the active tab's current session (cookies + the current page's
  // localStorage) into a Playwright storageState file. Returns the file name.
  ipcMain.handle('session:save', async (_event, name: string): Promise<string | null> => {
    try {
      const wc = activeWC()
      const raw = await wc.session.cookies.get({})
      const cookies = raw.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain ?? '',
        path: c.path ?? '/',
        expires: c.expirationDate ?? -1,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        sameSite: (c.sameSite === 'no_restriction'
          ? 'None'
          : c.sameSite === 'strict'
            ? 'Strict'
            : 'Lax') as 'Strict' | 'Lax' | 'None'
      }))
      let origins: PWStorageState['origins'] = []
      let origin = ''
      try {
        origin = new URL(wc.getURL()).origin
      } catch {
        origin = ''
      }
      if (origin) {
        const lsJson = (await wc
          .executeJavaScript('JSON.stringify(Object.entries(window.localStorage))')
          .catch(() => '[]')) as string
        const entries = JSON.parse(lsJson) as [string, string][]
        if (entries.length) {
          origins = [{ origin, localStorage: entries.map(([n, v]) => ({ name: n, value: v })) }]
        }
      }
      const state: PWStorageState = { cookies, origins }
      const file = `${slugify(name)}.json`
      await writeFile(join(sessionsDir, file), JSON.stringify(state, null, 2), 'utf-8')
      return file
    } catch {
      return null
    }
  })

  ipcMain.handle('session:list', async (): Promise<string[]> => {
    try {
      const files = await readdir(sessionsDir)
      return files.filter((f) => f.endsWith('.json'))
    } catch {
      return []
    }
  })

  // Seed a saved session into the browser before a replay so it starts logged in.
  // Cookies are set up front (they apply pre-navigation). localStorage is handed
  // back to the caller to inject after the first navigation reaches its origin
  // (localStorage is per-origin and needs the page loaded there first).
  const seedSession = async (
    wc: Electron.WebContents,
    file: string
  ): Promise<PWStorageState['origins']> => {
    try {
      const raw = await readFile(join(sessionsDir, file), 'utf-8')
      const state = JSON.parse(raw) as PWStorageState
      for (const c of state.cookies ?? []) {
        const host = (c.domain || '').replace(/^\./, '')
        if (!host) continue
        // Use HTTPS for the url (modern sites are https; a non-secure cookie set
        // via an https url is still valid and sent to https requests). Set it as
        // a HOST cookie (no `domain` field) — passing `domain` makes Electron
        // normalize it to ".host" (a domain cookie), which some apps' js-cookie
        // reads differ on; a host cookie matches exactly what the site set.
        const url = `https://${host}${c.path || '/'}`
        const isDomainCookie = (c.domain || '').startsWith('.')
        try {
          // Seed as a SESSION cookie (no expirationDate). The original cookie's
          // expiry may already have passed between saving the session and this
          // replay (many auth cookies are short-lived) — and setting an expired
          // cookie silently fails to persist. The seeded auth only needs to last
          // THIS replay, so a session cookie is both correct and bulletproof.
          await wc.session.cookies.set({
            url,
            name: c.name,
            value: c.value,
            ...(isDomainCookie ? { domain: c.domain } : {}),
            path: c.path || '/',
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite:
              c.sameSite === 'None' ? 'no_restriction' : c.sameSite === 'Strict' ? 'strict' : 'lax'
          })
        } catch {
          // a single bad cookie shouldn't abort the whole seed
        }
      }
      return state.origins ?? []
    } catch {
      return []
    }
  }

  // Day 17(+): SEED a saved session into the LIVE browser (not just replay), so
  // RECORDING a new test can start already logged in — no re-typing the password.
  // Mirrors the replay seed dance: clear → set cookies → navigate to the origin →
  // inject that origin's localStorage → reload. Returns the URL now showing.
  ipcMain.handle(
    'session:apply',
    async (
      _event,
      file: string,
      wantUrl?: string
    ): Promise<{ ok: boolean; url?: string; error?: string }> => {
      try {
        const wc = activeWC()
        // Start from a clean slate, like a real fresh login would.
        try {
          await wc.session.clearStorageData({ storages: ['cookies', 'localstorage'] })
        } catch {
          // best-effort
        }
        // clearStorageData resolves BEFORE the wipe settles — wait for the cookie
        // store to actually empty so the seed we set next isn't erased by it.
        for (let i = 0; i < 40; i++) {
          try {
            if ((await wc.session.cookies.get({})).length === 0) break
          } catch {
            break
          }
          await wait(50)
        }
        const seedOrigins = await seedSession(wc, file)
        // Where to open: the URL the user typed (so a site like SauceDemo, whose
        // ROOT is always the login page, can open a POST-login page like
        // /inventory.html directly — the cookie is already seeded), else the
        // session's localStorage origin, else a cookie's domain.
        let target = ''
        if (wantUrl && wantUrl.trim()) {
          const t = wantUrl.trim()
          target = /^https?:\/\//i.test(t) ? t : `https://${t}`
        }
        if (!target) target = seedOrigins[0]?.origin ?? ''
        if (!target) {
          const cookies = await wc.session.cookies.get({}).catch(() => [])
          const dom = cookies.map((c) => (c.domain || '').replace(/^\./, '')).find(Boolean)
          if (dom) target = `https://${dom}`
        }
        if (!target) return { ok: false, error: 'This session has no site to open.' }
        overlayOpen = false
        hasNavigated = true
        await loadUrlTolerantly(target, wc)
        resizeEmbedded() // unhide the embedded browser
        // Wait for the page so the localStorage seed lands on a live document.
        const deadline = Date.now() + 8000
        while (wc.isLoading() && Date.now() < deadline) await wait(100)
        // localStorage is per-origin — inject it now the page is at its origin,
        // then reload so the app reads it (exactly what replay does on first nav).
        let origin = ''
        try {
          origin = new URL(wc.getURL()).origin
        } catch {
          origin = ''
        }
        const match = seedOrigins.find((o) => o.origin === origin)
        if (match && match.localStorage.length) {
          const setLs = match.localStorage
            .map(
              (e) =>
                `window.localStorage.setItem(${JSON.stringify(e.name)},${JSON.stringify(e.value)});`
            )
            .join('')
          await wc.executeJavaScript(`(()=>{try{${setLs}}catch(e){}})()`).catch(() => {})
          await wc.loadURL(wc.getURL()).catch(() => {})
          while (wc.isLoading() && Date.now() < deadline) await wait(100)
        }
        notifyUrlChange(wc.getURL())
        return { ok: true, url: wc.getURL() }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // Day 16: downloads — auto-save to a known folder so a download never stalls
  // a run behind a native "Save as" dialog. Recorded as a `download` step for
  // visibility; on replay the file simply re-downloads to the same folder.
  const downloadsDir = join(libraryDir(), '_downloads')
  mkdir(downloadsDir, { recursive: true }).catch(() => {})
  // Day 16(+): downloads finished during a REPLAY, in order — a `download` step
  // consumes the next one to assert it arrived and isn't empty (see the replay
  // loop). Reset at the start of each replay.
  let isReplaying = false
  let replayDownloads: { name: string; path: string; bytes: number; completed: boolean }[] = []
  let replayDownloadCursor = 0
  // The session is shared across all tabs (same default session), so this is a
  // single registration that catches downloads from ANY tab.
  firstTab.view.webContents.session.on('will-download', (_event, item, webContents) => {
    const savePath = join(downloadsDir, item.getFilename())
    try {
      item.setSavePath(savePath)
    } catch {
      // setSavePath rejected (called too late) — let Electron handle it
    }
    const name = item.getFilename()
    // Day 16(+): announce the START immediately so big files (exe/png) give
    // instant feedback instead of a silent gap until the transfer finishes.
    mainWindow.webContents.send('recorder:download-start', { name })
    // When the transfer finishes, surface a confirmation toast (record AND
    // replay) and, during replay, queue it for the matching `download` step.
    item.once('done', (_e, state) => {
      const bytes = item.getReceivedBytes()
      const completed = state === 'completed'
      mainWindow.webContents.send('recorder:download-done', {
        name,
        path: savePath,
        bytes,
        completed
      })
      if (isReplaying) replayDownloads.push({ name, path: savePath, bytes, completed })
    })
    // Day 16(+): keep the saved path on the step (for "Show in folder" + the
    // on-replay file check). `value` holds the EXPECTED filename to verify —
    // defaults to the recorded name, editable via the step's ✎.
    if (isRecording) {
      sendStep(
        { type: 'download', label: name, value: name, downloadPath: savePath },
        webContents ? recWindowIdOfWC(webContents) : recWindowIdOf(activeTab())
      )
    }
  })

  // (Popup handling + per-frame observer injection now live in wireTab, so every
  // tab — the original and any future popup tab — is wired identically.)

  // === Element picker (Day 9) ========================================
  // The renderer turns pick mode on/off; the observer in the page does the
  // pointing. A picked element comes back as raw facts — run them through the
  // selector engine (same as recorded steps) before handing to the UI.
  ipcMain.handle('recorder:setPicking', (_event, active: boolean) => {
    isPicking = active
    reinjectAllFrames()
  })

  ipcMain.on(
    'recorder:picked',
    (
      _event,
      raw: {
        facts: ElementFacts
        text?: string
        inputValue?: string
        disabled?: boolean
        checked?: boolean
        // Day 15: baked-in frame of the picked element (see recorder:event).
        frame?: { url: string; name?: string }[] | null
      }
    ) => {
      // A completed pick ENDS pick mode. The page's own observer already flips
      // its local `picking` off when it captures the click, but main must reset
      // its flag too — otherwise the next observer re-injection (e.g. the
      // navigate at the start of a replay) bakes in a stale picking=true and the
      // page comes back up in pick mode, painting the blue highlight mid-replay.
      isPicking = false
      const { primary, candidates } = buildSelectors(raw.facts)
      // For 'count' checks: how many elements the primary strategy matched.
      // The observer already counted duplicates at pick time (Day 10b) — dup
      // info is only recorded when count > 1, so its absence means unique.
      const prim = candidates.find((c) => c.locator === primary)
      const groupCount = prim && prim.kind !== 'css' ? (raw.facts.dup?.[prim.kind]?.count ?? 1) : 1
      // Day 12: a bare element (no id/role/text/etc) yields ONLY the bare-tag
      // last resort — which replay refuses to act on (Day 10's honest-refusal
      // rule). Flag it so the UI can warn at PICK time, not fail at replay time.
      const unreliable = !candidates.some((c) => c.kind !== 'css')
      mainWindow.webContents.send('recorder:picked', {
        unreliable,
        label: labelFrom(raw.facts),
        selector: primary,
        candidates,
        text: raw.text,
        inputValue: raw.inputValue,
        disabled: raw.disabled,
        checked: raw.checked,
        groupCount,
        // Day 15: if the picked element is inside an iframe, the assertion (or
        // recovery heal) built from it must replay in — and export for — that frame.
        frame: raw.frame ?? undefined
      })
    }
  )

  ipcMain.on('recorder:pick-cancel', () => {
    mainWindow.webContents.send('recorder:pick-cancel')
  })

  // === Recovery (Day 12) =============================================
  // When an INTERACTIVE replay fails a step, the loop below pauses and waits
  // for the human's decision instead of returning. The pending pause is held
  // as a promise; this resolver is how the answer (retry/skip/stop) gets in.
  // 'abort' is the silent variant: Home was pressed, end with nothing to show.
  interface RecoveryDecision {
    action: 'retry' | 'continue' | 'skip' | 'stop' | 'abort'
    step?: ReplayStep // a re-pick sends the healed step to retry with
  }
  let recoveryResolve: ((decision: RecoveryDecision) => void) | null = null
  const resolveRecovery = (decision: RecoveryDecision): void => {
    const pending = recoveryResolve
    recoveryResolve = null
    pending?.(decision)
  }
  ipcMain.on('recorder:recovery', (_event, decision: RecoveryDecision) => resolveRecovery(decision))

  // F30: a manual (wait-for-human) step pauses replay here; the renderer's
  // "▶ Continue" resolves this so the run resumes where it left off.
  let manualResolve: (() => void) | null = null
  ipcMain.on('recorder:manual-continue', () => {
    const pending = manualResolve
    manualResolve = null
    pending?.()
  })

  // === Replay ========================================================
  // Run the recorded steps one-by-one inside the embedded browser. We report
  // progress per step so React can highlight the current/failed step. A plain
  // replay stops at the first failure; an `interactive` one (single Replay
  // button, Day 12) pauses there and offers Retry / Re-pick / Skip / Stop.
  ipcMain.handle(
    'recorder:replay',
    async (
      _event,
      steps: ReplayStep[],
      interactive?: boolean,
      storageState?: string,
      traceOpts?: { mode: 'always' | 'failure' | 'off'; stepTexts?: string[]; testName?: string },
      // F1: serve responses from this HAR. A test's saved `har` filename, or the
      // sentinel '__last' to use the just-captured (unsaved) HAR. Absent = live.
      harFile?: string,
      // F29 (chaos): replay under adverse conditions to test resilience / surface
      // timing flakiness. `slowNetwork` throttles via CDP emulateNetworkConditions
      // (the STABLE path — unlike F1's Fetch interception which crashed the view).
      chaos?: { slowNetwork?: boolean }
    ): Promise<{
      ok: boolean
      failedAt?: number
      error?: string
      traceId?: string
      screenshotPath?: string
      aborted?: boolean
      consoleErrors?: string[]
      networkErrors?: string[]
      // Day 20: EVERY failed step in this run (not just the first) — so the
      // banner can surface each one's screenshot when Continue bypassed several.
      failures?: { index: number; error: string; screenshotPath?: string }[]
      // F1: how many requests were served from the HAR vs passed through live.
      harServed?: number
      harPassthrough?: number
    }> => {
      // A dangling pause from a previous replay can never be answered — clear it.
      resolveRecovery({ action: 'abort' })
      overlayOpen = false // make sure the browser is visible while replaying

      // Day 17 (Phase 4): a replay can span MULTIPLE tabs. Start from a clean
      // SINGLE tab (test isolation, symmetric with a fresh recording): close any
      // leftover popup tabs, keep one as the recording-local windowId 0. Popups
      // opened during the run bind their ordinal as they appear.
      const baseTab = activeTab()
      for (const t of tabs.filter((t) => t.id !== baseTab.id)) closeTab(t)
      activeTabId = baseTab.id
      resizeEmbedded()
      const ordinalToTab = new Map<number, Tab>([[0, baseTab]])
      // The tab the CURRENT step runs in — repointed per step by switchTo().
      let currentWC = baseTab.view.webContents

      // Test isolation: start EVERY replay from a clean state (fresh cookies +
      // localStorage), exactly like a real Playwright test gets a fresh browser
      // context. Without this, leftover state — e.g. an item already in the cart
      // from the recording session — breaks the replay ("Add to cart" is gone).
      try {
        await currentWC.session.clearStorageData({
          storages: ['cookies', 'localstorage']
        })
      } catch {
        // best-effort; continue even if clearing isn't supported
      }
      // Electron resolves clearStorageData's promise BEFORE the async wipe
      // actually finishes — so a cookie set right after gets erased by the
      // still-pending clear. When we're about to SEED a session, wait for the
      // clear to truly settle (cookie store actually empty) before seeding.
      if (storageState) {
        for (let i = 0; i < 40; i++) {
          try {
            if ((await currentWC.session.cookies.get({})).length === 0) break
          } catch {
            break
          }
          await wait(50)
        }
      }

      // Day 17: if the test has a saved session, seed it AFTER clearing — cookies
      // now, localStorage after the first navigate reaches its origin (it's
      // per-origin and needs the page loaded there). So the run starts logged in.
      let seedOrigins: { origin: string; localStorage: { name: string; value: string }[] }[] = []
      let localStorageSeeded = false
      if (storageState) {
        // Seed, then VERIFY the cookies landed; re-seed once if the wipe still
        // raced us (belt-and-suspenders against the clearStorageData timing).
        seedOrigins = await seedSession(currentWC, storageState)
        try {
          if ((await currentWC.session.cookies.get({})).length === 0) {
            await wait(100)
            seedOrigins = await seedSession(currentWC, storageState)
          }
        } catch {
          // verification is best-effort
        }
      }

      // === Failure evidence capture (Day 13) ==========================
      // While the replay runs, quietly collect what a human debugging the
      // failure would open DevTools for: the page's own JavaScript errors
      // (console) and requests that failed or came back 4xx/5xx (network).
      // Every line is tagged with the step that was running at the time, so
      // the translator can tell fresh evidence from old noise. Capped — a
      // page stuck in an error loop must not grow an unbounded array.
      const consoleErrors: string[] = []
      const networkErrors: string[] = []
      let evidenceStep = 0 // index of the step currently running
      const addEvidence = (arr: string[], line: string): void => {
        if (arr.length < 30) arr.push(`[step ${evidenceStep + 1}] ${line}`)
      }

      // F1 (HAR replay): load the archive to serve from (if any) and tally what
      // gets served vs passed through to the live network.
      //
      // SAFETY GATE: serving responses via the CDP Fetch domain on the embedded
      // WebContentsView proved unstable (it hung/crashed the browser process on
      // Replay) and could not be reliably reproduced or verified outside the
      // real app. Until it's stabilised on real hardware, in-app serving is OFF
      // — capture + save (a valid .har) still work; deterministic replay is
      // deferred (see the exported Playwright routeFromHAR path instead). Normal
      // no-HAR replay is unaffected (everything below is gated on replayHar).
      const HAR_SERVE_IN_APP: boolean = false
      const replayHar: HarLog | null = !HAR_SERVE_IN_APP
        ? null
        : harFile === '__last'
          ? lastCapturedHar
          : harFile
            ? ((await loadHar(harFile)) as HarLog | null)
            : null
      let harServed = 0
      let harPassthrough = 0

      // === Run trace capture (Day 18) ==================================
      // When tracing is on, snapshot each step (screenshot + thumbnail + DOM +
      // that step's console/network) into memory, keyed by index so a recovery
      // retry overwrites rather than duplicates. We persist the bundle in
      // finish() only if the policy says so (always, or — like Playwright's
      // retain-on-failure — only when the run failed).
      const traceMode = traceOpts?.mode ?? 'off'
      const traceEnabled = traceMode !== 'off'
      // One stable id for the whole run, so a trace saved at the failure PAUSE
      // and re-saved at the end (after retries) lands in the same folder.
      const traceRunId = traceEnabled ? `trace-${Date.now()}` : ''
      let tracePersisted = false
      const traceStepMap = new Map<number, TraceStepRecord>()
      const traceAssets = new Map<string, Buffer>() // filename -> bytes (overwrite-safe)
      const stripStepTag = (line: string): string => line.replace(/^\[step \d+\]\s*/, '')
      // Console/network for a step = the lines that appeared while it ran. We
      // remember each array's length at the step's start and slice the rest.
      let traceConsoleCursor = 0
      let traceNetworkCursor = 0
      const captureTraceStep = async (
        i: number,
        status: 'done' | 'error' | 'skipped',
        startMs: number,
        error?: string,
        // Day 18: for a failure step, reuse the ANNOTATED capture (red banner +
        // outline) so the trace shows WHERE it failed, not a clean page.
        preImage?: Electron.NativeImage
      ): Promise<void> => {
        if (!traceEnabled) return
        const num = i + 1
        const rec: TraceStepRecord = {
          index: i,
          type: list[i]?.type ?? 'step',
          text: traceOpts?.stepTexts?.[i] ?? list[i]?.type ?? `Step ${num}`,
          status,
          durationMs: Math.max(0, Date.now() - startMs),
          error,
          consoleErrors: consoleErrors.slice(traceConsoleCursor).map(stripStepTag),
          networkErrors: networkErrors.slice(traceNetworkCursor).map(stripStepTag)
        }
        // Skipped steps never ran — record the row, but no page shot.
        if (status !== 'skipped') {
          try {
            rec.url = currentWC.getURL()
          } catch {
            // url unavailable — fine
          }
          try {
            const image = preImage ?? (await currentWC.capturePage())
            rec.screenshotFile = `step-${num}.png`
            traceAssets.set(rec.screenshotFile, image.toPNG())
            rec.thumbFile = `thumb-${num}.png`
            traceAssets.set(rec.thumbFile, image.resize({ width: 240 }).toPNG())
          } catch {
            // capture can fail if the page is gone — keep the row without a shot
          }
          try {
            const html = await currentWC.executeJavaScript(
              'document.documentElement.outerHTML',
              true
            )
            if (typeof html === 'string') {
              // Raw outerHTML has no base, so its relative CSS/img/script paths
              // 404 and the snapshot renders broken. Inject a <base href> (the
              // page's URL) so those resolve against the real site, and a
              // doctype so the browser renders in standards mode.
              const baseTag = rec.url ? `<base href="${rec.url.replace(/"/g, '%22')}">` : ''
              const withBase = baseTag
                ? /<head[^>]*>/i.test(html)
                  ? html.replace(/<head[^>]*>/i, (m) => `${m}${baseTag}`)
                  : `<head>${baseTag}</head>${html}`
                : html
              rec.domFile = `step-${num}.html`
              traceAssets.set(rec.domFile, Buffer.from(`<!DOCTYPE html>\n${withBase}`, 'utf-8'))
            }
          } catch {
            // DOM snapshot is best-effort
          }
        }
        traceStepMap.set(i, rec)
      }

      // Write the trace bundle so far to its (stable) run folder — called at the
      // failure pause (so the recovery panel can open it) and again at the end.
      // Best-effort: a trace problem must never change the run result.
      const persistTrace = async (ok: boolean, failedAt?: number): Promise<void> => {
        if (!traceEnabled || !traceStepMap.size) return
        try {
          // Walk EVERY step in order so the viewer shows the whole test:
          //  - captured steps (done / error) as recorded;
          //  - a DISABLED step (skipped during recovery, OR turned off in the
          //    editor and skipped on a fresh replay) shown as 'skipped' — with
          //    its failure screenshot if we have one, otherwise no shot;
          //  - a step we never reached (run stopped earlier): a 'pending' row.
          const orderedSteps: TraceStepRecord[] = []
          for (let idx = 0; idx < list.length; idx++) {
            const captured = traceStepMap.get(idx)
            const stepText = traceOpts?.stepTexts?.[idx] ?? list[idx].type
            if (list[idx].disabled) {
              orderedSteps.push(
                captured ?? {
                  index: idx,
                  type: list[idx].type,
                  text: stepText,
                  status: 'skipped',
                  durationMs: 0,
                  consoleErrors: [],
                  networkErrors: []
                }
              )
              continue
            }
            orderedSteps.push(
              captured ?? {
                index: idx,
                type: list[idx].type,
                text: stepText,
                status: 'pending',
                durationMs: 0,
                consoleErrors: [],
                networkErrors: []
              }
            )
          }
          const manifest: TraceManifest = {
            id: traceRunId,
            testName: traceOpts?.testName,
            at: new Date().toISOString(),
            ok,
            failedAt,
            stepCount: orderedSteps.length,
            steps: orderedSteps
          }
          await saveTrace(
            manifest,
            [...traceAssets.entries()].map(([file, data]) => ({ file, data }))
          )
          tracePersisted = true
        } catch {
          // ignore — tracing never breaks a run
        }
      }

      // F4 (self-heal 2.0): a broken step can heal ONLY if it targets a named
      // element (click/type/select/press/hover/assert) — navigate/wait/back/
      // dialog/file/a11y/perf steps have no element to re-find. Shared by the
      // green-run fingerprint capture AND the heal orchestrator (both below).
      const canHeal = (step: ReplayStep): boolean =>
        !!(step as { label?: string }).label &&
        step.type !== 'navigate' &&
        step.type !== 'wait' &&
        step.type !== 'back' &&
        step.type !== 'dialog' &&
        step.type !== 'download' &&
        step.type !== 'upload' &&
        step.type !== 'closeTab' &&
        step.type !== 'snapshot' &&
        step.type !== 'a11y' &&
        step.type !== 'perf'

      // Electron 32+ delivers the console params on the event object
      // (level is a string: 'error' | 'warning' | …); older versions used
      // positional args with numeric levels. Accept both shapes.
      const onConsoleMessage = (
        event: unknown,
        legacyLevel?: unknown,
        legacyMessage?: unknown
      ): void => {
        const e = event as { level?: unknown; message?: unknown }
        const level = typeof e?.level === 'string' ? e.level : legacyLevel === 3 ? 'error' : ''
        if (level !== 'error') return
        const message = typeof e?.message === 'string' ? e.message : String(legacyMessage ?? '')
        if (message) addEvidence(consoleErrors, message.slice(0, 300))
      }

      // Network watch rides the SAME CDP debugger the hover support attaches
      // (best-effort: no CDP, no network evidence — never a failed replay).
      // loadingFailed needs the request's URL, which only requestWillBeSent
      // carries — so we remember requestId → url as requests start.
      const requestUrls = new Map<string, string>()
      const trimUrl = (u: string): string => (u.length > 120 ? u.slice(0, 120) + '…' : u)
      // F3 (smart waits): live count of in-flight network requests + the last
      // time anything happened, so a `wait for network idle` step can wait until
      // the page truly goes quiet instead of guessing a fixed sleep.
      let inFlight = 0
      let lastNetworkActivity = Date.now()

      // Day 13 noise tagging: pages talk to OTHER companies' servers too
      // (analytics, crash reporters) and those fail constantly on real sites.
      // Mark every captured request as [site] (the site under test) or
      // [third-party] (someone else's server) — a FACT, not a judgment, so
      // nothing is ever hidden; readers and the AI just see whose server it was.
      // "Site" = the registrable domain, approximated as the host's last two
      // labels (three when the middle one is a registrar label like co.uk's
      // "co") — www.saucedemo.com and api.saucedemo.com both → saucedemo.com.
      const GENERIC_SLD = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu'])
      const siteOf = (url: string): string => {
        try {
          const labels = new URL(url).hostname.split('.')
          if (labels.length <= 2) return labels.join('.')
          const take = GENERIC_SLD.has(labels[labels.length - 2]) ? 3 : 2
          return labels.slice(-take).join('.')
        } catch {
          return ''
        }
      }
      const relationTag = (requestUrl: string): string => {
        const page = siteOf(currentWC.getURL())
        const req = siteOf(requestUrl)
        if (!page || !req) return ''
        return req === page ? '[site] ' : '[third-party] '
      }
      const onCdpMessage = (_e: unknown, method: string, params: Record<string, unknown>): void => {
        if (method === 'Network.requestWillBeSent') {
          inFlight++
          lastNetworkActivity = Date.now()
          const req = params.request as { url?: string } | undefined
          if (typeof params.requestId === 'string' && req?.url)
            requestUrls.set(params.requestId, req.url)
        } else if (method === 'Network.responseReceived') {
          lastNetworkActivity = Date.now()
          const res = params.response as { status?: number; url?: string } | undefined
          if (res?.status && res.status >= 400) {
            const url = res.url ?? ''
            addEvidence(networkErrors, `${relationTag(url)}HTTP ${res.status} on ${trimUrl(url)}`)
          }
        } else if (method === 'Network.loadingFinished') {
          if (inFlight > 0) inFlight--
          lastNetworkActivity = Date.now()
        } else if (method === 'Network.loadingFailed') {
          if (inFlight > 0) inFlight--
          lastNetworkActivity = Date.now()
          // canceled / ERR_ABORTED = a request superseded by navigation —
          // normal browsing noise, not evidence (same call as loadUrlTolerantly).
          const errorText = String(params.errorText ?? '')
          if (params.canceled || !errorText || errorText.includes('ERR_ABORTED')) return
          const url = requestUrls.get(String(params.requestId)) ?? ''
          addEvidence(networkErrors, `${relationTag(url)}${errorText} on ${trimUrl(url)}`)
        }
      }
      // F3: wait until the page has made no network requests for `idleMs`, or
      // give up after `timeoutMs` (long-poll / websockets never idle — that's
      // fine, we proceed). Best-effort: never throws.
      const waitForNetworkIdle = async (idleMs = 500, timeoutMs = 15000): Promise<void> => {
        const start = Date.now()
        for (;;) {
          if (inFlight <= 0 && Date.now() - lastNetworkActivity >= idleMs) return
          if (Date.now() - start > timeoutMs) return
          await wait(60)
        }
      }
      // F3: wait until `text` appears anywhere on the current page. Throws if it
      // never shows within the timeout — a text that never arrives is a real
      // problem worth surfacing (an implicit "the content loaded" check).
      const waitForText = async (text: string, timeoutMs = 15000): Promise<void> => {
        if (!text) return
        const needle = JSON.stringify(text)
        const start = Date.now()
        for (;;) {
          const found = await currentWC
            .executeJavaScript(`!!(document.body && document.body.innerText.includes(${needle}))`)
            .catch(() => false)
          if (found) return
          if (Date.now() - start > timeoutMs) {
            throw new Error(`Wait: text ${needle} never appeared (waited ${timeoutMs / 1000}s)`)
          }
          await wait(150)
        }
      }
      // Each tab a replay touches needs its OWN CDP debugger (hover / upload /
      // network) and console listener. Attach lazily on first visit; detach all
      // in finish(). `cdp`/`cdpReady` always point at the CURRENT tab's debugger.
      const attached = new Map<
        number,
        {
          wc: Electron.WebContents
          cdp: Electron.Debugger
          ready: boolean
          // F1: the per-debugger Fetch interceptor, kept so finish() can detach it.
          fetchListener?: CdpListener
        }
      >()
      let cdp: Electron.Debugger = currentWC.debugger
      let cdpReady = false
      const attachTo = (
        wcToAttach: Electron.WebContents
      ): { cdp: Electron.Debugger; ready: boolean } => {
        let rec = attached.get(wcToAttach.id)
        if (!rec) {
          wcToAttach.on('console-message', onConsoleMessage)
          const d = wcToAttach.debugger
          let ready = false
          try {
            if (!d.isAttached()) d.attach('1.3')
            ready = true
          } catch {
            // attach can fail (e.g. DevTools already attached) — fall back to
            // sendInputEvent for hover; no CDP means no network evidence here.
          }
          let fetchListener: CdpListener | undefined
          if (ready) {
            d.on('message', onCdpMessage)
            d.sendCommand('Network.enable').catch(() => {
              // network domain unavailable — console evidence still works
            })
            // F29 (chaos): throttle this tab to a "Slow 3G" profile so the run
            // exercises the app + test under adverse conditions. These are Chrome
            // DevTools' Slow-3G values — a real slow-network condition AND clearly
            // noticeable (each request gets +2s of latency). Stable CDP command
            // (no request interception). Best-effort.
            if (chaos?.slowNetwork) {
              // Disable the cache first — otherwise re-navigations are served from
              // cache and the network throttle has nothing to slow.
              d.sendCommand('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {})
              d.sendCommand('Network.emulateNetworkConditions', {
                offline: false,
                latency: 2000, // ~2s round-trip per request (Chrome's Slow 3G)
                downloadThroughput: (400 * 1024) / 8, // ~400 kbps
                uploadThroughput: (400 * 1024) / 8
              }).catch(() => {})
            }
            // F1: with a HAR loaded, intercept the API calls (XHR/fetch) and
            // serve the saved response when we have one; otherwise let it hit the
            // live network (augment mode). We deliberately DON'T intercept the
            // page navigation or static assets — fulfilling a top-level
            // navigation through the debugger on a WebContentsView crashes the
            // native browser process, and the API responses are what kill flake
            // anyway. Every paused request MUST be fulfilled or continued or the
            // page hangs — so any error falls back to continueRequest.
            if (replayHar && replayHar.log?.entries?.length) {
              const onFetch = (
                _e: unknown,
                method: string,
                params: Record<string, unknown>
              ): void => {
                if (method !== 'Fetch.requestPaused') return
                const requestId = String(params.requestId)
                const req = params.request as { url?: string; method?: string } | undefined
                const passThrough = (): void => {
                  d.sendCommand('Fetch.continueRequest', { requestId })
                    .then(() => {
                      harPassthrough++
                    })
                    .catch(() => {})
                }
                const entry = req?.url
                  ? matchEntry(replayHar.log.entries, req.method ?? 'GET', req.url)
                  : null
                if (!entry) return passThrough()
                d.sendCommand('Fetch.fulfillRequest', {
                  requestId,
                  responseCode: entry.response.status,
                  responseHeaders: serveHeaders(entry).map((h) => ({
                    name: h.name,
                    value: h.value
                  })),
                  body: entryBodyBase64(entry)
                })
                  .then(() => {
                    harServed++
                  })
                  .catch(passThrough)
              }
              d.on('message', onFetch)
              fetchListener = onFetch
              // Only XHR + fetch are paused; navigations and assets flow through
              // untouched (see the crash note above).
              d.sendCommand('Fetch.enable', {
                patterns: [
                  { urlPattern: '*', resourceType: 'XHR', requestStage: 'Request' },
                  { urlPattern: '*', resourceType: 'Fetch', requestStage: 'Request' }
                ]
              }).catch(() => {})
            }
          }
          rec = { wc: wcToAttach, cdp: d, ready, fetchListener }
          attached.set(wcToAttach.id, rec)
        }
        return rec
      }

      // Make the tab for a recording-local windowId the active/current target,
      // attaching its debugger. Returns false if that tab was never opened.
      const switchTo = (windowId: number): boolean => {
        const tab = ordinalToTab.get(windowId)
        if (!tab) return false
        if (tab.view.webContents !== currentWC) {
          activeTabId = tab.id
          mainWindow.contentView.addChildView(tab.view) // bring to top
          resizeEmbedded()
          currentWC = tab.view.webContents
        }
        const rec = attachTo(currentWC)
        cdp = rec.cdp
        cdpReady = rec.ready
        return true
      }

      // Day 18 (multi-tab hardening): a step says it runs in tab N, but N was
      // never bound to a tab. The usual cause is a DROPPED opener tag — at
      // record time the click that spawned the popup didn't get its
      // `opensWindow` set (a known click-vs-window.open timing race), so replay
      // never armed a wait for that popup. But the popup STILL opened during
      // replay (the click ran window.open → wireTab's handler created a real
      // tab) — it's just unbound. Recover by adopting the most recent live tab
      // that isn't the base and isn't already mapped, binding it to N. Polls
      // briefly since the popup opens asynchronously after the opener click.
      const adoptUnboundPopup = async (windowId: number): Promise<boolean> => {
        const deadline = Date.now() + 4000
        for (;;) {
          const bound = new Set(ordinalToTab.values())
          const candidate = tabs
            .filter(
              (t) => t.id !== baseTab.id && !bound.has(t) && !t.view.webContents.isDestroyed()
            )
            .sort((a, b) => b.ordinal - a.ordinal)[0]
          if (candidate) {
            ordinalToTab.set(windowId, candidate)
            const adoptedWC = candidate.view.webContents
            attachTo(adoptedWC)
            const loadDeadline = Date.now() + 8000
            while (adoptedWC.isLoading() && Date.now() < loadDeadline) await wait(100)
            return true
          }
          if (Date.now() > deadline) return false
          await wait(100)
        }
      }
      switchTo(0) // attach the starting tab

      // Every exit from the replay goes through here so the CDP debugger is
      // always released, pass or fail.
      const finish = async (outcome: {
        ok: boolean
        failedAt?: number
        error?: string
        screenshotPath?: string
        aborted?: boolean
        consoleErrors?: string[]
        networkErrors?: string[]
        traceId?: string
        failures?: { index: number; error: string; screenshotPath?: string }[]
        harServed?: number
        harPassthrough?: number
        whatChanged?: DomDiff
        category?: FailureCategory
        aiHealed?: number
        healable?: { index: number; label: string; signals: string[]; score: number; step: ReplayStep }
      }): Promise<{
        ok: boolean
        failedAt?: number
        error?: string
        screenshotPath?: string
        aborted?: boolean
        consoleErrors?: string[]
        networkErrors?: string[]
        traceId?: string
        failures?: { index: number; error: string; screenshotPath?: string }[]
        harServed?: number
        harPassthrough?: number
        whatChanged?: DomDiff
        category?: FailureCategory
        aiHealed?: number
        healable?: { index: number; label: string; signals: string[]; score: number; step: ReplayStep }
      }> => {
        // Detach EVERY tab we touched (console + CDP), and clear the replay flag
        // in each so normal browsing gets its real native dialogs back.
        onPopupOpened = null // drop any unfired one-shot popup hook
        for (const rec of attached.values()) {
          try {
            rec.wc.removeListener('console-message', onConsoleMessage)
          } catch {
            // listener already gone — fine
          }
          if (rec.ready) {
            try {
              rec.cdp.removeListener('message', onCdpMessage)
              if (rec.fetchListener) rec.cdp.removeListener('message', rec.fetchListener)
              rec.cdp.detach()
            } catch {
              // already detached — fine
            }
          }
          if (!rec.wc.isDestroyed()) {
            rec.wc
              .executeJavaScript('window.__qaflowReplaying=false;window.__qaflowNextDialog=null;')
              .catch(() => {})
          }
        }
        isReplaying = false
        // Day 18: keep the trace per the policy — always, or (retain-on-failure)
        // only when the run failed. An aborted run (Home mid-pause) is moot, so
        // skip it.
        if (traceEnabled && !outcome.aborted) {
          if (traceMode === 'always' || !outcome.ok) {
            await persistTrace(outcome.ok, outcome.failedAt) // overwrite final state
            if (tracePersisted) {
              outcome.traceId = traceRunId
              await pruneTraces()
            }
          } else if (tracePersisted) {
            // Policy is on-failure but the run RECOVERED to a pass (retry/skip) —
            // discard the trace we saved at the pause.
            await deleteTrace(traceRunId)
          }
        }
        // F1: report HAR usage when a HAR was in play (drives the run readout).
        if (replayHar) {
          outcome.harServed = harServed
          outcome.harPassthrough = harPassthrough
        }
        // F8: a fully-GREEN run becomes the new "last good" baseline for this test
        // — the reference a future failure is diffed against. Only for named tests.
        if (outcome.ok && !outcome.aborted && baselineKey && Object.keys(runSnaps).length) {
          await saveDomBaseline(baselineKey, {
            testName: traceOpts?.testName ?? '',
            at: new Date().toISOString(),
            steps: runSnaps,
            // F4: bank the element fingerprints from this green run too.
            elements: runFingerprints
          })
        }
        // F9 (Stage 2): stamp every FAILURE with its finer category — the cheap,
        // offline rule classifier over the evidence we already have — so the
        // suite-wide breakdown can count failures by type without needing anyone
        // to open Explain. Deterministic; best-effort (never blocks the result).
        if (!outcome.ok && !outcome.aborted) {
          try {
            const stepTexts = traceOpts?.stepTexts ?? []
            outcome.category = categorizeFailure({
              pageUrl: '',
              pageTitle: '',
              stepType: '',
              stepIndex: outcome.failedAt ?? 0,
              stepText: stepTexts[outcome.failedAt ?? 0] ?? '',
              error: outcome.error ?? '',
              consoleErrors: outcome.consoleErrors ?? consoleErrors,
              networkErrors: outcome.networkErrors ?? networkErrors,
              allSteps: stepTexts,
              failures: (outcome.failures ?? []).map((f) => ({
                index: f.index,
                stepText: stepTexts[f.index] ?? '',
                error: f.error,
                screenshotPath: f.screenshotPath
              }))
            })
          } catch {
            // classification is best-effort — a failure without a category is fine
          }
        }
        // F9/B: how many selectors F4 auto-healed this run — lets a suite report
        // surface "N tests auto-healed" and offer to save the repaired selectors.
        if (aiHealedOnce.size) outcome.aiHealed = aiHealedOnce.size
        return outcome
      }

      // Local copy so a re-pick can swap in a healed step mid-run without
      // mutating the renderer's array (it sends its own update separately).
      const list = steps.slice()
      // Day 16: flag replay up front so a dialog fired during the very first
      // load is auto-answered too (armNextDialog re-sets it before each action).
      // Day 16(+): also arm download tracking so `download` steps can verify.
      isReplaying = true
      replayDownloads = []
      replayDownloadCursor = 0
      currentWC.executeJavaScript('window.__qaflowReplaying=true').catch(() => {})

      // Day 18: 'Continue' bypasses a failure to check later steps — the run is
      // STILL failed overall. Remember the FIRST bypassed failure so the run
      // reports it at the end (and the trace is kept).
      let bypassedFailAt: number | null = null
      let bypassedError = ''
      let bypassedShot: string | undefined
      // Day 20: EVERY failed step this run (Continue-bypassed ones + a final
      // Stop), so the banner can show each failure's screenshot — not just the
      // first. The trace already keeps all; this surfaces them in the result.
      const failures: { index: number; error: string; screenshotPath?: string }[] = []
      // F4 (self-heal 2.0): steps we've already AUTO-healed this run. Guards the
      // re-run: if a healed step fails AGAIN it's a real failure, not a heal loop.
      const aiHealedOnce = new Set<number>()

      // === F8: "what changed since last green run" ===================
      // Snapshot the page going INTO each step; persist the whole set as the
      // baseline if the run passes, and diff the failing step against the stored
      // green baseline on a failure. Only for named tests (stable key); best-effort.
      const baselineKey = baselineKeyFor(traceOpts?.testName)
      const runSnaps: Record<number, PageSnapshot> = {}
      let greenBaseline: DomBaseline | null = null
      // F4 (self-heal 2.0): the target-element fingerprint (position + pixel crop)
      // for each healable step this run — persisted alongside the F8 baseline when
      // the run goes green, so a LATER failure can heal by "where it was / what it
      // looked like". Top-frame steps only: capturePage clips the viewport, so an
      // iframe element's frame-relative rect wouldn't line up.
      const runFingerprints: Record<number, ElementFingerprint> = {}
      const captureFingerprint = async (idx: number, step: ReplayStep): Promise<void> => {
        if (!baselineKey || !canHeal(step) || (step.frame && step.frame.length)) return
        try {
          const loc = (await currentWC.executeJavaScript(buildLocateRectScript(step), true)) as {
            rect: { x: number; y: number; w: number; h: number } | null
            vw: number
            vh: number
          }
          if (!loc?.rect || !loc.vw || !loc.vh) return
          const { x, y, w, h } = loc.rect
          if (w < 4 || h < 4) return
          // Clip the crop to the viewport (a partly off-screen element still gives
          // a usable fingerprint from the visible slice).
          const cx = Math.max(0, Math.floor(x))
          const cy = Math.max(0, Math.floor(y))
          const cw = Math.min(loc.vw - cx, Math.ceil(w))
          const ch = Math.min(loc.vh - cy, Math.ceil(h))
          if (cw < 4 || ch < 4) return
          const img = await currentWC.capturePage({ x: cx, y: cy, width: cw, height: ch })
          runFingerprints[idx] = {
            rect: { x: x / loc.vw, y: y / loc.vh, w: w / loc.vw, h: h / loc.vh },
            crop: toCropPng(img).toString('base64')
          }
        } catch {
          // fingerprints are best-effort evidence — never break a run
        }
      }
      const captureSnapshot = async (): Promise<PageSnapshot | null> => {
        try {
          return (await currentWC.executeJavaScript(
            `(() => {
              const pick = ['role','aria-label','name','id','type','placeholder','alt','title','href','value','data-test','data-testid'];
              const elements = Array.from(document.querySelectorAll('a,button,input,select,textarea,label,[role],[aria-label],[data-test],[data-testid],h1,h2,h3'))
                .slice(0, 120)
                .map((el) => {
                  const o = { tag: el.tagName.toLowerCase() };
                  for (const k of pick) { const v = el.getAttribute && el.getAttribute(k); if (v) o[k] = String(v).slice(0, 80); }
                  const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
                  if (t) o.text = t.slice(0, 60);
                  return o;
                });
              return {
                url: location.href,
                lines: (document.body ? document.body.innerText : '').split('\\n').map((s) => s.trim()).filter(Boolean).slice(0, 400),
                elements
              };
            })()`,
            true
          )) as PageSnapshot
        } catch {
          return null
        }
      }
      // F8: diff the failing step's page against the stored green baseline for the
      // same step — "what changed since it last worked". undefined when there's no
      // baseline yet or nothing changed.
      const computeWhatChanged = async (idx: number): Promise<DomDiff | undefined> => {
        if (!baselineKey || !runSnaps[idx]) return undefined
        if (!greenBaseline) greenBaseline = await loadDomBaseline(baselineKey)
        const greenSnap = greenBaseline?.steps?.[idx]
        if (!greenSnap) return undefined
        const d = diffSnapshots(greenSnap, runSnaps[idx], greenBaseline?.at)
        return d.hasChanges ? d : undefined
      }

      // === F4 (self-heal 2.0): the heal orchestrator =================
      // A step's selector broke. Re-find the element it MEANT using up to five
      // signals — accessible name + role + recorded text (always), plus position
      // + a pixel-crop compare when this test has a green baseline for the step.
      // Returns the best candidate as a pick-shaped suggestion (for the one-click
      // recovery panel) PLUS a verdict: `confident` (safe to auto-apply) needs a
      // strong combined score AND a clear gap over the runner-up (so a page full
      // of look-alike "Add to cart" buttons doesn't silently heal to the wrong
      // one). `signals` names what actually matched, for the audit trail.
      const computeHeal = async (
        step: ReplayStep,
        idx: number
      ): Promise<
        | {
            suggestion: {
              label: string
              selector: string
              candidates: ReturnType<typeof buildSelectors>['candidates']
              frame?: ReplayStep['frame']
              text?: string
              inputValue?: string
              disabled?: boolean
              checked?: boolean
              ambiguousCount: number
              unreliable: boolean
            }
            confident: boolean
            signals: string[]
            score: number
          }
        | undefined
      > => {
        if (!canHeal(step)) return undefined
        try {
          const frame = await resolveFrame(currentWC, step.frame)
          if (!frame) return undefined
          const label = (step as { label?: string }).label ?? ''
          const role = (step.candidates ?? []).find((c) => c.role)?.role ?? ''
          const recordedText =
            (step.candidates ?? []).find((c) => c.kind === 'text')?.text ?? label
          // Position comes from the green baseline (top-frame steps only). Absent
          // for iframe steps or tests that never ran green — heal still works on
          // name/role/text, just without the geometric + visual signals.
          const topFrame = !(step.frame && step.frame.length)
          if (baselineKey && !greenBaseline) greenBaseline = await loadDomBaseline(baselineKey)
          const fingerprint = topFrame ? greenBaseline?.elements?.[idx] : undefined
          const wantRect = fingerprint?.rect ?? null
          const found = (await frame.executeJavaScript(
            `window.__qaflow && window.__qaflow.findByLabel(${JSON.stringify(label)}, ${JSON.stringify(role)}, ${JSON.stringify(recordedText)}, ${JSON.stringify(wantRect)}, ${JSON.stringify(step.type)})`,
            true
          )) as {
            matches: {
              facts: ElementFacts
              rect: { x: number; y: number; w: number; h: number }
              vw: number
              vh: number
              score: number
              nameScore: number
              roleMatch: boolean
              textMatch: boolean
              hasPos: boolean
              posScore: number
              text?: string
              inputValue?: string
              disabled?: boolean
              checked?: boolean
            }[]
          } | null
          const matches = found?.matches ?? []
          if (!matches.length) return undefined

          // Fifth signal — VISUAL. Clip a live crop of each top candidate and
          // compare it to the green-run crop; fold the similarity into the score.
          // Top-frame only (capturePage clips the viewport, not an iframe).
          const scored = matches.map((m) => ({ m, score: m.score, visualSim: -1 }))
          if (topFrame && fingerprint?.crop) {
            for (const s of scored.slice(0, 3)) {
              const { x, y, w, h } = s.m.rect
              const cx = Math.max(0, Math.floor(x))
              const cy = Math.max(0, Math.floor(y))
              const cw = Math.min(s.m.vw - cx, Math.ceil(w))
              const ch = Math.min(s.m.vh - cy, Math.ceil(h))
              if (cw < 4 || ch < 4) continue
              try {
                const img = await currentWC.capturePage({ x: cx, y: cy, width: cw, height: ch })
                const sim = cropSimilarity(fingerprint.crop, img)
                s.visualSim = sim
                // A close look strongly corroborates (+20); a clearly different
                // look mildly discourages (-10, not fatal — a restyled-but-correct
                // element can still heal on its name/position).
                s.score += sim >= 0.85 ? 20 : sim >= 0 && sim < 0.5 ? -10 : 0
              } catch {
                // a capture problem just means "no visual evidence" for this one
              }
            }
          }
          scored.sort((a, b) => b.score - a.score)
          const winner = scored[0]
          const runnerUp = scored[1]

          const { primary, candidates } = buildSelectors(winner.m.facts)
          // Don't heal to a ladder replay would refuse (bare-tag last resort).
          if (!candidates.some((c) => c.kind !== 'css')) return undefined

          const signals: string[] = []
          if (winner.m.nameScore >= 55) signals.push('name')
          if (winner.m.roleMatch) signals.push('role')
          if (winner.m.textMatch) signals.push('text')
          if (winner.m.hasPos && winner.m.posScore > 0) signals.push('position')
          if (winner.visualSim >= 0.85) signals.push('visual')

          // Confident (safe to auto-apply) needs a strong match AND a clear win
          // over the runner-up. The GAP is the real ambiguity guard: a unique
          // match runs away (gap ≈ 999) and heals; several look-alikes stay
          // bunched (small gap) and DECLINE to a manual pick. Position + crop
          // feed the score, so they widen the gap for the true element rather
          // than being separately required — a unique name-only match (no green
          // baseline yet) still heals; a coincidental tie still won't.
          const gap = runnerUp ? winner.score - runnerUp.score : 999
          const confident = winner.score >= 90 && gap >= 25
          // How many stay within a whisker of the winner — the panel's existing
          // "too ambiguous" message keys off this when we decline to auto-heal.
          const ambiguousCount = scored.filter((s) => winner.score - s.score < 12).length

          return {
            suggestion: {
              label: labelFrom(winner.m.facts),
              selector: primary,
              candidates,
              frame: step.frame,
              text: winner.m.text,
              inputValue: winner.m.inputValue,
              disabled: winner.m.disabled,
              checked: winner.m.checked,
              ambiguousCount: confident ? 1 : ambiguousCount,
              unreliable: false
            },
            confident,
            signals,
            // Clamp to 100 for display: the raw score sums signal bonuses (name
            // 100 + position + visual) so it can exceed 100, but we present it as
            // a 0–100 confidence. The gate above uses the raw score, not this.
            score: Math.min(100, Math.round(winner.score))
          }
        } catch {
          return undefined
        }
      }

      for (let i = 0; i < list.length; i++) {
        const step = list[i]
        // Steps turned off in the editor are skipped — leave their row neutral
        // (no running/done/error) so the UI shows them as inert, not run.
        if (step.disabled) continue
        // F8: snapshot the page state this step is about to act on (before it runs).
        if (baselineKey) {
          const snap = await captureSnapshot()
          if (snap) runSnaps[i] = snap
          // F4: fingerprint this step's target element (position + crop) too, so a
          // future failure can heal against how it looked when it last worked.
          await captureFingerprint(i, step)
        }
        evidenceStep = i // tag captured console/network lines with this step
        // Day 18 trace: remember where this step's console/network begins + when
        // it started, so captureTraceStep can attribute the right slice + timing.
        traceConsoleCursor = consoleErrors.length
        traceNetworkCursor = networkErrors.length
        const stepStartMs = Date.now()
        // Day 19: set when a `snapshot` step fails its visual diff — the catch
        // then uses the diff image as the evidence (not a fresh page capture)
        // and offers an "Update baseline" recovery.
        let pendingVisual: {
          baselineId?: string
          currentPath: string
          diffPath?: string
          ratioPct: number
          thresholdPct: number
        } | null = null
        mainWindow.webContents.send('recorder:replay-progress', { index: i, status: 'running' })
        // Day 17 (Phase 4): if THIS step opens a new tab, arm a one-shot to
        // capture it so we can bind it to `opensWindow` after the action runs.
        let popupWait: Promise<Tab> | null = null
        try {
          // Make this step's tab the current target. Tab 0 is always bound; a
          // popup tab was bound when its opener step ran. If it isn't bound, the
          // opener tag was likely dropped at record time — try to adopt the
          // popup that opened anyway (Day 18) before giving up.
          const stepWindowId = step.windowId ?? 0
          // A closeTab step acts ON a tab (closes it) rather than running inside
          // one, so it doesn't switch in / require the tab to still be there.
          if (step.type !== 'closeTab') {
            if (!ordinalToTab.has(stepWindowId)) {
              await adoptUnboundPopup(stepWindowId)
            }
            if (!switchTo(stepWindowId)) {
              throw new Error(
                `This step runs in tab ${stepWindowId}, which was never opened during replay`
              )
            }
          }
          if (step.opensWindow !== undefined) {
            popupWait = new Promise<Tab>((resolve) => {
              onPopupOpened = resolve
            })
          }
          if (step.type === 'navigate') {
            hasNavigated = true
            resizeEmbedded()
            try {
              await currentWC.loadURL(step.url ?? '')
            } catch (err) {
              // ERR_ABORTED = the request was superseded (redirect / retry) —
              // a page IS loading, just not via the original request. Treat
              // as success; the next step's smart-wait does the real
              // verifying. Anything else (DNS, refused) fails honestly.
              // Match the name AND the numeric code -3: Electron 39 sometimes
              // reports just "(-3) loading 'url'" with no ERR_ABORTED text.
              const message = err instanceof Error ? err.message : String(err)
              if (!message.includes('ERR_ABORTED') && !message.includes('(-3)')) throw err
            }
            // Day 17: now that a page is loaded, seed this origin's localStorage
            // from the saved session (once), then reload so the app reads it —
            // so localStorage-based logins start authenticated too.
            if (seedOrigins.length && !localStorageSeeded) {
              let origin = ''
              try {
                origin = new URL(currentWC.getURL()).origin
              } catch {
                origin = ''
              }
              const match = seedOrigins.find((o) => o.origin === origin)
              if (match && match.localStorage.length) {
                localStorageSeeded = true
                const setLs = match.localStorage
                  .map(
                    (e) =>
                      `window.localStorage.setItem(${JSON.stringify(e.name)},${JSON.stringify(e.value)});`
                  )
                  .join('')
                await currentWC
                  .executeJavaScript(`(()=>{try{${setLs}}catch(e){}})()`)
                  .catch(() => {})
                await currentWC.loadURL(currentWC.getURL()).catch(() => {})
              }
            }
          } else if (step.type === 'back') {
            // Day 18: re-walk the browser's history one entry back, mirroring
            // the ← Back press that was recorded. The navigate/click steps run
            // so far have built up this tab's history, so goBack lands on the
            // previous page. Wait for it to commit + finish loading before the
            // next step runs (its smart-wait then does the real verifying).
            hasNavigated = true
            resizeEmbedded()
            const history = currentWC.navigationHistory
            if (!history.canGoBack()) {
              throw new Error('Cannot go Back — there is no previous page in history')
            }
            history.goBack()
            await wait(100)
            const backDeadline = Date.now() + 8000
            while (currentWC.isLoading() && Date.now() < backDeadline) await wait(100)
          } else if (step.type === 'closeTab') {
            // Day 18: close the recorded tab. If it was the current target, fall
            // back to the main tab so the rest of the run has a live tab. A tab
            // that isn't bound is already gone — nothing to do (idempotent).
            const tab = ordinalToTab.get(stepWindowId)
            if (tab) {
              ordinalToTab.delete(stepWindowId)
              const wasCurrent = currentWC === tab.view.webContents
              closeTab(tab)
              if (wasCurrent) switchTo(0)
            }
          } else if (step.type === 'snapshot') {
            // Day 19: re-capture the page and pixel-diff against the baseline.
            // Wait for the page to settle first so we don't compare a still-
            // loading page (images arriving) against the fully-rendered baseline.
            await waitForVisualStable(currentWC)
            const image = await currentWC.capturePage()
            const baseline = step.baselineId ? await loadBaseline(step.baselineId) : null
            if (!baseline) {
              // No baseline on disk (e.g. first run / deleted) — adopt the
              // current look as the baseline and pass, like Playwright does.
              if (step.baselineId) await saveBaseline(step.baselineId, image.toPNG())
            } else {
              const result = diffImages(baseline, image)
              const thresholdPct = Math.max(0, parseFloat(step.value ?? '1') || 0)
              const ratioPct = result.ratio * 100
              if (result.sizeMismatch || ratioPct > thresholdPct) {
                const dir = join(libraryDir(), '_failures')
                await mkdir(dir, { recursive: true })
                const stamp = Date.now()
                const currentPath = join(dir, `visual-current-${stamp}.png`)
                await writeFile(currentPath, image.toPNG())
                let diffPath: string | undefined
                if (result.diffPng) {
                  diffPath = join(dir, `visual-diff-${stamp}.png`)
                  await writeFile(diffPath, result.diffPng)
                }
                pendingVisual = {
                  baselineId: step.baselineId,
                  currentPath,
                  diffPath,
                  ratioPct,
                  thresholdPct
                }
                throw new Error(
                  result.sizeMismatch
                    ? `Visual snapshot: the page size changed (${result.baseSize?.width}×${result.baseSize?.height} → ${result.curSize?.width}×${result.curSize?.height})`
                    : `Visual snapshot differs by ${ratioPct.toFixed(2)}% (allowed ${thresholdPct}%)`
                )
              }
            }
          } else if (step.type === 'a11y') {
            // F13: run axe-core on the settled page and FAIL the step if any
            // violation is at or above the step's budget (default serious+).
            // A page-level check, like a snapshot — no element, no selector.
            await waitForVisualStable(currentWC)
            const scan = await scanAccessibility(currentWC)
            if (scan.error) {
              throw new Error(`Accessibility check couldn't run — ${scan.error}`)
            }
            const level = a11yThresholdLevel(step.value)
            const budget = a11yImpactRank(level)
            const blocking = scan.violations.filter((v) => a11yImpactRank(v.impact) <= budget)
            if (blocking.length) {
              const elements = blocking.reduce((n, v) => n + v.nodes.length, 0)
              const top = blocking
                .slice(0, 4)
                .map((v) => `${v.impact}: ${v.help} (${v.nodes.length})`)
                .join('; ')
              throw new Error(
                `Accessibility: ${blocking.length} rule${blocking.length === 1 ? '' : 's'}` +
                  ` / ${elements} element${elements === 1 ? '' : 's'} at "${level}" or worse — ${top}` +
                  (blocking.length > 4 ? '; …' : '')
              )
            }
          } else if (step.type === 'perf') {
            // F14: measure Core Web Vitals on the settled page and FAIL the
            // step if a core metric (LCP/CLS) is worse than the budget. Like
            // a11y, a page-level check — no element, no selector.
            await waitForVisualStable(currentWC)
            const perf = await measurePerformance(currentWC)
            if (perf.error) {
              throw new Error(`Performance check couldn't run — ${perf.error}`)
            }
            const budgetRank = perfBudgetRank(step.value)
            const core = perf.metrics.filter((m) => m.core && m.rating)
            const failing = core.filter((m) => PERF_RATING_RANK[m.rating!] > budgetRank)
            if (failing.length) {
              const detail = failing
                .map((m) => `${m.key.toUpperCase()} ${m.value}${m.unit} (${m.rating})`)
                .join('; ')
              throw new Error(
                `Performance: ${detail} — worse than budget "${perfBudgetLabel(step.value)}"`
              )
            }
          } else if (step.type === 'wait') {
            // F3 (smart waits): a fixed pause, OR a CONDITION — network idle /
            // text appears — which replaces a guessy sleep with a precise wait.
            const kind = (step as { waitKind?: string }).waitKind ?? 'time'
            if (kind === 'network-idle') {
              await waitForNetworkIdle()
            } else if (kind === 'text') {
              await waitForText(step.value ?? '')
            } else if (kind === 'manual') {
              // F30: a human gate (2FA/CAPTCHA/manual check). Interactively we PAUSE
              // and hold here until the user clicks Continue. Unattended (Run All /
              // CI) there's no human, so it's a no-op — the run proceeds (a manual
              // step can't be automated; downstream steps depending on it may fail,
              // which is honest — these steps are for watched runs).
              if (interactive) {
                mainWindow.webContents.send('recorder:manual-pause', {
                  index: i,
                  message: step.value || 'Complete the manual step, then continue.'
                })
                await new Promise<void>((resolve) => {
                  manualResolve = resolve
                })
              }
            } else {
              const seconds = Math.max(0, parseFloat(step.value ?? '0') || 0)
              await wait(seconds * 1000)
            }
          } else if (step.type === 'dialog') {
            // Day 16: a native dialog is answered by PRE-ARMING the page before
            // the step that triggers it (see armNextDialog below) — by the time
            // we reach this row the answer was already given. Nothing to do.
          } else if (step.type === 'download') {
            // Day 16(+): the download itself is a side effect of the preceding
            // action (the click) — here we VERIFY it. Wait for the next download
            // this run produced, then assert it arrived AND isn't empty AND its
            // name matches what's expected. This turns every recorded download
            // into a real checkpoint (e.g. "the receipt downloaded, non-empty").
            const expectName = (step.value ?? '').trim()
            const deadline = Date.now() + 12000
            let got: { name: string; bytes: number; completed: boolean } | null = null
            for (;;) {
              if (replayDownloads.length > replayDownloadCursor) {
                got = replayDownloads[replayDownloadCursor++]
                break
              }
              if (Date.now() > deadline) break
              await wait(150)
            }
            if (!got) {
              throw new Error(
                `Expected a download${expectName ? ` ("${expectName}")` : ''}, but nothing downloaded`
              )
            }
            if (!got.completed) {
              throw new Error(`Download of "${got.name}" did not finish (interrupted)`)
            }
            if (got.bytes <= 0) {
              throw new Error(`Downloaded file "${got.name}" is empty (0 bytes)`)
            }
            if (expectName && !got.name.includes(expectName)) {
              throw new Error(`Expected download "${expectName}" but got "${got.name}"`)
            }
          } else if (step.type === 'upload') {
            // Day 16: set the file(s) on the input. JavaScript can't assign a
            // file input (security), so use CDP DOM.setFileInputFiles — the same
            // engine-level channel Playwright's setInputFiles uses.
            const cssList = (step.candidates ?? [])
              .map((c) => c.css)
              .filter((c): c is string => !!c)
            const paths = (step.value ?? '').split('\n').filter(Boolean)
            if (!cssList.length)
              throw new Error('Upload step has no CSS selector for the file input')
            if (!paths.length) throw new Error('Upload step has no file to set')
            if (!cdpReady)
              throw new Error('File upload needs the debugger (CDP), which did not attach')
            // Poll for the input — it may still be loading after a navigation,
            // the same smart-wait every other step gets. Try the candidate
            // selectors strongest-first (like the normal finder, so a weak
            // primary can fall back), re-fetching the document each tick since
            // DOM node ids go stale.
            let fileNodeId = 0
            const uploadDeadline = Date.now() + 8000
            for (;;) {
              const doc = (await cdp.sendCommand('DOM.getDocument', { depth: 0 })) as {
                root: { nodeId: number }
              }
              for (const sel of cssList) {
                const found = (await cdp
                  .sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel })
                  .catch(() => ({ nodeId: 0 }))) as { nodeId: number }
                if (found.nodeId) {
                  fileNodeId = found.nodeId
                  break
                }
              }
              if (fileNodeId || Date.now() > uploadDeadline) break
              await wait(150)
            }
            if (!fileNodeId) throw new Error('Could not find the file input on the page')
            await cdp.sendCommand('DOM.setFileInputFiles', { files: paths, nodeId: fileNodeId })
          } else if (step.type === 'assert' && step.assertKind === 'nl') {
            // F19: an AI (natural-language) assertion — judged by the LLM, not
            // an in-page script. Capture the page's url/title/visible-text PLUS
            // an image signal (innerText has no evidence of images) AND a
            // screenshot the LLM can actually look at, so visual claims (images,
            // layout, colours) can be judged. A FAIL throws like any assertion,
            // so it flows into the normal failure path (screenshot/explain/report).
            const ctx = (await currentWC.executeJavaScript(
              `(() => {
                const imgs = Array.from(document.images || []);
                // A bounded list of notable elements with their key attributes,
                // so attribute/role/link claims have evidence (not in text/pixels).
                const pick = ['role','aria-label','name','id','type','placeholder','alt','title','href','value','data-test','data-testid'];
                const elements = Array.from(document.querySelectorAll('a,button,input,select,textarea,label,[role],[aria-label],[data-test],[data-testid],h1,h2,h3'))
                  .slice(0, 80)
                  .map((el) => {
                    const o = { tag: el.tagName.toLowerCase() };
                    for (const k of pick) { const v = el.getAttribute && el.getAttribute(k); if (v) o[k] = String(v).slice(0, 80); }
                    const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
                    if (t) o.text = t.slice(0, 60);
                    return o;
                  });
                return {
                  url: location.href,
                  title: document.title,
                  text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 8000),
                  images: {
                    count: imgs.length,
                    alts: imgs.map((i) => i.alt || i.getAttribute('aria-label') || '').filter(Boolean).slice(0, 20)
                  },
                  elements
                };
              })()`,
              true
            )) as {
              url: string
              title: string
              text: string
              images: { count: number; alts: string[] }
              elements: Array<Record<string, string>>
            }
            // FULL-PAGE screenshot so the model can SEE everything, incl. below the
            // fold. Prefer CDP (captureBeyondViewport); fall back to the viewport
            // capture, then to text-only. Best-effort; deleted after the call.
            let shotPath: string | undefined
            try {
              let png: Buffer | undefined
              if (cdpReady) {
                try {
                  const res = (await cdp.sendCommand('Page.captureScreenshot', {
                    format: 'png',
                    captureBeyondViewport: true
                  })) as { data?: string }
                  if (res?.data) png = Buffer.from(res.data, 'base64')
                } catch {
                  // CDP capture failed — fall back to the viewport capture below
                }
              }
              if (!png) png = (await currentWC.capturePage()).toPNG()
              const dir = join(libraryDir(), '_nlchecks')
              await mkdir(dir, { recursive: true })
              shotPath = join(dir, `nl-${Date.now()}.png`)
              await writeFile(shotPath, png)
            } catch {
              // couldn't capture — evaluate on text + signals alone
            }
            const nl = await evaluateNlAssertion(
              step.value ?? '',
              { ...ctx, screenshotPath: shotPath },
              libraryDir()
            )
            if (shotPath) await rm(shotPath, { force: true }).catch(() => {})
            if (!nl.pass) throw new Error(nl.error)
          } else {
            // Day 15: route the action into the frame it was recorded in (or
            // the top frame for a normal step). The injected script is entirely
            // document-relative, so it needs no changes — only the frame it
            // runs in differs. The finder still resolves the element through
            // the full candidate ladder (role / text / CSS), strongest-first.
            //
            // Day 18 (replay stability): the injected script POLLS (an assert
            // waits up to 3s), so it can still be running while the page is
            // navigating — e.g. a check right after a login redirect. When the
            // page navigates, Electron DESTROYS the frame the script runs in
            // before it returns ("…destroyed without running the callback").
            // That's transient, not a test failure: wait for the page to
            // settle, re-resolve the frame (the old handle is now stale), and
            // retry. Asserts/finders are read-only + idempotent, so re-running
            // just yields the real answer instead of a cryptic Electron error.
            let result: { ok: boolean; error?: string; hoverAt?: { x: number; y: number } } | null =
              null
            const execDeadline = Date.now() + 10000
            for (;;) {
              // Don't fire into a page that's still mid-navigation.
              while (currentWC.isLoading() && Date.now() < execDeadline) await wait(100)
              const targetFrame = await resolveFrame(currentWC, step.frame)
              if (!targetFrame) {
                throw new Error(
                  'Could not find the iframe for this step (it never appeared on the page)'
                )
              }
              // Day 16: if the NEXT step is a dialog, this action is what
              // triggers it — pre-arm the override in this frame so the dialog
              // answers itself instead of blocking. Also flag replay so any
              // UNEXPECTED dialog auto-accepts rather than hanging the run.
              await armNextDialog(targetFrame, list[i + 1])
              try {
                result = (await targetFrame.executeJavaScript(buildActionScript(step), true)) as {
                  ok: boolean
                  error?: string
                  hoverAt?: { x: number; y: number }
                } | null
                break
              } catch (execErr) {
                const m = execErr instanceof Error ? execErr.message : String(execErr)
                const transient =
                  m.includes('destroyed without running the callback') ||
                  m.includes('frame was disposed')
                if (!transient || Date.now() > execDeadline) throw execErr
                // The frame navigated/reloaded mid-execute — let it settle, then
                // loop to re-resolve a fresh frame and try the script again.
                await wait(250)
              }
            }
            if (!result || !result.ok) throw new Error(result?.error || 'Action failed')
            // A hover step: the page script located the trigger and returned
            // its center. Move the engine-level mouse there via CDP (sets CSS
            // :hover for real), then give the page a beat to react.
            if (result.hoverAt) {
              const x = Math.round(result.hoverAt.x)
              const y = Math.round(result.hoverAt.y)
              let moved = false
              if (cdpReady) {
                try {
                  await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
                  moved = true
                } catch {
                  // CDP hiccup — fall through to the weaker fallback
                }
              }
              if (!moved) {
                currentWC.sendInputEvent({ type: 'mouseMove', x, y })
              }
              await wait(150)
            }
          }
          // Day 17 (Phase 4): if this step opened a tab, the action above just
          // triggered the popup — wait for it and bind it to its ordinal so
          // later steps in that tab can run. A timeout means the popup never
          // appeared; a later step referencing it will fail clearly.
          if (popupWait) {
            const newTab = await Promise.race([popupWait, wait(8000).then(() => null)])
            onPopupOpened = null // disarm if it never fired
            if (newTab) {
              ordinalToTab.set(step.opensWindow as number, newTab)
              const popupWC = newTab.view.webContents
              attachTo(popupWC)
              // Give the popup a beat to load before steps run in it (its first
              // step would otherwise race the navigation).
              const loadDeadline = Date.now() + 8000
              while (popupWC.isLoading() && Date.now() < loadDeadline) await wait(100)
            }
          }
          mainWindow.webContents.send('recorder:replay-progress', { index: i, status: 'done' })
          await captureTraceStep(i, 'done', stepStartMs)
          await wait(450)
        } catch (err) {
          onPopupOpened = null // disarm any popup hook if the step failed
          const message = err instanceof Error ? err.message : String(err)
          // F26 (optional step): this step is allowed to be absent — an optional
          // cookie banner / promo popup that didn't appear. A failure here is NOT
          // a test failure: mark it skipped and continue, before any heal/pause.
          // (It uses a shorter find timeout, so an absent element doesn't stall.)
          if (step.optional) {
            mainWindow.webContents.send('recorder:replay-progress', { index: i, status: 'skipped' })
            await captureTraceStep(i, 'skipped', stepStartMs)
            await wait(200)
            continue
          }
          // F4 (self-heal 2.0): a healable failure is a SELECTOR break (the
          // element wasn't found) — not an assertion mismatch or a wrong-state
          // element, where the selector is fine and re-finding wouldn't help.
          const selectorBroke = /element not found|no reliable selector/i.test(message)
          // Run the multi-signal heal ONCE (it does capture work) and reuse the
          // result for both the auto-heal decision and the manual-pick panel.
          const heal = selectorBroke ? await computeHeal(step, i) : undefined
          // AUTO-HEAL: a confident, unambiguous match — swap in the healed ladder,
          // stamp it "fixed by AI", and RE-RUN the step (that re-run IS the runtime
          // validation: a heal that doesn't actually work fails again). Guarded to
          // once per step so a genuinely-broken step can't loop. Works in BOTH
          // interactive and unattended runs — the real "self-healing test".
          if (heal?.confident && !aiHealedOnce.has(i)) {
            aiHealedOnce.add(i)
            const s = heal.suggestion
            const healedStep: ReplayStep = {
              ...step,
              label: s.label,
              selector: s.selector,
              candidates: s.candidates,
              frame: step.frame,
              healedByAi: {
                at: new Date().toISOString(),
                signals: heal.signals,
                score: heal.score
              }
            }
            list[i] = healedStep
            // Tell the renderer so it swaps the step in (a 💾 save keeps the fix)
            // and shows the "fixed by AI" badge + live count.
            mainWindow.webContents.send('recorder:auto-healed', {
              index: i,
              step: healedStep,
              signals: heal.signals,
              score: heal.score
            })
            mainWindow.webContents.send('recorder:replay-progress', { index: i, status: 'running' })
            i-- // re-run the same index with the healed ladder
            continue
          }
          // Day 11.5: photograph the page AT the moment of failure — evidence
          // for a human now and required input for Day 13's AI translator.
          // Best-effort: a screenshot problem must never mask the real error.
          let screenshotPath: string | undefined
          let annotatedImage: Electron.NativeImage | undefined
          if (pendingVisual) {
            // Day 19: a visual-snapshot failure — the DIFF image is the evidence
            // (changed pixels in red), so don't annotate/capture the page.
            screenshotPath = pendingVisual.diffPath ?? pendingVisual.currentPath
          } else {
            try {
              // Day 12.9: annotate the evidence first — red error banner, plus
              // an outline around the culprit element when it still resolves.
              // Draw → capture → erase: the marks live only inside the PNG.
              try {
                await currentWC.executeJavaScript(buildFailureMarkScript(step, message), true)
                await wait(120) // let the scroll + overlay paint before capture
              } catch {
                // decoration failed — capture the plain screenshot anyway
              }
              annotatedImage = await currentWC.capturePage()
              const dir = join(libraryDir(), '_failures')
              await mkdir(dir, { recursive: true })
              screenshotPath = join(dir, `failure-${Date.now()}.png`)
              await writeFile(screenshotPath, annotatedImage.toPNG())
            } catch {
              screenshotPath = undefined
            }
            try {
              await currentWC.executeJavaScript(removeFailureMarkScript(), true)
            } catch {
              // page may be gone — nothing to clean
            }
          }
          mainWindow.webContents.send('recorder:replay-progress', {
            index: i,
            status: 'error',
            error: message
          })
          // Day 18: the trace's failure shot reuses the ANNOTATED image (red
          // banner + culprit outline) so it shows WHERE it failed. DOM is grabbed
          // clean here (the marks were just erased above).
          await captureTraceStep(i, 'error', stepStartMs, message, annotatedImage)
          // Day 12: in an interactive replay we PAUSE here instead of ending.
          // The browser is sitting in the exact state where things broke —
          // ideal for retrying or re-picking the element. The loop holds on
          // this promise until the user's decision arrives over IPC.
          if (interactive) {
            // Day 18: save the trace NOW so a ⏺ recording button in the recovery
            // panel can open it mid-pause (not just after the run ends).
            await persistTrace(false, i)
            // F4: we already ran the heal above. If it wasn't confident enough to
            // auto-apply (weak match, or several look-alikes it couldn't separate),
            // still offer it as a one-click fix / ambiguity warning in the panel.
            const suggestion = heal?.suggestion
            mainWindow.webContents.send('recorder:replay-paused', {
              index: i,
              error: message,
              screenshotPath,
              traceId: tracePersisted ? traceRunId : undefined,
              selectorBroke,
              suggestion,
              // Day 19: a visual-snapshot failure — lets the panel show the diff
              // and offer "Update baseline" (adopt the new look).
              visual: pendingVisual
                ? {
                    baselineId: pendingVisual.baselineId,
                    currentPath: pendingVisual.currentPath,
                    diffPath: pendingVisual.diffPath,
                    ratioPct: pendingVisual.ratioPct,
                    thresholdPct: pendingVisual.thresholdPct
                  }
                : undefined,
              // Day 13: evidence so far — the Explain button works mid-pause too
              consoleErrors: consoleErrors.slice(),
              networkErrors: networkErrors.slice()
            })
            const decision = await new Promise<RecoveryDecision>((resolve) => {
              recoveryResolve = resolve
            })
            if (decision.action === 'retry') {
              // A re-pick rides along as a healed step — swap it in first.
              if (decision.step) list[i] = decision.step
              i-- // run the same index again
              continue
            }
            if (decision.action === 'continue') {
              // DEBUG bypass: keep going to check the later steps, but the run is
              // STILL failed (remember the first one). The step keeps its 'error'
              // mark + screenshot (no 'skipped' progress sent) — we don't pretend
              // it passed; we only deferred dealing with it. The trace shows it
              // red with its shot (we left the 'error' capture in place).
              if (bypassedFailAt === null) {
                bypassedFailAt = i
                bypassedError = message
                bypassedShot = screenshotPath
              }
              failures.push({ index: i, error: message, screenshotPath })
              continue
            }
            if (decision.action === 'skip') {
              // PERMANENT skip: disable the step so it's skipped this run AND in
              // future (the renderer disables its own copy to persist on save).
              // It doesn't count as a failure. KEEP its capture but mark it
              // 'skipped' (with its failure screenshot) so the recording still
              // shows it happened — a complete, honest log.
              list[i].disabled = true
              const cap = traceStepMap.get(i)
              if (cap) cap.status = 'skipped'
              mainWindow.webContents.send('recorder:replay-progress', {
                index: i,
                status: 'skipped'
              })
              continue
            }
            if (decision.action === 'abort') {
              // Home was pressed mid-pause — end quietly, nothing to report.
              return await finish({ ok: false, failedAt: i, error: message, aborted: true })
            }
            // 'stop' falls through to the normal failure return below.
          }
          // This step is a real failure (Stop, or a non-interactive run that
          // ends at the first failure) — record it before returning.
          failures.push({ index: i, error: message, screenshotPath })
          // Option 2 (conservative unattended heal): the selector broke and
          // self-heal FOUND a likely fix but wasn't confident enough to auto-apply
          // (and there was no one to click Accept in a batch run). We DON'T apply
          // it silently — a wrong guess that "works" is a false pass. Instead we
          // hand the suggestion back so the suite report can list it "healable —
          // review & accept", keeping a human in the loop before it turns green.
          const healable =
            heal && !heal.confident
              ? {
                  index: i,
                  label: heal.suggestion.label,
                  signals: heal.signals,
                  score: heal.score,
                  step: {
                    ...step,
                    label: heal.suggestion.label,
                    selector: heal.suggestion.selector,
                    candidates: heal.suggestion.candidates,
                    frame: step.frame,
                    healedByAi: {
                      at: new Date().toISOString(),
                      signals: heal.signals,
                      score: heal.score
                    }
                  } as ReplayStep
                }
              : undefined
          return await finish({
            ok: false,
            failedAt: i,
            error: message,
            screenshotPath,
            failures,
            consoleErrors: consoleErrors.slice(),
            networkErrors: networkErrors.slice(),
            whatChanged: await computeWhatChanged(i),
            healable
          })
        }
      }
      // Day 18: if a failure was bypassed with 'Continue', the run is FAILED even
      // though we reached the end — report the first one (and keep the trace).
      if (bypassedFailAt !== null) {
        return await finish({
          ok: false,
          failedAt: bypassedFailAt,
          error: bypassedError,
          screenshotPath: bypassedShot,
          failures,
          consoleErrors: consoleErrors.slice(),
          networkErrors: networkErrors.slice(),
          whatChanged: await computeWhatChanged(bypassedFailAt)
        })
      }
      return await finish({ ok: true })
    }
  )

  // === Test library (Day 11) =========================================
  // Thin IPC wrappers — all the real logic (paths, slugs, safety) lives in
  // library.ts where it's testable without Electron wiring.
  ipcMain.handle(
    'library:save',
    (
      _event,
      input: {
        name: string
        baseURL: string
        suite: string
        steps: unknown[]
        storageState?: string
        viewport?: { width: number; height: number }
        dataRows?: Record<string, string>[]
        // F1: renderer signals "bank the captured network with this test"; main
        // supplies the actual HAR log (it lives here, not in the renderer).
        captureHar?: boolean
      }
    ) => saveTest({ ...input, harLog: input.captureHar ? lastCapturedHar : undefined })
  )

  // === Data-driven (Day 20) + Environments (F25) =====================
  // Resolve {{env:NAME}} tokens for a run. The ACTIVE environment's vars (F25)
  // win, then the real process environment fills the rest — so `{{env:PASSWORD}}`
  // is this environment's password when one is selected, and the shell's
  // otherwise. Missing everywhere → '' (the step runs empty and fails honestly),
  // keeping a secret out of the saved test + the export.
  ipcMain.handle('env:get', async (_event, names: string[]): Promise<Record<string, string>> => {
    const envVars = await activeEnvVars()
    const out: Record<string, string> = {}
    for (const name of Array.isArray(names) ? names : []) {
      out[name] = envVars[name] ?? process.env[name] ?? ''
    }
    return out
  })

  // === Environment / config manager (F25) ============================
  // CRUD + active selection for named { baseURL + credentials } environments,
  // persisted in userData (they hold secrets — kept out of the shared Tests
  // folder). Each mutation returns the whole new state so the renderer stays in
  // sync in one round-trip.
  ipcMain.handle('env:listEnvironments', () => getEnvState())
  ipcMain.handle('env:saveEnvironment', (_event, env: Environment) => saveEnvironment(env))
  ipcMain.handle('env:deleteEnvironment', (_event, id: string) => deleteEnvironment(id))
  ipcMain.handle('env:setActive', (_event, id: string | null) => setActiveEnvironment(id))

  // === Cross-browser replay (F17) ====================================
  // Chromium is the embedded engine; WebKit/Firefox can only run via REAL
  // Playwright, shelled out. `check` reports whether it's installed; `run`
  // exports the current test to a temp spec and runs it per selected browser.
  ipcMain.handle('xbrowser:check', () => checkPlaywright())
  ipcMain.handle('xbrowser:run', async (_event, specCode: string, browsers: BrowserName[]) => {
    // Bridge the active F25 environment: its vars feed process.env.* in the spec,
    // and its base URL feeds process.env.BASE_URL (the export reads that).
    const env = await activeEnvironment()
    const envVars: Record<string, string> = {}
    for (const v of env?.vars ?? []) if (v.name) envVars[v.name] = v.value
    if (env?.baseURL) envVars.BASE_URL = env.baseURL
    return runCrossBrowser(specCode, browsers, envVars)
  })
  ipcMain.handle('library:list', () => listTests())
  ipcMain.handle('library:listSuites', () => listSuites())
  ipcMain.handle('library:load', (_event, fileName: string) => loadTest(fileName))
  ipcMain.handle('library:delete', (_event, fileName: string) => deleteTest(fileName))
  ipcMain.handle('library:recordRun', (_event, fileName: string, run: RunInfo) =>
    recordRun(fileName, run)
  )

  // === Drafts (Day 18) — auto-saved in-progress recordings ===========
  ipcMain.handle('drafts:save', (_event, input: DraftFile) => saveDraft(input))
  ipcMain.handle('drafts:list', () => listDrafts())
  ipcMain.handle('drafts:load', (_event, id: string) => loadDraft(id))
  ipcMain.handle('drafts:delete', (_event, id: string) => deleteDraft(id))

  // === Reusable step blocks (Pillar 4) ===============================
  ipcMain.handle('blocks:save', (_event, input: { name: string; steps: unknown[] }) =>
    saveBlock(input)
  )
  ipcMain.handle('blocks:list', () => listBlocks())
  ipcMain.handle('blocks:load', (_event, fileName: string) => loadBlock(fileName))
  ipcMain.handle('blocks:delete', (_event, fileName: string) => deleteBlock(fileName))
  // F7 (blast-radius): which tests link each block, so the UI can warn before an edit.
  ipcMain.handle('blocks:usage', () => blockUsage())

  // === Visual regression (Day 19) ====================================
  // Capture the current page as a baseline + emit a `snapshot` step. The
  // step carries the baseline id; replay re-captures and pixel-diffs.
  ipcMain.handle('recorder:snapshot', async (): Promise<void> => {
    try {
      await waitForVisualStable(activeWC())
      const image = await activeWC().capturePage()
      const id = `snap-${Date.now()}`
      await saveBaseline(id, image.toPNG())
      // `value` = allowed diff threshold (percent). 1% tolerates anti-aliasing
      // while still catching real visual changes; editable per step.
      sendStep({ type: 'snapshot', label: 'Visual snapshot', baselineId: id, value: '1' })
    } catch {
      // capture can fail if the page is gone — silently no-op
    }
  })
  // Adopt the CURRENT look as the new baseline (a page legitimately changed).
  ipcMain.handle(
    'visual:updateBaseline',
    async (_event, baselineId: string, currentPath: string): Promise<boolean> => {
      if (!isSafeBaselineId(baselineId)) return false
      // currentPath is one of OUR saved diff-source PNGs in the library.
      if (typeof currentPath !== 'string' || !currentPath.startsWith(libraryDir())) return false
      try {
        await saveBaseline(baselineId, await readFile(currentPath))
        return true
      } catch {
        return false
      }
    }
  )
  // Serve a baseline image as a data URL (for the diff view).
  ipcMain.handle('visual:getBaseline', async (_event, id: string): Promise<string | null> => {
    const buf = await loadBaseline(id)
    return buf ? `data:image/png;base64,${buf.toString('base64')}` : null
  })
  // === Accessibility scan (F13) ======================================
  // Inject axe-core into the ACTIVE tab, run WCAG A/AA, hand back the
  // trimmed violations. A failure (no real page, or it navigated mid-scan)
  // comes back as an `error` result the panel explains — never a throw.
  ipcMain.handle('a11y:scan', async (): Promise<A11yScanResult> => {
    try {
      return await scanAccessibility(activeWC())
    } catch (err) {
      return {
        url: '',
        title: '',
        at: new Date().toISOString(),
        violations: [],
        passCount: 0,
        incompleteCount: 0,
        nodeCount: 0,
        error:
          'Could not scan this page. Open a real web page first, then try again.' +
          (err instanceof Error && err.message ? ` (${err.message})` : '')
      }
    }
  })
  // Open a rule's "how to fix" docs in the user's real browser. Restricted to
  // https deque/w3 help links — this is a doc opener, not a general launcher.
  ipcMain.handle('a11y:openHelp', (_event, url: string) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url)
  })

  // === Performance / Core Web Vitals (F14) ============================
  // Measure the ACTIVE tab's Core Web Vitals. Like a11y, a page we can't
  // measure comes back as an `error` result, never a throw.
  ipcMain.handle('perf:measure', async (): Promise<PerfResult> => {
    try {
      return await measurePerformance(activeWC())
    } catch (err) {
      return {
        url: '',
        title: '',
        at: new Date().toISOString(),
        metrics: [],
        error:
          'Could not measure this page. Open a real web page first, then try again.' +
          (err instanceof Error && err.message ? ` (${err.message})` : '')
      }
    }
  })

  // === HAR record & replay (F1) ======================================
  // Toggle capture on/off (set before recording). The count of what was
  // captured is pushed via the 'har:captured' event when recording stops.
  ipcMain.handle('har:setEnabled', (_event, enabled: boolean): void => {
    harCaptureEnabled = !!enabled
  })
  // The renderer asks how many responses the last capture kept (e.g. after a
  // reload, to re-show the badge).
  ipcMain.handle('har:lastCount', (): number => lastCapturedHar?.log.entries.length ?? 0)

  // Open a failure screenshot in the OS image viewer. Only paths inside the
  // library folder are allowed — this is a viewer, not a general file opener.
  ipcMain.handle('library:openScreenshot', (_event, path: string) => {
    if (typeof path === 'string' && path.startsWith(libraryDir())) shell.openPath(path)
  })

  // === Run trace (Day 18) ============================================
  // The viewer asks for the manifest (with each step's thumbnail inlined as a
  // data URL for the filmstrip), then the full screenshot for the selected
  // step on demand, and can open the full image / DOM html externally.
  const pngDataUrl = (buf: Buffer): string => `data:image/png;base64,${buf.toString('base64')}`
  ipcMain.handle('trace:get', async (_event, id: string) => {
    const manifest = await loadTrace(id)
    if (!manifest) return null
    // Inline the small thumbnails so the filmstrip renders without N round-trips.
    for (const step of manifest.steps) {
      if (step.thumbFile) {
        const buf = await readTraceAsset(id, step.thumbFile)
        if (buf) (step as TraceStepRecord & { thumbData?: string }).thumbData = pngDataUrl(buf)
      }
    }
    return manifest
  })
  ipcMain.handle('trace:getImage', async (_event, id: string, file: string) => {
    const buf = await readTraceAsset(id, file)
    return buf ? pngDataUrl(buf) : null
  })
  ipcMain.handle('trace:openFile', (_event, id: string, file: string) => {
    // readTraceAsset's guards (id + file shape) keep this inside the trace dir.
    if (typeof id !== 'string' || typeof file !== 'string') return
    if (!/^trace-[a-zA-Z0-9_-]+$/.test(id) || !/^[a-zA-Z0-9_.-]+$/.test(file)) return
    shell.openPath(join(traceDir(id), file))
  })
  // Copy the whole recording to a folder the user picks (so it survives pruning
  // and can be shared), then reveal it. Returns the destination path or null.
  ipcMain.handle('trace:export', async (_event, id: string): Promise<string | null> => {
    if (typeof id !== 'string' || !isSafeTraceId(id)) return null
    const manifest = await loadTrace(id)
    if (!manifest) return null
    // Save as ONE self-contained .html file — images + DOM embedded as data
    // URLs — so the recording is a single, shareable, double-clickable file
    // (no folder of loose screenshots).
    const slug = (manifest.testName || id).replace(/[^a-zA-Z0-9-_]+/g, '-').slice(0, 60)
    const picked = await dialog.showSaveDialog(mainWindow, {
      title: 'Save recording',
      defaultPath: `recording-${slug}.html`,
      filters: [{ name: 'HTML report', extensions: ['html'] }]
    })
    if (picked.canceled || !picked.filePath) return null
    try {
      // Embed every referenced asset as a data: URL keyed by its filename.
      const assets: Record<string, string> = {}
      for (const step of manifest.steps) {
        for (const file of [step.thumbFile, step.screenshotFile, step.domFile]) {
          if (!file || assets[file]) continue
          const buf = await readTraceAsset(id, file)
          if (!buf) continue
          const mime = file.endsWith('.html') ? 'text/html;charset=utf-8' : 'image/png'
          assets[file] = `data:${mime};base64,${buf.toString('base64')}`
        }
      }
      await writeFile(picked.filePath, generateTraceHtml(manifest, assets), 'utf-8')
      shell.openPath(picked.filePath)
      return picked.filePath
    } catch {
      return null
    }
  })

  // Whole-run REPORT — a summary-first, print-friendly HTML doc of the WHOLE run
  // (verdict banner + every step + timings + evidence), for pass OR fail. This is
  // the "📄 report" button that sits next to the recording; the markdown bug
  // report (report:save) is a separate, defect-focused artifact. Same trace data
  // as the recording; only the full-size screenshots need embedding.
  ipcMain.handle('trace:exportReport', async (_event, id: string): Promise<string | null> => {
    if (typeof id !== 'string' || !isSafeTraceId(id)) return null
    const manifest = await loadTrace(id)
    if (!manifest) return null
    const slug = (manifest.testName || id).replace(/[^a-zA-Z0-9-_]+/g, '-').slice(0, 60)
    const picked = await dialog.showSaveDialog(mainWindow, {
      title: 'Save run report',
      defaultPath: `report-${slug}.html`,
      filters: [{ name: 'HTML report', extensions: ['html'] }]
    })
    if (picked.canceled || !picked.filePath) return null
    try {
      const assets: Record<string, string> = {}
      for (const step of manifest.steps) {
        const file = step.screenshotFile
        if (!file || assets[file]) continue
        const buf = await readTraceAsset(id, file)
        if (buf) assets[file] = `data:image/png;base64,${buf.toString('base64')}`
      }
      await writeFile(picked.filePath, generateReportHtml(manifest, assets), 'utf-8')
      shell.openPath(picked.filePath)
      return picked.filePath
    } catch {
      return null
    }
  })

  // Day 16(+): reveal a downloaded file in the OS file explorer (highlighted),
  // so a silent auto-save is confirmable and one click from opening. Guarded to
  // the library folder, same as the screenshot opener above.
  ipcMain.handle('recorder:revealDownload', (_event, path: string) => {
    if (typeof path === 'string' && path.startsWith(libraryDir())) shell.showItemInFolder(path)
  })

  // === Failure translator + bug report (Day 13) ======================
  // The renderer assembles the evidence bundle (it owns the steps and their
  // human sentences); main runs the translator because spawning the Claude
  // CLI is an OS-process affair — backstage work, like all disk access.
  // cwd = the library folder, so the CLI may read failure screenshots
  // (they live under <library>/_failures) without extra permissions.
  ipcMain.handle('translator:explain', (_event, evidence: FailureEvidence) =>
    explainFailure(evidence, libraryDir())
  )

  // F9 Stage 3: Deep RCA over a whole run trace. Loads the trace, hands every
  // step (status + error + logs + screenshot filename) to the LLM with cwd set
  // to the trace folder so it can Read the step screenshots. Returns null when
  // there's no trace or Claude is unavailable (the renderer explains why).
  ipcMain.handle('translator:deepRca', async (_event, traceId: string) => {
    const manifest = await loadTrace(traceId)
    if (!manifest) return null
    const steps = manifest.steps.map((s) => ({
      index: s.index,
      text: s.text,
      status: s.status,
      durationMs: s.durationMs,
      error: s.error,
      screenshotFile: s.screenshotFile,
      consoleErrors: s.consoleErrors ?? [],
      networkErrors: s.networkErrors ?? []
    }))
    return deepRcaFailure(manifest.testName, steps, traceDir(traceId))
  })

  // Save a generated bug report as a .md file the user picks a place for.
  // Same pattern as recorder:export — main owns the disk.
  ipcMain.handle(
    'report:save',
    async (_event, markdown: string, defaultName: string): Promise<string | null> => {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save bug report',
        defaultPath: defaultName || 'bug-report.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (result.canceled || !result.filePath) return null
      await writeFile(result.filePath, markdown, 'utf-8')
      return result.filePath
    }
  )

  // === Export ========================================================
  // React generates the Playwright code (it owns the steps); main just saves
  // it to disk, because only the backstage engine is allowed to touch files.
  // Returns the saved file path, or null if the user cancels the dialog.
  ipcMain.handle(
    'recorder:export',
    async (
      _event,
      code: string,
      fixturePaths?: string[],
      sessionFile?: string,
      pageObjectCode?: string,
      pageObjectFileName?: string,
      harFile?: string,
      ciWorkflow?: string,
      configFile?: string
    ): Promise<string | null> => {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Playwright test',
        defaultPath: 'recorded.spec.ts',
        filters: [{ name: 'TypeScript test', extensions: ['ts'] }]
      })
      if (result.canceled || !result.filePath) return null
      await writeFile(result.filePath, code, 'utf-8')
      // Day 16(+): the exported test references its upload files by a relative
      // `fixtures/<name>` path. Copy each fixture into a fixtures/ folder beside
      // the saved spec so the test is self-contained — it runs on a teammate's
      // machine or in CI without the original loose files existing.
      if (fixturePaths && fixturePaths.length) {
        const fixturesDir = join(dirname(result.filePath), 'fixtures')
        await mkdir(fixturesDir, { recursive: true }).catch(() => {})
        for (const src of fixturePaths) {
          await copyFile(src, join(fixturesDir, basename(src))).catch(() => {})
        }
      }
      // Day 17: the test.use({ storageState }) the export emits points at
      // `sessions/<file>` — copy the session JSON there so the spec is portable.
      if (sessionFile) {
        const sessDir = join(dirname(result.filePath), 'sessions')
        await mkdir(sessDir, { recursive: true }).catch(() => {})
        await copyFile(join(sessionsDir, sessionFile), join(sessDir, sessionFile)).catch(() => {})
      }
      // F1: the exported test's routeFromHAR points at `hars/<file>` — put the
      // captured archive there so the deterministic replay is self-contained.
      // Prefer the saved .har on disk; if there isn't one (a fresh recording
      // exported before saving), write the in-memory capture instead.
      if (harFile && /^[a-zA-Z0-9_-]+\.har$/.test(harFile)) {
        const harDir = join(dirname(result.filePath), 'hars')
        await mkdir(harDir, { recursive: true }).catch(() => {})
        const dest = join(harDir, harFile)
        try {
          await copyFile(join(libraryDir(), '_hars', harFile), dest)
        } catch {
          if (lastCapturedHar) {
            await writeFile(dest, JSON.stringify(lastCapturedHar)).catch(() => {})
          }
        }
      }
      // Day 17 (full POM): the spec imports the page class from `./pages/<Name>` —
      // write that class file into a pages/ folder beside the spec.
      if (pageObjectCode && pageObjectFileName) {
        const pagesDir = join(dirname(result.filePath), 'pages')
        await mkdir(pagesDir, { recursive: true }).catch(() => {})
        await writeFile(join(pagesDir, pageObjectFileName), pageObjectCode, 'utf-8').catch(() => {})
      }
      // F33: a GitHub Actions workflow that runs the tests on every PR. Written to
      // .github/workflows/ RELATIVE TO THE SPEC — the file's header tells the user
      // to move it to the repo root if the spec lives in a subfolder.
      if (ciWorkflow) {
        const wfDir = join(dirname(result.filePath), '.github', 'workflows')
        await mkdir(wfDir, { recursive: true }).catch(() => {})
        await writeFile(join(wfDir, 'playwright.yml'), ciWorkflow, 'utf-8').catch(() => {})
      }
      // F17: a cross-browser playwright.config.ts written beside the spec, so
      // `npx playwright test` runs it on Chromium + Firefox + WebKit.
      if (configFile) {
        await writeFile(
          join(dirname(result.filePath), 'playwright.config.ts'),
          configFile,
          'utf-8'
        ).catch(() => {})
      }
      return result.filePath
    }
  )
}

// If the user types "google.com" we turn it into "https://google.com"
function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  // Already has a scheme we support (http/https, or file:// for a local page,
  // e.g. a test fixture) — leave it alone. Otherwise assume a bare domain.
  if (/^(https?|file):\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.qatestflow.recorder')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
