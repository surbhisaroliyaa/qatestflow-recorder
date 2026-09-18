import { ipcRenderer, webFrame, webUtils } from 'electron'
import {
  createObserver,
  dialogShimProgram,
  type ObserverFrameStep,
  type ObserverHandle
} from '../main/observerSource'

// =====================================================================
// THE RECORDER PRELOAD — runs in the ISOLATED world of EVERY frame
// =====================================================================
// QF-002, completed. The page under test cannot see anything in this file:
// it runs in Electron's isolated world (contextIsolation), in a sandboxed
// renderer, and its only link to the app is ipcRenderer — which exists only
// here. Every frame gets its own copy (nodeIntegrationInSubFrames on the
// view), and main learns which frame sent an event from Electron itself
// (event.senderFrame), so there is nothing for a page to forge or sniff.
//
// History, because it matters for what comes next: the Day 15 rewrite had
// moved the observer OUT of the preload and into the page world, because
// preload-into-subframes "randomly" missed iframes. A probe on Electron 44
// (2026-09-18) pinned down which ones: iframes whose content is written by
// script into about:blank — rich-text editors, many widgets — get no preload.
// Those are adopted below by the frame that contains them, so nothing is
// missed and nothing runs in the page world.

// Marks "a recorder lives in this frame" — in THIS isolated world, where a
// parent frame's recorder (same world, same origin) can read it through
// iframe.contentWindow and the page cannot.
;(window as unknown as { __qaRecorderHere?: boolean }).__qaRecorderHere = true

// The one page-world piece — the native-dialog shim (see dialogShimProgram) —
// is installed by THIS frame's own preload, into its own main world, at the
// very start of the document: before any page script runs, so even a dialog a
// page opens while loading is caught.
//
// It used to be injected by MAIN with executeJavaScript as frames loaded. That
// broke recording in real iframes: an iframe with a src starts on an empty
// about:blank document, and main's injection into THAT document stopped
// Electron from running this preload when the iframe navigated to its real
// page (it keeps the same window). Whether it happened depended on timing, so
// it looked random. (Pinned down 2026-09-18 with tools/e2e-smoke.mjs.)
const SHIM = `(${dialogShimProgram.toString()})();`
webFrame.executeJavaScript(SHIM).catch(() => {
  // a frame with no document to run in — nothing to shim
})

let state = { recording: false, picking: false }
const send = (channel: string, payload: Record<string, unknown>): void =>
  ipcRenderer.send(channel, payload)

// Every document this preload observes: its own, plus adopted children,
// keyed by their frame path relative to this frame ('' = this frame).
const observed = new Map<string, { doc: Document; handle: ObserverHandle }>()
const pathKey = (path: ObserverFrameStep[] | null): string => (path ? JSON.stringify(path) : '')

function observe(
  win: Window & typeof globalThis,
  doc: Document,
  path: ObserverFrameStep[] | null
): void {
  const key = pathKey(path)
  const known = observed.get(key)
  if (known && known.doc === doc) return
  const handle = createObserver(win, doc, {
    send,
    frame: path,
    recording: state.recording,
    picking: state.picking
  })
  observed.set(key, { doc, handle })
  watchUploads(doc, path)
  // An adopted frame has no preload of its own to install the dialog shim, so
  // do it from here: an inline <script> inserted into a document runs in THAT
  // document's page world. (A frame under a CSP that forbids inline scripts
  // keeps native dialogs — rare, and the only cost is dialogs in that frame.)
  if (path) {
    try {
      const s = doc.createElement('script')
      s.textContent = SHIM
      ;(doc.head || doc.documentElement).appendChild(s)
      s.remove()
    } catch {
      // no document to insert into yet
    }
  }
  adoptChildren(doc, path ?? [])
}

// === Adopting script-written iframes ================================
// A child iframe we can reach (same origin) whose own world has no recorder
// is one Electron gave no preload to. Observe it from here, reporting its
// frame path so main files its steps under the right frame. Recurses, so a
// script-written frame inside another is adopted too.
function adoptChildren(doc: Document, prefix: ObserverFrameStep[]): void {
  const scan = (): void => {
    for (const iframe of Array.from(doc.querySelectorAll('iframe, frame'))) {
      const el = iframe as HTMLIFrameElement
      // Only a frame with NO address of its own is script-written. A frame with
      // a real src (or srcdoc) loads its own document and gets its own preload
      // — but it starts life as an empty about:blank for a moment first, and
      // adopting it THEN filed every later step in it under "about:blank", so
      // replay couldn't find them. (Found by tools/e2e-smoke.mjs.)
      const src = (el.getAttribute('src') || '').trim().toLowerCase()
      if (el.hasAttribute('srcdoc')) continue
      const written = !src || src === 'about:blank' || src.startsWith('javascript:')
      let cw: (Window & typeof globalThis) | null = null
      let cd: Document | null = null
      try {
        cw = el.contentWindow as (Window & typeof globalThis) | null
        cd = el.contentDocument
      } catch {
        continue // cross-origin: it has (or will have) its own preload
      }
      if (!cw || !cd) continue
      if ((cw as unknown as { __qaRecorderHere?: boolean }).__qaRecorderHere) continue
      // The same identity main sees for this frame (WebFrameMain url + name).
      // A script-written frame's committed url is about:blank.
      let url = 'about:blank'
      if (!written) {
        // A frame with a real src normally gets its own preload — but NOT if
        // the page touched the frame's window while it was still the initial
        // about:blank (read its name, posted it a message). Electron then
        // keeps that window for the real page and never runs the preload.
        // Google's ad scripts do exactly that to every frame, so on a site
        // with ads a same-origin form iframe recorded nothing (found on
        // practice.expandtesting.com/iframe, 2026-09-18). Adopt it — but only
        // once its REAL document is in: adopting the initial about:blank
        // filed its steps under the wrong frame.
        if (!cd.URL || cd.URL === 'about:blank' || cd.readyState === 'loading') continue
        url = cd.URL
      }
      const step: ObserverFrameStep = { url, name: cw.name || '' }
      observe(cw, cd, [...prefix, step])
    }
  }
  scan()
  // Frames added later, and a frame whose content is (re)written on load.
  try {
    new MutationObserver(scan).observe(doc.documentElement, { childList: true, subtree: true })
  } catch {
    // no documentElement yet — the load listener below still rescans
  }
  doc.addEventListener('load', scan, true)
}

// === File uploads ====================================================
// The page world has no access to a file's real disk path; this world does
// (webUtils.getPathForFile). Captured here for every observed document, and
// only ever sent from here — never accepted from a page.
function watchUploads(doc: Document, path: ObserverFrameStep[] | null): void {
  doc.addEventListener(
    'change',
    (event: Event) => {
      if (!event.isTrusted || !state.recording) return
      const el = event.target as HTMLInputElement | null
      if (!el || el.tagName !== 'INPUT' || el.type !== 'file' || !el.files || !el.files.length)
        return
      const files = Array.from(el.files)
      const paths: string[] = []
      for (const f of files) {
        try {
          const p = webUtils.getPathForFile(f)
          if (p) paths.push(p)
        } catch {
          // not resolvable (e.g. a synthetic file) — skip it
        }
      }
      if (!paths.length) return
      const facts: { tag: string; id?: string; name?: string; testId?: string } = { tag: 'input' }
      if (el.id) facts.id = el.id
      const name = el.getAttribute('name')
      if (name) facts.name = name
      const testId = el.getAttribute('data-test') || el.getAttribute('data-testid')
      if (testId) facts.testId = testId
      ipcRenderer.send('recorder:upload', {
        facts,
        paths,
        names: files.map((f) => f.name),
        frame: path
      })
    },
    true
  )
}

// === State from main =================================================
const apply = (s: unknown): void => {
  const v = s as { recording?: unknown; picking?: unknown } | null
  if (!v || typeof v !== 'object') return
  state = { recording: v.recording === true, picking: v.picking === true }
  for (const { handle } of observed.values()) {
    handle.setActive(state.recording)
    handle.setPicking(state.picking)
  }
}
ipcRenderer.on('recorder:state', (_e, s: unknown) => apply(s))

// Self-heal lookup (Day 18): main asks a frame to find the element a broken
// step meant. `path` names an adopted child when the frame itself has no
// preload of its own.
ipcRenderer.on('recorder:find', (_e, reqId: unknown, args: unknown, path: unknown) => {
  let result: unknown = null
  try {
    const a = Array.isArray(args) ? args : []
    const key = Array.isArray(path) && path.length ? JSON.stringify(path) : ''
    const target = observed.get(key)
    if (target) {
      result = target.handle.findByLabel(
        String(a[0] ?? ''),
        a[1] as string | undefined,
        a[2] as string | undefined,
        (a[3] as { x: number; y: number; w: number; h: number } | null) ?? null,
        a[4] as string | undefined
      )
    }
  } catch {
    result = null
  }
  ipcRenderer.send('recorder:found', reqId, result)
})

// === Start ===========================================================
const start = (): void => {
  observe(window as Window & typeof globalThis, document, null)
  // Ask main for the current record/pick state: a frame that loads mid-
  // recording must come up already recording.
  ipcRenderer
    .invoke('recorder:hello')
    .then(apply)
    .catch(() => {
      // not one of the app's tabs — stay idle
    })
}
if (document.documentElement) start()
else document.addEventListener('DOMContentLoaded', start, { once: true })
