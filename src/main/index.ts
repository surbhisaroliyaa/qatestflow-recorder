import { app, shell, BrowserWindow, ipcMain, WebContentsView, dialog } from 'electron'
import { join } from 'path'
import { writeFile } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { buildSelectors, labelFrom, type ElementFacts } from './selector'
import { buildActionScript, pickCss, type ReplayStep } from './replay'

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

  // "Navigate to this URL" — adds https:// if user typed a bare domain
  ipcMain.handle('browser:navigate', async (_event, rawUrl: string) => {
    const url = normalizeUrl(rawUrl)
    hasNavigated = true
    resizeEmbedded() // unhide the embedded browser
    // Navigating via the URL bar is itself a step worth recording.
    if (isRecording) sendStep({ type: 'navigate', url })
    await embeddedBrowser.webContents.loadURL(url)
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

  // "Home" — jump straight back to the welcome screen in one click, instead of
  // walking Back through the whole history. A fresh start: also stop recording
  // (disarm the observer) so nothing is captured on the way out. Hide the
  // embedded browser and forget its history so the next navigation starts clean.
  ipcMain.handle('browser:home', () => {
    hasNavigated = false
    isRecording = false
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
  ipcMain.handle('recorder:toggle', (): boolean => {
    isRecording = !isRecording
    // Arm or disarm the observer living inside the current page.
    embeddedBrowser.webContents.send('recorder:set-active', isRecording)
    // When recording begins, log where we're starting from as the first step.
    if (isRecording) {
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
    (_event, raw: { type: string; facts: ElementFacts; value?: string; secret?: boolean }) => {
      if (!isRecording) return
      const { primary, candidates } = buildSelectors(raw.facts)
      sendStep({
        type: raw.type,
        label: labelFrom(raw.facts),
        value: raw.value,
        secret: raw.secret,
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

  // === Replay ========================================================
  // Run the recorded steps one-by-one inside the embedded browser. We report
  // progress per step so React can highlight the current/failed step, and stop
  // at the first failure (basic — smart waits/recovery come later).
  ipcMain.handle(
    'recorder:replay',
    async (
      _event,
      steps: ReplayStep[]
    ): Promise<{ ok: boolean; failedAt?: number; error?: string }> => {
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

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]
        mainWindow.webContents.send('recorder:replay-progress', { index: i, status: 'running' })
        try {
          if (step.type === 'navigate') {
            hasNavigated = true
            resizeEmbedded()
            await embeddedBrowser.webContents.loadURL(step.url ?? '')
          } else {
            const css = pickCss(step)
            if (!css) throw new Error('No usable CSS selector for this step')
            const result = await embeddedBrowser.webContents.executeJavaScript(
              buildActionScript(step, css),
              true
            )
            if (!result || !result.ok) throw new Error(result?.error || 'Action failed')
          }
          mainWindow.webContents.send('recorder:replay-progress', { index: i, status: 'done' })
          await wait(450)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          mainWindow.webContents.send('recorder:replay-progress', {
            index: i,
            status: 'error',
            error: message
          })
          return { ok: false, failedAt: i, error: message }
        }
      }
      return { ok: true }
    }
  )

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
