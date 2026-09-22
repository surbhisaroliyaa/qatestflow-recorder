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
  /** The first failure's step number (1-based) and message, when there is one. */
  failedAtStep?: number
  error?: string
  suite?: string
  project?: string
  tags?: string[]
  /** Where the evidence for this run lives, when it was kept. A receiver can't
   *  fetch it — it's a local folder — but naming it is what lets a human find
   *  the run a dashboard is pointing at. */
  traceId?: string
}

/** The wire format. Versioned because somebody else's code depends on it. */
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
  failure?: { step: number; message: string }
  traceId?: string
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
  if (!run.ok && run.failedAtStep !== undefined) {
    payload.failure = { step: run.failedAtStep, message: run.error ?? 'Step failed' }
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
