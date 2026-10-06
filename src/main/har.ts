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

import { redact, REDACTED, userPatterns, type PrivacySettings } from '../shared/evidencePrivacy'

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

// =====================================================================
// EVIDENCE PRIVACY FOR SAVED ARCHIVES  (audit: "HAR artifacts may contain
// sensitive business data")
// =====================================================================
// A HAR is the most complete copy of a run's data the app writes: every API
// response body, every request header, every form post. The evidence-privacy
// policy used to stop at the trace, so a tester who switched redaction on
// still banked the raw archive next to the test — the one file most likely to
// be committed, since the test needs it to replay.
//
// This applies the SAME policy through the SAME redact() — not a second
// redactor with its own idea of what is sensitive — at the point an archive
// is written to disk. The in-memory capture is left alone: it never leaves the
// machine, and the Mock editor and "replay the last capture" read it live.
//
// == What each field costs replay, and why each is redacted anyway ==
//
// A HAR is not only evidence; it is REPLAYED (F1 in-app, and routeFromHAR in
// exported specs). So every field below is a trade, decided per field:
//
//   · request/response HEADERS — redacted. In-app replay matches on method +
//     URL only, and routeFromHAR uses headers only to break ties. Cost: a
//     replayed Set-Cookie now sets the literal "[redacted]", which a frozen
//     backend never reads back anyway.
//   · the QUERY STRING (and the query part of the URL) — redacted. The PATH
//     is deliberately kept: it is the replay key. In-app replay already falls
//     back to matching on the path without the query, so it still serves the
//     entry; an exported spec (notFound: 'fallback') sends that one request to
//     the live network instead. A path segment that is itself personal data
//     (/users/jane@x.com) is therefore NOT redacted — said here, and on the
//     privacy screen, rather than claimed covered.
//   · POST DATA — redacted. Used only to tell apart same-URL POSTs.
//   · RESPONSE BODIES — redacted, and this is the expensive one: replay now
//     SERVES "[redacted]" where the data was, so a step that checks that exact
//     value fails on replay. It is redacted anyway because the body IS the
//     data — without it the policy would be a statement about headers. JSON is
//     redacted value by value so the body stays valid JSON (a card number
//     stored as a JSON number becomes the string "[redacted]" rather than
//     breaking the parse and blanking the page on replay).
//   · base64 (binary) bodies — skipped. A text pattern cannot match inside
//     base64, and capture keeps only Document/XHR/Fetch, which are text.
// =====================================================================

// Header values that are credentials BY NAME. The built-in "auth-header"
// pattern relies on the name sitting next to the value in one line of text; a
// HAR stores them apart, and a session cookie has no recognisable shape at
// all. Tied to the built-ins switch, whose promise is "tokens" — a session
// cookie in a committed archive is a working login for whoever reads it.
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key'
])

function redactHeader(h: HarHeader, settings: PrivacySettings): HarHeader {
  if (settings.builtins && CREDENTIAL_HEADERS.has(h.name.toLowerCase())) {
    return { name: h.name, value: REDACTED }
  }
  // A header whose value IS an address — Referer on nearly every request,
  // Location on a redirect — carries the previous page's query string
  // percent-encoded ("jane%40x.com"), which no text pattern recognises. The
  // request URL itself was decoded and redacted while its Referer copy went
  // to disk untouched; give it the same treatment as the URL.
  if (/^https?:\/\//i.test(h.value.trim())) {
    const value = redactUrl(h.value.trim(), settings)
    if (value !== h.value.trim()) return { name: h.name, value }
  }
  // Redacted as "name: value" so a pattern that needs the header's name for
  // context (the built-in auth-header rule, or a user's own) still sees it.
  const prefix = `${h.name}: `
  const joined = prefix + h.value
  const out = redact(joined, settings)
  if (out === joined) return h
  return { name: h.name, value: out.startsWith(prefix) ? out.slice(prefix.length) : REDACTED }
}

function redactJsonValue(v: unknown, settings: PrivacySettings): unknown {
  if (typeof v === 'string') return redact(v, settings)
  if (typeof v === 'number') return redact(String(v), settings) === String(v) ? v : REDACTED
  if (Array.isArray(v)) return v.map((x) => redactJsonValue(x, settings))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = redactJsonValue(x, settings)
    return out
  }
  return v
}

// Form bodies and query strings are percent-encoded: "jane%40x.com" does not
// look like an email to any pattern. Decode, redact, re-encode — and only
// re-encode when something changed, so an untouched body stays byte-identical.
function redactFormPairs(text: string, settings: PrivacySettings): string {
  const out = new URLSearchParams()
  let changed = false
  new URLSearchParams(text).forEach((value, name) => {
    const red = redact(value, settings)
    if (red !== value) changed = true
    out.append(name, red)
  })
  return changed ? out.toString() : redact(text, settings)
}

/** Redact one body by what it is: JSON value by value, a form pair by pair,
 *  anything else as plain text. */
export function redactBodyText(text: string, mimeType: string, settings: PrivacySettings): string {
  if (!text) return text
  const mime = (mimeType || '').toLowerCase()
  if (mime.includes('json') || /^\s*[[{]/.test(text)) {
    try {
      const parsed: unknown = JSON.parse(text)
      const red = redactJsonValue(parsed, settings)
      // Unchanged → the original bytes, not a re-serialisation that would
      // differ in whitespace and look like an edit to anyone diffing the file.
      return JSON.stringify(red) === JSON.stringify(parsed) ? text : JSON.stringify(red)
    } catch {
      // not actually JSON — handled as text below
    }
  }
  if (mime.includes('x-www-form-urlencoded')) return redactFormPairs(text, settings)
  return redact(text, settings)
}

// The query (and fragment) of a URL, redacted; the origin + path kept as the
// replay key (see above).
function redactUrl(url: string, settings: PrivacySettings): string {
  const cut = url.search(/[?#]/)
  if (cut < 0) return url
  const base = url.slice(0, cut)
  const rest = url.slice(cut)
  const hashAt = rest.indexOf('#')
  const query = hashAt >= 0 ? rest.slice(0, hashAt) : rest
  const hash = hashAt >= 0 ? redact(rest.slice(hashAt), settings) : ''
  if (!query) return base + hash
  return `${base}?${redactFormPairs(query.slice(1), settings)}${hash}`
}

// =====================================================================
// THE TEST'S OWN SECRETS — blanked whatever the privacy policy says
// =====================================================================
// A recorded login posts the password, so the capture holds it in the form
// body (and sometimes the URL or a response). The policy's patterns can't see
// it: a password has no shape. But the app KNOWS the value — it is the test's
// own secret — so it is blanked by value, always, policy on or off. This is
// the F40 promise ("no password in a file next to the tests") applied to the
// one file that copies what the page sent rather than what the test says.
//
// Each value is matched as typed AND in the forms a request carries it:
// percent-encoded (URLs), form-encoded (spaces as +) and JSON-escaped. Values
// shorter than MIN_SCRUB_LENGTH are skipped — blanking "ab" everywhere would
// wreck the page HTML in the archive and the replay along with it.
// =====================================================================

export const MIN_SCRUB_LENGTH = 4

function scrubForms(values: string[]): string[] {
  const forms = new Set<string>()
  for (const v of values) {
    if (typeof v !== 'string' || v.length < MIN_SCRUB_LENGTH) continue
    forms.add(v)
    forms.add(encodeURIComponent(v))
    forms.add(new URLSearchParams({ v }).toString().slice(2))
    forms.add(JSON.stringify(v).slice(1, -1))
  }
  // Longest first, so a value is replaced whole rather than around a shorter
  // value it happens to contain.
  return [...forms].filter((f) => f.length >= MIN_SCRUB_LENGTH).sort((a, b) => b.length - a.length)
}

function scrubString(s: string, forms: string[]): string {
  let out = s
  for (const f of forms) if (out.includes(f)) out = out.split(f).join(REDACTED)
  return out
}

/** Every string in a value, scrubbed — except a base64 body, which a text
 *  match can't reach into and must not be corrupted by trying. */
function scrubDeep(v: unknown, forms: string[], key?: string, parent?: unknown): unknown {
  if (typeof v === 'string') {
    const isBase64Body =
      key === 'text' && (parent as { encoding?: string } | undefined)?.encoding === 'base64'
    return isBase64Body ? v : scrubString(v, forms)
  }
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, forms))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = scrubDeep(x, forms, k, v)
    return out
  }
  return v
}

/**
 * The archive with these secret values blanked everywhere they appear. Returns
 * the SAME object when nothing matched (or there is nothing to look for), so an
 * untouched archive is written byte-identical. Never mutates the input.
 */
export function scrubSecretValues(log: HarLog, values: string[]): HarLog {
  const forms = scrubForms(values)
  if (!forms.length) return log
  let changed = false
  const entries = log.log.entries.map((e): HarEntry => {
    const before = JSON.stringify(e)
    const next = scrubDeep(e, forms) as HarEntry
    if (JSON.stringify(next) === before) return e
    changed = true
    // Keep the size fields honest about the text they describe.
    const post = next.request.postData
    if (post) next.request.bodySize = Buffer.byteLength(post.text, 'utf8')
    const c = next.response.content
    if (c.text != null && c.encoding !== 'base64') {
      c.size = Buffer.byteLength(c.text, 'utf8')
      next.response.bodySize = c.size
    }
    return next
  })
  return changed ? { log: { ...log.log, entries } } : log
}

/**
 * The archive as it may be written to disk under this policy.
 *
 * Returns the SAME object when the policy has no text redaction on (the
 * common case costs one check), otherwise a redacted copy. The input is never
 * mutated: the live capture is still read by replay and the Mock editor.
 */
export function redactHar(log: HarLog, settings: PrivacySettings): HarLog {
  if (!settings.builtins && !userPatterns(settings).length) return log
  const entries = log.log.entries.map((e): HarEntry => {
    const post = e.request.postData
    const postText = post ? redactBodyText(post.text, post.mimeType, settings) : undefined
    const content = e.response.content
    const binary = content.encoding === 'base64'
    const text =
      content.text != null && !binary
        ? redactBodyText(content.text, content.mimeType, settings)
        : content.text
    const size = text != null && !binary ? Buffer.byteLength(text, 'utf8') : content.size
    return {
      ...e,
      request: {
        ...e.request,
        url: redactUrl(e.request.url, settings),
        headers: e.request.headers.map((h) => redactHeader(h, settings)),
        queryString: e.request.queryString.map((q) => ({
          name: q.name,
          value: redact(q.value, settings)
        })),
        ...(post && postText != null
          ? {
              postData: { mimeType: post.mimeType, text: postText },
              bodySize: Buffer.byteLength(postText, 'utf8')
            }
          : {})
      },
      response: {
        ...e.response,
        headers: e.response.headers.map((h) => redactHeader(h, settings)),
        content: { ...content, ...(text != null ? { text } : {}), size },
        bodySize: size
      }
    }
  })
  return { log: { ...log.log, entries } }
}
