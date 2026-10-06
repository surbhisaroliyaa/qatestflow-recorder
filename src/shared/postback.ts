// =====================================================================
// POSTBACK — telling something else that a run finished  (Phase 4)
// =====================================================================
// WHAT THE GAP WAS
//
// This app already had ONE outbound notification: F32b posts a monitor failure
// to a Slack/Discord/Teams incoming webhook, as chat text. That covers one
// event (a monitor failed) for one kind of receiver (a chat room).
//
// What the audit asked for is the general case: any run finishing, described
// in a way a MACHINE can act on. A chat message is prose — a dashboard, a
// release gate or a bot cannot read "3 of 12 failed" without parsing English.
// So a postback sends structured JSON, and the chat form stays what it is.
//
// == The shape is the contract ==
//
// Whatever receives this is code someone else wrote, and it breaks when fields
// move. So the payload is defined here, in one place, with a version on it, and
// the test below asserts its exact shape — not "it has the right sort of data"
// but the literal keys. A field renamed without thinking becomes a failing test
// rather than somebody's broken dashboard.
//
// == Why not just fire and forget ==
//
// A postback that silently doesn't arrive is worse than no postback: the whole
// point is that something downstream is waiting for it. So delivery reports its
// outcome, retries a failure that might be transient, and does NOT retry one
// that plainly won't fix itself (a 400 is the same 400 next time).
// =====================================================================

/** When to send. The same three words as the trace and video policies. */
export type PostbackWhen = 'always' | 'failure' | 'off'

export interface PostbackSettings {
  when: PostbackWhen
  url: string
  /** Extra headers, one `Name: value` per line — an auth token, usually. */
  headers: string
}

export const DEFAULT_POSTBACK: PostbackSettings = { when: 'off', url: '', headers: '' }

/** The run being reported. Deliberately the small set of facts every kind of
 *  run has, so a single test, a data-driven run and a whole suite all fit. */
export interface RunSummary {
  testName: string
  ok: boolean
  total: number
  failed: number
  durationMs: number
  /** The first failure's step number (1-based, as the editor numbers them) and
   *  message. The number can be missing on a failed run — see PostbackPayload —
   *  and the message then goes out on its own. */
  failedAtStep?: number
  error?: string
  suite?: string
  project?: string
  tags?: string[]
  /** Where the evidence for this run lives, when it was kept. A receiver can't
   *  fetch it — it's a local folder — but naming it is what lets a human find
   *  the run a dashboard is pointing at. */
  traceId?: string
  /** A data-driven run: how many rows ran and how many failed. The whole run
   *  is ONE postback — per-row postbacks gave a receiver N separate "runs" of
   *  the same test with no way to tell they belonged together. */
  rows?: { total: number; failed: number }
}

/** The wire format. Versioned because somebody else's code depends on it.
 *  `rows` was added later as an OPTIONAL field — a receiver written before it
 *  still reads every field it knew about, so the schema stays at /1.
 *
 *  `failure.step` is the 1-based step number as the editor shows it. It MAY BE
 *  ABSENT on a failed run: a command-line or scheduled run learns where it
 *  failed from Playwright's report, and when that cannot be traced back to a
 *  recorded step (a failure before the first step, or inside a helper) the
 *  number is left out rather than guessed. `failure.message` is always there
 *  on a failed run. Additive for the same reason as `rows` — a receiver that
 *  reads `failure.message` keeps working, one that reads `failure.step` has to
 *  allow for it being missing — so the schema stays at /1. */
export interface PostbackPayload {
  schema: 'qatestflow.run/1'
  sentAt: string
  test: string
  suite?: string
  project?: string
  tags?: string[]
  status: 'passed' | 'failed'
  steps: { total: number; failed: number }
  durationMs: number
  failure?: { step?: number; message: string }
  traceId?: string
  rows?: { total: number; failed: number }
}

export function shouldPost(when: PostbackWhen, ok: boolean): boolean {
  if (when === 'off') return false
  if (when === 'always') return true
  return !ok
}

/**
 * Build the payload.
 *
 * `now` is injected rather than read from the clock so the shape can be
 * asserted exactly in a test — a timestamp is the one field that would
 * otherwise make the output untestable.
 */
/**
 * Put the evidence-privacy policy over the one free-text field in the payload.
 *
 * `error` is a Playwright assertion message, and those QUOTE THE PAGE: the text
 * an element actually had, the URL actually reached. So a postback to a chat
 * webhook or a public inbox can carry real data out of a staging environment,
 * while the same patterns were busy scrubbing the page HTML, console, network
 * and step titles that never left the machine.
 *
 * Takes the redactor rather than importing it, so this file stays free of main's
 * settings loading and can be tested without one.
 *
 * NOT redacted: testName, suite, project and tags. Those are names the user
 * chose and the receiver identifies the run by; blanking them would leave a
 * payload nobody can act on. Said here so the gap is a decision, not a
 * discovery.
 */
export function redactRunSummary(run: RunSummary, redactFn: (text: string) => string): RunSummary {
  if (run.error === undefined) return run
  return { ...run, error: redactFn(run.error) }
}

export function buildRunPayload(run: RunSummary, now = new Date()): PostbackPayload {
  const payload: PostbackPayload = {
    schema: 'qatestflow.run/1',
    sentAt: now.toISOString(),
    test: run.testName,
    status: run.ok ? 'passed' : 'failed',
    steps: { total: run.total, failed: run.failed },
    durationMs: run.durationMs
  }
  if (run.suite) payload.suite = run.suite
  if (run.project) payload.project = run.project
  if (run.tags?.length) payload.tags = run.tags
  if (run.traceId) payload.traceId = run.traceId
  if (run.rows) payload.rows = { total: run.rows.total, failed: run.rows.failed }
  // A failed run always says WHY. It used to need a step number before it
  // would say anything, so a headless failure — which does not always know one
  // — reached the receiver as a bare `status: failed` with nothing to act on.
  if (!run.ok) {
    payload.failure =
      run.failedAtStep !== undefined
        ? { step: run.failedAtStep, message: run.error ?? 'Step failed' }
        : { message: run.error ?? 'Test failed' }
  }
  return payload
}

/**
 * Parse the extra-headers box.
 *
 * Two headers are refused outright rather than passed through:
 *   · Content-Type, because this endpoint sends JSON and letting a setting
 *     claim otherwise would produce a body the receiver can't parse while the
 *     app reports success;
 *   · Host, because overriding it is how a request gets routed somewhere other
 *     than the URL the user typed.
 */
const REFUSED_HEADERS = new Set(['content-type', 'host', 'content-length'])

export function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of (raw ?? '').split('\n')) {
    const text = line.trim()
    if (!text) continue
    const at = text.indexOf(':')
    if (at <= 0) continue
    const name = text.slice(0, at).trim()
    const value = text.slice(at + 1).trim()
    // A header name is a token: no spaces, no colons, no control characters.
    // Anything else is either a typo or an attempt to inject a second header.
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue
    if (REFUSED_HEADERS.has(name.toLowerCase())) continue
    if (/[\r\n]/.test(value)) continue
    out[name] = value
  }
  return out
}

/**
 * Is this a URL we're willing to send to?
 *
 * https only, with one exception for localhost — which is how this gets tested
 * against a local receiver, and never puts anything on a network. The headers
 * routinely carry a bearer token, and plain http would put it on the wire in
 * readable form; the Jira integration refuses for exactly the same reason.
 */
export function postbackUrlError(url: string): string | null {
  const u = (url ?? '').trim()
  if (!u) return 'Enter the URL to post run results to.'
  if (!/^https?:\/\//i.test(u)) return 'The URL must start with https://'
  if (
    /^http:\/\//i.test(u) &&
    !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(u)
  ) {
    return 'Refusing to send over plain http — your headers usually carry a token, and http would put it on the network in readable form. Use https://'
  }
  return null
}

/**
 * Is this failure worth trying again?
 *
 * A network error or a 5xx is the server having a moment. A 4xx is a statement
 * about the request, and it will be the same statement next time — retrying it
 * just delays telling the user their URL or token is wrong. 408 and 429 are the
 * two 4xx codes that explicitly mean "later", so they're the exceptions.
 */
export function isRetryable(status: number | null): boolean {
  if (status === null) return true // no response at all — network
  if (status === 408 || status === 429) return true
  return status >= 500
}

/** What happened to one postback. `skipped` = the policy said not to send;
 *  `unconfigured` = armed but no usable URL, so nothing was attempted. */
export interface PostbackOutcome {
  ok: boolean
  skipped?: boolean
  unconfigured?: boolean
  status?: number
  error?: string
}

/** The side effects delivery needs, handed in so the rules below can be tested
 *  without a network, a clock or main's settings files. */
export interface PostbackIo {
  fetch: (
    url: string,
    init: { method: 'POST'; headers: Record<string, string>; body: string }
  ) => Promise<{ ok: boolean; status: number; statusText: string }>
  wait: (ms: number) => Promise<void>
  /** The evidence-privacy policy, already loaded. */
  redact: (text: string) => string
  /** Turn a thrown network error into a sentence naming the host. */
  reachError: (e: unknown, url: string) => string
  now?: Date
}

/**
 * Send one run's postback: policy, URL check, redaction, then up to three
 * attempts.
 *
 * This is the ONLY implementation. It used to live inside the `postback:send`
 * IPC handler, which meant the command line — the path that runs with nobody
 * watching, where a machine-readable "it finished" matters most — could not
 * reach it and sent nothing. Copying it for the CLI would have been two sets of
 * retry and redaction rules to keep in step; the first time they drifted, a
 * nightly run would leak a page quote the in-app run had scrubbed.
 */
export async function deliverPostback(
  settings: PostbackSettings,
  run: RunSummary,
  io: PostbackIo
): Promise<PostbackOutcome> {
  if (!shouldPost(settings?.when ?? 'off', run.ok)) return { ok: true, skipped: true }
  const urlError = postbackUrlError(settings.url)
  // Flagged as UNCONFIGURED, not as a failed delivery. Nothing was sent, so
  // "didn't arrive" would be false — and with the postback armed but no URL
  // typed, every single run would say it. The Integrations panel already
  // shows this error beside the URL box, which is where it gets fixed; a
  // toast on every run would be noise in front of the one notice that has
  // to be believed, a receiver that really did not answer.
  if (urlError) return { ok: false, unconfigured: true, error: urlError }

  // The failure message quotes the page, so the evidence-privacy policy has
  // to reach it too — this payload LEAVES the machine, which the page HTML
  // and console it already scrubs never do.
  const body = JSON.stringify(buildRunPayload(redactRunSummary(run, io.redact), io.now))
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...parseHeaders(settings.headers ?? '')
  }
  // Three attempts with a widening gap. Enough to ride out a restart or a
  // rate limit; short enough that a finished run isn't held open for long.
  let lastError = ''
  let lastStatus: number | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await io.wait(attempt * 1000)
    try {
      const res = await io.fetch(settings.url.trim(), { method: 'POST', headers, body })
      lastStatus = res.status
      if (res.ok) return { ok: true, status: res.status }
      lastError = `The receiver returned ${res.status} ${res.statusText}`.trim()
      if (!isRetryable(res.status)) break
    } catch (e) {
      lastStatus = null
      lastError = io.reachError(e, settings.url)
    }
  }
  return { ok: false, status: lastStatus ?? undefined, error: lastError }
}

// ── GitLab ───────────────────────────────────────────────────────────
// The mirror of the existing Jira integration: file a failure as an issue, in
// the tracker the team actually uses. Nothing here is GitLab-specific beyond
// the URL shape and the token header — it is deliberately the same idea.

export interface GitLabConfig {
  /** The GitLab host, e.g. https://gitlab.com or a self-hosted one. */
  baseUrl: string
  /** A personal or project access token with `api` scope. */
  token: string
  /** The project, either numeric id or "group/project" — GitLab accepts both,
   *  URL-encoded. Most people have the path, so both are supported. */
  projectId: string
}

/** The issues endpoint for a project. The project path has to be URL-encoded
 *  WHOLE, slashes included — that encoding is the single most common thing to
 *  get wrong against this API, and it fails as a confusing 404. */
export function gitlabIssuesUrl(cfg: GitLabConfig): string {
  const base = (cfg.baseUrl || '').trim().replace(/\/+$/, '')
  return `${base}/api/v4/projects/${encodeURIComponent((cfg.projectId || '').trim())}/issues`
}

export function gitlabConfigError(cfg: GitLabConfig): string | null {
  const base = (cfg.baseUrl || '').trim()
  if (!/^https?:\/\//i.test(base)) return 'GitLab URL must start with https://'
  if (
    /^http:\/\//i.test(base) &&
    !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(base)
  ) {
    return 'Refusing to send your access token over plain http — that would put it on the network in readable form. Use https://'
  }
  if (!cfg.token?.trim()) return 'A GitLab access token with `api` scope is required.'
  if (!cfg.projectId?.trim()) return 'A project id or path (e.g. my-group/my-app) is required.'
  return null
}
