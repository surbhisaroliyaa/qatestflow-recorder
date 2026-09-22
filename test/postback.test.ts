import { describe, it, expect } from 'vitest'
import {
  DEFAULT_POSTBACK,
  buildRunPayload,
  redactRunSummary,
  gitlabConfigError,
  gitlabIssuesUrl,
  isRetryable,
  parseHeaders,
  postbackUrlError,
  shouldPost,
  type RunSummary
} from '../src/shared/postback'

// =====================================================================
// Postback — telling something else that a run finished.
//
// The thing under test here is a CONTRACT. Whatever receives this payload is
// code somebody else wrote, and it breaks silently when a field moves. So the
// first section asserts the literal shape rather than "it has the right sort
// of data": a field renamed without thinking should fail here, not in their
// dashboard a week later.
// =====================================================================

const RUN: RunSummary = {
  testName: 'SauceDemo login',
  ok: true,
  total: 12,
  failed: 0,
  durationMs: 4310,
  suite: 'E2E',
  project: 'Checkout',
  tags: ['@smoke']
}

const AT = new Date('2026-09-21T10:30:00.000Z')

describe('§ the payload is a contract', () => {
  it('a passing run has exactly this shape', () => {
    expect(buildRunPayload(RUN, AT)).toEqual({
      schema: 'qatestflow.run/1',
      sentAt: '2026-09-21T10:30:00.000Z',
      test: 'SauceDemo login',
      suite: 'E2E',
      project: 'Checkout',
      tags: ['@smoke'],
      status: 'passed',
      steps: { total: 12, failed: 0 },
      durationMs: 4310
    })
  })

  it('a failing run adds the failure, and nothing else', () => {
    expect(
      buildRunPayload(
        {
          ...RUN,
          ok: false,
          failed: 1,
          failedAtStep: 7,
          error: 'Button not found',
          traceId: 'trace-9'
        },
        AT
      )
    ).toEqual({
      schema: 'qatestflow.run/1',
      sentAt: '2026-09-21T10:30:00.000Z',
      test: 'SauceDemo login',
      suite: 'E2E',
      project: 'Checkout',
      tags: ['@smoke'],
      status: 'failed',
      steps: { total: 12, failed: 1 },
      durationMs: 4310,
      failure: { step: 7, message: 'Button not found' },
      traceId: 'trace-9'
    })
  })

  it('leaves out what it does not have, rather than sending empties', () => {
    // A receiver checking `if (payload.suite)` should not be handed "".
    const bare = buildRunPayload(
      { testName: 'T', ok: true, total: 1, failed: 0, durationMs: 5 },
      AT
    )
    expect('suite' in bare).toBe(false)
    expect('project' in bare).toBe(false)
    expect('tags' in bare).toBe(false)
    expect('failure' in bare).toBe(false)
  })

  it('carries a status a machine can branch on, not prose', () => {
    // The whole reason this exists alongside the chat webhook: a dashboard
    // cannot read "3 of 12 failed".
    expect(buildRunPayload(RUN, AT).status).toBe('passed')
    expect(buildRunPayload({ ...RUN, ok: false }, AT).status).toBe('failed')
  })
})

describe('§ when to send', () => {
  it('off sends nothing', () => {
    expect(shouldPost('off', true)).toBe(false)
    expect(shouldPost('off', false)).toBe(false)
  })

  it('always sends both', () => {
    expect(shouldPost('always', true)).toBe(true)
    expect(shouldPost('always', false)).toBe(true)
  })

  it('on-failure sends only the failure', () => {
    expect(shouldPost('failure', false)).toBe(true)
    expect(shouldPost('failure', true)).toBe(false)
  })

  it('is off by default', () => {
    expect(DEFAULT_POSTBACK.when).toBe('off')
  })
})

describe('§ headers', () => {
  it('reads one Name: value per line', () => {
    expect(parseHeaders('Authorization: Bearer abc\nX-Env: staging')).toEqual({
      Authorization: 'Bearer abc',
      'X-Env': 'staging'
    })
  })

  it('keeps colons inside the value', () => {
    expect(parseHeaders('X-Url: https://x.test/a')).toEqual({ 'X-Url': 'https://x.test/a' })
  })

  it('refuses a header that would break the body', () => {
    // This endpoint sends JSON. A setting claiming otherwise produces a body
    // the receiver cannot parse, while the app reports a successful send.
    expect(parseHeaders('Content-Type: text/plain')).toEqual({})
  })

  it('refuses Host, which reroutes the request', () => {
    expect(parseHeaders('Host: evil.test')).toEqual({})
  })

  it('refuses a name that is not a token', () => {
    // A space in a header name is either a typo or an attempt to smuggle a
    // second header into the first one's name.
    expect(parseHeaders('Bad Name: x')).toEqual({})
    expect(parseHeaders('X-Quote": x')).toEqual({})
    // A line with no colon at all names nothing, so there is no header in it.
    expect(parseHeaders('just-some-text')).toEqual({})
  })

  it('handles CRLF line endings without leaving a stray carriage return', () => {
    // A settings box on Windows produces \r\n. Those are two headers the user
    // typed, not an injection — but the \r must not survive into the VALUE,
    // where it would be a stray control character on the wire.
    expect(parseHeaders('X-A: one\r\nX-B: two')).toEqual({ 'X-A': 'one', 'X-B': 'two' })
  })

  it('ignores blank and malformed lines without throwing', () => {
    expect(parseHeaders('\n\nnot-a-header\n  \nX-Ok: 1')).toEqual({ 'X-Ok': '1' })
  })
})

describe('§ where it will send', () => {
  it('requires https', () => {
    expect(postbackUrlError('https://hooks.test/run')).toBe(null)
    expect(postbackUrlError('ftp://x.test')).toMatch(/must start with https/)
    expect(postbackUrlError('')).toMatch(/Enter the URL/)
  })

  it('refuses plain http to a remote host, because headers carry tokens', () => {
    expect(postbackUrlError('http://example.com/hook')).toMatch(/readable form/)
  })

  it('allows http to localhost, which never reaches a network', () => {
    // Also how this is tested against a local receiver without a real service.
    expect(postbackUrlError('http://localhost:3000/hook')).toBe(null)
    expect(postbackUrlError('http://127.0.0.1:8080/x')).toBe(null)
  })
})

describe('§ what is worth retrying', () => {
  it('retries a network error and a server error', () => {
    expect(isRetryable(null)).toBe(true)
    expect(isRetryable(500)).toBe(true)
    expect(isRetryable(503)).toBe(true)
  })

  it('does NOT retry a bad request — it will be bad next time too', () => {
    // Retrying a 401 just delays telling the user their token is wrong.
    expect(isRetryable(400)).toBe(false)
    expect(isRetryable(401)).toBe(false)
    expect(isRetryable(404)).toBe(false)
  })

  it('retries the two 4xx codes that mean "later"', () => {
    expect(isRetryable(408)).toBe(true)
    expect(isRetryable(429)).toBe(true)
  })

  it('does not retry a success', () => {
    expect(isRetryable(200)).toBe(false)
  })
})

describe('§ GitLab', () => {
  const cfg = { baseUrl: 'https://gitlab.com', token: 'glpat-x', projectId: 'my-group/my-app' }

  it('URL-encodes the project path WHOLE, slashes included', () => {
    // The single most common way to get this API wrong, and it fails as a
    // confusing 404 rather than as anything that names the cause.
    expect(gitlabIssuesUrl(cfg)).toBe('https://gitlab.com/api/v4/projects/my-group%2Fmy-app/issues')
  })

  it('takes a numeric project id too', () => {
    expect(gitlabIssuesUrl({ ...cfg, projectId: '4711' })).toBe(
      'https://gitlab.com/api/v4/projects/4711/issues'
    )
  })

  it('tolerates a trailing slash on the host', () => {
    expect(gitlabIssuesUrl({ ...cfg, baseUrl: 'https://gitlab.example.com/' })).toBe(
      'https://gitlab.example.com/api/v4/projects/my-group%2Fmy-app/issues'
    )
  })

  it('accepts a complete config', () => {
    expect(gitlabConfigError(cfg)).toBe(null)
  })

  it('names what is missing, one thing at a time', () => {
    expect(gitlabConfigError({ ...cfg, token: '' })).toMatch(/access token/)
    expect(gitlabConfigError({ ...cfg, projectId: '' })).toMatch(/project id or path/)
    expect(gitlabConfigError({ ...cfg, baseUrl: 'gitlab.com' })).toMatch(/must start with https/)
  })

  it('refuses to send an access token over plain http', () => {
    // The same rule the Jira integration applies, for the same reason.
    expect(gitlabConfigError({ ...cfg, baseUrl: 'http://gitlab.example.com' })).toMatch(
      /readable form/
    )
    expect(gitlabConfigError({ ...cfg, baseUrl: 'http://localhost:8929' })).toBe(null)
  })
})

// =====================================================================
// § the policy reaches the payload
//
// The postback is the one thing here that LEAVES the machine. The page HTML,
// console and network that evidence-privacy already scrubs sit in a local
// folder; this goes to a chat webhook, a CI server, or — in the test plan's own
// instructions — a public inbox. And `error` is a Playwright assertion message,
// which quotes the page: the text an element actually had, the URL reached.
//
// So it was the least protected field in the app and the most exposed.
// =====================================================================
describe('the evidence-privacy policy over a run summary', () => {
  const run = {
    testName: 'SauceDemo Positive Login',
    ok: false,
    total: 6,
    failed: 1,
    durationMs: 4310,
    failedAtStep: 3,
    error: 'Expected "Products" — actual: "standard_user is locked out"'
  }
  const scrub = (t: string): string => t.split('standard_user').join('[redacted]')

  it('redacts the failure message', () => {
    const out = redactRunSummary(run, scrub)
    expect(out.error).toBe('Expected "Products" — actual: "[redacted] is locked out"')
  })

  it('reaches the payload the receiver actually gets', () => {
    // Redacting the summary but building the payload from the raw run would
    // look right in a unit test and leak in production.
    const payload = buildRunPayload(redactRunSummary(run, scrub))
    expect(payload.failure?.message).not.toContain('standard_user')
    expect(JSON.stringify(payload)).not.toContain('standard_user')
  })

  it('leaves a run with no error alone, object identity and all', () => {
    const passing = { ...run, ok: true, error: undefined }
    expect(redactRunSummary(passing, scrub)).toBe(passing)
  })

  it('does not touch the fields the receiver identifies the run by', () => {
    // A blanked test name is a payload nobody can act on. This is a decision,
    // not an oversight — see the note on redactRunSummary.
    const out = redactRunSummary({ ...run, testName: 'standard_user login' }, scrub)
    expect(out.testName).toBe('standard_user login')
  })
})
