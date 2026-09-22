import { describe, it, expect } from 'vitest'
import { makeInert } from '../src/shared/domSnapshot'

// The bug: a saved step-N.html kept SauceDemo's <script type="module">, and a
// <base href> pointing at the live site. Opening it fetched and ran the real
// React bundle, which mounted over #root and wiped the captured DOM — the
// snapshot opened blank while the evidence sat intact inside the file.
describe('makeInert', () => {
  it('stops a module script running', () => {
    const html = '<script type="module" crossorigin="" src="/assets/index-D3OxT1jE.js"></script>'
    const out = makeInert(html)
    // Our type must come FIRST: HTML ignores a duplicate attribute, so the
    // browser reads ours and never reaches type="module". If it were appended
    // instead, the original type would win and the script would still run.
    expect(out.indexOf('application/qaflow-inert')).toBeLessThan(out.indexOf('type="module"'))
    expect(out).toContain('<script type="application/qaflow-inert"')
  })

  it('neutralises inline scripts too, not just external ones', () => {
    // SauceDemo's saved page carries an inline SPA-redirect script that calls
    // history.replaceState — harmless on the live site, but a snapshot that
    // rewrites its own URL on open is not a snapshot.
    const out = makeInert('<script>window.history.replaceState(null, null, "/x")</script>')
    expect(out).toContain('type="application/qaflow-inert"')
  })

  it('keeps the script CONTENT — a neutralised tag is still evidence', () => {
    // Deleting scripts would quietly rewrite the record of the page. Which
    // bundle loaded, and what an inline tag contained, can be the thing you
    // are trying to prove.
    const out = makeInert('<script src="/assets/app.js"></script>')
    expect(out).toContain('/assets/app.js')
  })

  it('leaves stylesheets and content alone', () => {
    // The snapshot still has to LOOK like the page. Only code is neutralised.
    const html = '<link rel="stylesheet" href="/assets/index.css"><div id="root">[redacted]</div>'
    expect(makeInert(html)).toBe(html)
  })

  it('handles every case-variant of the tag', () => {
    // A real page is not guaranteed to be lowercase, and a SCRIPT that slipped
    // through because of its casing would run exactly like any other.
    for (const tag of ['<script', '<SCRIPT', '<ScRiPt']) {
      expect(makeInert(`${tag} src="/a.js"></script>`)).toContain('application/qaflow-inert')
    }
  })
})
