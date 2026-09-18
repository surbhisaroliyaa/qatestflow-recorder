import { ipcRenderer, webUtils } from 'electron'
import { relayDecision } from '../shared/recorderMessages'

// =====================================================================
// THE RELAY (Day 15 rewrite)
// =====================================================================
// The recorder observer no longer lives here. It is injected into EVERY frame
// of the embedded browser by main (see observerSource.ts + injectObserver in
// src/main/index.ts), because Electron's preload-into-sub-frames mechanism was
// unreliable — iframes randomly went uncaptured.
//
// This preload now loads ONLY in the top frame (nodeIntegrationInSubFrames is
// off again). Its single job is to be the bridge: the injected observers, which
// run in the page world and have no ipcRenderer, post their events UP to the
// top window via window.top.postMessage. Here — in the top frame, where
// ipcRenderer IS available — we forward each one to main over IPC, unchanged.
//
// So every recorded event from any frame travels:
//   frame's observer ──postMessage──▶ top window ──(this relay)──▶ main (IPC)

// === QF-002: this relay is a TRUST BOUNDARY, not a pipe ==============
// It used to forward any channel name with any payload for any message tagged
// __qaflow, which meant the website under test could pick an Electron IPC
// channel and call it. See src/shared/recorderMessages.ts for the full finding
// and for what this does and does not fix.
//
// The nonce is re-rolled by main for every recording session and delivered
// HERE, over IPC, into the preload's isolated world — a place the page's own
// scripts cannot read. A page that has never observed a live recorder message
// cannot guess it.
let sessionNonce: string | null = null

ipcRenderer.on('recorder:arm', (_event, nonce: unknown) => {
  sessionNonce = typeof nonce === 'string' && nonce ? nonce : null
})

// Is the sender a frame of THIS tab?
//
// Comparing `.top` rather than walking `.parent` is deliberate: the observer is
// injected into every frame at any depth, and a parent check would silently
// stop recording anything inside a nested iframe — the exact capture gap the
// Day 15 rewrite existed to close. `.top` is readable cross-origin, so this
// works for foreign frames too, while a message from another tab or from an
// opener fails it.
function isSameTab(source: MessageEventSource | null): boolean {
  try {
    return !!source && (source as Window).top === window.top
  } catch {
    return false // unreadable source — not something to trust
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  // Every rule about what may cross lives in relayDecision, so it can be tested
  // from the attacker's side without Electron. This is only the plumbing.
  const relay = relayDecision({
    sessionNonce,
    sameTab: isSameTab(event.source),
    data: event.data
  })
  if (!relay) return
  ipcRenderer.send(relay.channel, relay.payload)
})

// === Day 16: file upload capture (TOP frame only) ====================
// The injected observer runs in the PAGE world, where Electron no longer
// exposes a file's real disk path (File.path was removed). This relay preload
// runs in an isolated world that DOES have `webUtils.getPathForFile`, so it
// captures file-input changes itself: resolve the real path(s), gather a few
// identifying facts (id / name / data-test) so MAIN can build the selector with
// the normal engine, and forward an `recorder:upload` event. Main records it as
// an `upload` step only while recording; replay sets the file via CDP.
document.addEventListener(
  'change',
  (event: Event) => {
    const el = event.target as HTMLInputElement | null
    if (!el || el.tagName !== 'INPUT' || el.type !== 'file' || !el.files || !el.files.length) return
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
      names: files.map((f) => f.name)
    })
  },
  true
)
