import { app, shell, BrowserWindow, ipcMain, WebContentsView, dialog } from 'electron'
import { join } from 'path'
import { writeFile, mkdir } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { buildSelectors, labelFrom, type ElementFacts } from './selector'
import {
  buildActionScript,
  buildFailureMarkScript,
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
  libraryDir,
  type RunInfo
} from './library'

// Small pause so a human can watch each replayed step happen.
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Height in pixels reserved at the top of the window for our React chrome
// (URL bar + back/forward/reload buttons). Everything below this is the
// embedded browser showing the website under test.
const CHROME_HEIGHT = 60

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

  // === The embedded browser — a real Chrome view that loads the website ===
  // We inject the "recorder" observer preload into every page it loads, so it
  // can watch for clicks/typing while recording is ON.
  const embeddedBrowser = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/recorder.js'),
      sandbox: false
    }
  })
  mainWindow.contentView.addChildView(embeddedBrowser)

  // Recording on/off lives here in main, because main is the hub that merges
  // page events (from the observer) with navigation events (which main owns).
  let isRecording = false

  // Until the user navigates to a real URL, we keep the embedded browser
  // hidden (zero size) so the React welcome page is visible across the
  // whole window. After first navigation, it expands to fill below the chrome.
  let hasNavigated = false

  // The embedded browser is a NATIVE pane painted ON TOP of our React screen,
  // so it covers any React pop-up (e.g. the export modal). While an overlay is
  // open we hide the browser by shrinking it to nothing, then restore it.
  let overlayOpen = false

  const resizeEmbedded = (): void => {
    if (!hasNavigated || overlayOpen) {
      embeddedBrowser.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      return
    }
    // getContentBounds = the drawable area inside the window frame, so the
    // native browser view and the CSS panel measure from the same ruler and
    // meet exactly at width - PANEL_WIDTH (no overlap, no gap at the seam).
    const { width, height } = mainWindow.getContentBounds()
    embeddedBrowser.setBounds({
      x: 0,
      y: CHROME_HEIGHT,
      width: Math.max(0, width - PANEL_WIDTH),
      height: Math.max(0, height - CHROME_HEIGHT)
    })
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
  const loadUrlTolerantly = async (url: string): Promise<void> => {
    try {
      await embeddedBrowser.webContents.loadURL(url)
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
    const history = embeddedBrowser.webContents.navigationHistory
    if (history.canGoBack()) {
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
    const history = embeddedBrowser.webContents.navigationHistory
    if (history.canGoForward()) {
      history.goForward()
      return true
    }
    return false
  })

  ipcMain.handle('browser:reload', () => {
    embeddedBrowser.webContents.reload()
  })

  // When the React UI opens a full-window overlay (e.g. the export modal), hide
  // the native embedded browser so it doesn't cover the overlay; restore after.
  ipcMain.handle('browser:setOverlay', (_event, open: boolean) => {
    overlayOpen = open
    resizeEmbedded()
  })

  // The embedded page's live URL + title — the renderer can't see inside the
  // native browser view, so page-level checks (Day 11) ask main for prefills.
  ipcMain.handle('browser:getPageInfo', (): { url: string; title: string } => ({
    url: embeddedBrowser.webContents.getURL(),
    title: embeddedBrowser.webContents.getTitle()
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
    embeddedBrowser.webContents.send('recorder:set-active', false)
    resizeEmbedded() // hide the embedded browser
    try {
      embeddedBrowser.webContents.navigationHistory.clear()
    } catch {
      // older Electron versions might not have clear(); safe to ignore
    }
  })

  // === Tell the React UI whenever the embedded browser changes URL ===
  const notifyUrlChange = (url: string): void => {
    mainWindow.webContents.send('browser:url-changed', url)
  }

  embeddedBrowser.webContents.on('did-navigate', (_event, url) => notifyUrlChange(url))
  embeddedBrowser.webContents.on('did-navigate-in-page', (_event, url) => notifyUrlChange(url))

  // === Recording =====================================================
  // One door for steps: whether a step came from the observer (a click/type
  // inside the page) or from main itself (a navigation), it leaves through
  // here on its way to the React panel.
  const sendStep = (step: Record<string, unknown>): void => {
    mainWindow.webContents.send('recorder:step', step)
  }

  // Start/stop recording. Returns the new state so React stays in sync.
  // `resume` = continue an existing recording: we DON'T log a starting Go-to
  // step (the existing list already begins with one), we just append more.
  ipcMain.handle('recorder:toggle', (_event, resume?: boolean): boolean => {
    isRecording = !isRecording
    // Arm or disarm the observer living inside the current page.
    embeddedBrowser.webContents.send('recorder:set-active', isRecording)
    // When a FRESH recording begins, log where we're starting from as step 1.
    if (isRecording && !resume) {
      const url = embeddedBrowser.webContents.getURL()
      if (url && !url.startsWith('data:')) sendStep({ type: 'navigate', url })
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
      _event,
      raw: { type: string; facts: ElementFacts; value?: string; secret?: boolean; key?: string }
    ) => {
      if (!isRecording) return
      const { primary, candidates } = buildSelectors(raw.facts)
      sendStep({
        type: raw.type,
        label: labelFrom(raw.facts),
        value: raw.value,
        secret: raw.secret,
        key: raw.key,
        selector: primary,
        candidates
      })
    }
  )

  // Every page load gives us a fresh copy of the observer that starts OFF
  // (its `recording` flag resets to false). If we're recording, re-arm it.
  embeddedBrowser.webContents.on('did-finish-load', () => {
    if (isRecording) embeddedBrowser.webContents.send('recorder:set-active', true)
  })

  // === Element picker (Day 9) ========================================
  // The renderer turns pick mode on/off; the observer in the page does the
  // pointing. A picked element comes back as raw facts — run them through the
  // selector engine (same as recorded steps) before handing to the UI.
  ipcMain.handle('recorder:setPicking', (_event, active: boolean) => {
    embeddedBrowser.webContents.send('recorder:set-picking', active)
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
      }
    ) => {
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
        groupCount
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
    action: 'retry' | 'skip' | 'stop' | 'abort'
    step?: ReplayStep // a re-pick sends the healed step to retry with
  }
  let recoveryResolve: ((decision: RecoveryDecision) => void) | null = null
  const resolveRecovery = (decision: RecoveryDecision): void => {
    const pending = recoveryResolve
    recoveryResolve = null
    pending?.(decision)
  }
  ipcMain.on('recorder:recovery', (_event, decision: RecoveryDecision) =>
    resolveRecovery(decision)
  )

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
      interactive?: boolean
    ): Promise<{
      ok: boolean
      failedAt?: number
      error?: string
      screenshotPath?: string
      aborted?: boolean
    }> => {
      // A dangling pause from a previous replay can never be answered — clear it.
      resolveRecovery({ action: 'abort' })
      overlayOpen = false // make sure the browser is visible while replaying

      // Test isolation: start EVERY replay from a clean state (fresh cookies +
      // localStorage), exactly like a real Playwright test gets a fresh browser
      // context. Without this, leftover state — e.g. an item already in the cart
      // from the recording session — breaks the replay ("Add to cart" is gone).
      try {
        await embeddedBrowser.webContents.session.clearStorageData({
          storages: ['cookies', 'localstorage']
        })
      } catch {
        // best-effort; continue even if clearing isn't supported
      }

      // Hover steps need a REAL mouse move. Electron's sendInputEvent delivers
      // the event to page JavaScript but does NOT reliably switch on CSS
      // :hover styling (electron/electron#13511). So we attach the Chrome
      // DevTools Protocol (CDP) and use Input.dispatchMouseEvent — the same
      // engine-level channel Playwright's .hover() uses. Attached once per
      // replay, detached in the finally below.
      const cdp = embeddedBrowser.webContents.debugger
      let cdpReady = false
      try {
        if (!cdp.isAttached()) cdp.attach('1.3')
        cdpReady = true
      } catch {
        // attach can fail (e.g. DevTools already attached) — we'll fall back
        // to sendInputEvent, which at least delivers JS mouse events.
      }

      // Every exit from the replay goes through here so the CDP debugger is
      // always released, pass or fail.
      const finish = (outcome: {
        ok: boolean
        failedAt?: number
        error?: string
        screenshotPath?: string
        aborted?: boolean
      }): {
        ok: boolean
        failedAt?: number
        error?: string
        screenshotPath?: string
        aborted?: boolean
      } => {
        if (cdpReady) {
          try {
            cdp.detach()
          } catch {
            // already detached — fine
          }
        }
        return outcome
      }

      // Local copy so a re-pick can swap in a healed step mid-run without
      // mutating the renderer's array (it sends its own update separately).
      const list = steps.slice()

      for (let i = 0; i < list.length; i++) {
        const step = list[i]
        // Steps turned off in the editor are skipped — leave their row neutral
        // (no running/done/error) so the UI shows them as inert, not run.
        if (step.disabled) continue
        mainWindow.webContents.send('recorder:replay-progress', { index: i, status: 'running' })
        try {
          if (step.type === 'navigate') {
            hasNavigated = true
            resizeEmbedded()
            try {
              await embeddedBrowser.webContents.loadURL(step.url ?? '')
            } catch (err) {
              // ERR_ABORTED = the request was superseded (redirect / retry) —
              // a page IS loading, just not via the original request. Treat
              // as success; the next step's smart-wait does the real
              // verifying. Anything else (DNS, refused) fails honestly.
              const message = err instanceof Error ? err.message : String(err)
              if (!message.includes('ERR_ABORTED')) throw err
            }
          } else if (step.type === 'wait') {
            // An explicit pause — no element involved, just time (Day 9).
            const seconds = Math.max(0, parseFloat(step.value ?? '0') || 0)
            await wait(seconds * 1000)
          } else {
            // The injected finder resolves the element through the full
            // candidate ladder (role / text / CSS), strongest-first.
            const result = await embeddedBrowser.webContents.executeJavaScript(
              buildActionScript(step),
              true
            )
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
                embeddedBrowser.webContents.sendInputEvent({ type: 'mouseMove', x, y })
              }
              await wait(150)
            }
          }
          mainWindow.webContents.send('recorder:replay-progress', { index: i, status: 'done' })
          await wait(450)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // Day 11.5: photograph the page AT the moment of failure — evidence
          // for a human now and required input for Day 13's AI translator.
          // Best-effort: a screenshot problem must never mask the real error.
          let screenshotPath: string | undefined
          try {
            // Day 12.9: annotate the evidence first — red error banner, plus
            // an outline around the culprit element when it still resolves.
            // Draw → capture → erase: the marks live only inside the PNG.
            try {
              await embeddedBrowser.webContents.executeJavaScript(
                buildFailureMarkScript(step, message),
                true
              )
              await wait(120) // let the scroll + overlay paint before capture
            } catch {
              // decoration failed — capture the plain screenshot anyway
            }
            const image = await embeddedBrowser.webContents.capturePage()
            const dir = join(libraryDir(), '_failures')
            await mkdir(dir, { recursive: true })
            screenshotPath = join(dir, `failure-${Date.now()}.png`)
            await writeFile(screenshotPath, image.toPNG())
          } catch {
            screenshotPath = undefined
          }
          try {
            await embeddedBrowser.webContents.executeJavaScript(removeFailureMarkScript(), true)
          } catch {
            // page may be gone — nothing to clean
          }
          mainWindow.webContents.send('recorder:replay-progress', {
            index: i,
            status: 'error',
            error: message
          })
          // Day 12: in an interactive replay we PAUSE here instead of ending.
          // The browser is sitting in the exact state where things broke —
          // ideal for retrying or re-picking the element. The loop holds on
          // this promise until the user's decision arrives over IPC.
          if (interactive) {
            mainWindow.webContents.send('recorder:replay-paused', {
              index: i,
              error: message,
              screenshotPath
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
            if (decision.action === 'skip') {
              mainWindow.webContents.send('recorder:replay-progress', {
                index: i,
                status: 'skipped'
              })
              continue
            }
            if (decision.action === 'abort') {
              // Home was pressed mid-pause — end quietly, nothing to report.
              return finish({ ok: false, failedAt: i, error: message, aborted: true })
            }
            // 'stop' falls through to the normal failure return below.
          }
          return finish({ ok: false, failedAt: i, error: message, screenshotPath })
        }
      }
      return finish({ ok: true })
    }
  )

  // === Test library (Day 11) =========================================
  // Thin IPC wrappers — all the real logic (paths, slugs, safety) lives in
  // library.ts where it's testable without Electron wiring.
  ipcMain.handle(
    'library:save',
    (_event, input: { name: string; baseURL: string; suite: string; steps: unknown[] }) =>
      saveTest(input)
  )
  ipcMain.handle('library:list', () => listTests())
  ipcMain.handle('library:listSuites', () => listSuites())
  ipcMain.handle('library:load', (_event, fileName: string) => loadTest(fileName))
  ipcMain.handle('library:delete', (_event, fileName: string) => deleteTest(fileName))
  ipcMain.handle('library:recordRun', (_event, fileName: string, run: RunInfo) =>
    recordRun(fileName, run)
  )
  // Open a failure screenshot in the OS image viewer. Only paths inside the
  // library folder are allowed — this is a viewer, not a general file opener.
  ipcMain.handle('library:openScreenshot', (_event, path: string) => {
    if (typeof path === 'string' && path.startsWith(libraryDir())) shell.openPath(path)
  })

  // === Export ========================================================
  // React generates the Playwright code (it owns the steps); main just saves
  // it to disk, because only the backstage engine is allowed to touch files.
  // Returns the saved file path, or null if the user cancels the dialog.
  ipcMain.handle('recorder:export', async (_event, code: string): Promise<string | null> => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Playwright test',
      defaultPath: 'recorded.spec.ts',
      filters: [{ name: 'TypeScript test', extensions: ['ts'] }]
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, code, 'utf-8')
    return result.filePath
  })
}

// If the user types "google.com" we turn it into "https://google.com"
function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
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
