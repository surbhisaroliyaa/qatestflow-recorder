import { describe, it, expect } from 'vitest'
import {
  expectStatusLabel,
  maskBody,
  maskHeaders,
  parseHeaders,
  statusMatches
} from '../src/main/apiStep'
import { generatePlaywrightTest } from '../src/renderer/src/playwrightExport'

// =====================================================================
// F24 — the API step: the one thing in this app that sends real traffic
// to a real server, with real credentials.
//
// Two things here are worth more than the rest of the file combined:
//
//  1. MASKING. The request and response are kept as evidence and end up
//     in a trace, a bug report and a shareable HTML file. A missed mask
//     is a live credential pasted into Slack.
//  2. The status rule, which decides whether a step passed — and which is
//     written a SECOND time inside the exporter.
// =====================================================================

const s = (o: Record<string, unknown>): never => o as never

describe('credentials must not reach the evidence', () => {
  it('masks the obvious auth headers', () => {
    const out = maskHeaders({
      Authorization: 'Bearer eyJhbGciOi.SECRET.value',
      Cookie: 'session=abc123',
      'Content-Type': 'application/json'
    })
    expect(out).not.toContain('eyJhbGciOi')
    expect(out).not.toContain('abc123')
    // …while leaving the harmless ones readable, or the evidence is useless.
    expect(out).toContain('Content-Type: application/json')
  })

  it('masks anything NAMED like a credential, whatever the casing', () => {
    for (const name of [
      'X-Api-Key',
      'x_api_key',
      'apikey',
      'X-Auth-Token',
      'my-secret-header',
      'PASSWORD',
      'proxy-authorization',
      'set-cookie'
    ]) {
      expect(maskHeaders({ [name]: 'hunter2' }), name).not.toContain('hunter2')
    }
  })

  it('keeps the header NAME visible — you need to see what was sent', () => {
    expect(maskHeaders({ Authorization: 'Bearer x' })).toContain('Authorization:')
  })

  it('masks credential values in a JSON body, keeping the shape readable', () => {
    const out = maskBody('{"user":"qa","password":"hunter2","accessToken":"eyJ.abc"}')
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('eyJ.abc')
    expect(out).toContain('"user":"qa"')
    expect(out).toContain('"password"')
  })

  it('masks the RESPONSE too — a login answers WITH the token', () => {
    // Now that a PASSING step shows its response, this is the path that would
    // print a live credential into a report someone pastes in Slack.
    for (const key of ['accessToken', 'refresh_token', 'apiKey', 'sessionId', 'client_secret']) {
      const out = maskBody(`{"${key}":"LIVE-CREDENTIAL"}`)
      expect(out, key).not.toContain('LIVE-CREDENTIAL')
    }
  })

  it('does not mask a field that merely LOOKS related', () => {
    // Over-masking makes the evidence useless in its own way.
    const out = maskBody('{"username":"qa","tokenCount":4,"authorised":true}')
    expect(out).toContain('"username":"qa"')
  })

  it('handles an escaped quote inside the value', () => {
    const out = maskBody('{"password":"he said \\"hi\\"","user":"qa"}')
    expect(out).not.toContain('he said')
    expect(out).toContain('"user":"qa"')
  })

  it('leaves a non-JSON body alone rather than mangling it', () => {
    expect(maskBody('<html>502 Bad Gateway</html>')).toBe('<html>502 Bad Gateway</html>')
  })

  it('returns undefined for no body at all', () => {
    expect(maskBody(undefined)).toBeUndefined()
    expect(maskBody('')).toBeUndefined()
  })
})

describe('request headers', () => {
  it('splits on the FIRST colon, so a value may contain colons', () => {
    expect(parseHeaders('Referer: https://shop.test:8443/a')).toEqual({
      Referer: 'https://shop.test:8443/a'
    })
  })

  it('ignores blank lines and lines with no colon', () => {
    expect(parseHeaders('A: 1\n\nnot a header\nB: 2\n')).toEqual({ A: '1', B: '2' })
  })

  it('ignores a line that starts with a colon', () => {
    expect(parseHeaders(': value')).toEqual({})
  })

  it('trims around the name and the value', () => {
    expect(parseHeaders('  A  :   1  ')).toEqual({ A: '1' })
  })

  it('returns an empty map for nothing', () => {
    expect(parseHeaders(undefined)).toEqual({})
    expect(parseHeaders('   ')).toEqual({})
  })
})

describe('did the response status pass?', () => {
  it('blank means any 2xx — the common "it worked" check', () => {
    expect(statusMatches(200)).toBe(true)
    expect(statusMatches(204, '')).toBe(true)
    expect(statusMatches(301)).toBe(false)
    expect(statusMatches(404)).toBe(false)
  })

  it('a family matches its whole range', () => {
    expect(statusMatches(201, '2xx')).toBe(true)
    expect(statusMatches(299, '2xx')).toBe(true)
    expect(statusMatches(300, '2xx')).toBe(false)
    expect(statusMatches(404, '4xx')).toBe(true)
  })

  it('an exact code is strict', () => {
    expect(statusMatches(201, '201')).toBe(true)
    expect(statusMatches(200, '201')).toBe(false)
  })

  it('a list means ANY of them — the idempotent-teardown case', () => {
    // A delete-check that only accepts 204 passes on the first run and fails
    // forever after, because the record is already gone: the test goes
    // permanently red and looks like a product bug. "204,404" says GONE IS GONE.
    expect(statusMatches(204, '204,404')).toBe(true)
    expect(statusMatches(404, '204,404')).toBe(true)
    expect(statusMatches(500, '204,404')).toBe(false)
    expect(statusMatches(201, '2xx,404')).toBe(true)
  })

  it('a field holding only separators is treated as blank, not as "match nothing"', () => {
    // It used to leave an empty list, and [].some() is false — so the step
    // failed on EVERY status with the baffling message 'expected ,'.
    expect(statusMatches(200, ',')).toBe(true)
    expect(statusMatches(200, ' , ')).toBe(true)
  })

  it('refuses a code that is not three plain digits', () => {
    // Number() accepts "0x1F4", "2e2" and "200.0" as 200. A status is three
    // digits or it is a typo the user needs to hear about.
    for (const typo of ['0x1F4', '2e2', '200.0', '20', '2000', 'abc']) {
      expect(statusMatches(200, typo), typo).toBe(false)
    }
  })

  it('describes the expectation in the words the user wrote', () => {
    expect(expectStatusLabel('204,404')).toBe('204,404')
    expect(expectStatusLabel()).toBe('2xx')
    expect(expectStatusLabel('  ')).toBe('2xx')
  })
})

// =====================================================================
// § the mirror
// The status rule is written a SECOND time in the exporter, as the
// assertion pasted into the generated spec. If the two disagree, a step
// passes in the app and fails in CI — with no clue why.
// =====================================================================
describe('the exported assertion agrees with the in-app rule', () => {
  const specFor = (expectStatus?: string): string =>
    generatePlaywrightTest(
      [s({ type: 'api', apiMethod: 'GET', url: 'https://a.test/x', apiExpectStatus: expectStatus })],
      { name: 'T' }
    )

  it('blank exports as "any 2xx", matching statusMatches', () => {
    expect(statusMatches(204)).toBe(true)
    expect(specFor()).toContain('res.ok()')
  })

  it('an exact code exports as an equality check on that code', () => {
    expect(specFor('201')).toContain('toBe(201)')
  })

  it('a family exports as the same range the app applies', () => {
    const spec = specFor('2xx')
    expect(spec).toContain('toBeGreaterThanOrEqual(200)')
    expect(spec).toContain('toBeLessThan(300)')
    expect(statusMatches(299, '2xx')).toBe(true)
    expect(statusMatches(300, '2xx')).toBe(false)
  })

  it('a list exports as a membership check over the SAME codes', () => {
    // The teardown case. If the export dropped the 404 the app accepts, every
    // re-run of a delete step would go red in CI only.
    const spec = specFor('204,404')
    expect(spec).toContain('204')
    expect(spec).toContain('404')
    expect(statusMatches(404, '204,404')).toBe(true)
  })

  it('a family inside a list survives into the export', () => {
    const spec = specFor('2xx,404')
    expect(spec).toMatch(/2xx|200/)
    expect(spec).toContain('404')
    expect(statusMatches(201, '2xx,404')).toBe(true)
  })
})
