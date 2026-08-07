// =====================================================================
// F1 — NETWORK CAPTURE (the HAR recorder)
//
// Lifted out of index.ts's createWindow closure, where it was 135 lines of
// stateful CDP plumbing tangled up with everything else in the main process.
//
// It takes a STRUCTURAL type rather than Electron's WebContents — the only
// thing it needs is a debugger with attach/detach/sendCommand/on. That keeps
// this module free of Electron entirely, which is what lets it be tested with a
// fake instead of a real browser. The pure half (buildEntry / matchEntry) already
// lives in har.ts; this is the stateful half that drives it.
// =====================================================================

import { buildEntry, newHarLog, shouldCaptureType, type HarLog } from './har'

/** The CDP debugger 'message' listener shape: (event, method, params). */
type CdpListener = (event: unknown, method: string, params: Record<string, unknown>) => void

interface DebuggerLike {
  isAttached(): boolean
  attach(version: string): void
  detach(): void
  // Electron types this as Promise<any>. Mirrored deliberately: it lets the
  // moved body stay verbatim, and CDP results genuinely are shape-per-command.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendCommand(method: string, params?: Record<string, unknown>): Promise<any>
  on(event: 'message', listener: CdpListener): void
  removeListener(event: 'message', listener: CdpListener): void
}

/** Just enough of a WebContents to record from — see the note above. */
export interface WebContentsLike {
  debugger: DebuggerLike
}

export interface HarRecorder {
  /** Is capture switched ON for the next recording? (The user's toggle.) */
  isEnabled(): boolean
  setEnabled(on: boolean): void
  /** Is a capture running RIGHT NOW? */
  isCapturing(): boolean
  start(wc: WebContentsLike): Promise<void>
  /** Stop and return how many entries were captured. */
  stop(): number
  /** The finished log, for the Save panel to bank. */
  captured(): HarLog | null
  count(): number
  reset(): void
}

export function createHarRecorder(): HarRecorder {
  // === F1 (HAR) network capture ======================================
  // When ON, recording also captures the page's network (requests + response
  // bodies) into a HAR via a CDP debugger attached to the active tab. On stop
  // the finished log is kept in `lastCapturedHar` for the Save panel to bank.
  let harCaptureEnabled = false
  let lastCapturedHar: HarLog | null = null
  let harCapture: { wc: WebContentsLike; onMessage: CdpListener } | null = null

  const startHarCapture = (wc: WebContentsLike): Promise<void> => {
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

  return {
    isEnabled: () => harCaptureEnabled,
    setEnabled: (on: boolean) => {
      harCaptureEnabled = on
    },
    isCapturing: () => harCapture !== null,
    start: startHarCapture,
    stop: stopHarCapture,
    captured: () => lastCapturedHar,
    count: () => lastCapturedHar?.log.entries.length ?? 0,
    reset: () => {
      lastCapturedHar = null
    }
  }
}
