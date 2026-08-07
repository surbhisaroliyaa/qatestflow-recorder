import { describe, it, expect, vi } from 'vitest'
import ts from 'typescript'

// xbrowser imports electron for app paths. None of the logic under test touches
// it, but the module-level import has to resolve.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/app',
    getPath: () => '/userData'
  }
}))

const { pointAtAbsolute, resultsFromReport, runConfig, specSlug } = await import(
  '../src/main/xbrowser'
)

// =====================================================================
// F17 / F39 — the paths NOBODY WATCHES.
//
// A cross-browser or parallel run shells out to real Playwright and comes
// back with a verdict nobody was sitting in front of. That makes a wrong
// verdict here far more dangerous than a wrong one in the app: there is
// no human noticing that the browser never actually opened.
//
// This file has already produced the worst possible version of that — it
// reported 12 tests FAILED when Playwright had run none of them.
// =====================================================================

describe('the config it writes for the run', () => {
  it('parses as TypeScript', () => {
    // A config that doesn't compile means Playwright loads nothing, which is
    // exactly the state that used to be reported as "every test failed".
    const code = runConfig(['chromium', 'firefox', 'webkit'], '/tmp/specs')
    const sf = ts.createSourceFile('c.ts', code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
    const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []
    expect(diags).toEqual([])
  })

  it('creates one project per requested engine, and no others', () => {
    const code = runConfig(['chromium', 'webkit'], '/tmp/specs')
    expect(code).toContain("{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }")
    expect(code).toContain("{ name: 'webkit', use: { ...devices['Desktop Safari'] } }")
    expect(code).not.toContain('firefox')
  })

  it('runs headless — there is no screen to draw on', () => {
    expect(runConfig(['chromium'], '/tmp/specs')).toContain('headless: true')
  })

  it('escapes a Windows spec directory instead of pasting it raw', () => {
    // 'C:\Users\…' inside a quoted literal reads \U as an escape. JSON.stringify
    // is what makes the path survive.
    const code = runConfig(['chromium'], 'C:\\Users\\samee\\.qa-run\\specs')
    expect(code).toContain('C:\\\\Users\\\\samee')
    expect(code).not.toMatch(/testDir: 'C:\\Users/)
  })

  it('points storageState at an absolute path when a session is attached', () => {
    const code = runConfig(['chromium'], '/tmp/specs', 'C:\\sessions\\auth.json')
    expect(code).toContain('storageState:')
    expect(code).toContain('C:\\\\sessions\\\\auth.json')
  })

  it('omits storageState entirely when there is no session', () => {
    expect(runConfig(['chromium'], '/tmp/specs')).not.toContain('storageState')
  })
})

describe('one spec file per test', () => {
  it('makes a filename-safe slug', () => {
    expect(specSlug('saucedemo login.json', 0)).toBe('0-saucedemo-login')
  })

  it('keeps two identically-named tests in different suites apart', () => {
    // Both suites can hold a "Login" test. Same slug means one spec file
    // overwrites the other, and one of the two silently never runs.
    expect(specSlug('login.json', 0)).not.toBe(specSlug('login.json', 1))
  })

  it('strips characters a filesystem would reject', () => {
    const slug = specSlug('a/b\\c:d*e?f"g<h>i|j.json', 3)
    expect(slug).not.toMatch(/[/\\:*?"<>|]/)
    expect(slug.startsWith('3-')).toBe(true)
  })

  it('never produces an empty name', () => {
    expect(specSlug('！！！.json', 0)).toBe('0-test')
    expect(specSlug('', 7)).toBe('7-test')
  })

  it('caps the length so the path cannot blow past the OS limit', () => {
    expect(specSlug(`${'x'.repeat(300)}.json`, 0).length).toBeLessThan(60)
  })
})

describe('pointing a spec at a copied asset', () => {
  // The spec lives in a temp dir but the run's cwd is elsewhere, so relative
  // references have to be rewritten to absolute ones.
  it('rewrites the quoted reference', () => {
    const code = `await page.setInputFiles('#f', 'fixtures/a.txt')`
    expect(pointAtAbsolute(code, 'fixtures/a.txt', '/tmp/run/fixtures/a.txt')).toContain(
      '"/tmp/run/fixtures/a.txt"'
    )
  })

  it('escapes a Windows path rather than breaking the literal', () => {
    // 'C:\Users\a.txt' pasted in reads \U as an escape and the spec stops
    // compiling — which the run then reports as a test failure.
    const out = pointAtAbsolute(
      `page.setInputFiles('#f', 'fixtures/a.txt')`,
      'fixtures/a.txt',
      'C:\\Users\\run\\a.txt'
    )
    expect(out).toContain('"C:\\\\Users\\\\run\\\\a.txt"')
  })

  it('handles every quote style the exporter can emit', () => {
    for (const q of ["'", '"', '`']) {
      const out = pointAtAbsolute(`f(${q}hars/x.har${q})`, 'hars/x.har', '/tmp/x.har')
      expect(out, q).toContain('"/tmp/x.har"')
    }
  })

  it('rewrites every occurrence, not just the first', () => {
    const code = `a('fixtures/a.txt'); b('fixtures/a.txt')`
    expect(pointAtAbsolute(code, 'fixtures/a.txt', '/tmp/a').match(/tmp\/a/g)).toHaveLength(2)
  })

  it('treats the reference as literal text, not a pattern', () => {
    // A filename with regex characters must not become a wildcard that rewrites
    // something else in the spec.
    const code = `f('fixtures/a.b(1).txt'); g('fixtures/axb(1)!txt')`
    const out = pointAtAbsolute(code, 'fixtures/a.b(1).txt', '/tmp/ok')
    expect(out).toContain('"/tmp/ok"')
    expect(out).toContain('fixtures/axb(1)!txt')
  })

  it('leaves the code alone when the reference is not there', () => {
    const code = `page.goto('/')`
    expect(pointAtAbsolute(code, 'fixtures/missing.txt', '/tmp/x')).toBe(code)
  })
})

// =====================================================================
// § reading the report
// The piece that has already fabricated results. Playwright reports a
// failure to LOAD (bad config, a spec that won't compile, "no tests
// found") under `errors`, not as test results — so parsing only `suites`
// returned an empty report, and every test in the batch was labelled
// "did not run", i.e. the app claimed 12 tests FAILED when zero had been
// attempted.
// =====================================================================
describe('mapping Playwright’s report back onto our tests', () => {
  const slugs = new Map([
    ['0-login', 'login.json'],
    ['1-checkout', 'checkout.json']
  ])
  const ids = ['login.json', 'checkout.json']

  const report = (o: Record<string, unknown>): string => JSON.stringify(o)
  const suite = (file: string, tests: { status: string; error?: string }[]): unknown => ({
    file,
    specs: [
      {
        title: 't',
        tests: tests.map((t) => ({
          results: [{ status: t.status, error: t.error ? { message: t.error } : undefined }]
        }))
      }
    ]
  })

  it('attributes each spec file to its test id', () => {
    const out = resultsFromReport(
      report({
        suites: [
          suite('0-login.spec.ts', [{ status: 'passed' }]),
          suite('1-checkout.spec.ts', [{ status: 'failed', error: 'boom' }])
        ]
      }),
      slugs,
      ids
    )
    expect(out.ran).toBe(true)
    expect(out.results.find((r) => r.id === 'login.json')?.ok).toBe(true)
    const failed = out.results.find((r) => r.id === 'checkout.json')
    expect(failed?.ok).toBe(false)
    expect(failed?.error).toContain('boom')
  })

  it('does NOT invent failures when nothing ran', () => {
    // The bug. A config that won't load produces errors and no suites; claiming
    // every test failed is a fabricated result, and worse than the real error.
    const out = resultsFromReport(
      report({ errors: [{ message: 'Cannot find module ./nope', location: { file: 'c.ts', line: 3 } }] }),
      slugs,
      ids
    )
    expect(out.ran).toBe(false)
    expect(out.results).toEqual([])
    expect(out.message).toContain('Cannot find module')
  })

  it('still says something useful when there are no errors and no suites either', () => {
    const out = resultsFromReport(report({}), slugs, ids)
    expect(out.ran).toBe(false)
    expect(out.message).toBeTruthy()
  })

  it('a data-driven file is green only if EVERY test in it passed', () => {
    // One file, several test() blocks — one row failing must fail the test.
    const out = resultsFromReport(
      report({
        suites: [suite('0-login.spec.ts', [{ status: 'passed' }, { status: 'failed', error: 'row 2' }])]
      }),
      slugs,
      ['login.json']
    )
    expect(out.results[0].ok).toBe(false)
  })

  it('marks a spec that produced no result, while others did, as a per-test problem', () => {
    const out = resultsFromReport(
      report({ suites: [suite('0-login.spec.ts', [{ status: 'passed' }])] }),
      slugs,
      ids
    )
    expect(out.ran).toBe(true)
    const missing = out.results.find((r) => r.id === 'checkout.json')
    expect(missing?.ok).toBe(false)
    expect(missing?.error).toBeTruthy()
  })

  it('uses Playwright’s own error for the file that failed to load', () => {
    const out = resultsFromReport(
      report({
        suites: [suite('0-login.spec.ts', [{ status: 'passed' }])],
        errors: [{ message: 'SyntaxError: bad', location: { file: '1-checkout.spec.ts' } }]
      }),
      slugs,
      ids
    )
    expect(out.results.find((r) => r.id === 'checkout.json')?.error).toContain('SyntaxError')
  })

  it('walks nested suites — Playwright groups by project', () => {
    const out = resultsFromReport(
      report({
        suites: [{ title: 'chromium', suites: [suite('0-login.spec.ts', [{ status: 'passed' }])] }]
      }),
      slugs,
      ['login.json']
    )
    expect(out.results[0].ok).toBe(true)
  })

  it('returns a result for every test asked about, in order', () => {
    const out = resultsFromReport(
      report({ suites: [suite('0-login.spec.ts', [{ status: 'passed' }])] }),
      slugs,
      ids
    )
    expect(out.results.map((r) => r.id)).toEqual(ids)
  })

  it('ignores a spec file it does not recognise', () => {
    const out = resultsFromReport(
      report({
        suites: [
          suite('0-login.spec.ts', [{ status: 'passed' }]),
          suite('99-stranger.spec.ts', [{ status: 'failed' }])
        ]
      }),
      slugs,
      ['login.json']
    )
    expect(out.results).toHaveLength(1)
    expect(out.results[0].ok).toBe(true)
  })

  it('handles Windows path separators in the report', () => {
    const out = resultsFromReport(
      report({ suites: [suite('C:\\tmp\\specs\\0-login.spec.ts', [{ status: 'passed' }])] }),
      slugs,
      ['login.json']
    )
    expect(out.results[0].ok).toBe(true)
  })
})
