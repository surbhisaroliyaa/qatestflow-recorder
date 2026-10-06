import { describe, it, expect } from 'vitest'
import {
  buildEntry,
  matchEntry,
  newHarLog,
  redactBodyText,
  redactHar,
  scrubSecretValues,
  MIN_SCRUB_LENGTH,
  type HarLog
} from '../src/main/har'
import {
  DEFAULT_PRIVACY,
  describePrivacy,
  type PrivacySettings
} from '../src/shared/evidencePrivacy'

// =====================================================================
// EVIDENCE PRIVACY FOR SAVED NETWORK CAPTURES.
//
// A HAR is the most complete copy of a run's data the app writes. The policy
// used to stop at the trace, so a tester who switched redaction on still saved
// the raw archive next to the test. These pin down what a redacted archive
// contains — and that it still REPLAYS, because a HAR is a replay input too.
// =====================================================================

const on = (patch: Partial<PrivacySettings> = {}): PrivacySettings => ({
  ...DEFAULT_PRIVACY,
  builtins: true,
  ...patch
})

function fixture(): HarLog {
  const log = newHarLog()
  log.log.entries.push(
    buildEntry({
      method: 'POST',
      url: 'https://shop.test/api/orders?email=jane%40example.com&page=2',
      requestHeaders: {
        Authorization: 'Bearer abc.def.ghi',
        Cookie: 'session-username=standard_user',
        'content-type': 'application/json',
        Accept: 'application/json'
      },
      postData: JSON.stringify({ email: 'jane@example.com', qty: 2 }),
      status: 200,
      mimeType: 'application/json',
      responseHeaders: { 'Set-Cookie': 'sid=s3cr3t; Path=/', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 7, owner: 'jane@example.com', card: 4111111111111111, qty: 2 }),
      base64: false,
      resourceType: 'Fetch'
    }),
    buildEntry({
      method: 'GET',
      url: 'https://shop.test/logo',
      status: 200,
      mimeType: 'image/png',
      body: 'iVBORw0KGgo=',
      base64: true,
      resourceType: 'Fetch'
    })
  )
  return log
}

describe('redactHar — what reaches the disk', () => {
  it('returns the capture untouched (same object) when no text redaction is on', () => {
    const log = fixture()
    expect(redactHar(log, DEFAULT_PRIVACY)).toBe(log)
    // Masks and "no page HTML" do nothing to a HAR, so they must not trigger it.
    expect(redactHar(log, { ...DEFAULT_PRIVACY, maskSelectors: '.x', captureDom: false })).toBe(log)
  })

  it('blanks credential headers by name and redacts everything with a matching shape', () => {
    const out = redactHar(fixture(), on())
    const e = out.log.entries[0]
    const req = Object.fromEntries(e.request.headers.map((h) => [h.name, h.value]))
    const res = Object.fromEntries(e.response.headers.map((h) => [h.name, h.value]))
    expect(req.Authorization).toBe('[redacted]')
    expect(req.Cookie).toBe('[redacted]')
    expect(res['Set-Cookie']).toBe('[redacted]')
    // Ordinary headers are left alone — replay's content type must survive.
    expect(req.Accept).toBe('application/json')
    expect(res['Content-Type']).toBe('application/json')
  })

  it('redacts the query (decoded AND in the URL) but keeps the path, the replay key', () => {
    const e = redactHar(fixture(), on()).log.entries[0]
    expect(e.request.queryString.find((q) => q.name === 'email')?.value).toBe('[redacted]')
    expect(e.request.queryString.find((q) => q.name === 'page')?.value).toBe('2')
    expect(e.request.url).not.toContain('jane')
    expect(e.request.url.startsWith('https://shop.test/api/orders?')).toBe(true)
  })

  it('redacts the encoded query inside a Referer / Location header too', () => {
    // Found driving the built app: the request URL was redacted, but the NEXT
    // request's Referer carried the same address — email still %40-encoded —
    // straight to disk. Browsers send Referer on nearly every request.
    const log = newHarLog()
    log.log.entries.push(
      buildEntry({
        method: 'GET',
        url: 'https://shop.test/next',
        requestHeaders: {
          Referer: 'https://shop.test/orders?contact=jane.doe%40example.com&page=2'
        },
        status: 302,
        mimeType: 'text/html',
        responseHeaders: { Location: 'https://shop.test/done?email=jane%40example.com' },
        body: '',
        base64: false,
        resourceType: 'Document'
      })
    )
    const out = redactHar(log, on())
    const text = JSON.stringify(out)
    expect(text).not.toMatch(/jane/i)
    const e = out.log.entries[0]
    const referer = e.request.headers.find((h) => h.name === 'Referer')?.value ?? ''
    expect(referer.startsWith('https://shop.test/orders?')).toBe(true)
    expect(referer).toContain('page=2') // the rest of the address survives
  })

  it('redacts post data and response bodies, keeping JSON valid', () => {
    const e = redactHar(fixture(), on()).log.entries[0]
    const post = JSON.parse(e.request.postData!.text)
    expect(post).toEqual({ email: '[redacted]', qty: 2 })
    const body = JSON.parse(e.response.content.text!)
    // A card number stored as a JSON NUMBER becomes a string, not broken JSON.
    expect(body).toEqual({ id: 7, owner: '[redacted]', card: '[redacted]', qty: 2 })
    expect(e.response.content.size).toBe(Buffer.byteLength(e.response.content.text!, 'utf8'))
    expect(e.response.bodySize).toBe(e.response.content.size)
  })

  it('leaves binary (base64) bodies alone', () => {
    const e = redactHar(fixture(), on()).log.entries[1]
    expect(e.response.content.text).toBe('iVBORw0KGgo=')
    expect(e.response.content.encoding).toBe('base64')
  })

  it('never mutates the live capture (replay and the Mock editor still read it)', () => {
    const log = fixture()
    const before = JSON.stringify(log)
    redactHar(log, on())
    expect(JSON.stringify(log)).toBe(before)
  })

  it('applies the user’s own patterns too, without the built-ins', () => {
    const e = redactHar(fixture(), { ...DEFAULT_PRIVACY, patterns: 'standard_user' }).log.entries[0]
    const cookie = e.request.headers.find((h) => h.name === 'Cookie')?.value
    // Not blanked by name (that is the built-ins' promise) — only the match.
    expect(cookie).toBe('session-username=[redacted]')
    expect(e.request.headers.find((h) => h.name === 'Authorization')?.value).toBe(
      'Bearer abc.def.ghi'
    )
  })

  it('a redacted archive still replays: the entry is found by its path', () => {
    const e = redactHar(fixture(), on()).log.entries
    const hit = matchEntry(
      e,
      'POST',
      'https://shop.test/api/orders?email=jane%40example.com&page=2'
    )
    expect(hit).not.toBeNull()
    expect(hit?.response.status).toBe(200)
  })
})

describe('redactBodyText', () => {
  it('decodes form posts so an encoded email is still found', () => {
    const out = redactBodyText(
      'user=jane%40example.com&n=1',
      'application/x-www-form-urlencoded',
      on()
    )
    expect(out).not.toContain('jane')
    expect(new URLSearchParams(out).get('n')).toBe('1')
  })

  it('returns an untouched body byte-for-byte', () => {
    const text = '{ "a": 1,\n  "b": "plain" }'
    expect(redactBodyText(text, 'application/json', on())).toBe(text)
  })

  it('redacts plain text (an HTML document) as text', () => {
    expect(redactBodyText('<p>jane@example.com</p>', 'text/html', on())).toBe('<p>[redacted]</p>')
  })
})

describe('the privacy summary names HAR only when it is covered', () => {
  it('lists saved network captures when text redaction is on', () => {
    expect(describePrivacy(on())).toContain('saved network captures (HAR)')
  })

  it('does not claim HAR for masks or "no page HTML" alone', () => {
    const text = describePrivacy({ ...DEFAULT_PRIVACY, maskSelectors: '.x', captureDom: false })
    expect(text).not.toContain('HAR')
  })
})

// =====================================================================
// THE TEST'S OWN SECRETS — blanked by value, policy on or off.
//
// A recorded login posts the password; no privacy pattern can recognise a
// password by its shape. Found by recording a real login (2026-10-06): the
// saved archive held `"p":"swordfish"` in the form body with redaction ON.
// =====================================================================

function loginCapture(): HarLog {
  const log = newHarLog()
  log.log.entries.push(
    buildEntry({
      method: 'POST',
      url: 'https://shop.test/api/login?next=%2Fhome&pw=sw%20ord%26fish',
      requestHeaders: { 'content-type': 'application/json', Referer: 'https://shop.test/' },
      postData: JSON.stringify({ u: 'jane', p: 'sw ord&fish', note: 'say "hi"' }),
      status: 200,
      mimeType: 'application/json',
      body: JSON.stringify({ ok: true, echo: 'sw ord&fish' }),
      base64: false,
      resourceType: 'Fetch'
    }),
    buildEntry({
      method: 'POST',
      url: 'https://shop.test/form',
      requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: 'user=jane&pass=sw+ord%26fish',
      status: 200,
      mimeType: 'text/html',
      body: '<p>ok</p>',
      base64: false,
      resourceType: 'Document'
    }),
    buildEntry({
      method: 'GET',
      url: 'https://shop.test/logo',
      status: 200,
      mimeType: 'image/png',
      body: 'c3cgb3JkJmZpc2g=',
      base64: true,
      resourceType: 'Fetch'
    })
  )
  return log
}

describe("scrubbing the test's own secrets out of a capture", () => {
  const SECRET = 'sw ord&fish'

  it('blanks the password wherever the page sent it, in every encoding', () => {
    const out = JSON.stringify(scrubSecretValues(loginCapture(), [SECRET]))
    expect(out).not.toContain(SECRET) // as typed (JSON body, response echo)
    expect(out).not.toContain('sw%20ord%26fish') // percent-encoded (URL)
    expect(out).not.toContain('sw+ord%26fish') // form-encoded (form post)
    expect(out).toContain('[redacted]')
  })

  it('leaves everything else in the entry alone', () => {
    const [login] = scrubSecretValues(loginCapture(), [SECRET]).log.entries
    expect(JSON.parse(login.request.postData!.text)).toEqual({
      u: 'jane',
      p: '[redacted]',
      note: 'say "hi"'
    })
    expect(login.request.url).toContain('next=%2Fhome')
    expect(login.request.url).toMatch(/^https:\/\/shop\.test\/api\/login\?/) // replay key kept
  })

  it('keeps size fields honest about the text they now hold', () => {
    const [login] = scrubSecretValues(loginCapture(), [SECRET]).log.entries
    expect(login.request.bodySize).toBe(Buffer.byteLength(login.request.postData!.text, 'utf8'))
    expect(login.response.content.size).toBe(
      Buffer.byteLength(login.response.content.text!, 'utf8')
    )
  })

  it('never touches a base64 body', () => {
    const logo = scrubSecretValues(loginCapture(), [SECRET]).log.entries[2]
    expect(logo.response.content.text).toBe('c3cgb3JkJmZpc2g=')
  })

  it('works with the privacy policy OFF — it is not a pattern, it is a known value', () => {
    const log = redactHar(loginCapture(), DEFAULT_PRIVACY)
    expect(JSON.stringify(scrubSecretValues(log, [SECRET]))).not.toContain(SECRET)
  })

  it('returns the same object when nothing matched, so the file is not rewritten', () => {
    const log = loginCapture()
    expect(scrubSecretValues(log, ['not-in-here'])).toBe(log)
    expect(scrubSecretValues(log, [])).toBe(log)
  })

  it('skips values too short to blank safely', () => {
    const log = loginCapture()
    expect(MIN_SCRUB_LENGTH).toBe(4)
    expect(scrubSecretValues(log, ['ok'])).toBe(log) // would wreck "ok" in every body
  })

  it('does not mutate the capture it was given (replay still reads it)', () => {
    const log = loginCapture()
    const before = JSON.stringify(log)
    scrubSecretValues(log, [SECRET])
    expect(JSON.stringify(log)).toBe(before)
  })
})
