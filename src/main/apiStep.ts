// =====================================================================
// API TEST STEP (F24)
// A step that fires an HTTP request and asserts on the response, inline with
// the UI flow. Real suites are not pure-UI: they seed a user over the API
// before a login test, assert a REST contract mid-flow, or tear down data
// after — the setup/teardown/contract checks that would otherwise force you
// out of the recorder and into hand-written code. This runs the request in
// the MAIN process (Node's fetch), independent of the embedded browser, so it
// works even on a blank page and never fights the page's own network.
//
// Pure + injectable: parseHeaders / statusMatches are exported for unit checks,
// and runApiStep takes plain input so it can be exercised without Electron.
// =====================================================================

import {
  runChecks,
  checkContract,
  inferContract,
  type Contract,
  type CheckFailure
} from './apiChecks'

export interface ApiStepInput {
  method?: string // GET (default) | POST | PUT | PATCH | DELETE
  url?: string
  headers?: string // raw text, one "Name: value" per line
  body?: string // request body (POST/PUT/PATCH)
  expectStatus?: string // "200" | "2xx"/"4xx"/"5xx" family | "204,404" list | blank = any 2xx
  expectBody?: string // substring the response body must contain; blank = skip
  // F24.2: real assertions, one per line ("status equals CONFIRMED"). A substring
  // check cannot tell you a field exists, is non-empty, or equals anything.
  checks?: string
  // F24.2: the response SHAPE captured from a known-good run — catches a backend
  // renaming/dropping a field, which no value assertion can.
  contract?: Contract
  // F24.2: SLA — fail if the response took longer than this (ms). We already
  // measured it; not being able to assert on it was the odd part.
  maxMs?: number
  // F24.2: give up on the request after this many ms. Node's fetch has NO default
  // timeout, so without this a dead endpoint hangs the whole suite forever.
  timeoutMs?: number
  // F29 (chaos): add this much latency before the request goes out, mirroring the
  // Slow-3G profile CDP applies to the browser tab.
  //
  // Chaos throttles the TAB via CDP — which an API step never touches, because it
  // runs on Node's fetch. So "replay under a slow network" left every API call at
  // full speed, and the two assertions chaos is most useful against (the SLA and
  // the timeout) were exactly the two it could not exercise.
  //
  // Honest limit: this reproduces Slow-3G's LATENCY, not its bandwidth ceiling. A
  // 2s round-trip is what makes an SLA bite; throttling throughput on a Node fetch
  // would mean streaming the body by hand for very little extra signal.
  slowNetworkMs?: number
  // F24.3: the caller wants this response's cookies (to log the browser in).
  // fetch follows redirects TRANSPARENTLY and only hands back the final response
  // — but a form login very often answers `302 + Set-Cookie` and then redirects
  // to a landing page, so the session cookie lives on a hop we would never see.
  // With this on we walk the redirect chain ourselves and collect every Set-Cookie.
  collectCookies?: boolean
}

const MAX_REDIRECTS = 5

const setCookiesOf = (res: Response): string[] => {
  const h = res.headers as unknown as { getSetCookie?: () => string[] }
  if (typeof h.getSetCookie === 'function') return h.getSetCookie()
  const one = res.headers.get('set-cookie')
  return one ? [one] : []
}

const DEFAULT_TIMEOUT_MS = 30_000

// What actually went over the wire. For an API step this — not a screenshot of
// whatever page the browser happened to be showing — IS the evidence: it's what
// a dev needs to reproduce the call, and what the AI needs to judge the failure.
export interface ApiEvidence {
  method: string
  url: string
  status?: number // absent = the request never reached the server
  requestHeaders?: string // secrets masked
  requestBody?: string // secrets masked
  responseBody?: string // truncated, secrets masked
  durationMs?: number
  sizeBytes?: number // the FULL response size, even when the body is truncated
  responseHeaders?: string // secrets masked; shown in the response panel
  // The response's SHAPE (path → JSON type), inferred here from the RAW body.
  // "📐 Save this shape as the contract" used to re-parse `responseBody` in the
  // renderer — but that string is truncated at 2 KB, so any real payload failed to
  // parse and the user was told "this response isn't JSON", which was a lie.
  // The shape carries no values, so it leaks nothing.
  shape?: Contract
}

export interface ApiStepResult {
  ok: boolean
  status?: number
  error?: string // populated on failure — feeds the normal step-failure flow
  // The exchange — captured whether the step PASSED or FAILED. A green tick you
  // can't inspect is just "trust me": `body contains "id"` passes happily on
  // {"id": null, "status": "FAILED"}, and only the actual response reveals it.
  evidence?: ApiEvidence
  // The RAW response body — unmasked and untruncated, for {{saved:x}} extraction
  // only. Never displayed or written anywhere: `evidence.responseBody` is the
  // one that gets shown, and that one is masked.
  bodyText?: string
  // F24.3: the response's Set-Cookie headers, so an API login can hand its
  // session to the embedded browser (the UI test then starts logged IN).
  setCookies?: string[]
}

// A bug report gets pasted into Jira / GitHub / Slack, so anything that looks
// like a credential must never leave this process in the clear. Masking is by
// header NAME (Authorization, Cookie, X-API-Key…), so the header is still
// visible — you can see the token was SENT without seeing the token.
const SECRET_KEY = /^(authorization|cookie|set-cookie|proxy-authorization)$|(api[-_]?key|token|secret|password|passwd|auth)/i
const MASK = '••••••••'
const BODY_LIMIT = 2000

export function maskHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${SECRET_KEY.test(name) ? MASK : value}`)
    .join('\n')
}

// Same idea for a JSON body: blank the VALUE of any credential-ish key
// ({"password":"hunter2"} → {"password":"••••"}), leaving the shape readable.
//
// This runs on the RESPONSE too, not just the request. A login endpoint answers
// WITH a token ({"accessToken":"eyJ…"}) — and now that we show the response of a
// PASSING step, a green step would otherwise print a live credential straight
// into a report someone pastes in Slack.
export function maskBody(body?: string): string | undefined {
  if (!body) return undefined
  return body.replace(
    /("(?:[^"]*(?:password|passwd|token|secret|api[-_]?key|auth|credential|session)[^"]*)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    `$1"${MASK}"`
  )
}

// Keep a report readable (and a prompt affordable) — a 2 MB JSON dump helps no one.
function truncate(text: string): string {
  if (text.length <= BODY_LIMIT) return text
  return `${text.slice(0, BODY_LIMIT)}\n… (${text.length - BODY_LIMIT} more characters)`
}

// Mask FIRST, then truncate. The other order leaks: if the 2000-char cut lands in
// the middle of a secret's value, the closing quote is gone, maskBody's regex no
// longer matches the pair, and the partial credential is written to the report in
// the clear. Masking a whole body then cutting it can never do that.
function safeBody(text?: string): string | undefined {
  if (!text) return undefined
  return truncate(maskBody(text) ?? '')
}

// "Name: value" lines → a header map. Blank lines and lines without a colon are
// skipped (forgiving of a trailing newline or a stray comment). The first colon
// splits, so header values may themselves contain colons (e.g. a URL).
export function parseHeaders(text?: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!text) return out
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(':')
    if (idx <= 0) continue
    const name = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim()
    if (name) out[name] = value
  }
  return out
}

// Does the actual status satisfy the expectation?
//   blank            → any 2xx (the common "it worked" check)
//   "2xx" family     → 200–299 (also 4xx / 5xx)
//   exact number     → strict equality
//   "204,404" list   → ANY of them (comma-separated; families allowed too)
//
// The list form exists for idempotent teardown. A delete-check that only accepts
// 204 passes on the first run and fails forever after, because the record is
// already gone — so the test goes permanently red and looks like a product bug.
// "204,404" says what you actually mean: GONE IS GONE.
export function statusMatches(actual: number, expect?: string): boolean {
  const e = (expect ?? '').trim().toLowerCase()
  if (!e) return actual >= 200 && actual < 300
  const parts = e
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  // A field holding only separators (","  or " , ") used to leave an empty list,
  // and [].some() is false — so the step failed on EVERY status, with the baffling
  // message 'expected ,'. Treat "nothing was actually specified" as blank.
  if (!parts.length) return actual >= 200 && actual < 300
  return parts.some((part) => {
    const family = /^([1-5])xx$/.exec(part)
    if (family) {
      const hundreds = Number(family[1]) * 100
      return actual >= hundreds && actual < hundreds + 100
    }
    // Number() would happily accept "0x1F4", "2e2" and "200.0" as 200. A status is
    // three plain digits or it's a typo the user needs to hear about.
    if (!/^\d{3}$/.test(part)) return false
    return actual === Number(part)
  })
}

// A short, human description of the expectation, for error messages + labels.
export function expectStatusLabel(expect?: string): string {
  const e = (expect ?? '').trim()
  return e || '2xx'
}

// Fire the request and check the response. Never throws — resolves an
// ApiStepResult whose `error` (when set) is thrown by the caller so it flows
// into the normal failure path (screenshot/explain/report), same as any step.
export async function runApiStep(input: ApiStepInput): Promise<ApiStepResult> {
  const method = (input.method || 'GET').toUpperCase()
  const url = (input.url || '').trim()
  if (!url) {
    return { ok: false, error: 'API step has no URL — enter the endpoint to call.' }
  }
  const hasBody = method !== 'GET' && method !== 'DELETE' && !!(input.body && input.body.length)
  const headers = parseHeaders(input.headers)
  // If a body is sent with no explicit content type, default to JSON — the
  // overwhelmingly common case for a REST API and what the export assumes too.
  if (hasBody && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json'
  }

  // The request half of the evidence is known before we even send it, so a
  // request that never lands (DNS/offline/refused) still reports what we tried.
  const sent: ApiEvidence = {
    method,
    url,
    requestHeaders: Object.keys(headers).length ? maskHeaders(headers) : undefined,
    requestBody: hasBody ? maskBody(input.body) : undefined
  }

  const startedAt = Date.now()
  // F24.2: Node's fetch never times out on its own. A single unresponsive
  // endpoint would otherwise hang the step — and with it the whole suite —
  // forever, with no error and no way to tell what went wrong.
  const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_TIMEOUT_MS
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)

  let res: Response
  // Every Set-Cookie seen along the way — including the ones on redirect hops,
  // which the automatic follower would have swallowed.
  const chainCookies: string[] = []
  try {
    // F29: the chaos delay is INSIDE the try and honours the abort signal, so a
    // timeout shorter than the injected latency still fires (and reports as a
    // timeout). A plain sleep here would make the step un-cancellable — the very
    // thing the timeout exists to rule out.
    if (input.slowNetworkMs && input.slowNetworkMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, input.slowNetworkMs)
        abort.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t)
            reject(new Error('aborted'))
          },
          { once: true }
        )
      })
    }
    if (input.collectCookies) {
      // Walk the redirects by hand so no Set-Cookie is lost. This mirrors what
      // fetch does automatically (301/302/303 downgrade to GET and drop the body;
      // 307/308 preserve both), so the final response is the same one we'd have
      // got — we just also kept the cookies from each hop.
      let currentUrl = url
      let currentMethod = method
      let currentBody: string | undefined = hasBody ? input.body : undefined
      let currentHeaders = headers
      let hops = 0
      let tooManyHops = false
      for (;;) {
        res = await fetch(currentUrl, {
          method: currentMethod,
          headers: currentHeaders,
          body: currentBody,
          redirect: 'manual',
          signal: abort.signal
        })
        chainCookies.push(...setCookiesOf(res))
        const location = res.headers.get('location')
        if (res.status < 300 || res.status >= 400 || !location) break
        // Running out of hops is an ERROR, not a quiet stop. Breaking here left the
        // 3xx as "the response", and the step then failed with "returned 302,
        // expected 2xx" — which hides a redirect loop behind a status complaint.
        if (hops >= MAX_REDIRECTS) {
          tooManyHops = true
          break
        }
        const nextUrl = new URL(location, currentUrl)
        // Because we follow redirects by hand, we also have to do what the real
        // fetch does on a CROSS-ORIGIN hop: drop the auth headers. Forwarding
        // Authorization / Cookie to whatever host a Location points at would hand
        // this test's credentials to a third party.
        if (nextUrl.origin !== new URL(currentUrl).origin) {
          currentHeaders = Object.fromEntries(
            Object.entries(currentHeaders).filter(
              ([name]) => !/^(authorization|cookie|proxy-authorization)$/i.test(name)
            )
          )
        }
        currentUrl = nextUrl.toString()
        if (res.status === 301 || res.status === 302 || res.status === 303) {
          currentMethod = 'GET'
          currentBody = undefined
        }
        hops++
      }
      if (tooManyHops) {
        clearTimeout(timer)
        return {
          ok: false,
          error: `API request gave up after ${MAX_REDIRECTS} redirects — ${method} ${url} is still redirecting (a redirect loop, or a login that never lands).`,
          evidence: { ...sent, status: res.status, durationMs: Date.now() - startedAt }
        }
      }
    } else {
      res = await fetch(url, {
        method,
        headers,
        body: hasBody ? input.body : undefined,
        signal: abort.signal
      })
      chainCookies.push(...setCookiesOf(res))
    }
  } catch (err) {
    clearTimeout(timer)
    const timedOut = abort.signal.aborted
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: timedOut
        ? `API request timed out — ${method} ${url} did not respond within ${timeoutMs} ms.`
        : `API request failed — ${method} ${url} could not be reached (${message}).`,
      evidence: { ...sent, durationMs: Date.now() - startedAt }
    }
  }

  const status = res.status

  // The timer stays ARMED across the body read. A server can answer with headers
  // in 20 ms and then dribble (or never finish) the body — `res.text()` waits for
  // the last byte, so cancelling the timeout before this line reopened the exact
  // hang the timeout exists to prevent, just one step later.
  let bodyText: string
  try {
    bodyText = await res.text()
  } catch (err) {
    clearTimeout(timer)
    const timedOut = abort.signal.aborted
    return {
      ok: false,
      error: timedOut
        ? `API request timed out — ${method} ${url} sent its headers but did not finish sending its body within ${timeoutMs} ms.`
        : // Don't swallow this as an empty body: "the response isn't JSON" would
          // send you hunting the wrong problem entirely.
          `API response could not be read — ${method} ${url} answered ${status}, but its body failed to download (${err instanceof Error ? err.message : String(err)}).`,
      evidence: { ...sent, status, durationMs: Date.now() - startedAt }
    }
  }
  clearTimeout(timer)

  const durationMs = Date.now() - startedAt

  // Response headers, for header checks and for the panel. Lower-cased names, so
  // a check for "content-type" matches whatever casing the server chose.
  const resHeaders: Record<string, string> = {}
  res.headers.forEach((value, name) => {
    resHeaders[name.toLowerCase()] = value
  })
  // F24.3: every Set-Cookie from the whole chain (see collectCookies above).
  const setCookies: string[] = chainCookies

  // Inferred from the RAW body, so "save this shape as the contract" works on a
  // 2 MB payload as happily as on a 200-byte one. undefined when the body isn't
  // JSON — which is the honest answer, and the one the UI can act on.
  let shape: Contract | undefined
  try {
    const parsed: unknown = JSON.parse(bodyText)
    if (parsed && typeof parsed === 'object') shape = inferContract(parsed)
  } catch {
    shape = undefined
  }

  const evidence: ApiEvidence = {
    ...sent,
    status,
    responseBody: safeBody(bodyText),
    durationMs,
    // The real size on the wire, measured BEFORE truncation — otherwise a 2 MB
    // payload would report itself as 2 KB and hide exactly the thing worth seeing.
    sizeBytes: Buffer.byteLength(bodyText, 'utf8'),
    responseHeaders: maskHeaders(resHeaders) || undefined,
    shape
  }
  // bodyText rides along on FAILURE too. A failing step is very often one the server
  // already acted on — an SLA breach, a failed check and a contract violation are all
  // verdicts the CLIENT passes on a response the server has already committed to. The
  // record exists, and its id is in this body. Without it, the caller cannot capture
  // {{saved:…}}, and teardown then deletes nothing while reporting success.
  const fail = (error: string): ApiStepResult => ({ ok: false, status, error, evidence, bodyText })

  if (!statusMatches(status, input.expectStatus)) {
    return fail(
      `API check failed — ${method} ${url} returned ${status}, expected ${expectStatusLabel(input.expectStatus)}.`
    )
  }

  const needle = (input.expectBody ?? '').trim()
  if (needle && !bodyText.includes(needle)) {
    const preview = bodyText.replace(/\s+/g, ' ').trim().slice(0, 120)
    return fail(
      `API check failed — ${method} ${url} responded ${status}, but the body did not contain "${needle}". Body starts: "${preview}".`
    )
  }

  // F24.2: the real assertions — field-level, header, count, type.
  const failures: CheckFailure[] = runChecks(input.checks, bodyText, resHeaders)

  // F24.2: the contract — did the SHAPE change? (a renamed/dropped field)
  if (input.contract && Object.keys(input.contract).length) {
    try {
      failures.push(...checkContract(JSON.parse(bodyText), input.contract))
    } catch {
      failures.push({
        line: 'contract',
        reason: "the response isn't JSON, so its shape can't be checked against the contract"
      })
    }
  }

  if (failures.length) {
    const detail = failures.map((f) => `  • ${f.line} — ${f.reason}`).join('\n')
    return fail(
      `API check failed — ${method} ${url} responded ${status}, but ${failures.length} check${
        failures.length === 1 ? '' : 's'
      } did not hold:\n${detail}`
    )
  }

  // F24.2: SLA. Measured on every call already; asserting on it is the point.
  if (input.maxMs && input.maxMs > 0 && durationMs > input.maxMs) {
    return fail(
      `API check failed — ${method} ${url} responded ${status} but took ${durationMs} ms, over the ${input.maxMs} ms budget.`
    )
  }

  // PASSED — and the evidence still comes back, so the tester can see WHAT passed.
  // bodyText is the raw body, for {{saved:…}} extraction by the caller.
  return { ok: true, status, evidence, bodyText, setCookies }
}
