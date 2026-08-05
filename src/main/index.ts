import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  WebContentsView,
  dialog,
  webFrameMain,
  nativeImage,
  Notification
} from 'electron'
import {
  listMonitors,
  saveMonitor,
  deleteMonitor,
  recordMonitorRun,
  type Monitor,
  type MonitorRun
} from './monitors'
import { join, basename, dirname } from 'path'
import { execFile } from 'child_process'
import { writeFile, mkdir, copyFile, readFile, readdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { buildSelectors, labelFrom, type ElementFacts } from './selector'
import {
  buildActionScript,
  buildFailureMarkScript,
  buildLocateRectScript,
  buildProbeScript,
  buildCollectionScript,
  removeFailureMarkScript,
  type ReplayStep
} from './replay'
// F37: loops + branching. Shared with the renderer's Playwright export so the
// app and the exported spec can never disagree about how a loop runs.
import { analyzeControlFlow, isControlStep, resolveLoopTokens } from '../shared/controlFlow'
import { collidesWithOsEnv } from '../shared/osEnvNames'
// F40: passwords live in userData, not in the shared test files.
import { resolveSecrets, getSecrets, migratePlaintextSecrets } from './secrets'
// F40: export/import the library as a portable, git-committable bundle.
import { exportBundle, inspectBundle, importBundle, type ImportPlanEntry } from './bundle'
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
  evaluateNlAssertions,
  type NlVerdict,
  categorizeFailure,
  deepRcaFailure,
  generateAiSteps,
  mapAcCoverage,
  draftTestFromStory,
  type AcCoverage,
  type FailureEvidence,
  type FailureCategory
} from './translator'
import { loadAcs, saveAcs } from './acStore'
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
// F1: how long a HAR-intercepted request may stay paused before we give up and
// let it hit the live network. Deciding what to serve is pure in-memory work
// (match + base64), so anything still outstanding after this went wrong — and a
// slightly slow request beats a page that hangs forever with no error.
const HAR_PAUSE_WATCHDOG_MS = 5000
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
  rememberRetargetChoice,
  forgetRetargetChoices,
  activeEnvVars,
  activeEnvironment,
  type Environment
} from './environments'
import {
  cancelBrowserInstall,
  checkPlaywright,
  installBrowsers,
  runCrossBrowser,
  runSuiteParallel,
  type BrowserName,
  type ParallelSpec
} from './xbrowser'
import { runApiStep, type ApiEvidence } from './apiStep'
import {
  newRunTokens,
  resolveRuntimeStep,
  resolveRuntimeText,
  applySaves,
  type RunTokens
} from './runtimeTokens'
import {
  saveEdgeRun,
  listEdgeRuns,
  loadEdgeRun,
  deleteEdgeRun,
  protectedEdgeTraceIds,
  type EdgeRunRecord
} from './edgeRuns'

// Small pause so a human can watch each replayed step happen.
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Turn a thrown fetch error into something a user can act on.
 *
 * Node's fetch reports every connection-level problem as the bare string
 * "fetch failed" — no host, no cause, no hint. Surfaced raw (as Jira and the
 * webhook both used to), it tells someone who mistyped a URL or whose VPN is
 * down precisely nothing, and it breaks the pattern set by the rest of these
 * errors ("Unauthorized — check the email + API token").
 */
function reachError(e: unknown, url: string): string {
  const raw = e instanceof Error ? e.message : String(e)
  const host = (() => {
    try {
      return new URL(url).host
    } catch {
      return url
    }
  })()
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET/i.test(raw)) {
    // `cause` is where Node hides the actual reason; include it when it's there.
    const cause = (e as { cause?: { code?: string } })?.cause?.code
    return `Couldn’t reach ${host} — check the URL and your connection.${cause ? ` (${cause})` : ''}`
  }
  if (/certificate|self.signed|CERT_/i.test(raw)) {
    return `Couldn’t verify the HTTPS certificate for ${host}. (${raw})`
  }
  return raw
}

// F29 (chaos): the latency of Chrome DevTools' "Slow 3G" profile. ONE constant, so
// the CDP throttle applied to the browser tab and the delay applied to API steps
// (which run on Node's fetch, out of CDP's reach) can never drift apart — a chaos
// run has to be equally slow for both halves of the test or it proves nothing.
const SLOW_NETWORK_LATENCY_MS = 2000

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

// F15: mask selectors text (one per line / comma-separated) → a clean list.
function parseMaskSelectors(text?: string): string[] {
  if (!text) return []
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// F15 (smarter visual diffing): capture the page for a visual snapshot with two
// stabilizers applied identically to BOTH the baseline and the compared image,
// so neither can cause a false diff:
//   • freeze — disable CSS animations/transitions (default on) so a mid-flight
//     frame doesn't differ from the baseline.
//   • mask — paint an opaque box over each masked selector's rect (same colour
//     on both sides), excluding dynamic regions (clock/ad/carousel) from the diff.
// The injected nodes are removed after the shot, so the page is left untouched.
// True FULL-PAGE screenshot: the entire scrollable document, not just the visible
// viewport that capturePage() gives. This makes visual snapshots scroll-independent
// — baseline and replay both photograph the whole page, so where either happens to
// be scrolled no longer matters and content anywhere (top, middle, below the fold)
// is verified. Done via CDP Page.captureScreenshot with captureBeyondViewport.
// The app also attaches the CDP debugger for HAR capture, so REUSE an existing
// session when one's attached (attaching twice throws) and only detach if we opened
// it. Any CDP failure (DevTools open, page too tall) falls back to the viewport.
async function captureFullPage(wc: Electron.WebContents): Promise<Electron.NativeImage> {
  const alreadyAttached = wc.debugger.isAttached()
  try {
    if (!alreadyAttached) wc.debugger.attach('1.3')
  } catch {
    return wc.capturePage()
  }
  try {
    const metrics = (await wc.debugger.sendCommand('Page.getLayoutMetrics')) as {
      contentSize?: { width: number; height: number }
      cssContentSize?: { width: number; height: number }
    }
    const size = metrics.cssContentSize || metrics.contentSize
    if (!size || size.width <= 0 || size.height <= 0) return wc.capturePage()
    const shot = (await wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: Math.ceil(size.width),
        height: Math.ceil(size.height),
        scale: 1
      }
    })) as { data: string }
    return nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'))
  } catch {
    return wc.capturePage()
  } finally {
    if (!alreadyAttached && wc.debugger.isAttached()) {
      try {
        wc.debugger.detach()
      } catch {
        // already gone
      }
    }
  }
}

async function captureStabilized(
  wc: Electron.WebContents,
  maskSelectors?: string,
  freezeAnimations?: boolean
): Promise<Electron.NativeImage> {
  const selectors = parseMaskSelectors(maskSelectors)
  const freeze = freezeAnimations !== false // default ON (undefined = on)
  // Always inject: even with no freeze/mask we must reset scroll to the top before
  // capturing. capturePage() photographs only the CURRENT viewport, so a baseline
  // taken at the top and a replay capture left scrolled by earlier steps would show
  // different slices of the page and diff ~100% with nothing actually changed. Reset
  // scroll first (smooth-scroll off so it jumps instantly), THEN measure the masks —
  // they're viewport-fixed, so they must be positioned at this same scroll offset.
  await wc
    .executeJavaScript(
      `(() => {
          const D = (window.__qaflowVisual = { freeze: null, masks: [] });
          const de = document.documentElement;
          const prevBehavior = de.style.scrollBehavior;
          de.style.scrollBehavior = 'auto';
          window.scrollTo(0, 0);
          de.style.scrollBehavior = prevBehavior;
          if (${freeze ? 'true' : 'false'}) {
            const s = document.createElement('style');
            s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}html{scroll-behavior:auto!important;}';
            document.head.appendChild(s);
            D.freeze = s;
          }
          // Full-page capture covers the whole document, so masks are positioned in
          // DOCUMENT coordinates (absolute = viewport rect + scroll offset), not the
          // viewport-fixed coords a viewport-only capture used — otherwise a mask
          // below the fold would sit at the wrong place in the tall stitched image.
          const sx = window.scrollX, sy = window.scrollY;
          for (const sel of ${JSON.stringify(selectors)}) {
            let els; try { els = document.querySelectorAll(sel); } catch { continue; }
            for (const el of els) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              const o = document.createElement('div');
              o.setAttribute('data-qaflow-mask', '1');
              o.style.cssText = 'position:absolute;z-index:2147483647;background:#FF00FF;pointer-events:none;left:'+(r.left+sx)+'px;top:'+(r.top+sy)+'px;width:'+r.width+'px;height:'+r.height+'px;';
              document.body.appendChild(o);
              D.masks.push(o);
            }
          }
        })()`,
      true
    )
    .catch(() => {})
  await wait(120) // let the scroll reset + freeze + overlays settle and paint
  const image = await captureFullPage(wc)
  await wc
    .executeJavaScript(
      `(() => {
          const D = window.__qaflowVisual; if (!D) return;
          if (D.freeze) D.freeze.remove();
          for (const m of D.masks) m.remove();
          window.__qaflowVisual = null;
        })()`,
      true
    )
    .catch(() => {})
  return image
}

// F18: injected into the current page to list its INTERACTIVE elements, each
// with real selector candidates (test-id / id / name / role+name / text), so the
// AI-prompt step can map an intent onto elements WE can locate — the model picks
// which element by index, never invents a selector. Visible + enabled only,
// capped at 60. `index` mirrors array position so the caller can look each up.
const AI_CAPTURE_JS = `(() => {
  const q = (s) => JSON.stringify(String(s));
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const accName = (el) => {
    const al = el.getAttribute('aria-label'); if (al) return norm(al);
    if (el.id) { const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (lab) { const t = norm(lab.textContent); if (t) return t; } }
    const cl = el.closest && el.closest('label'); if (cl) { const t = norm(cl.textContent); if (t) return t; }
    const ph = el.getAttribute('placeholder'); if (ph) return norm(ph);
    const tc = norm(el.textContent); if (tc) return tc.slice(0, 60);
    const v = el.getAttribute('value'); if (v) return norm(v);
    const nm = el.getAttribute('name'); if (nm) return nm;
    return el.tagName.toLowerCase();
  };
  const roleOf = (el) => {
    const r = el.getAttribute('role'); if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') { const t = (el.getAttribute('type') || 'text').toLowerCase(); if (t === 'submit' || t === 'button') return 'button'; if (t === 'checkbox') return 'checkbox'; if (t === 'radio') return 'radio'; return 'textbox'; }
    return '';
  };
  const randomId = (id) => id.length > 40 || id.includes(' ') || id.includes(':') || /[0-9]{4,}/.test(id);
  const SEL = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[contenteditable="true"]';
  const els = Array.from(document.querySelectorAll(SEL)).filter((el) => {
    if (el.disabled) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') return false;
    if ((el.getAttribute('type') || '').toLowerCase() === 'hidden') return false;
    return true;
  }).slice(0, 60);
  const out = [];
  els.forEach((el) => {
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.getAttribute('type') || 'text') : '';
    const label = accName(el);
    const cands = [];
    const dt = el.getAttribute('data-test'); if (dt) cands.push({ kind: 'testId', score: 95, css: '[data-test=' + q(dt) + ']', locator: 'getByTestId(' + q(dt) + ')' });
    const dti = el.getAttribute('data-testid'); if (dti) cands.push({ kind: 'testId', score: 95, css: '[data-testid=' + q(dti) + ']', locator: 'getByTestId(' + q(dti) + ')' });
    if (el.id && !randomId(el.id)) cands.push({ kind: 'id', score: 88, css: '#' + CSS.escape(el.id), locator: 'locator(' + q('#' + el.id) + ')' });
    const nm = el.getAttribute('name'); if (nm) cands.push({ kind: 'name', score: 82, css: '[name=' + q(nm) + ']', locator: 'locator(' + q('[name=' + nm + ']') + ')' });
    const role = roleOf(el); if (role && label) cands.push({ kind: 'role', score: 74, css: null, role: role, name: label, locator: 'getByRole(' + q(role) + ', { name: ' + q(label) + ' })' });
    if ((tag === 'button' || tag === 'a' || role === 'button' || role === 'link') && label) cands.push({ kind: 'text', score: 64, css: null, text: label, locator: 'getByText(' + q(label) + ')' });
    if (cands.length) out.push({ index: out.length, tag: tag, type: type, label: label, candidates: cands });
  });
  return out;
})()`

// Height in pixels reserved at the top of the window for our React chrome
// (URL bar + back/forward/reload buttons). Everything below this is the
// embedded browser showing the website under test.
// NOTE: two-row toolbar — this MUST equal the `.chrome` height in main.css
// (row 1 = browser bar, row 2 = QA tool belt), or the native browser view
// won't line up with the empty browser area beneath the toolbar.
const CHROME_HEIGHT = 104

// Day 17 (multiple windows): height reserved for the tab strip, shown ONLY when
// more than one tab is open. When visible, the embedded browser starts this
// much further down. The renderer renders the same-height strip under the same
// condition, so the React strip and the native view line up exactly. MUST match
// the .tab-strip height in main.css.
const TAB_STRIP_HEIGHT = 34

// F15: default absolute changed-pixel floor for a visual snapshot. A % threshold
// alone dilutes a small localized change (a recoloured button, a badge) on a large
// full-page image below the bar, so we also fail past this raw count. Small on
// purpose — an identical re-render changes ~0 pixels (the diff's colour tolerance
// filters anti-aliasing) — so it catches real changes without flaky failures.
const DEFAULT_MAX_DIFF_PIXELS = 200

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

  const startHarCapture = (wc: Electron.WebContents): Promise<void> => {
    if (harCapture) return Promise.resolve() // already capturing
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
      return Promise.resolve() // can't attach (DevTools open?) — capture unavailable
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
    harCapture = { wc, onMessage }
    lastCapturedHar = log // grows live; finalized (kept or discarded) on stop
    // Resolve once Network events are actually flowing, so the caller can reload
    // the page to capture its load and know the reload's requests will be seen.
    return d
      .sendCommand('Network.enable')
      .catch(() => {})
      .then(() => undefined)
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

  // F36 (device emulation): the four signals a real phone has that a narrow
  // window does NOT. Size is still handled by viewportOverride above (a real
  // native resize — the page genuinely lays out at that width); these are the
  // rest, applied over CDP. Null = a plain desktop browser.
  let deviceOverride: {
    userAgent?: string
    deviceScaleFactor?: number
    isMobile?: boolean
    hasTouch?: boolean
  } | null = null

  // Push the current device signals onto one tab. Called when the device is
  // chosen, when a new tab is created, and again when replay (re)attaches its
  // debugger — a detach drops CDP overrides, so re-applying is what keeps a
  // mobile run mobile all the way through.
  //
  // Every command is best-effort: device emulation must never be the reason a
  // run fails. UA goes through Electron's own setUserAgent (persistent on the
  // WebContents, survives a debugger detach) AND through CDP so the client-hint
  // headers (sec-ch-ua-mobile / platform) agree with it — a site that reads
  // hints instead of the UA string would otherwise still see a desktop.
  const applyDeviceTo = (wc: Electron.WebContents): void => {
    if (wc.isDestroyed()) return
    const dev = deviceOverride
    try {
      wc.setUserAgent(dev?.userAgent || wc.session.getUserAgent())
    } catch {
      // best-effort
    }
    let d: Electron.Debugger
    try {
      d = wc.debugger
      if (!d.isAttached()) d.attach('1.3')
    } catch {
      // DevTools already owns the debugger — size emulation still applies, and
      // the exported spec carries the full device regardless.
      return
    }
    const send = (m: string, p: Record<string, unknown>): void => {
      d.sendCommand(m, p).catch(() => {})
    }
    if (!dev) {
      // Clear a previous device so the next plain run isn't stuck pretending to
      // be a phone (same reasoning as the F28 locale else-branch).
      send('Emulation.clearDeviceMetricsOverride', {})
      send('Emulation.setTouchEmulationEnabled', { enabled: false })
      send('Emulation.setEmitTouchEventsForMouse', { enabled: false })
      send('Network.setUserAgentOverride', { userAgent: wc.session.getUserAgent() })
      return
    }
    // width/height 0 = "don't override the size" — the native resize already did
    // that, and overriding it here too would fight it.
    send('Emulation.setDeviceMetricsOverride', {
      width: 0,
      height: 0,
      deviceScaleFactor: dev.deviceScaleFactor ?? 0,
      mobile: !!dev.isMobile
    })
    // maxTouchPoints is deliberately 1, not the 5 a real phone reports.
    // Verified against real Playwright: `devices['iPhone 13']` leaves
    // navigator.maxTouchPoints at 0 on BOTH chromium and webkit, while
    // `ontouchstart` and `@media (pointer: coarse)` are correctly set. Claiming
    // 5 here would make the in-app run MORE touch-capable than the exported
    // spec — a test asserting on maxTouchPoints would pass in the app and fail
    // in CI. Parity with the export beats realism: this app's whole identity is
    // that a green run can be trusted.
    send('Emulation.setTouchEmulationEnabled', {
      enabled: !!dev.hasTouch,
      maxTouchPoints: dev.hasTouch ? 1 : 0
    })
    // Without this, touch is only ADVERTISED (ontouchstart exists) but a click
    // still arrives as a mouse event, so tap-only handlers never fire.
    send('Emulation.setEmitTouchEventsForMouse', {
      enabled: !!dev.hasTouch,
      configuration: 'mobile'
    })
    if (dev.userAgent) {
      const isIOS = /iPhone|iPad/.test(dev.userAgent)
      const isAndroid = /Android/.test(dev.userAgent)
      send('Network.setUserAgentOverride', {
        userAgent: dev.userAgent,
        platform: isIOS ? 'iPhone' : isAndroid ? 'Linux armv8l' : undefined,
        userAgentMetadata: {
          platform: isIOS ? 'iOS' : isAndroid ? 'Android' : 'Windows',
          platformVersion: '',
          architecture: '',
          model: '',
          mobile: !!dev.isMobile
        }
      })
    }
  }

  const applyDeviceToAllTabs = (): void => {
    for (const t of tabs) applyDeviceTo(t.view.webContents)
  }

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

  // `hasNavigated` exists in BOTH processes, and nothing kept them in step. If
  // the renderer reloads (Vite HMR in dev; a renderer crash in production) it
  // comes back believing nothing has been navigated and draws the welcome
  // screen — while main still thinks a page is open and keeps painting the
  // native browser view straight over it. Surbhi hit exactly that: a 390px-wide
  // strip of SauceDemo covering a third of the library.
  //
  // The renderer now declares its view state on mount, and main obeys. This is
  // the same divergence that caused the F39 empty-workspace bug from the other
  // direction — one process guessing what the other believes.
  ipcMain.handle('browser:syncNavigated', (_event, navigated: boolean) => {
    hasNavigated = !!navigated
    resizeEmbedded()
  })

  // Day 17 (viewport emulation): render at a fixed viewport (or null = fill).
  // Kept as its own channel — a size-only preset (and every test saved before
  // F36) goes through here and must behave exactly as it always did.
  ipcMain.handle(
    'browser:setViewport',
    (_event, viewport: { width: number; height: number } | null) => {
      viewportOverride = viewport && viewport.width > 0 && viewport.height > 0 ? viewport : null
      deviceOverride = null
      applyDeviceToAllTabs()
      resizeEmbedded()
    }
  )

  // F36 (device emulation): size AND the four signals that make it a real phone.
  // Passing null returns the browser to a plain desktop.
  ipcMain.handle(
    'browser:setDevice',
    (
      _event,
      device: {
        viewport: { width: number; height: number }
        userAgent?: string
        deviceScaleFactor?: number
        isMobile?: boolean
        hasTouch?: boolean
      } | null
    ) => {
      viewportOverride =
        device && device.viewport.width > 0 && device.viewport.height > 0 ? device.viewport : null
      deviceOverride = device
        ? {
            userAgent: device.userAgent,
            deviceScaleFactor: device.deviceScaleFactor,
            isMobile: device.isMobile,
            hasTouch: device.hasTouch
          }
        : null
      applyDeviceToAllTabs()
      resizeEmbedded()
      // A UA/touch change only takes full effect on the next document — a page
      // already rendered as desktop keeps its desktop layout otherwise, which
      // looks exactly like the feature not working.
      try {
        if (hasNavigated) activeWC().reload()
      } catch {
        // nothing loaded yet — the next navigation picks it up
      }
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
        sandbox: false,
        // Own session bucket, separate from the app UI (localhost:5173, on the
        // default session). Per-run test isolation calls clearStorageData() on this
        // session with no origin filter; without a partition that wipe also erased
        // the app UI's OWN localStorage (e.g. the saved traceMode). All tabs share
        // this one partition, so cookies/session-block/downloads stay shared as
        // before — only the app UI is now insulated from the wipe.
        partition: 'persist:qaflow-browser'
      }
    })
    mainWindow.contentView.addChildView(view)
    // F36: a popup/second tab must be the SAME device as the tab that opened it
    // — a flow that hops to a new tab mid-way would otherwise silently revert to
    // desktop halfway through a mobile test.
    applyDeviceTo(view.webContents)
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
        // The page the user is already on loaded BEFORE capture started (on the
        // welcome-screen navigation), so it isn't in the HAR. Once capture is live,
        // reload it — its full load lands in the HAR, matching the "Go to <url>"
        // step replay will run. A real user just does Net ON → Record; no manual
        // reload needed. did-navigate records no step, so the reload adds no junk.
        const wc = activeWC()
        startHarCapture(wc).then(() => {
          const u = wc.getURL()
          if (u && !u.startsWith('data:')) {
            try {
              wc.reload()
            } catch {
              // view gone mid-start — nothing to capture
            }
          }
        })
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

  /**
   * When does each saved session expire?
   *
   * A saved session is a login that quietly rots. Surbhi's `saucedemo-auth`
   * cookie expired on 26 June; four tests went on PASSING in the app for another
   * month, because the embedded browser was still logged in from ordinary use —
   * the session file was never what made them green. Headless, where no such
   * leftover state exists, all four failed. So the app was reporting green for
   * tests that would fail on anybody else's machine and in CI: the exact
   * false-green this whole app exists to prevent, hiding inside a "pass".
   *
   * We report the EARLIEST real expiry: a session is only as alive as the first
   * cookie to die, and it's usually the auth one. Session-scoped cookies (no
   * expiry) can't be judged from the file and are ignored rather than guessed at.
   */
  ipcMain.handle(
    'session:status',
    async (): Promise<{ file: string; expiresAt: number | null; expired: boolean }[]> => {
      const files = await readdir(sessionsDir).catch(() => [] as string[])
      const out: { file: string; expiresAt: number | null; expired: boolean }[] = []
      for (const file of files.filter((f) => f.endsWith('.json'))) {
        try {
          const raw = await readFile(join(sessionsDir, file), 'utf-8')
          const state = JSON.parse(raw) as PWStorageState
          const stamps = (state.cookies ?? [])
            .map((c) => c.expires)
            .filter((e): e is number => typeof e === 'number' && e > 0)
          const expiresAt = stamps.length ? Math.min(...stamps) * 1000 : null
          out.push({ file, expiresAt, expired: expiresAt !== null && expiresAt < Date.now() })
        } catch {
          // Unreadable file: say nothing rather than claim it's fine or broken.
          out.push({ file, expiresAt: null, expired: false })
        }
      }
      return out
    }
  )

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

  // F21b: the "add checks along a replay" pause. When the renderer has decided
  // (add a check / skip this page / stop the ride) it calls this to release the
  // held replay. `stop` aborts the whole ride like a normal replay abort.
  let checkOfferResolve: ((r: { stop?: boolean }) => void) | null = null
  ipcMain.on('recorder:check-offer-respond', (_e, resp: { stop?: boolean }) => {
    const pending = checkOfferResolve
    checkOfferResolve = null
    pending?.(resp || {})
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
      chaos?: { slowNetwork?: boolean; locale?: string },
      // F21b (Bug check across replay): when true (interactive only), the replay
      // PAUSES after each page it lands on and offers to add a grounded check for
      // THAT page — so a multi-page test gets a check per page in ONE ride, no
      // re-typing the flow. Off by default → normal replay is byte-for-byte unchanged.
      authorChecks?: boolean
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
      failures?: { index: number; error: string; screenshotPath?: string; apiEvidence?: ApiEvidence }[]
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
      // HISTORY — read before touching the interceptor below. Serving responses
      // through the CDP Fetch domain once HUNG the embedded WebContentsView, and
      // in-app serving sat behind a hardcoded kill switch from the day it was
      // written. The cause is a single invariant: a paused request that is never
      // fulfilled OR continued stalls forever, and the page waits on it with no
      // error. Two mitigations were written at the time but never actually
      // exercised, because the switch was off: only XHR/fetch are paused (never
      // the top-level navigation or static assets), and a failed fulfill falls
      // back to continue. Enabling it now adds the missing third: NOTHING can
      // leave a request paused — see the interceptor's watchdog.
      //
      // Serving only engages when a HAR is actually selected for the run, so the
      // escape hatch is simply not picking one; no-HAR replay never touches this
      // code path (everything below is gated on `replayHar`).
      const replayHar: HarLog | null =
        harFile === '__last'
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
        preImage?: Electron.NativeImage,
        // F24: an API step's HTTP exchange, recorded INSTEAD of a page shot.
        apiEvidence?: ApiEvidence
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
          networkErrors: networkErrors.slice(traceNetworkCursor).map(stripStepTag),
          apiEvidence
        }
        // Skipped steps never ran — record the row, but no page shot.
        // F24 note: an API step DOES keep its page shot here. The exchange above
        // is the evidence; the page is context, and dropping it would punch a
        // hole in the filmstrip timeline for no gain.
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
      // F37: answer an `if` step's question about the page.
      //
      // Deliberately NEVER throws for "the thing isn't there" — that's an
      // answer, not a failure. The whole point of a conditional is to handle
      // both outcomes, so treating absence as an error would defeat it. A
      // genuinely broken probe (page navigating away mid-check) resolves false,
      // which routes to the else branch — the safe direction, since the else
      // branch is where "the optional thing didn't happen" logic lives.
      const evaluateCondition = async (step: ReplayStep): Promise<boolean> => {
        const kind = step.condKind ?? 'element-visible'
        if (kind === 'url-contains') {
          const needle = (step.value ?? '').trim()
          if (!needle) return false
          return (currentWC.getURL() || '').includes(needle)
        }
        if (kind === 'text-present' || kind === 'text-absent') {
          const needle = (step.value ?? '').trim()
          if (!needle) return false
          const present = (await currentWC
            .executeJavaScript(
              `!!(document.body && document.body.innerText.includes(${JSON.stringify(needle)}))`
            )
            .catch(() => false)) as boolean
          return kind === 'text-present' ? present : !present
        }
        const probe = (await currentWC
          .executeJavaScript(buildProbeScript(step as ReplayStep), true)
          .catch(() => ({ found: false, visible: false }))) as {
          found: boolean
          visible: boolean
        }
        return kind === 'element-absent' ? !probe.visible : probe.visible
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
          // F1: the per-debugger Fetch interceptor, kept so finish() can detach it,
          // plus its in-flight watchdog timers so finish() can clear them.
          fetchListener?: CdpListener
          fetchPending?: Map<string, NodeJS.Timeout>
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
          let fetchPending: Map<string, NodeJS.Timeout> | undefined
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
                latency: SLOW_NETWORK_LATENCY_MS, // ~2s round-trip (Chrome's Slow 3G)
                downloadThroughput: (400 * 1024) / 8, // ~400 kbps
                uploadThroughput: (400 * 1024) / 8
              }).catch(() => {})
            }
            // F28: run the flow under a browser locale — sets the language the page
            // reads (navigator.language via setLocaleOverride) AND the Accept-Language
            // header (what the server localizes on). Stable CDP commands, best-effort.
            // The else-branch CLEARS a previous sweep's override so a later normal
            // replay isn't stuck in, say, Arabic.
            if (chaos?.locale) {
              d.sendCommand('Emulation.setLocaleOverride', { locale: chaos.locale }).catch(() => {})
              d.sendCommand('Network.setExtraHTTPHeaders', {
                headers: { 'Accept-Language': `${chaos.locale},${chaos.locale.split('-')[0]};q=0.9` }
              }).catch(() => {})
            } else {
              d.sendCommand('Emulation.setLocaleOverride', {}).catch(() => {})
              d.sendCommand('Network.setExtraHTTPHeaders', { headers: {} }).catch(() => {})
            }
            // F36: attaching/detaching the debugger drops CDP emulation, so the
            // device signals are re-applied here for the run. Without this a
            // mobile test would replay with mobile SIZE but desktop UA + no
            // touch — passing while never having tested the mobile path.
            applyDeviceTo(wcToAttach)
            // F1: with a HAR loaded, intercept the API calls (XHR/fetch) and
            // serve the saved response when we have one; otherwise let it hit the
            // live network (augment mode). We deliberately DON'T intercept the
            // page navigation or static assets — fulfilling a top-level
            // navigation through the debugger on a WebContentsView crashes the
            // native browser process, and the API responses are what kill flake
            // anyway. Every paused request MUST be fulfilled or continued or the
            // page hangs — so any error falls back to continueRequest.
            if (replayHar && replayHar.log?.entries?.length) {
              // THE INVARIANT: every paused request must end in fulfillRequest or
              // continueRequest. Leave one paused and the page hangs on it with no
              // error — the symptom that shelved this feature. So a watchdog is
              // armed the instant a request pauses, BEFORE any logic that could
              // throw; whatever happens next, the request gets continued.
              const pending = new Map<string, NodeJS.Timeout>()
              fetchPending = pending
              const settle = (requestId: string): void => {
                const t = pending.get(requestId)
                if (t) clearTimeout(t)
                pending.delete(requestId)
              }
              // Let it hit the live network (augment mode). Safe to call twice —
              // settle() makes the watchdog a no-op once the request is resolved.
              const passThrough = (requestId: string): void => {
                settle(requestId)
                d.sendCommand('Fetch.continueRequest', { requestId })
                  .then(() => {
                    harPassthrough++
                  })
                  .catch(() => {
                    // request already gone, or the debugger detached — either way
                    // there is nothing left to strand.
                  })
              }
              const onFetch = (
                _e: unknown,
                method: string,
                params: Record<string, unknown>
              ): void => {
                if (method !== 'Fetch.requestPaused') return
                const requestId = String(params.requestId)
                pending.set(
                  requestId,
                  setTimeout(() => passThrough(requestId), HAR_PAUSE_WATCHDOG_MS)
                )
                try {
                  const req = params.request as { url?: string; method?: string } | undefined
                  const entry = req?.url
                    ? matchEntry(replayHar.log.entries, req.method ?? 'GET', req.url)
                    : null
                  if (!entry) return passThrough(requestId)
                  // The HAR matched but captured no body for it (bodies aren't
                  // always retrievable). Serving an empty 200 would break a page
                  // that expects JSON, so go to the network instead — a miss is
                  // far better than a lie.
                  if (entry.response.content?.text == null) return passThrough(requestId)
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
                      settle(requestId)
                      harServed++
                    })
                    .catch(() => passThrough(requestId))
                } catch {
                  // A malformed entry must not cost us the request.
                  passThrough(requestId)
                }
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
          rec = { wc: wcToAttach, cdp: d, ready, fetchListener, fetchPending }
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
      // F37: plain-English notes about control flow that did NOT run this time
      // (an untaken if-branch, a loop that iterated zero times). Declared here
      // so finish() can attach them; filled by the run loop below.
      const controlNotes: string[] = []

      const finish = async (outcome: {
        ok: boolean
        failedAt?: number
        error?: string
        screenshotPath?: string
        aborted?: boolean
        consoleErrors?: string[]
        networkErrors?: string[]
        traceId?: string
        failures?: { index: number; error: string; screenshotPath?: string; apiEvidence?: ApiEvidence }[]
        harServed?: number
        harPassthrough?: number
        whatChanged?: DomDiff
        category?: FailureCategory
        aiHealed?: number
        healable?: { index: number; label: string; signals: string[]; score: number; step: ReplayStep }
        // F37: which if-branches / loops actually executed. A green test whose
        // checks all sat in a branch that was never taken has verified NOTHING
        // — the F6 dead-assertion problem in control-flow form — so the run
        // reports it rather than letting the tick speak for itself.
        branchNotes?: string[]
      }): Promise<{
        ok: boolean
        failedAt?: number
        error?: string
        screenshotPath?: string
        aborted?: boolean
        consoleErrors?: string[]
        networkErrors?: string[]
        traceId?: string
        failures?: { index: number; error: string; screenshotPath?: string; apiEvidence?: ApiEvidence }[]
        harServed?: number
        harPassthrough?: number
        whatChanged?: DomDiff
        category?: FailureCategory
        aiHealed?: number
        healable?: { index: number; label: string; signals: string[]; score: number; step: ReplayStep }
        // F37: which if-branches / loops actually executed. A green test whose
        // checks all sat in a branch that was never taken has verified NOTHING
        // — the F6 dead-assertion problem in control-flow form — so the run
        // reports it rather than letting the tick speak for itself.
        branchNotes?: string[]
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
              // F1: drop any armed watchdogs — detaching releases the paused
              // requests itself, and a timer firing afterwards would only send a
              // continueRequest down a debugger that is already gone.
              if (rec.fetchPending) {
                for (const t of rec.fetchPending.values()) clearTimeout(t)
                rec.fetchPending.clear()
              }
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
              // F20 (Option 2): never prune a recording a saved edge run owns.
              await pruneTraces(40, await protectedEdgeTraceIds())
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
        // F37: report any branch/loop that never ran. Only the SKIPPED ones —
        // listing branches that did run would be noise, and the whole point is
        // to surface the steps a green tick silently didn't cover.
        if (controlNotes.length) outcome.branchNotes = controlNotes.slice()
        return outcome
      }

      // Local copy so a re-pick can swap in a healed step mid-run without
      // mutating the renderer's array (it sends its own update separately).
      // F40: put the real password back, HERE in main and on this copy only. The
      // renderer never receives it, and the saved test still holds only a ref —
      // so the value exists in memory for the length of the run and nowhere else.
      const list = (await resolveSecrets(steps.slice())) as typeof steps
      // Day 16: flag replay up front so a dialog fired during the very first
      // load is auto-answered too (armNextDialog re-sets it before each action).
      // Day 16(+): also arm download tracking so `download` steps can verify.
      isReplaying = true
      replayDownloads = []
      replayDownloadCursor = 0
      currentWC.executeJavaScript('window.__qaflowReplaying=true').catch(() => {})

      // F24.1: this run's runtime tokens — {{uuid}}/{{timestamp}} (fresh per run,
      // stable within it) and {{saved:x}} (lifted out of an earlier API response).
      // Scoped to ONE run: a fresh run must not reuse the last run's saved order id.
      const runTokens: RunTokens = newRunTokens()

      // For each {{saved:NAME}} a step tried to capture: did that step actually get a
      // RESPONSE from the server? This is the difference between the only two reasons a
      // token can be missing, and they call for opposite reactions:
      //
      //   got a response, step then failed (SLA / check / contract)  → the server ACTED.
      //       A record exists. Teardown couldn't delete it. Say so, loudly.
      //   no response at all (timeout, abort, connection refused)    → nothing was created.
      //       There is nothing to clean up. Warning about orphaned data here is a LIE —
      //       and a cleanup step that cries wolf gets ignored exactly as fast as one that
      //       stays silent.
      const saveGotResponse = new Map<string, boolean>()
      const notePendingSaves = (s: ReplayStep, gotResponse: boolean): void => {
        if (!s.apiSave) return
        for (const line of s.apiSave.split('\n')) {
          const name = line.split('=')[0].trim()
          if (name) saveGotResponse.set(name, gotResponse)
        }
      }

      const method = (s: ReplayStep): string => (s.apiMethod ?? 'GET').toUpperCase()

      // F24.4 — ALWAYS-RUN TEARDOWN.
      // A test that fails midway never reaches its cleanup step, so the record it
      // created is orphaned. Do that 200 times and the test environment fills with
      // junk that breaks OTHER tests for reasons nobody can trace back here.
      //
      // So when the run ends early, the steps marked ◆ teardown that never got a
      // chance to run are executed anyway — the equivalent of an `afterEach` that
      // runs whether the test passed or blew up.
      //
      // HONEST LIMIT: teardown runs API steps only. A UI cleanup step ("click
      // Delete account") is not re-driven here — after a failure the page is in an
      // unknown state, and blindly clicking around a broken app is how you turn a
      // failed test into a corrupted environment. An HTTP call has no such problem:
      // it doesn't care what the browser is doing.
      const runTeardowns = async (afterIndex: number): Promise<void> => {
        const pending = list
          .map((s, j) => ({ s, j }))
          .filter(({ s, j }) => j > afterIndex && s.teardown && !s.disabled && s.type === 'api')
        if (!pending.length) return

        for (const { s, j } of pending) {
          const t = resolveRuntimeStep(s, runTokens)

          // An UNRESOLVED {{saved:…}} must never be sent. resolveRuntimeText leaves a
          // token it can't fill as the literal text (deliberately — blanking it would
          // turn `DELETE /orders/{{saved:id}}` into `DELETE /orders/`, which on a real
          // API can mean "delete the entire collection"). But firing the literal is its
          // own trap: the server 404s on `/objects/{{saved:objId}}`, 404 is in the
          // teardown's accept list, and the step goes GREEN having deleted nothing.
          // That is a cleanup step lying about cleaning up. Say so instead.
          const unresolved = [t.url, t.apiBody, t.apiHeaders]
            .filter((v): v is string => typeof v === 'string')
            .flatMap((v) => [...v.matchAll(/\{\{\s*saved:([^}]+)\}\}/g)].map((m) => m[1].trim()))
          if (unresolved.length) {
            const name = unresolved[0]
            // Did the step that should have captured this token ever hear back from the
            // server? If it didn't (timeout / abort / refused), the request never landed,
            // NOTHING was created, and there is genuinely nothing to clean up. Skipping is
            // the honest answer. Shouting "your data has NOT been removed" at data that was
            // never created is the same class of lie as the silent green this guard replaced
            // — it just fails in the opposite direction.
            if (saveGotResponse.get(name) !== true) {
              mainWindow.webContents.send('recorder:replay-progress', {
                index: j,
                status: 'skipped'
              })
              continue
            }
            mainWindow.webContents.send('recorder:replay-progress', { index: j, status: 'error' })
            failures.push({
              index: j,
              error:
                `Teardown could not run — {{saved:${name}}} was never captured, so this step has nothing to delete. ` +
                `The step that saves it DID get a response from the server (it failed afterwards, on a check, the contract or its SLA), ` +
                `which means the record was very likely created and is STILL THERE. Fix the earlier failure — the data it left behind has not been removed.`
            })
            continue
          }

          mainWindow.webContents.send('recorder:replay-progress', { index: j, status: 'running' })
          try {
            const api = await runApiStep({
              method: t.apiMethod,
              url: t.url,
              headers: t.apiHeaders,
              body: t.apiBody,
              expectStatus: t.apiExpectStatus,
              expectBody: t.apiExpectBody,
              checks: t.apiChecks,
              contract: t.apiContract,
              maxMs: t.apiMaxMs,
              timeoutMs: t.apiTimeoutMs,
              // F29: a teardown runs under the same adverse conditions as the rest
              // of the run — cleanup that only works on a fast network isn't cleanup.
              slowNetworkMs: chaos?.slowNetwork ? SLOW_NETWORK_LATENCY_MS : undefined
            })
            if (api.evidence) {
              mainWindow.webContents.send('recorder:api-response', {
                index: j,
                evidence: api.evidence
              })
            }
            mainWindow.webContents.send('recorder:replay-progress', {
              index: j,
              status: api.ok ? 'done' : 'error'
            })
            if (!api.ok) {
              // A teardown that fails is worth knowing about — it means something
              // was NOT cleaned up — but it must never replace the run's real
              // error, which is what actually broke the test.
              failures.push({
                index: j,
                error: `Teardown failed — ${api.error}`,
                apiEvidence: api.evidence
              })
            }
          } catch (err) {
            mainWindow.webContents.send('recorder:replay-progress', { index: j, status: 'error' })
            failures.push({
              index: j,
              error: `Teardown failed — ${err instanceof Error ? err.message : String(err)}`
            })
          }
        }
      }

      // F24.3: copy an API login's Set-Cookie headers into the embedded browser's
      // session, so the very next navigation is authenticated. Returns how many
      // cookies actually landed (0 = nothing usable, which we treat as a failure —
      // silently "logging in" and then testing a logged-OUT app is the worst
      // possible outcome: every later assertion fails for a reason that looks
      // nothing like the cause).
      const injectCookies = async (setCookies: string[], forUrl: string): Promise<number> => {
        let origin: URL
        try {
          origin = new URL(forUrl)
        } catch {
          return 0
        }
        let count = 0
        for (const raw of setCookies) {
          // "name=value; Path=/; HttpOnly; Domain=…" — the first pair is the
          // cookie, the rest are its attributes.
          const [pair, ...attrs] = raw.split(';')
          const eq = pair.indexOf('=')
          if (eq <= 0) continue
          const name = pair.slice(0, eq).trim()
          const value = pair.slice(eq + 1).trim()
          if (!name) continue
          const attr = (key: string): string | undefined => {
            const hit = attrs.find((a) => a.trim().toLowerCase().startsWith(`${key}=`))
            return hit ? hit.split('=').slice(1).join('=').trim() : undefined
          }
          const domain = attr('domain')
          const path = attr('path') || '/'
          const expires = attr('expires')
          const details: Electron.CookiesSetDetails = {
            url: `${origin.protocol}//${origin.host}${path}`,
            name,
            value,
            path,
            secure: origin.protocol === 'https:',
            httpOnly: attrs.some((a) => a.trim().toLowerCase() === 'httponly')
          }
          if (domain) details.domain = domain
          if (expires) {
            const t = Date.parse(expires)
            if (!Number.isNaN(t)) details.expirationDate = t / 1000
          }
          try {
            // Write into the BROWSER VIEW's session, not defaultSession. The view
            // now has its own partition, so an injected API-login cookie left in the
            // default bucket would never reach the tab and the browser would stay
            // silently logged out. activeWC().session IS the partition session.
            await activeWC().session.cookies.set(details)
            count++
          } catch {
            // a malformed cookie — skip it, but don't claim success for it
          }
        }
        return count
      }

      // F24.3: the other half — an API that returns a TOKEN in the body (rather
      // than a cookie) needs it written into the page's localStorage under the key
      // the app reads. `key = value` per line; the value may use {{saved:token}}.
      const injectLocalStorage = async (spec: string, tokens: RunTokens): Promise<string | null> => {
        const entries: [string, string][] = []
        for (const line of spec.split('\n')) {
          const t = line.trim()
          if (!t) continue
          const eq = t.indexOf('=')
          if (eq <= 0) continue
          const key = t.slice(0, eq).trim()
          const value = resolveRuntimeText(t.slice(eq + 1).trim(), tokens)
          if (!key) continue
          if (value.includes('{{')) {
            return `Could not set localStorage "${key}" — its value still contains an unresolved token (${value}). Save it from an earlier API response first.`
          }
          entries.push([key, value])
        }
        if (!entries.length) return null
        try {
          await currentWC.executeJavaScript(
            `(() => { const e = ${JSON.stringify(entries)}; for (const [k, v] of e) localStorage.setItem(k, v); return true })()`,
            true
          )
          return null
        } catch (err) {
          return `Could not set localStorage — ${err instanceof Error ? err.message : String(err)}`
        }
      }

      // Day 18: 'Continue' bypasses a failure to check later steps — the run is
      // STILL failed overall. Remember the FIRST bypassed failure so the run
      // reports it at the end (and the trace is kept).
      let bypassedFailAt: number | null = null
      let bypassedError = ''
      let bypassedShot: string | undefined
      // Day 20: EVERY failed step this run (Continue-bypassed ones + a final
      // Stop), so the banner can show each failure's screenshot — not just the
      // first. The trace already keeps all; this surfaces them in the result.
      const failures: {
        index: number
        error: string
        screenshotPath?: string
        apiEvidence?: ApiEvidence
      }[] = []
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

      // F21b: track the page we last offered a check on, so the "add checks along
      // a replay" ride offers exactly ONCE per distinct page it lands on.
      let lastOfferPath = ''
      let rideStopped = false
      const pagePath = (u: string): string => {
        try {
          const url = new URL(u)
          return url.origin + url.pathname
        } catch {
          return u
        }
      }
      // === F37: loops + branching ==================================
      // Pair up the control markers ONCE, before the run. If the structure is
      // broken (an unclosed repeat, crossed markers) we refuse to run rather
      // than guess — guessing wrong silently repeats or skips real test steps,
      // and a test that lies is worse than a test that won't start.
      const cf = analyzeControlFlow(list as { type: string; disabled?: boolean }[])
      if (cf.errors.length) {
        throw new Error(`Test structure problem — ${cf.errors[0]}`)
      }
      // One frame per loop currently running. Innermost is last.
      const loopStack: {
        start: number
        end: number
        index: number
        total: number
        texts: string[]
      }[] = []
      // "its 1 step was" / "its 3 steps were" — the verb has to agree too, not
      // just the noun.
      const stepsWere = (n: number): string =>
        n === 1 ? 'its 1 step was' : `its ${n} steps were`
      const stepsNever = (n: number): string =>
        n === 1 ? 'its 1 step never' : `its ${n} steps never`
      const stepsThe = (n: number): string =>
        n === 1 ? 'the 1 step' : `the ${n} steps`
      // F37 coverage honesty: a branch that never ran verified NOTHING. How
      // many real (non-marker) steps sit in a span, so a note can say how much
      // was skipped — "the check you wrote never ran" is the useful part.
      const bodyStepCount = (from: number, to: number): number => {
        let n = 0
        for (let k = from + 1; k < to; k++) {
          const s = list[k] as { type: string; disabled?: boolean }
          if (!s.disabled && !isControlStep(s)) n++
        }
        return n
      }
      // How many times a given loop marker has sent us round. Purely a runaway
      // guard: a for-each count is fixed up front and a times-loop is bounded,
      // but a corrupted file shouldn't be able to hang the app forever.
      const MAX_ITERATIONS = 1000

      // F19 batching: verdicts for a RUN of consecutive AI checks, judged in one
      // model call at the first of them. An AI check costs ~7-12s and that cost
      // is per CALL, not per claim — six checks on one page meant six start-ups
      // and six round trips for a single page state.
      //
      // Keyed by step index and thrown away the moment execution leaves the run,
      // because F37 loops can jump `i` backwards: on a second lap the page state
      // is NOT the one these verdicts were formed against, and reusing them
      // would be reporting a stale judgment as a fresh one.
      let nlBatch: { indices: Set<number>; verdicts: Map<number, NlVerdict> } | null = null

      for (let i = 0; i < list.length; i++) {
        if (nlBatch && !nlBatch.indices.has(i)) nlBatch = null
        // F24.1: resolve the LATE tokens now, for THIS step. {{env:X}} and data
        // columns were substituted by the renderer before the run; {{uuid}} and
        // {{saved:orderId}} can't be — a saved id doesn't exist until the step
        // that creates it has run. Resolving on a COPY leaves the saved test
        // untouched (the step list still shows the token, which is what you
        // authored and what you'd want to see).
        // F37: {{loop:*}} resolves against the INNERMOST enclosing loop, and for
        // the same reason — its value changes on every iteration of the same step.
        const activeLoop = loopStack.length ? loopStack[loopStack.length - 1] : null
        const loopCtx = activeLoop
          ? {
              index: activeLoop.index,
              total: activeLoop.total,
              text: activeLoop.texts[activeLoop.index]
            }
          : null
        const step = resolveRuntimeStep(list[i], runTokens)
        if (loopCtx) {
          step.value = resolveLoopTokens(step.value, loopCtx)
          step.label = resolveLoopTokens(step.label, loopCtx)
        }
        // Steps turned off in the editor are skipped — leave their row neutral
        // (no running/done/error) so the UI shows them as inert, not run.
        if (step.disabled) continue

        // === F37: control markers ==================================
        // These decide WHERE the run goes next rather than doing something to
        // the page, so they're handled before all the per-step machinery below
        // (trace slices, baselines, element evidence) — none of which applies
        // to a jump. They report progress so their rows still light up.
        if (isControlStep(step)) {
          const span = cf.spans.get(i)
          mainWindow.webContents.send('recorder:replay-progress', { index: i, status: 'running' })
          try {
            if (step.type === 'repeat') {
              if (!span) throw new Error('This loop has no matching endRepeat.')
              let total = 0
              let texts: string[] = []
              if (step.repeatKind === 'each') {
                // Count the collection ONCE, up front — see buildCollectionScript
                // for why a live count would be unpredictable.
                const res = (await currentWC
                  .executeJavaScript(buildCollectionScript(step), true)
                  .catch(() => ({ count: 0, texts: [] }))) as {
                  count: number
                  texts: string[]
                }
                total = res.count
                texts = res.texts ?? []
              } else {
                const n = parseInt(step.value ?? '1', 10)
                total = Number.isFinite(n) && n > 0 ? Math.min(n, MAX_ITERATIONS) : 0
              }
              if (total <= 0) {
                // Zero iterations: the body never runs. Jump past endRepeat and
                // record it, because a loop that ran zero times verified nothing
                // — the same honesty problem as an untaken branch.
                const skipped = bodyStepCount(i, span.end)
                controlNotes.push(
                  step.repeatKind === 'each'
                    ? `Step ${i + 1}: the "for each" loop matched NO elements, so ${stepsNever(skipped)} ran.`
                    : `Step ${i + 1}: the loop was set to 0 times, so ${stepsNever(skipped)} ran.`
                )
                mainWindow.webContents.send('recorder:replay-progress', {
                  index: i,
                  status: 'skipped'
                })
                i = span.end
                continue
              }
              loopStack.push({ start: i, end: span.end, index: 0, total, texts })
            } else if (step.type === 'endRepeat') {
              const frame = loopStack[loopStack.length - 1]
              if (frame && frame.end === i) {
                frame.index++
                if (frame.index < frame.total) {
                  // Round again: set i to the loop header so the i++ lands on
                  // the first body step.
                  i = frame.start
                  mainWindow.webContents.send('recorder:replay-progress', {
                    index: i,
                    status: 'done'
                  })
                  continue
                }
                loopStack.pop()
              }
            } else if (step.type === 'if') {
              if (!span) throw new Error('This if has no matching endIf.')
              const truth = await evaluateCondition(step)
              if (truth) {
                // The true branch runs. If there's an else, ITS steps don't —
                // note that, because any check written there was not performed.
                if (span.elseAt !== undefined) {
                  const skipped = bodyStepCount(span.elseAt, span.end)
                  if (skipped > 0) {
                    controlNotes.push(
                      `Step ${span.elseAt + 1}: the "otherwise" branch did not run this time — ${stepsWere(skipped)} not checked.`
                    )
                  }
                }
              } else {
                const skipped = bodyStepCount(
                  i,
                  span.elseAt !== undefined ? span.elseAt : span.end
                )
                if (skipped > 0) {
                  controlNotes.push(
                    `Step ${i + 1}: the condition was false, so ${stepsThe(skipped)} inside the "if" did not run.`
                  )
                }
                // Jump to just after `else`, or past `endIf` when there isn't one.
                const skipTo = span.elseAt !== undefined ? span.elseAt : span.end
                // The `if` itself DID run — we evaluated its condition. Mark it
                // done, not skipped; only its untaken body is skipped (and those
                // rows are never visited, so they correctly stay blank).
                mainWindow.webContents.send('recorder:replay-progress', {
                  index: i,
                  status: 'done'
                })
                // And mark where we land. When there's an `else` its branch is
                // about to run, so "skipped" would have been exactly backwards.
                mainWindow.webContents.send('recorder:replay-progress', {
                  index: skipTo,
                  status: 'done'
                })
                i = skipTo
                continue
              }
            } else if (step.type === 'else') {
              // Reached by FALLING OUT of a true branch, so the true branch ran
              // and the else branch must not. (When the condition was false we
              // jumped straight past this marker.)
              const owner = cf.ownerOf.get(i)
              const ownerSpan = owner !== undefined ? cf.spans.get(owner) : undefined
              if (ownerSpan) {
                // Mark BOTH markers before jumping. Without this the run leaves
                // "Otherwise" and "End if" blank at the bottom of an otherwise
                // green test, which reads as "it didn't finish" — the worst
                // possible signal from a tool whose whole point is trust.
                // Otherwise = skipped (its branch really didn't run); End if =
                // done (the branches rejoined and the flow carried on).
                mainWindow.webContents.send('recorder:replay-progress', {
                  index: i,
                  status: 'skipped'
                })
                mainWindow.webContents.send('recorder:replay-progress', {
                  index: ownerSpan.end,
                  status: 'done'
                })
                i = ownerSpan.end
                continue
              }
            }
            // endIf: nothing to do — it's just where the branches rejoin.
            mainWindow.webContents.send('recorder:replay-progress', { index: i, status: 'done' })
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            mainWindow.webContents.send('recorder:replay-progress', {
              index: i,
              status: 'error',
              error: message
            })
            throw err
          }
          continue
        }

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
        // F24: set when an `api` step FAILS — the catch uses it as the evidence
        // (the page screenshot is only context) and hands it to the report.
        let pendingApi: ApiEvidence | null = null
        // F24: the exchange for THIS step whether it passed or failed, so the
        // trace records a passing API step's response too (not just failures).
        let stepApi: ApiEvidence | null = null
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
            // F15: capture with the step's mask + freeze applied — identical to
            // how its baseline was captured, so dynamic regions / animations
            // can't cause a false diff.
            const image = await captureStabilized(
              currentWC,
              step.maskSelectors,
              step.freezeAnimations
            )
            const baseline = step.baselineId ? await loadBaseline(step.baselineId) : null
            if (!baseline) {
              // No baseline on disk (e.g. first run / deleted) — adopt the
              // current look as the baseline and pass, like Playwright does.
              if (step.baselineId) await saveBaseline(step.baselineId, image.toPNG())
            } else {
              const result = diffImages(baseline, image)
              const thresholdPct = Math.max(0, parseFloat(step.value ?? '1') || 0)
              const ratioPct = result.ratio * 100
              // Absolute changed-pixel floor. A % threshold alone dilutes a small
              // localized change (a recoloured button, a badge) on a large full-page
              // image below the bar — so ALSO fail past a raw pixel count. Default is
              // deliberately small: an identical re-render changes ~0 pixels (color
              // tolerance filters anti-aliasing), so this catches real changes without
              // flaky failures. Per-step overridable via maxDiffPixels.
              const maxDiffPixels = Math.max(
                0,
                Math.round(Number((step as { maxDiffPixels?: number }).maxDiffPixels)) ||
                  DEFAULT_MAX_DIFF_PIXELS
              )
              const overPixelFloor = result.changedPixels > maxDiffPixels
              const overPct = ratioPct > thresholdPct
              if (result.sizeMismatch || overPct || overPixelFloor) {
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
                    : overPct
                      ? `Visual snapshot differs by ${ratioPct.toFixed(2)}% (allowed ${thresholdPct}%)`
                      : `Visual snapshot: ${result.changedPixels.toLocaleString()} pixels changed (over the ${maxDiffPixels.toLocaleString()}-pixel limit) — a localized change too small to show as ${ratioPct.toFixed(2)}%`
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
            // 30s — the same wait an ordinary element-find now gets, and the same
            // Playwright uses. The reason is evidence, not taste:
            //
            // `Upload fixture check` passed in-app twice, then failed once with
            // "Could not find the file input on the page", then passed HEADLESS
            // four minutes later. The site (free-tier Heroku) was simply slow to
            // serve the page; the in-app engine gave up at 8s and Playwright,
            // which waits 30s, did not. The same test legitimately disagreeing
            // with itself depending on which engine ran it is the failure here.
            //
            // Kept in step with replay.ts's findTimeout: if the two ever drift,
            // uploads start disagreeing with every other kind of step about how
            // long "not there yet" takes — the same class of inconsistency this
            // change exists to remove.
            const uploadDeadline = Date.now() + 30000
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
            // Already judged as part of the batch formed at the first check in
            // this run — same page state, no second round trip.
            const cached = nlBatch?.verdicts.get(i)
            if (cached) {
              if (!cached.pass) throw new Error(cached.error)
            } else {
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
            // Every consecutive AI check from here shares this exact page state
            // — nothing runs between them to change it — so they can all be
            // judged in ONE call. Later steps in the run read their verdict from
            // the batch instead of paying for another round trip.
            const runIdx: number[] = [i]
            for (let k = i + 1; k < list.length; k++) {
              const nx = list[k] as typeof step
              if (nx?.type === 'assert' && nx.assertKind === 'nl' && !nx.disabled) runIdx.push(k)
              else break
            }
            // Tell the UI what this pause IS. The leader of a batch carries the
            // cost for every check in its run, so it sits there for ~10s while
            // the ones after it return instantly — without saying so, that reads
            // as a hang on one step and magic on the rest.
            if (runIdx.length > 1) {
              mainWindow.webContents.send('recorder:replay-progress', {
                index: i,
                status: 'running',
                nlBatch: { count: runIdx.length }
              })
            }
            const verdicts = await evaluateNlAssertions(
              runIdx.map((k) => (list[k] as typeof step).value ?? ''),
              { ...ctx, screenshotPath: shotPath },
              libraryDir()
            )
            if (shotPath) await rm(shotPath, { force: true }).catch(() => {})
            nlBatch = { indices: new Set(runIdx), verdicts: new Map() }
            runIdx.forEach((k, n) => {
              nlBatch!.verdicts.set(k, verdicts[n] ?? { pass: false, error: 'AI check produced no verdict.' })
            })
            const nl = nlBatch.verdicts.get(i)!
            if (!nl.pass) throw new Error(nl.error)
            }
          } else if (step.type === 'api') {
            // F24: fire an HTTP request from the main process (not the embedded
            // browser) and assert on the response. Env tokens in the URL / headers
            // / body were already substituted by applyEnv before the run, so
            // {{env:APIKEY}} is a concrete value here. A failed assertion throws
            // like any step, flowing into the normal failure path.
            const api = await runApiStep({
              method: step.apiMethod,
              url: step.url,
              headers: step.apiHeaders,
              body: step.apiBody,
              expectStatus: step.apiExpectStatus,
              expectBody: step.apiExpectBody,
              // F24.2: real assertions + contract + SLA + a hard timeout.
              checks: step.apiChecks,
              contract: step.apiContract,
              maxMs: step.apiMaxMs,
              timeoutMs: step.apiTimeoutMs,
              // F29: chaos throttles the TAB via CDP, which never touches a Node
              // fetch — so an API step used to sail through at full speed while the
              // browser crawled, and the SLA/timeout (the two checks chaos is most
              // useful against) were the two it couldn't exercise.
              slowNetworkMs: chaos?.slowNetwork ? SLOW_NETWORK_LATENCY_MS : undefined,
              // F24.3: only walk the redirect chain by hand when we actually need
              // the cookies — a plain API step keeps fetch's normal behaviour.
              collectCookies: !!step.apiInjectCookies
            })
            // Keep the exchange whether it passed or failed, and push it to the
            // renderer immediately so the step row can show "↩ 201 · 142ms" and
            // open a Postman-style response panel. A green API step you can't
            // inspect is just "trust me" — the response is what makes it evidence.
            stepApi = api.evidence ?? null
            if (api.evidence) {
              mainWindow.webContents.send('recorder:api-response', {
                index: i,
                evidence: api.evidence
              })
            }
            // F24.1: lift values OUT of the response into {{saved:…}} tokens, so a
            // later step can GET/DELETE the very record this one just created —
            // the id is invented by the server, so it cannot be typed in advance.
            //
            // This runs BEFORE the pass/fail verdict, and that order is the whole
            // point. A POST that breaches its SLA (or fails a check, or violates the
            // contract) still CREATED THE RECORD — those are all client-side verdicts
            // on a response the server already committed to. Bailing out first meant
            // objId was never captured, so teardown fired
            // `DELETE /objects/{{saved:objId}}` at the literal token, collected a 404
            // — which is in its accept list — and went GREEN while the record it
            // existed to remove was orphaned forever. Cleanup matters MOST on a failing
            // test; that was the one case it silently didn't happen.
            // Did the server answer at all? A timeout/abort/refusal leaves status
            // undefined — nothing was created, so a later teardown must NOT claim
            // that data was left behind.
            notePendingSaves(step, api.status !== undefined)

            const saveErr = applySaves(api.bodyText ?? '', step.apiSave, runTokens)

            if (!api.ok) {
              pendingApi = api.evidence ?? null
              // The step's own error wins. A save miss on an already-failing response
              // is a symptom; api.error is the cause, and it's what the user needs.
              throw new Error(api.error)
            }
            // A miss FAILS here, where the cause is obvious; saving nothing and
            // carrying on would blow up later on a nonsense URL.
            if (saveErr) {
              pendingApi = api.evidence ?? null
              throw new Error(saveErr)
            }

            // F24.3: hand this response's auth to the BROWSER. This is the big
            // suite-scale win: log in once over the API and the UI test starts
            // already authenticated — no login screen in 500 tests, which is both
            // the slowest part of a suite and its biggest single flake source.
            // An API that returns NO Set-Cookie at all must fail here just as hard
            // as one whose cookies we couldn't use — it's the likelier mistake (🔑
            // ticked on the wrong endpoint), and it's the one that ends with a
            // green "login" and a logged-OUT browser.
            if (step.apiInjectCookies) {
              const injected = api.setCookies?.length
                ? await injectCookies(api.setCookies, step.url ?? '')
                : 0
              if (injected === 0) {
                pendingApi = api.evidence ?? null
                throw new Error(
                  `Could not hand the session to the browser — ${method(step)} ${step.url} returned no usable Set-Cookie header. (If this API returns a TOKEN in the body instead of a cookie, use "set localStorage" rather than "copy cookies".)`
                )
              }
            }
            if ((step.apiInjectStorage ?? '').trim()) {
              // localStorage is per-ORIGIN, so the browser has to already be on
              // the app's origin — on about:blank it would write to nowhere and
              // the "logged in" illusion would silently fail. Say so, loudly.
              const pageUrl = currentWC.getURL()
              if (!/^https?:/i.test(pageUrl)) {
                pendingApi = api.evidence ?? null
                throw new Error(
                  `Could not set localStorage — the browser isn't on a page yet (${pageUrl || 'blank'}). localStorage belongs to an origin, so navigate to the app FIRST, then run this step.`
                )
              }
              const storeErr = await injectLocalStorage(step.apiInjectStorage!, runTokens)
              if (storeErr) {
                pendingApi = api.evidence ?? null
                throw new Error(storeErr)
              }
            }
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
          await captureTraceStep(i, 'done', stepStartMs, undefined, undefined, stepApi ?? undefined)
          await wait(450)
          // F21b: if this step landed the ride on a NEW page, pause and offer to
          // add a grounded check for it. One offer per distinct page; the renderer
          // grounds the check against the LIVE page and splices it into the test.
          if (authorChecks && interactive && !rideStopped) {
            let curUrl = ''
            try {
              curUrl = currentWC.getURL()
            } catch {
              curUrl = ''
            }
            if (curUrl && pagePath(curUrl) !== lastOfferPath) {
              lastOfferPath = pagePath(curUrl)
              mainWindow.webContents.send('recorder:check-offer', { afterIndex: i, url: curUrl })
              const resp = await new Promise<{ stop?: boolean }>((resolve) => {
                checkOfferResolve = resolve
              })
              if (resp.stop) {
                rideStopped = true
                break
              }
            }
          }
        } catch (err) {
          onPopupOpened = null // disarm any popup hook if the step failed
          const message = err instanceof Error ? err.message : String(err)
          // F4 (self-heal 2.0): a healable failure is a SELECTOR break (the
          // element wasn't found) — not an assertion mismatch or a wrong-state
          // element, where the selector is fine and re-finding wouldn't help.
          const selectorBroke = /element not found|no reliable selector/i.test(message)
          // F26 (optional step): the step is allowed to be UNREACHABLE — a cookie
          // banner or promo modal that never appeared, or that a previous step
          // already dismissed. Mark it skipped and continue, before any
          // heal/pause. (Optional steps use a shorter find timeout, so an absent
          // element doesn't stall the run.)
          //
          // "Unreachable" is drawn where a USER would draw it: not in the DOM, or
          // in the DOM but invisible. Real banners do both — some unmount, some
          // just set display:none. A VISIBLE-but-disabled control is deliberately
          // excluded: the user can see it and cannot use it, which is a genuine
          // defect. Skipping that would turn an optional step into something that
          // can never fail — the dead-check disease F6 exists to catch. Likewise
          // an assertion mismatch (the element was found and read wrong) fails.
          //
          // Kept separate from `selectorBroke`, which gates SELF-HEAL: re-finding
          // helps when a selector is stale, not when an element is merely hidden.
          const unreachable = selectorBroke || /never became visible/i.test(message)
          //
          // Runs BEFORE computeHeal: healing an element that is legitimately
          // absent is wasted capture work, and risks healing onto the wrong one.
          if (step.optional && unreachable) {
            mainWindow.webContents.send('recorder:replay-progress', { index: i, status: 'skipped' })
            await captureTraceStep(i, 'skipped', stepStartMs)
            await wait(200)
            continue
          }
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
          if (pendingApi) {
            // F24: an API-step failure. The request/response IS the evidence (it
            // travels in `apiEvidence`); the page is CONTEXT — often the whole
            // point ("the UI says 'Order placed ✓' but the API has no order").
            // So capture it, but PLAIN: no red error banner, no culprit outline.
            // The page didn't cause an HTTP failure and must not be annotated as
            // if it had — that was the misleading part, not the picture itself.
            try {
              annotatedImage = await currentWC.capturePage()
              const dir = join(libraryDir(), '_failures')
              await mkdir(dir, { recursive: true })
              screenshotPath = join(dir, `failure-${Date.now()}.png`)
              await writeFile(screenshotPath, annotatedImage.toPNG())
            } catch {
              screenshotPath = undefined // page gone — the exchange still stands alone
            }
          } else if (pendingVisual) {
            // Day 19: a visual-snapshot failure — the DIFF image is the evidence
            // (changed pixels in red), so don't annotate/capture the page.
            screenshotPath = pendingVisual.diffPath ?? pendingVisual.currentPath
            // F15: feed that diff to the trace as THIS step's screenshot. The trace
            // filmstrip AND the HTML report both render step.screenshotFile, and
            // captureTraceStep would otherwise grab a fresh PLAIN capturePage() of
            // the page after the diff ran — so a reviewer opening the report or the
            // recording saw a normal page, not where it changed. Loading the diff
            // here surfaces the red highlight in both, not just the front panel.
            if (screenshotPath) {
              try {
                const diffImg = nativeImage.createFromPath(screenshotPath)
                if (!diffImg.isEmpty()) annotatedImage = diffImg
              } catch {
                // couldn't load it — the trace falls back to a plain capture
              }
            }
          } else {
            try {
              // Day 12.9: annotate the evidence first — red error banner, plus
              // an outline around the culprit element when it still resolves.
              // Draw → capture → erase: the marks live only inside the PNG.
              //
              // Retried once. An a11y step injects axe-core (a large script)
              // immediately before failing, and the banner injection that follows
              // sometimes loses that race — so the SAME failure got a banner on one
              // run and a plain screenshot on the next. Intermittent, reproduced
              // and then not reproduced. A second attempt after a short pause is
              // enough; the swallow below is still the backstop.
              //
              // The catch stays silent-by-intent (a decoration problem must never
              // cost the screenshot), but no longer INVISIBLE: the reason is
              // recorded as console evidence, so a future miss is diagnosable
              // instead of mysterious.
              let marked = false
              for (let attempt = 0; attempt < 2 && !marked; attempt++) {
                try {
                  if (attempt > 0) await wait(150) // let the renderer settle
                  await currentWC.executeJavaScript(buildFailureMarkScript(step, message), true)
                  marked = true
                  await wait(120) // let the scroll + overlay paint before capture
                } catch (e) {
                  if (attempt === 1) {
                    addEvidence(
                      consoleErrors,
                      `failure-screenshot annotation failed twice: ${e instanceof Error ? e.message : String(e)}`
                    )
                  }
                }
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
          await captureTraceStep(i, 'error', stepStartMs, message, annotatedImage, pendingApi ?? undefined)
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
              // F24: the request/response detail, in place of a screenshot.
              apiEvidence: pendingApi ?? undefined,
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
              failures.push({ index: i, error: message, screenshotPath, apiEvidence: pendingApi ?? undefined })
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
          failures.push({ index: i, error: message, screenshotPath, apiEvidence: pendingApi ?? undefined })
          // F24.4: the run is over, but the cleanup steps below never ran. Do them
          // now — otherwise every failed run leaves its data behind for good.
          await runTeardowns(i)
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
        deviceId?: string // F36
        tags?: string[] // F38
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
  // Resolve {{env:NAME}} for a run: the active environment's vars first, then the
  // real process environment.
  //
  // The process fallback is deliberate — it's how a CI machine supplies a value
  // with no environment configured. But it silently made `{{env:USERNAME}}` mean
  // "the Windows account name", because the OS always sets that. A suite run with
  // no environment active typed `samee` into a login, and the failure surfaced
  // three steps later as "Expected URL to contain /inventory.html", categorised
  // "stale data" — a plausible, wrong explanation pointing at the test rather
  // than the environment. Same hole the EXPORT had; fixed there first and missed
  // here, which is exactly why the name list now lives in src/shared/.
  //
  // For a colliding name the OS value is refused: an empty result is honest, and
  // `unresolved` tells the caller which names have no value so the run can say so
  // instead of typing nothing and failing somewhere else.
  ipcMain.handle(
    'env:get',
    async (
      _event,
      names: string[]
    ): Promise<{ values: Record<string, string>; unresolved: string[] }> => {
      const envVars = await activeEnvVars()
      const values: Record<string, string> = {}
      const unresolved: string[] = []
      for (const name of Array.isArray(names) ? names : []) {
        // An environment the user configured always wins, collision or not —
        // they named it deliberately.
        const fromEnv = envVars[name]
        const fromProcess = collidesWithOsEnv(name) ? undefined : process.env[name]
        const value = fromEnv ?? fromProcess ?? ''
        values[name] = value
        if (!value) unresolved.push(name)
      }
      return { values, unresolved }
    }
  )

  // === Environment / config manager (F25) ============================
  // CRUD + active selection for named { baseURL + credentials } environments,
  // persisted in userData (they hold secrets — kept out of the shared Tests
  // folder). Each mutation returns the whole new state so the renderer stays in
  // sync in one round-trip.
  ipcMain.handle('env:listEnvironments', () => getEnvState())
  ipcMain.handle('env:saveEnvironment', (_event, env: Environment) => saveEnvironment(env))
  ipcMain.handle('env:deleteEnvironment', (_event, id: string) => deleteEnvironment(id))
  ipcMain.handle('env:setActive', (_event, id: string | null) => setActiveEnvironment(id))
  ipcMain.handle('env:rememberRetarget', (_event, keys: string[], choice: 'run' | 'noenv') =>
    rememberRetargetChoice(keys, choice)
  )
  ipcMain.handle('env:forgetRetarget', () => forgetRetargetChoices())

  // === F31 AC checklist: persist ACs + map them to covering tests ====
  ipcMain.handle('ac:load', () => loadAcs())
  ipcMain.handle('ac:save', (_event, text: string) => saveAcs(text))
  ipcMain.handle(
    'ac:map',
    (
      _event,
      acs: string[],
      tests: { name: string; summary: string }[]
    ): Promise<AcCoverage[] | null> => mapAcCoverage(acs, tests, libraryDir())
  )

  // === F28 localization sweep: inspect the CURRENT page for i18n issues ==========
  // Text OVERFLOW (a leaf whose content is wider than its box → clipped in this
  // locale), the layout DIRECTION (rtl?), and the visible strings (so the renderer
  // can flag strings that DIDN'T change from the base locale = likely untranslated).
  ipcMain.handle('i18n:inspect', async (): Promise<{
    dir: string
    overflow: string[]
    overflowCount: number
    texts: string[]
  }> => {
    try {
      return (await activeWC().executeJavaScript(
        `(() => {
          const dir = document.documentElement.getAttribute('dir')
            || getComputedStyle(document.body).direction || 'ltr';
          const overflow = [];
          let checked = 0;
          // Skip form/replaced/interactive controls: a <select>'s dropdown arrow or a
          // button's padding makes scrollWidth exceed clientWidth even when NO text is
          // clipped — a false positive that flagged Mozilla's language picker in EVERY
          // locale (incl. the English base). Only genuinely clipped TEXT should count.
          const SKIP = new Set(['SELECT','OPTION','INPUT','TEXTAREA','BUTTON','IMG','SVG','VIDEO','CANVAS','IFRAME','OBJECT']);
          for (const el of document.querySelectorAll('body *')) {
            if (checked++ > 4000) break;
            if (SKIP.has(el.tagName)) continue;
            // ...and skip text that merely lives inside such a control.
            if (el.closest('select, button, input, textarea')) continue;
            // a leaf whose content is wider than its box = clipped/overflowing text
            if (el.children.length === 0 && el.clientWidth > 0
                && el.scrollWidth > el.clientWidth + 2) {
              const t = (el.textContent || '').trim().slice(0, 40);
              if (t) overflow.push(t);
            }
          }
          const texts = (document.body.innerText || '').split('\\n')
            .map(s => s.trim()).filter(Boolean).slice(0, 400);
          return { dir, overflow: overflow.slice(0, 15), overflowCount: overflow.length, texts };
        })()`,
        true
      )) as { dir: string; overflow: string[]; overflowCount: number; texts: string[] }
    } catch {
      return { dir: 'ltr', overflow: [], overflowCount: 0, texts: [] }
    }
  })

  // === F23: coverage crawl ===========================================
  // Breadth-first walk of the app from the CURRENT page, driving the embedded
  // browser (so it renders JS and uses the live session — logged-in pages are
  // reachable). Same host only, capped hard so it always terminates. Restores the
  // page it started on. Returns the discovered pages; the renderer overlays which
  // ones the saved tests actually visit.
  ipcMain.handle(
    'coverage:crawl',
    async (): Promise<{
      pages: { path: string; url: string; title: string; depth: number }[]
      origin: string
      startPath: string
      capped: boolean
    }> => {
      const wc = activeWC()
      const startUrl = wc.getURL()
      let startOrigin = ''
      try {
        startOrigin = new URL(startUrl).origin
      } catch {
        return { pages: [], origin: '', startPath: '', capped: false }
      }
      if (!startOrigin.startsWith('http'))
        return { pages: [], origin: startOrigin, startPath: '', capped: false }

      const MAX_PAGES = 40
      const MAX_DEPTH = 3
      const norm = (u: string): string | null => {
        try {
          const x = new URL(u)
          if (x.origin !== startOrigin) return null
          const p = x.pathname.replace(/\/+$/, '') || '/'
          return startOrigin + p
        } catch {
          return null
        }
      }
      const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 600))
      const queue: { url: string; depth: number }[] = [{ url: startUrl, depth: 0 }]
      const seen = new Set<string>()
      const pages: { path: string; url: string; title: string; depth: number }[] = []
      let capped = false

      while (queue.length) {
        if (pages.length >= MAX_PAGES) {
          capped = queue.length > 0
          break
        }
        const { url, depth } = queue.shift()!
        const key = norm(url)
        if (!key || seen.has(key)) continue
        seen.add(key)
        await loadUrlTolerantly(url, wc)
        await settle()
        let info: { title: string; links: string[] } = { title: '', links: [] }
        try {
          info = (await wc.executeJavaScript(
            `(() => {
              const origin = location.origin
              const out = new Set()
              for (const a of document.querySelectorAll('a[href]')) {
                try { const u = new URL(a.href, location.href)
                  if (u.origin === origin) out.add(u.origin + u.pathname) } catch {}
              }
              return { title: document.title, links: [...out].slice(0, 200) }
            })()`,
            true
          )) as { title: string; links: string[] }
        } catch {
          // a page we can't read — still counts as discovered
        }
        let path = '/'
        try {
          path = new URL(url).pathname || '/'
        } catch {
          /* keep '/' */
        }
        pages.push({ path, url, title: info.title || path, depth })
        mainWindow?.webContents.send('coverage:progress', { found: pages.length })
        if (depth < MAX_DEPTH) {
          for (const link of info.links) {
            const k = norm(link)
            if (k && !seen.has(k)) queue.push({ url: link, depth: depth + 1 })
          }
        }
      }
      // Put the browser back where the user left it.
      await loadUrlTolerantly(startUrl, wc)
      let startPath = '/'
      try {
        startPath = new URL(startUrl).pathname || '/'
      } catch {
        /* keep */
      }
      return { pages, origin: startOrigin, startPath, capped }
    }
  )

  // === Cross-browser replay (F17) ====================================
  // Chromium is the embedded engine; WebKit/Firefox can only run via REAL
  // Playwright, shelled out. `check` reports whether it's installed; `run`
  // exports the current test to a temp spec and runs it per selected browser.
  ipcMain.handle('xbrowser:check', () => checkPlaywright())

  // The runner now ships with the app, but the ~400 MB of browser binaries
  // can't — so the app downloads them itself on demand. Progress is streamed
  // as events because this takes minutes and a silent freeze would look like
  // a hang. Serialised: two concurrent installs would fight over the cache.
  let installingBrowsers = false
  ipcMain.handle(
    'xbrowser:installBrowsers',
    async (event, which: BrowserName[]): Promise<{ ok: boolean; message?: string }> => {
      if (installingBrowsers) {
        return { ok: false, message: 'A browser download is already running.' }
      }
      installingBrowsers = true
      try {
        return await installBrowsers(which ?? ['chromium'], (line) => {
          if (!event.sender.isDestroyed()) event.sender.send('xbrowser:installProgress', line)
        })
      } finally {
        installingBrowsers = false
      }
    }
  )
  // Stop an in-flight download. Returns false if nothing was running, so the
  // UI can re-sync rather than sit on a Cancel button that does nothing.
  ipcMain.handle('xbrowser:cancelInstall', () => cancelBrowserInstall())
  ipcMain.handle(
    'xbrowser:run',
    async (
      _event,
      specCode: string,
      browsers: BrowserName[],
      // F32: a monitor passes its PINNED environment's vars here (possibly {} for
      // "recorded URLs"), so its run ignores the global "Run against" selection.
      // undefined = the pre-F32 behaviour: use whatever env is currently active.
      envOverride?: Record<string, string>,
      // F32: a saved session filename so a "starts logged in" test runs headless
      // without being bounced to login. Resolved against the _sessions store.
      sessionFile?: string,
      // F40: the secret refs used by this test's steps. The export writes
      // `process.env.PASSWORD ?? ''` for a password field, so without these a
      // login types an EMPTY string, the next step waits for a page that never
      // loads, and every engine reports an identical 30s timeout — which reads
      // as "the browsers are broken" when the truth is "no password arrived".
      // The parallel runner and monitors already did this; this path never did,
      // so F17 has been quietly broken since F40 moved passwords to userData.
      secretRefs?: string[],
      // Uploads + HAR, same as the parallel runner has always taken. Without
      // them a monitored or cross-browser run of any test with an upload step
      // died on `ENOENT …\fixtures\<name>` — and a HAR-backed test quietly ran
      // against the live site instead of the archive, which is worse: it passes.
      fixturePaths?: string[],
      harFile?: string
    ) => {
      let envVars: Record<string, string> = {}
      if (envOverride) {
        envVars = envOverride
      } else {
        // Bridge the active F25 environment: its vars feed process.env.* in the
        // spec, and its base URL feeds process.env.BASE_URL (the export reads it).
        const env = await activeEnvironment()
        for (const v of env?.vars ?? []) if (v.name) envVars[v.name] = v.value
        if (env?.baseURL) envVars.BASE_URL = env.baseURL
      }
      // Fill PASSWORD from the secret store only when nothing else supplied it,
      // so an explicit environment variable still wins.
      if (envVars.PASSWORD === undefined && secretRefs?.length) {
        const resolved = await getSecrets(secretRefs)
        const password = secretRefs.map((r) => resolved[r]).find((v) => v)
        if (password) envVars.PASSWORD = password
      }
      const session = sessionFile
        ? { name: sessionFile, srcPath: join(libraryDir(), '_sessions', sessionFile) }
        : undefined
      return runCrossBrowser(
        specCode,
        browsers,
        envVars,
        session,
        fixturePaths?.length ? fixturePaths : undefined,
        // A HAR is stored by bare filename in the library's _hars/, like a
        // session — resolved here, not in the renderer, for the same reason.
        harFile ? join(libraryDir(), '_hars', harFile) : undefined
      )
    }
  )

  // F39: run a whole batch of tests at once through real Playwright, N at a
  // time. The renderer decides WHICH tests are safe to run this way (see
  // headlessBlockers) and generates each spec; main only writes them out and
  // hands Playwright's scheduler the job.
  ipcMain.handle(
    'xbrowser:runSuite',
    async (
      _event,
      specs: {
        id: string
        name: string
        code: string
        sessionFile?: string
        // F39 fix: the files an upload step needs, and the test's HAR. Without
        // these the generated spec's relative `fixtures/…` / `hars/…` paths
        // point at nothing and the test fails for a reason of ours, not its own.
        fixturePaths?: string[]
        harFile?: string
      }[],
      workers: number,
      envOverride?: Record<string, string>
    ) => {
      let envVars: Record<string, string> = {}
      if (envOverride) {
        envVars = envOverride
      } else {
        const env = await activeEnvironment()
        for (const v of env?.vars ?? []) if (v.name) envVars[v.name] = v.value
        if (env?.baseURL) envVars.BASE_URL = env.baseURL
      }
      const prepared: ParallelSpec[] = (specs ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        code: s.code,
        sessionPath: s.sessionFile
          ? join(libraryDir(), '_sessions', s.sessionFile)
          : undefined,
        fixturePaths: s.fixturePaths?.length ? s.fixturePaths : undefined,
        // A HAR is stored by bare filename in the library's _hars/, like a session.
        harPath: s.harFile ? join(libraryDir(), '_hars', s.harFile) : undefined
      }))
      return runSuiteParallel(prepared, workers, envVars)
    }
  )
  ipcMain.handle('library:list', () => listTests())

  // === F40: secrets =================================================
  // Move any plaintext password left in a test file into the userData store.
  // Runs once at startup, is idempotent, and backs the whole library up before
  // touching anything (it rewrites the user's real test files). Returns what it
  // moved so the UI can say so rather than changing files silently.
  ipcMain.handle('secrets:migrate', async () => {
    return migratePlaintextSecrets(
      libraryDir(),
      async () => (await listTests()).map((t) => t.fileName),
      async (f) => (await loadTest(f)) as Record<string, unknown> | null,
      async (f, data) => {
        await writeFile(join(libraryDir(), f), JSON.stringify(data, null, 2), 'utf-8')
      }
    )
  })

  // F32/F39: the headless paths run the EXPORTED spec, which reads
  // process.env.PASSWORD — so those runs need the value resolved. Same machine,
  // same user, and it never reaches disk in the renderer.
  ipcMain.handle('secrets:resolve', (_event, refs: string[]) => getSecrets(refs ?? []))

  // === F40: shareable bundles =======================================
  ipcMain.handle(
    'bundle:export',
    async (_event, tests: string[], includeAcs: boolean) => {
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose a folder for the bundle',
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Export here'
      })
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: 'cancelled' }
      // A named subfolder, so exporting into an existing repo folder can't
      // scatter bundle files among the user's own.
      const stamp = new Date().toISOString().slice(0, 10)
      const dest = join(picked.filePaths[0], `qaflow-bundle-${stamp}`)
      const acs = includeAcs ? await loadAcs() : null
      return exportBundle(libraryDir(), dest, tests, acs)
    }
  )

  // Inspect first, apply second: the renderer shows collisions and gets a
  // decision per test BEFORE anything is written.
  ipcMain.handle('bundle:inspect', async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a bundle folder to import',
      properties: ['openDirectory'],
      buttonLabel: 'Inspect'
    })
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, tests: [], error: 'cancelled' }
    const inspection = await inspectBundle(picked.filePaths[0], libraryDir())
    return { ...inspection, bundleDir: picked.filePaths[0] }
  })

  ipcMain.handle(
    'bundle:import',
    async (_event, bundleDir: string, plan: ImportPlanEntry[]) => {
      const res = await importBundle(bundleDir, libraryDir(), plan)
      // Acceptance criteria are additive — a shared AC list should ADD to what
      // you already track, never replace it.
      const acPath = join(bundleDir, 'acceptance-criteria.txt')
      if (existsSync(acPath)) {
        try {
          const incoming = (await readFile(acPath, 'utf-8')).split(/\r?\n/)
          const current = await loadAcs()
          const lines = current ? current.split(/\r?\n/) : []
          for (const a of incoming) {
            const trimmed = a.trim()
            if (trimmed && !lines.some((l) => l.trim() === trimmed)) lines.push(a)
          }
          await saveAcs(lines.join('\n'))
        } catch {
          // a malformed AC file must not fail the whole import
        }
      }
      return res
    }
  )

  ipcMain.handle('bundle:reveal', async (_event, path: string) => {
    // OPEN the bundle, don't reveal it. showItemInFolder drops you in the
    // PARENT with the folder merely selected — which is right for a file, but
    // after "Bundle exported" you clicked this to see what's INSIDE, and landing
    // on your Desktop reads as "the export produced nothing".
    const err = await shell.openPath(path)
    if (err) shell.showItemInFolder(path) // fall back if the folder won't open
  })
  ipcMain.handle('library:listSuites', () => listSuites())
  ipcMain.handle('library:load', (_event, fileName: string) => loadTest(fileName))
  ipcMain.handle('library:delete', (_event, fileName: string) => deleteTest(fileName))
  ipcMain.handle('library:recordRun', (_event, fileName: string, run: RunInfo) =>
    recordRun(fileName, run)
  )
  // F32 — scheduled monitors: the persisted store + a native failure alert. The
  // scheduler lives in the renderer (it owns spec generation + xbrowser.run); main
  // just keeps the config/history and rings the OS notification bell.
  ipcMain.handle('monitors:list', () => listMonitors())
  ipcMain.handle('monitors:save', (_event, mon: Monitor) => saveMonitor(mon))
  ipcMain.handle('monitors:delete', (_event, id: string) => deleteMonitor(id))
  ipcMain.handle('monitors:recordRun', (_event, id: string, run: MonitorRun) =>
    recordMonitorRun(id, run)
  )
  ipcMain.handle('notify:show', (_event, title: string, body: string) => {
    if (!Notification.isSupported()) return
    new Notification({ title, body }).show()
  })
  // F32b: POST a monitor failure to a Slack/Discord/Teams incoming webhook. All
  // three accept a simple JSON `{text}` body, so one shape covers them. Best-effort
  // — a bad/unreachable webhook must never break the run, so errors are swallowed.
  ipcMain.handle(
    'notify:webhook',
    async (_event, url: string, title: string, body: string): Promise<{ ok: boolean; error?: string }> => {
      const hook = (url || '').trim()
      if (!/^https:\/\//.test(hook)) return { ok: false, error: 'Webhook URL must start with https://' }
      try {
        const res = await fetch(hook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `*${title}*\n${body}` })
        })
        return res.ok ? { ok: true } : { ok: false, error: `Webhook returned ${res.status}` }
      } catch (e) {
        return { ok: false, error: reachError(e, hook) }
      }
    }
  )
  // F20 (Option 2): persist / list / re-open edge-case batches (negative-testing
  // evidence), kept separate from the pass/fail run history above.
  ipcMain.handle(
    'library:saveEdgeRun',
    (_event, input: Omit<EdgeRunRecord, 'id' | 'at' | 'variantCount' | 'acceptedCount'>) =>
      saveEdgeRun(input)
  )
  ipcMain.handle('library:listEdgeRuns', (_event, testFile: string) => listEdgeRuns(testFile))
  ipcMain.handle('library:loadEdgeRun', (_event, id: string) => loadEdgeRun(id))
  ipcMain.handle('library:deleteEdgeRun', (_event, id: string) => deleteEdgeRun(id))

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
      // F15: freeze animations on the first baseline too (default on), so it
      // matches how the compare path captures — otherwise a fresh snapshot on an
      // animated page could diff against its own baseline. No mask yet (the user
      // adds selectors via the editor, which re-captures).
      const image = await captureStabilized(activeWC())
      const id = `snap-${Date.now()}`
      await saveBaseline(id, image.toPNG())
      // `value` = allowed diff threshold (percent). 1% tolerates anti-aliasing
      // while still catching real visual changes; editable per step.
      sendStep({ type: 'snapshot', label: 'Visual snapshot', baselineId: id, value: '1' })
    } catch {
      // capture can fail if the page is gone — silently no-op
    }
  })
  // F15: re-capture the baseline from the CURRENT page WITH the given mask +
  // freeze settings, so baseline and future comparisons are stabilized the same
  // way. Called when the snapshot editor's mask/freeze change (a plain
  // updateBaseline would save an un-masked PNG and every masked compare would
  // then differ in the masked region).
  ipcMain.handle(
    'visual:recaptureBaseline',
    async (
      _event,
      baselineId: string,
      maskSelectors: string | undefined,
      freeze: boolean | undefined
    ): Promise<boolean> => {
      if (!isSafeBaselineId(baselineId)) return false
      try {
        // The renderer closes the snapshot editor modal right before calling this,
        // so the browser should end up VISIBLE. Show it (if still hidden), capture,
        // and deliberately LEAVE it shown — restoring the hidden state would flash
        // the browser off then on again as the modal-close independently un-hides
        // it. Both paths converge on "shown", so there's no race and no double-flash.
        // (A hidden view is zero-sized and its capturePage() returns a blank
        // baseline, so it must be full-size here.)
        overlayOpen = false
        resizeEmbedded()
        await wait(150) // let the view resize and the page re-layout at full size
        await waitForVisualStable(activeWC())
        const image = await captureStabilized(activeWC(), maskSelectors, freeze)
        await saveBaseline(baselineId, image.toPNG())
        return true
      } catch {
        return false
      }
    }
  )
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

  // F35 (Mock Studio): hand the renderer the MOCKABLE responses from the last HAR
  // capture — the API calls (XHR/Fetch) with a text body — so it can edit one into
  // a scenario (force a 500, empty a list, flip a flag) and emit a Playwright
  // route/fulfill. Binary/base64 bodies and the page Document are skipped (you don't
  // hand-edit an image or the HTML shell). Bodies are capped so a huge payload can't
  // bloat the IPC message.
  const MOCK_BODY_CAP = 200_000
  ipcMain.handle(
    'har:mockList',
    (): {
      available: boolean
      entries: Array<{
        index: number
        method: string
        url: string
        status: number
        statusText: string
        mimeType: string
        resourceType: string
        body: string
        bodyTruncated: boolean
      }>
    } => {
      const har = lastCapturedHar
      if (!har || !har.log.entries.length) return { available: false, entries: [] }
      const entries: Array<{
        index: number
        method: string
        url: string
        status: number
        statusText: string
        mimeType: string
        resourceType: string
        body: string
        bodyTruncated: boolean
      }> = []
      har.log.entries.forEach((e, index) => {
        const rt = e._resourceType ?? ''
        if (rt === 'Document') return // the HTML shell — not a data mock target
        const content = e.response.content
        if (content.encoding === 'base64') return // binary — not text-editable
        const raw = content.text ?? ''
        entries.push({
          index,
          method: e.request.method,
          url: e.request.url,
          status: e.response.status,
          statusText: e.response.statusText,
          mimeType: (content.mimeType || '').split(';')[0].trim(),
          resourceType: rt,
          body: raw.length > MOCK_BODY_CAP ? raw.slice(0, MOCK_BODY_CAP) : raw,
          bodyTruncated: raw.length > MOCK_BODY_CAP
        })
      })
      return { available: true, entries }
    }
  )

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

  // F18: plain-English "AI Prompt" step. Capture the CURRENT page's interactive
  // elements (each with real selector candidates), let the LLM map the tester's
  // intent onto those elements by index, then build replayable steps from the
  // candidates WE own — so the model never invents a selector. Returns the draft
  // steps for the renderer to insert + review, or null if Claude is unavailable.
  // Shared by F18 (ai:generateSteps) and F21 (ai:generateRegressionTest): expose the
  // page, list its interactive elements, ask the LLM which to act on for `intent`,
  // and map each pick back to the element's OWN candidates (the model never invents
  // a selector). Returns draft steps for the renderer to insert + review, or null if
  // Claude is unavailable.
  const aiStepsFromIntent = async (
    intent: string
  ): Promise<{ steps: unknown[]; note: string } | null> => {
    let captured: Array<{
      index: number
      tag: string
      type: string
      label: string
      candidates: Array<Record<string, unknown>>
    }>
    try {
      // The renderer closes the prompt modal right before calling this (so the
      // native browser doesn't flash up over it while we read the page), which
      // means the browser should end up VISIBLE. Show it (if still hidden), measure
      // at real size, and LEAVE it shown — mirrors visual:recaptureBaseline. Both
      // this and the modal-close converge on "browser shown", so there's no race and
      // no double-flash. (At zero size every element is 0×0 and the filter drops all.)
      overlayOpen = false
      resizeEmbedded()
      await wait(150) // let the view resize and the page re-layout at full size
      captured = (await activeWC().executeJavaScript(AI_CAPTURE_JS, true)) as typeof captured
    } catch {
      captured = []
    }
    const slim = captured.map((e) => ({
      index: e.index,
      tag: e.tag,
      type: e.type,
      label: e.label
    }))
    const result = await generateAiSteps(intent, slim, libraryDir())
    if (result == null) return null
    const steps = result.actions
      .map((a) => {
        const el = captured[a.element]
        if (!el || !el.candidates.length) return null
        // Every candidate carries BOTH a raw `css` string and a `locator`
        // EXPRESSION. `selector` must be the EXPRESSION: every exporter emits
        // `page.${selector}`, so storing raw CSS here produced
        // `page.[data-test="username"]` — a SyntaxError that aborted the whole
        // spec before a single test ran. The app's own replay parses selectors
        // leniently, so these steps went GREEN in-app and failed in every real
        // runner (export, headless, parallel, monitors, cross-browser).
        //
        // Picking on `locator` rather than `css` also stops us skipping the
        // role/text candidates, whose `css` is null but whose locator
        // (`getByRole("textbox", { name: "Username" })`) is perfectly good.
        // Candidates arrive in score order, so the first match is the best one.
        const primary = el.candidates.find((c) => typeof c.locator === 'string' && c.locator) as
          | { locator?: string }
          | undefined
        const base = {
          label: el.label,
          selector: primary?.locator ?? undefined,
          candidates: el.candidates
        }
        if (a.action === 'type') return { type: 'type', ...base, value: a.value ?? '' }
        if (a.action === 'select') return { type: 'select', ...base, value: a.value ?? '' }
        return { type: 'click', ...base }
      })
      .filter(Boolean)
    return { steps, note: result.note }
  }

  ipcMain.handle(
    'ai:generateSteps',
    async (_event, intent: string): Promise<{ steps: unknown[]; note: string } | null> =>
      aiStepsFromIntent(intent)
  )

  // F21: paste a bug's plain-English repro + expected result → reproduce it with the
  // AI (same page-grounding as F18), then append a plain-English `nl` assertion of
  // the EXPECTED behaviour. Result: a test that reproduces the bug AND verifies the
  // fix — replay it before the fix (fails on the assertion), after the fix (passes).
  ipcMain.handle(
    'ai:generateRegressionTest',
    async (
      _event,
      repro: string,
      expected: string
    ): Promise<{ steps: unknown[]; note: string } | null> => {
      const base = await aiStepsFromIntent(repro)
      if (base == null) return null
      const exp = (expected ?? '').trim()
      if (!exp) {
        return {
          steps: base.steps,
          note: `${base.note} — no expected result given, so no verification was added. Add an "expected result" to make it a true regression test.`
        }
      }
      const assertStep = {
        type: 'assert',
        assertKind: 'nl',
        value: exp,
        label: `Expected: ${exp.length > 60 ? exp.slice(0, 57) + '…' : exp}`
      }
      return { steps: [...base.steps, assertStep], note: base.note }
    }
  )

  // F22: draft a whole test from a user story (+ optional PR diff). No live page,
  // so the model can't ground selectors — actions become MANUAL steps (a pause +
  // instruction the tester grounds by recording over them) and checks become real
  // `nl` assertions that run at replay. navigate paths are resolved against the
  // page the user is currently on, so a bare "/inventory" becomes a full URL.
  // Only a target we actually FOUND — a full URL, or a path — is trustworthy.
  // Everything else is a guess, and a guess is reported as one: the step still
  // gets a usable URL, but `guessed` marks it in the review list so a
  // plausible-but-wrong address is caught BEFORE Insert instead of failing much
  // later, at replay, with an error that looks nothing like its cause.
  const isHttpUrl = (u: string): boolean => {
    try {
      return /^https?:$/.test(new URL(u).protocol)
    } catch {
      return false
    }
  }
  const resolveDraftUrl = (text: string, baseUrl?: string): { url: string; guessed: boolean } => {
    const t = (text || '').trim()
    // The model is asked for a bare path/URL, but often wraps it in prose
    // ("Open the login page at /login"). Extract the real target rather than
    // storing the sentence — an un-navigable URL would fail at replay.
    // 1. A full URL anywhere in the text wins (stop at whitespace or a ")").
    const urlInProse = t.match(/https?:\/\/[^\s)]+/i)
    if (urlInProse) {
      const found = urlInProse[0].replace(/[.,]+$/, '') // drop trailing punctuation
      if (isHttpUrl(found)) return { url: found, guessed: false }
    }
    // 2. A path: either the WHOLE string, or one embedded in prose. The whole
    //    string only counts when it contains no whitespace — "/login page shows
    //    the form" starts with "/" but is a SENTENCE, and taking it verbatim is
    //    how prose used to end up in the URL. Requiring a word boundary before
    //    the "/" also stops us grabbing the slash inside things like "and/or".
    const path =
      t.startsWith('/') && !/\s/.test(t) ? t : (t.match(/(?:^|\s)(\/[^\s)]+)/)?.[1] ?? '')
    if (baseUrl) {
      try {
        const base = new URL(baseUrl)
        if (path.length > 1) {
          const abs = base.origin + '/' + path.replace(/^\/+|[.,/]+$/g, '')
          if (isHttpUrl(abs)) return { url: abs, guessed: false }
        }
        // 3. A single bare word like "login" -> a path under the current origin;
        //    prose with no path at all -> the current site's root. Both are
        //    GUESSES: the story never actually named a target.
        const fallback =
          t && !t.includes(' ')
            ? base.origin + '/' + t.replace(/^\/+|\/+$/g, '')
            : base.origin + '/'
        if (isHttpUrl(fallback)) return { url: fallback, guessed: true }
      } catch {
        /* unusable base — fall through */
      }
    }
    // 4. No page open to resolve against. A bare path is still the best answer
    //    we have (the step editor can finish it). Prose is NOT — storing a
    //    sentence as a URL is the very thing this function exists to prevent, so
    //    leave it empty and let the flag tell the user to fill it in.
    return { url: path.length > 1 ? path : '', guessed: true }
  }
  const trunc = (s: string, n = 60): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)
  ipcMain.handle(
    'ai:draftFromStory',
    async (
      _event,
      story: string,
      diff: string | undefined,
      baseUrl: string | undefined
    ): Promise<{ title: string; steps: unknown[]; note: string; guessed: number[] } | null> => {
      const res = await draftTestFromStory(story, diff, libraryDir())
      if (res == null) return null // Claude unavailable — renderer surfaces it
      // Indices of navigate steps whose URL we had to guess. Kept OUT of the step
      // itself so nothing review-only can be saved into the test file.
      const guessed: number[] = []
      const steps = res.steps.map((d, i) => {
        if (d.kind === 'navigate') {
          const target = resolveDraftUrl(d.text, baseUrl)
          if (target.guessed) guessed.push(i)
          return { type: 'navigate', url: target.url, label: `Go to ${trunc(d.text)}` }
        }
        if (d.kind === 'check') {
          return { type: 'assert', assertKind: 'nl', value: d.text, label: `Check: ${trunc(d.text)}` }
        }
        // action → a manual pause with the instruction, for the tester to ground.
        return { type: 'wait', waitKind: 'manual', value: d.text, label: `Do: ${trunc(d.text)}` }
      })
      const notes = [res.note]
      if (guessed.length) {
        notes.push(
          `${guessed.length} “Go to” step${guessed.length === 1 ? '' : 's'} had no clear address in the story — marked ⚠ below. Set the URL before you replay.`
        )
      }
      return { title: res.title, steps, note: notes.filter(Boolean).join(' '), guessed }
    }
  )

  // F22: let the user point at a local git repo and pull a diff to draft from —
  // the "leverages sitting next to the local repo" half. Prefers uncommitted work
  // (git diff HEAD); if the tree is clean, falls back to the last commit's diff.
  // Returns null if the user cancels; an ok:false payload if the folder isn't a repo.
  const gitText = (dir: string, args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-C', dir, ...args],
        { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, stdout) => (err ? reject(err) : resolve(stdout))
      )
    })
  ipcMain.handle(
    'repo:pickDiff',
    async (): Promise<{ ok: boolean; path: string; diff: string; summary: string; note: string } | null> => {
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose the app’s local git repo to draft from',
        properties: ['openDirectory']
      })
      if (picked.canceled || !picked.filePaths.length) return null
      const dir = picked.filePaths[0]
      try {
        await gitText(dir, ['rev-parse', '--is-inside-work-tree'])
      } catch {
        return { ok: false, path: dir, diff: '', summary: '', note: 'That folder isn’t a git repo (or git isn’t installed).' }
      }
      // Uncommitted work first; fall back to the last commit if the tree is clean.
      let diff = ''
      let scope = ''
      try {
        diff = (await gitText(dir, ['diff', 'HEAD'])).trim()
        scope = 'uncommitted changes'
      } catch {
        diff = ''
      }
      if (!diff) {
        try {
          diff = (await gitText(dir, ['diff', 'HEAD~1', 'HEAD'])).trim()
          scope = 'the last commit'
        } catch {
          diff = ''
        }
      }
      if (!diff) {
        return { ok: false, path: dir, diff: '', summary: '', note: 'No changes found (clean tree, no prior commit to diff).' }
      }
      let stat = ''
      try {
        stat = (await gitText(dir, scope === 'the last commit' ? ['diff', '--stat', 'HEAD~1', 'HEAD'] : ['diff', '--stat', 'HEAD'])).trim()
      } catch {
        /* stat is optional */
      }
      const files = (stat.match(/\n/g)?.length ?? 0) || (stat ? 1 : 0)
      const summary = `${basename(dir)} — ${scope}${files ? ` (${files} file${files === 1 ? '' : 's'})` : ''}`
      return { ok: true, path: dir, diff, summary, note: '' }
    }
  )

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

  // === F34: Jira integration ==========================================
  // Push a failure's bug report to Jira as a new issue. Uses Jira Cloud's REST
  // v2 (a plain-string description — v3 needs ADF, which is far heavier for the
  // same result). Basic auth = base64(email:apiToken), the standard Jira Cloud
  // token scheme. Returns the new key + a browse URL, or a readable error so the
  // renderer can show WHY (bad token, wrong project key, etc.) instead of a 500.
  ipcMain.handle(
    'jira:createIssue',
    async (
      _event,
      cfg: {
        baseUrl: string
        email: string
        apiToken: string
        projectKey: string
        summary: string
        description: string
        issueType?: string
      }
    ): Promise<{ ok: boolean; key?: string; url?: string; error?: string }> => {
      const base = (cfg.baseUrl || '').trim().replace(/\/+$/, '')
      // This request carries Basic auth — base64(email:apiToken) — and base64 is
      // encoding, not encryption. Over plain http the token is readable by anyone
      // on the path, so remote http is refused outright. localhost is allowed
      // because that traffic never reaches a network (and it's how F34 is tested
      // against a mock Jira without a real account).
      if (!/^https?:\/\//.test(base)) {
        return { ok: false, error: 'Jira site URL must start with https://' }
      }
      if (/^http:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(base)) {
        return {
          ok: false,
          error:
            'Refusing to send your API token over plain http — that would put it on the network in readable form. Use https:// for the Jira site.'
        }
      }
      if (!cfg.email || !cfg.apiToken) return { ok: false, error: 'Email and API token are required.' }
      if (!cfg.projectKey) return { ok: false, error: 'A project key (e.g. QA) is required.' }
      try {
        const auth = Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64')
        const res = await fetch(`${base}/rest/api/2/issue`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify({
            fields: {
              project: { key: cfg.projectKey.trim() },
              summary: cfg.summary.slice(0, 240),
              description: cfg.description,
              issuetype: { name: cfg.issueType || 'Bug' }
            }
          })
        })
        const text = await res.text()
        if (!res.ok) {
          let msg = `Jira returned ${res.status} ${res.statusText}`
          try {
            const j = JSON.parse(text)
            const detail =
              (Array.isArray(j.errorMessages) && j.errorMessages.join('; ')) ||
              (j.errors && Object.values(j.errors).join('; '))
            if (detail) msg = detail
          } catch {
            /* keep the status line */
          }
          if (res.status === 401) msg = 'Unauthorized — check the email + API token.'
          return { ok: false, error: msg }
        }
        const j = JSON.parse(text)
        return { ok: true, key: j.key, url: `${base}/browse/${j.key}` }
      } catch (e) {
        return { ok: false, error: reachError(e, base) }
      }
    }
  )
  // F34: open Jira's "create issue" page in the real browser — the no-token path
  // (you paste the copied ticket). openExternal is https-guarded like elsewhere.
  ipcMain.handle('jira:openCreate', (_event, baseUrl: string): void => {
    const base = (baseUrl || '').trim().replace(/\/+$/, '')
    if (/^https:\/\//.test(base)) shell.openExternal(`${base}/secure/CreateIssue!default.jspa`)
  })

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
    ): Promise<{ path: string; alsoWrote: string[]; pageOverwritten: boolean } | null> => {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Playwright test',
        defaultPath: 'recorded.spec.ts',
        filters: [{ name: 'TypeScript test', extensions: ['ts'] }]
      })
      if (result.canceled || !result.filePath) return null
      // Everything written BESIDES the spec the dialog named. A POM export, a CI
      // workflow and a cross-browser config all land in folders the user never
      // chose, and reporting only the spec made them look unwritten.
      const alsoWrote: string[] = []
      let pageOverwritten = false
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
      //
      // The save dialog only ever names the SPEC, so this file lands silently and
      // the user is told about one file when two were written. Both paths are
      // returned now so the confirmation can name them.
      if (pageObjectCode && pageObjectFileName) {
        const pagesDir = join(dirname(result.filePath), 'pages')
        const pagePath = join(pagesDir, pageObjectFileName)
        // The class name comes from the TEST name, so two different tests with
        // the same name write the same file. Exporting the second silently
        // replaces the first's page class and leaves that spec paired with a
        // class it no longer matches. Only flag a REAL change — re-exporting the
        // same test is routine and must not nag.
        try {
          const existing = await readFile(pagePath, 'utf-8')
          if (existing !== pageObjectCode) pageOverwritten = true
        } catch {
          // no previous file — nothing to overwrite
        }
        await mkdir(pagesDir, { recursive: true }).catch(() => {})
        await writeFile(pagePath, pageObjectCode, 'utf-8').catch(() => {})
        alsoWrote.push(pagePath)
      }
      // F33: a GitHub Actions workflow that runs the tests on every PR. Written to
      // .github/workflows/ RELATIVE TO THE SPEC — the file's header tells the user
      // to move it to the repo root if the spec lives in a subfolder.
      if (ciWorkflow) {
        const wfDir = join(dirname(result.filePath), '.github', 'workflows')
        const wfPath = join(wfDir, 'playwright.yml')
        await mkdir(wfDir, { recursive: true }).catch(() => {})
        await writeFile(wfPath, ciWorkflow, 'utf-8').catch(() => {})
        alsoWrote.push(wfPath)
      }
      // F17: a cross-browser playwright.config.ts written beside the spec, so
      // `npx playwright test` runs it on Chromium + Firefox + WebKit.
      if (configFile) {
        const cfgPath = join(dirname(result.filePath), 'playwright.config.ts')
        await writeFile(cfgPath, configFile, 'utf-8').catch(() => {})
        alsoWrote.push(cfgPath)
      }
      return { path: result.filePath, alsoWrote, pageOverwritten }
    }
  )
}

// If the user types "google.com" we turn it into "https://google.com"
function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  // Leave ANY explicit scheme alone — http(s)://, file://, chrome://, about:,
  // data:, etc. Only a bare domain like "example.com" or "localhost:5173" gets
  // https:// prepended. A `host:port` is NOT a scheme (no `//` after the colon),
  // so it still gets the prefix. (The old whitelist mangled `chrome://version`
  // into `https://chrome://version` because chrome wasn't on the list.)
  if (/^[a-zA-Z][\w+.-]*:\/\//.test(trimmed) || /^(about|data|blob|view-source):/i.test(trimmed))
    return trimmed
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
