import { describe, it, expect } from 'vitest'
import { normalizeUrl, reachError } from '../src/main/urls'

// Both of these are things the USER sees: one silently rewrites the address
// they typed, the other is the entire error message when a site can't be
// reached. They lived in a 5,900-line file with no way to test them.

describe('what a typed address means', () => {
  it('adds https:// to a bare domain', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('  example.com  ')).toBe('https://example.com')
  })

  it('adds it to host:port too — a port is not a scheme', () => {
    // The giveaway is the missing `//`. Without this, localhost:5173 was read
    // as the scheme "localhost" and left alone, so the app never navigated.
    expect(normalizeUrl('localhost:5173')).toBe('https://localhost:5173')
  })

  it('leaves ANY explicit scheme alone', () => {
    for (const url of [
      'https://example.com',
      'http://example.com',
      'file:///C:/x.html',
      'chrome://version',
      'about:blank',
      'data:text/html,<p>hi</p>',
      'view-source:https://example.com'
    ]) {
      expect(normalizeUrl(url), url).toBe(url)
    }
  })

  it('does not re-mangle chrome:// — the bug the whitelist caused', () => {
    // An allow-list of known schemes turned `chrome://version` into
    // `https://chrome://version`, because chrome wasn't on the list. Matching
    // the SHAPE of a scheme rather than naming them is what fixed it.
    expect(normalizeUrl('chrome://version')).not.toContain('https://chrome')
  })
})

describe('what the user is told when a site cannot be reached', () => {
  it('translates Node error codes into a sentence naming the host', () => {
    for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET']) {
      const msg = reachError(new Error(`request failed: ${code}`), 'https://shop.test/cart')
      expect(msg, code).toContain('shop.test')
      expect(msg, code).toContain('check the URL and your connection')
      // The raw code is not the message — that's the whole point.
      expect(msg.startsWith('request failed'), code).toBe(false)
    }
  })

  it("surfaces Node's hidden `cause` code, where the real reason lives", () => {
    const e = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    expect(reachError(e, 'https://shop.test')).toContain('(ENOTFOUND)')
  })

  it('tells a certificate problem apart from an unreachable host', () => {
    // Different action for the tester: one means "fix the address", the other
    // means "this host is up but its HTTPS is not trusted".
    const msg = reachError(new Error('self signed certificate in chain'), 'https://staging.test')
    expect(msg).toContain('verify the HTTPS certificate')
    expect(msg).toContain('staging.test')
  })

  it('passes an unrecognised error through untouched rather than guessing', () => {
    expect(reachError(new Error('Navigation cancelled'), 'https://x.test')).toBe(
      'Navigation cancelled'
    )
  })

  it('falls back to the raw text when the url is not parseable', () => {
    expect(reachError(new Error('ENOTFOUND'), 'not a url')).toContain('not a url')
  })

  it('handles a thrown non-Error without crashing', () => {
    expect(reachError('plain string boom', 'https://x.test')).toBe('plain string boom')
  })
})
