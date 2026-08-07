import { describe, it, expect } from 'vitest'
import {
  buildEntry,
  entryBodyBase64,
  headersToArray,
  matchEntry,
  newHarLog,
  serveHeaders,
  shouldCaptureType,
  type HarEntry
} from '../src/main/har'

// =====================================================================
// F1 — DETERMINISTIC REPLAY FROM A CAPTURED ARCHIVE.
//
// Record the network once, then replay the test against the recording
// instead of the live site. The whole point is that a green run means the
// APP behaved, not that the backend happened to be up.
//
// Which makes the failure mode here uniquely nasty: if the archive serves
// the WRONG entry — or serves a body the browser then mis-decodes — the
// test still runs, still goes green or red, and is measuring something
// nobody asked for. There is no error to notice.
// =====================================================================

const entry = (method: string, url: string, extra: Partial<HarEntry> = {}): HarEntry =>
  buildEntry({
    method,
    url,
    status: 200,
    body: 'ok',
    base64: false,
    ...(extra as Record<string, never>)
  })

describe('what is worth capturing', () => {
  it('captures the document and data calls, not every image and font', () => {
    // An archive of every asset is enormous and mostly noise; the requests a
    // TEST depends on are the page itself and its data.
    for (const t of ['Document', 'XHR', 'Fetch']) expect(shouldCaptureType(t), t).toBe(true)
    for (const t of ['Image', 'Font', 'Stylesheet', 'Media', 'Script']) {
      expect(shouldCaptureType(t), t).toBe(false)
    }
  })

  it('does not capture a request whose type CDP never reported', () => {
    expect(shouldCaptureType(undefined)).toBe(false)
    expect(shouldCaptureType('')).toBe(false)
  })

  it('starts from an empty, valid HAR', () => {
    const log = newHarLog()
    expect(log.log.version).toBe('1.2')
    expect(log.log.entries).toEqual([])
  })
})

describe('choosing which recorded response to serve', () => {
  const entries = [
    entry('GET', 'https://shop.test/api/items?page=1'),
    entry('GET', 'https://shop.test/api/items?page=2'),
    entry('POST', 'https://shop.test/api/items'),
    entry('GET', 'https://shop.test/api/user')
  ]

  it('prefers an exact URL match', () => {
    const hit = matchEntry(entries, 'GET', 'https://shop.test/api/items?page=2')
    expect(hit?.request.url).toContain('page=2')
  })

  it('never crosses methods — a GET must not be answered with the POST', () => {
    // Serving the POST's response to a GET would make a read return whatever
    // the write replied, silently.
    expect(matchEntry(entries, 'GET', 'https://shop.test/api/nothing')).toBeNull()
    expect(matchEntry(entries, 'POST', 'https://shop.test/api/items')?.request.method).toBe('POST')
  })

  it('does not cross methods on the PATH FALLBACK either', () => {
    // The case the test above misses: with no exact match, the fallback
    // compares paths — and must still refuse a different method. Written after
    // mutation testing showed that dropping the method check from the fallback
    // broke nothing, because every earlier case was resolved by the exact match
    // before the fallback ever ran.
    const onlyPost = [entry('POST', 'https://shop.test/api/orders')]
    expect(matchEntry(onlyPost, 'GET', 'https://shop.test/api/orders?x=1')).toBeNull()
    expect(matchEntry(onlyPost, 'DELETE', 'https://shop.test/api/orders')).toBeNull()
    // …and the right method still resolves through the fallback.
    expect(matchEntry(onlyPost, 'POST', 'https://shop.test/api/orders?x=1')).toBeTruthy()
  })

  it('falls back to the path when the query differs', () => {
    // Query strings carry session ids and cache-busters that change every run,
    // so an exact-only match would miss nearly everything on the second run.
    const hit = matchEntry(entries, 'GET', 'https://shop.test/api/items?page=9&t=163')
    expect(hit?.request.url).toContain('/api/items')
  })

  it('ignores a trailing slash difference', () => {
    expect(matchEntry(entries, 'GET', 'https://shop.test/api/user/')).toBeTruthy()
  })

  it('is case-insensitive about the METHOD only', () => {
    expect(matchEntry(entries, 'get', 'https://shop.test/api/user')).toBeTruthy()
    // …but not about the path: /API/USER is a different resource.
    expect(matchEntry(entries, 'GET', 'https://shop.test/API/USER')).toBeNull()
  })

  it('does not match across origins', () => {
    // Same path on a different host is a different endpoint entirely.
    expect(matchEntry(entries, 'GET', 'https://evil.test/api/user')).toBeNull()
  })

  it('returns null rather than the first entry when nothing matches', () => {
    // Falling back to "something" would serve an unrelated response and the
    // test would pass or fail for a reason that never existed.
    expect(matchEntry(entries, 'GET', 'https://shop.test/api/orders')).toBeNull()
    expect(matchEntry([], 'GET', 'https://shop.test/api/user')).toBeNull()
  })

  it('survives an unparseable url instead of throwing', () => {
    expect(() => matchEntry(entries, 'GET', 'not a url')).not.toThrow()
  })
})

describe('serving the recorded response back', () => {
  it('strips the encoding headers that describe bytes we no longer have', () => {
    // CDP hands back the DECODED body while the saved headers still describe
    // the ENCODED bytes. Serve the two together and the browser mis-decodes:
    // the page renders as garbage, for a reason nothing reports.
    const e = entry('GET', 'https://shop.test/', {
      responseHeaders: {
        'content-type': 'text/html',
        'content-encoding': 'gzip',
        'content-length': '9999',
        'transfer-encoding': 'chunked',
        connection: 'keep-alive'
      }
    } as Partial<HarEntry>)
    const names = serveHeaders(e).map((h) => h.name.toLowerCase())
    expect(names).toContain('content-type')
    for (const gone of ['content-encoding', 'content-length', 'transfer-encoding', 'connection']) {
      expect(names, gone).not.toContain(gone)
    }
  })

  it('strips them whatever case the server used', () => {
    const e = entry('GET', 'https://shop.test/', {
      responseHeaders: { 'Content-Encoding': 'gzip', 'Content-Type': 'text/html' }
    } as Partial<HarEntry>)
    const names = serveHeaders(e).map((h) => h.name.toLowerCase())
    expect(names).not.toContain('content-encoding')
    expect(names).toContain('content-type')
  })

  it('hands back the body as base64, whichever way it was stored', () => {
    const text = buildEntry({
      method: 'GET',
      url: 'https://s.test/',
      status: 200,
      body: 'hello',
      base64: false
    })
    expect(Buffer.from(entryBodyBase64(text), 'base64').toString('utf8')).toBe('hello')

    const already = buildEntry({
      method: 'GET',
      url: 'https://s.test/',
      status: 200,
      body: Buffer.from('hello').toString('base64'),
      base64: true
    })
    expect(entryBodyBase64(already)).toBe(Buffer.from('hello').toString('base64'))
  })

  it('round-trips a body that is not plain ASCII', () => {
    const body = 'price: £9.99 — 日本語 🧪'
    const e = buildEntry({ method: 'GET', url: 'https://s.test/', status: 200, body, base64: false })
    expect(Buffer.from(entryBodyBase64(e), 'base64').toString('utf8')).toBe(body)
  })

  it('serves an empty string for a response with no body', () => {
    const e = buildEntry({ method: 'GET', url: 'https://s.test/', status: 204, body: '', base64: false })
    expect(entryBodyBase64(e)).toBe('')
  })
})

describe('the entry it writes', () => {
  it('records the request and response faithfully', () => {
    const e = buildEntry({
      method: 'POST',
      url: 'https://shop.test/api/orders?draft=1',
      requestHeaders: { 'content-type': 'application/json' },
      postData: '{"item":"backpack"}',
      status: 201,
      statusText: 'Created',
      mimeType: 'application/json',
      responseHeaders: { 'content-type': 'application/json' },
      body: '{"id":7}',
      base64: false
    })
    expect(e.request.method).toBe('POST')
    expect(e.request.postData?.text).toBe('{"item":"backpack"}')
    expect(e.response.status).toBe(201)
    expect(e.response.content.text).toBe('{"id":7}')
    expect(e.response.content.mimeType).toBe('application/json')
  })

  it('splits the query string out, as the HAR format expects', () => {
    const e = entry('GET', 'https://shop.test/api/items?page=2&sort=name')
    expect(e.request.queryString).toEqual([
      { name: 'page', value: '2' },
      { name: 'sort', value: 'name' }
    ])
  })

  it('reports size in BYTES, not characters', () => {
    // A multi-byte body reported by character count understates the size and
    // the browser can truncate what it reads.
    const e = buildEntry({ method: 'GET', url: 'https://s.test/', status: 200, body: '£££', base64: false })
    expect(e.response.content.size).toBe(6)
  })

  it('marks a base64 body so it is not re-encoded on the way out', () => {
    const e = buildEntry({ method: 'GET', url: 'https://s.test/', status: 200, body: 'AAAA', base64: true })
    expect(e.response.content.encoding).toBe('base64')
  })

  it('omits postData entirely for a request that had none', () => {
    expect(entry('GET', 'https://s.test/').request.postData).toBeUndefined()
  })

  it('does not throw on an unparseable url', () => {
    expect(() =>
      buildEntry({ method: 'GET', url: 'not a url', status: 200, body: '', base64: false })
    ).not.toThrow()
  })

  it('converts headers into the array form, stringifying values', () => {
    expect(headersToArray({ a: '1', b: 2 as unknown as string })).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' }
    ])
    expect(headersToArray(undefined)).toEqual([])
  })
})
