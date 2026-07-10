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

export interface ApiStepInput {
  method?: string // GET (default) | POST | PUT | PATCH | DELETE
  url?: string
  headers?: string // raw text, one "Name: value" per line
  body?: string // request body (POST/PUT/PATCH)
  expectStatus?: string // "200" | "2xx"/"4xx"/"5xx" family | blank = any 2xx
  expectBody?: string // substring the response body must contain; blank = skip
}

export interface ApiStepResult {
  ok: boolean
  status?: number
  error?: string // populated on failure — feeds the normal step-failure flow
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
//   blank         → any 2xx (the common "it worked" check)
//   "2xx" family  → 200–299 (also 4xx / 5xx)
//   exact number  → strict equality
export function statusMatches(actual: number, expect?: string): boolean {
  const e = (expect ?? '').trim().toLowerCase()
  if (!e) return actual >= 200 && actual < 300
  const family = /^([1-5])xx$/.exec(e)
  if (family) {
    const hundreds = Number(family[1]) * 100
    return actual >= hundreds && actual < hundreds + 100
  }
  const n = Number(e)
  return Number.isFinite(n) && actual === n
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

  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers,
      body: hasBody ? input.body : undefined
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `API request failed — ${method} ${url} could not be reached (${message}).` }
  }

  const status = res.status
  const bodyText = await res.text().catch(() => '')

  if (!statusMatches(status, input.expectStatus)) {
    return {
      ok: false,
      status,
      error: `API check failed — ${method} ${url} returned ${status}, expected ${expectStatusLabel(input.expectStatus)}.`
    }
  }

  const needle = (input.expectBody ?? '').trim()
  if (needle && !bodyText.includes(needle)) {
    const preview = bodyText.replace(/\s+/g, ' ').trim().slice(0, 120)
    return {
      ok: false,
      status,
      error: `API check failed — ${method} ${url} responded ${status}, but the body did not contain "${needle}". Body starts: "${preview}".`
    }
  }

  return { ok: true, status }
}
