// =====================================================================
// HAR RECORD & REPLAY (F1) — the biggest flake-killer.
//
// While recording we capture the page's network traffic (requests +
// responses, INCLUDING bodies) into a HAR file saved with the test. On
// replay we intercept each outgoing request and serve the SAVED response
// instead of hitting the real backend — so the test runs against a frozen,
// known-good copy of the server. Most flaky failures aren't the UI breaking;
// they're the backend being slow / down / returning slightly different data.
// Freeze the backend and that whole class of flakiness disappears.
//
// We write the STANDARD HAR 1.2 format (http://www.softwareishard.com/har),
// so the same file also opens in Chrome DevTools and works with Playwright's
// routeFromHAR — not a private format.
//
// The CDP orchestration (getting bodies, intercepting) lives in index.ts,
// next to the existing debugger machinery; this module is the pure data +
// matching logic, so it can be reasoned about and tested on its own.
// =====================================================================

export interface HarHeader {
  name: string
  value: string
}

export interface HarEntry {
  startedDateTime: string
  time: number
  // CDP resource type (Document / XHR / Fetch / …) — not part of the HAR spec
  // proper, but harmless extra data and useful for our own filtering/UI.
  _resourceType?: string
  request: {
    method: string
    url: string
    httpVersion: string
    headers: HarHeader[]
    queryString: HarHeader[]
    cookies: []
    headersSize: number
    bodySize: number
    postData?: { mimeType: string; text: string }
  }
  response: {
    status: number
    statusText: string
    httpVersion: string
    headers: HarHeader[]
    cookies: []
    content: { size: number; mimeType: string; text?: string; encoding?: 'base64' }
    redirectURL: string
    headersSize: number
    bodySize: number
  }
  cache: Record<string, never>
  timings: { send: number; wait: number; receive: number }
}

export interface HarLog {
  log: {
    version: '1.2'
    creator: { name: string; version: string }
    entries: HarEntry[]
  }
}

// Which requests we keep: the DATA-bearing ones that actually cause flaky
// tests — API calls (XHR/fetch) and page documents. Images/fonts/media/css
// are deliberately skipped so HAR files stay small (KBs, not MBs). (Widen this
// set later for a full-offline capture mode.)
export const CAPTURE_RESOURCE_TYPES = new Set(['Document', 'XHR', 'Fetch'])

export function shouldCaptureType(resourceType: string | undefined): boolean {
  return !!resourceType && CAPTURE_RESOURCE_TYPES.has(resourceType)
}

export function newHarLog(): HarLog {
  return {
    log: {
      version: '1.2',
      creator: { name: 'QATestFlow Recorder', version: '1.0' },
      entries: []
    }
  }
}

export function headersToArray(headers: Record<string, string> | undefined): HarHeader[] {
  if (!headers) return []
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }))
}

function queryStringOf(url: string): HarHeader[] {
  try {
    const out: HarHeader[] = []
    new URL(url).searchParams.forEach((value, name) => out.push({ name, value }))
    return out
  } catch {
    return []
  }
}

// Assemble one standard HAR entry from the CDP pieces we collected for a
// single request. `body`/`base64` come from Network.getResponseBody.
export function buildEntry(parts: {
  method: string
  url: string
  requestHeaders?: Record<string, string>
  postData?: string
  status: number
  statusText?: string
  mimeType?: string
  responseHeaders?: Record<string, string>
  body: string
  base64: boolean
  resourceType?: string
  startedDateTime?: string
}): HarEntry {
  const size = parts.base64
    ? Math.floor((parts.body.length * 3) / 4)
    : Buffer.byteLength(parts.body, 'utf8')
  return {
    startedDateTime: parts.startedDateTime ?? new Date(0).toISOString(),
    time: 0,
    _resourceType: parts.resourceType,
    request: {
      method: parts.method,
      url: parts.url,
      httpVersion: 'HTTP/1.1',
      headers: headersToArray(parts.requestHeaders),
      queryString: queryStringOf(parts.url),
      cookies: [],
      headersSize: -1,
      bodySize: parts.postData ? Buffer.byteLength(parts.postData, 'utf8') : -1,
      ...(parts.postData
        ? {
            postData: {
              mimeType: parts.requestHeaders?.['content-type'] ?? '',
              text: parts.postData
            }
          }
        : {})
    },
    response: {
      status: parts.status,
      statusText: parts.statusText ?? '',
      httpVersion: 'HTTP/1.1',
      headers: headersToArray(parts.responseHeaders),
      cookies: [],
      content: {
        size,
        mimeType: parts.mimeType ?? 'application/octet-stream',
        text: parts.body,
        ...(parts.base64 ? { encoding: 'base64' as const } : {})
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: size
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 }
  }
}

// Strip the query string + trailing slash — the fallback key when an exact
// URL match fails (cache-busting timestamps/tokens vary run to run).
function pathKey(url: string): string {
  try {
    const u = new URL(url)
    return (u.origin + u.pathname).replace(/\/$/, '')
  } catch {
    return url.split('?')[0].replace(/\/$/, '')
  }
}

// Find the saved response for a live request. Exact method+url first; then the
// same method with the query stripped (handles cache-busting params). Returns
// null when nothing matches → the caller lets it hit the live network.
export function matchEntry(entries: HarEntry[], method: string, url: string): HarEntry | null {
  const m = method.toUpperCase()
  const exact = entries.find((e) => e.request.method.toUpperCase() === m && e.request.url === url)
  if (exact) return exact
  const key = pathKey(url)
  const byPath = entries.find(
    (e) => e.request.method.toUpperCase() === m && pathKey(e.request.url) === key
  )
  return byPath ?? null
}

// CDP's getResponseBody hands back the DECODED body, but the saved response
// headers still describe the ENCODED bytes. If we serve the decoded body under
// a `content-encoding: gzip` / stale `content-length`, the browser mis-decodes
// it and the page breaks. Strip those (and hop-by-hop) headers when serving.
const STRIP_ON_SERVE = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection'
])
export function serveHeaders(entry: HarEntry): HarHeader[] {
  return entry.response.headers.filter((h) => !STRIP_ON_SERVE.has(h.name.toLowerCase()))
}

// A response's body as a base64 string (what CDP Fetch.fulfillRequest wants),
// decoding/encoding as needed.
export function entryBodyBase64(entry: HarEntry): string {
  const content = entry.response.content
  if (content.text == null) return ''
  return content.encoding === 'base64'
    ? content.text
    : Buffer.from(content.text, 'utf8').toString('base64')
}
