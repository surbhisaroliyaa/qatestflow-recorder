import { describe, it, expect } from 'vitest'
import {
  CliError,
  exitCodeFor,
  formatJunit,
  formatReport,
  parseArgs,
  selectTests,
  summarize,
  describeMissingEnv,
  missingEnvRefs,
  type CliOptions,
  type SelectableTest
} from '../src/main/cli'
import { generatePlaywrightTest } from '../src/renderer/src/playwrightExport'
import { dataColumns } from '../src/renderer/src/dataDriven'

// =====================================================================
// The command line.
//
// This is the same executable a person double-clicks, so argument parsing has
// a failure mode no ordinary CLI has: treat a normal launch as a command and
// the app never opens; miss a real command and a build agent silently opens a
// window and hangs until the job times out. § not a command is about that.
//
// The other theme is that "green" has to mean something. A typo'd filter that
// matches nothing, exiting 0, is how a pipeline ends up permanently green
// while testing nothing — the exact failure this whole app exists to prevent.
// =====================================================================

const opts = (over: Partial<CliOptions> = {}): CliOptions => ({
  command: 'run',
  tags: [],
  reporter: 'text',
  workers: 4,
  allowFailures: false,
  ...over
})

describe('§ not a command', () => {
  it('a plain launch is not a command', () => {
    // The normal case: someone double-clicked the app.
    expect(parseArgs([])).toBe(null)
  })

  it('Electron and Chromium switches are not commands', () => {
    // These arrive on their own, from the platform and from dev tooling. Any
    // of them treated as a command would mean the window never opens.
    for (const arg of [
      '--no-sandbox',
      '--inspect=5858',
      '--remote-debugging-port=9222',
      '--disable-gpu',
      '--allow-file-access-from-files'
    ]) {
      expect(parseArgs([arg]), arg).toBe(null)
    }
  })

  it('a file path passed by the OS is not a command', () => {
    expect(parseArgs(['C:\\Users\\qa\\some-file.json'])).toBe(null)
  })

  it('a command must be FIRST, not buried in the arguments', () => {
    expect(parseArgs(['--no-sandbox', 'run'])).toBe(null)
  })

  it('recognises the real commands', () => {
    expect(parseArgs(['run'])?.command).toBe('run')
    expect(parseArgs(['list'])?.command).toBe('list')
    expect(parseArgs(['help'])?.command).toBe('help')
    expect(parseArgs(['--help'])?.command).toBe('help')
    expect(parseArgs(['-h'])?.command).toBe('help')
  })
})

describe('§ options', () => {
  it('accepts both --flag value and --flag=value', () => {
    expect(parseArgs(['run', '--suite', 'E2E'])?.suite).toBe('E2E')
    expect(parseArgs(['run', '--suite=E2E'])?.suite).toBe('E2E')
  })

  it('collects repeated tags, and adds the @ if it was left off', () => {
    const o = parseArgs(['run', '--tag', '@smoke', '--tag', 'checkout'])!
    expect(o.tags).toEqual(['@smoke', '@checkout'])
  })

  it('REJECTS an unknown flag instead of ignoring it', () => {
    // The expensive one. `--suit E2E` ignored would run the entire library and
    // report success, and nobody would look again for months.
    expect(() => parseArgs(['run', '--suit', 'E2E'])).toThrow(CliError)
    expect(() => parseArgs(['run', '--suit', 'E2E'])).toThrow(/Unknown option/)
  })

  it('rejects a flag whose value is missing', () => {
    expect(() => parseArgs(['run', '--suite'])).toThrow(/needs a value/)
    // …including when the next token is obviously another flag rather than
    // this one's value.
    expect(() => parseArgs(['run', '--suite', '--reporter', 'json'])).toThrow(/needs a value/)
  })

  it('rejects an unknown reporter by name', () => {
    expect(() => parseArgs(['run', '--reporter', 'xml'])).toThrow(/Use text, json or junit/)
  })

  it('validates the worker count', () => {
    expect(parseArgs(['run', '--workers', '8'])?.workers).toBe(8)
    for (const bad of ['0', '-1', '99', 'lots', '2.5']) {
      expect(() => parseArgs(['run', '--workers', bad]), bad).toThrow(/whole number/)
    }
  })

  it('defaults to a text report and four workers', () => {
    const o = parseArgs(['run'])!
    expect(o.reporter).toBe('text')
    expect(o.workers).toBe(4)
    expect(o.allowFailures).toBe(false)
  })
})

describe('§ selecting tests', () => {
  const tests: SelectableTest[] = [
    { fileName: 'E2E/login.json', name: 'Login', suite: 'E2E', project: '', tags: ['@smoke'] },
    {
      fileName: 'Checkout/E2E/pay.json',
      name: 'Pay',
      suite: 'E2E',
      project: 'Checkout',
      tags: ['@smoke', '@checkout']
    },
    { fileName: 'Daily/search.json', name: 'Search', suite: 'Daily', project: '', tags: [] }
  ]

  it('no filter selects everything', () => {
    expect(selectTests(tests, opts())).toHaveLength(3)
  })

  it('filters by suite, project and text', () => {
    expect(selectTests(tests, opts({ suite: 'Daily' })).map((t) => t.name)).toEqual(['Search'])
    expect(selectTests(tests, opts({ project: 'Checkout' })).map((t) => t.name)).toEqual(['Pay'])
    expect(selectTests(tests, opts({ grep: 'log' })).map((t) => t.name)).toEqual(['Login'])
  })

  it('ANDs the tags rather than ORing them', () => {
    // "run the smoke tests for checkout" is what --tag @smoke --tag @checkout
    // means. The union is almost never what anyone wants.
    expect(selectTests(tests, opts({ tags: ['@smoke'] })).map((t) => t.name)).toEqual([
      'Login',
      'Pay'
    ])
    expect(selectTests(tests, opts({ tags: ['@smoke', '@checkout'] })).map((t) => t.name)).toEqual([
      'Pay'
    ])
  })

  it('ANDs different filters too', () => {
    expect(selectTests(tests, opts({ suite: 'E2E', grep: 'pay' })).map((t) => t.name)).toEqual([
      'Pay'
    ])
  })

  it('an empty filter value means "not filtering", not "must be empty"', () => {
    // `--project=` is the only way to produce this, and it reads as "I didn't
    // give a project". Treating it as "only tests with no project" would make a
    // trailing `=` in a pipeline silently change which tests run.
    expect(selectTests(tests, opts({ project: '' }))).toHaveLength(3)
    expect(selectTests(tests, opts({ suite: '' }))).toHaveLength(3)
  })

  it('selects nothing when nothing matches, rather than falling back to all', () => {
    expect(selectTests(tests, opts({ suite: 'Nope' }))).toEqual([])
  })
})

describe('§ exit codes', () => {
  const report = (passed: number, failed: number): ReturnType<typeof summarize> =>
    summarize(
      [
        ...Array.from({ length: passed }, (_, i) => ({
          name: `p${i}`,
          fileName: 'f',
          ok: true,
          durationMs: 1
        })),
        ...Array.from({ length: failed }, (_, i) => ({
          name: `f${i}`,
          fileName: 'f',
          ok: false,
          durationMs: 1,
          error: 'boom'
        }))
      ],
      100
    )

  it('0 when everything passed', () => {
    expect(exitCodeFor(report(3, 0), opts())).toBe(0)
  })

  it('1 when something failed', () => {
    expect(exitCodeFor(report(2, 1), opts())).toBe(1)
  })

  it('2 when NOTHING MATCHED — not 0', () => {
    // A green pipeline that ran no tests is worse than a red one. This is the
    // single most important line in this file.
    expect(exitCodeFor(report(0, 0), opts())).toBe(2)
    expect(exitCodeFor(report(0, 0), opts({ allowFailures: true }))).toBe(2)
  })

  it('--allow-failures turns a failure into 0, but never an empty run', () => {
    expect(exitCodeFor(report(1, 1), opts({ allowFailures: true }))).toBe(0)
  })
})

describe('§ JUnit XML', () => {
  const r = summarize(
    [
      { name: 'Login', fileName: 'E2E/login.json', ok: true, durationMs: 1200 },
      {
        name: 'Pay',
        fileName: 'E2E/pay.json',
        ok: false,
        durationMs: 800,
        error: 'Button not found'
      }
    ],
    2000
  )

  it('counts tests and failures in the suite element', () => {
    const xml = formatJunit(r)
    expect(xml).toContain('tests="2"')
    expect(xml).toContain('failures="1"')
    expect(xml).toContain('time="2.000"')
  })

  it('writes a failure element only for the failure', () => {
    const xml = formatJunit(r)
    expect(xml).toContain('<failure message="Button not found">')
    expect(xml.match(/<failure/g) ?? []).toHaveLength(1)
  })

  it('escapes the five characters that break an XML parser', () => {
    const nasty = summarize(
      [
        {
          name: 'Tom & Jerry <b>',
          fileName: 'f',
          ok: false,
          durationMs: 1,
          error: `he said "hi" & <left> 'now'`
        }
      ],
      1
    )
    const xml = formatJunit(nasty)
    expect(xml).toContain('Tom &amp; Jerry &lt;b&gt;')
    expect(xml).toContain('&quot;hi&quot;')
    expect(xml).toContain('&apos;now&apos;')
    // Nothing raw survived that would end an attribute early.
    expect(xml).not.toMatch(/message="[^"]*"[^/>]*"/)
  })

  it('strips control characters, which are legal in JS and illegal in XML', () => {
    // One of these makes the ENTIRE file unparseable, so a single odd byte in
    // one failure message would take the whole report down — which reads to the
    // user as "the run produced nothing".
    const weird = summarize(
      [{ name: 'T', fileName: 'f', ok: false, durationMs: 1, error: 'bad\u0001byte\u0008here' }],
      1
    )
    const xml = formatJunit(weird)
    expect(xml).toContain('badbytehere')
    // Asserting the ABSENCE of control characters necessarily means naming them.
    // eslint-disable-next-line no-control-regex
    expect(xml).not.toMatch(/[\u0000-\u0008]/)
  })
})

describe('§ the other reporters', () => {
  const r = summarize(
    [
      { name: 'Login', fileName: 'a', ok: true, durationMs: 1000 },
      { name: 'Pay', fileName: 'b', ok: false, durationMs: 500, error: 'nope' }
    ],
    1500
  )

  it('json is parseable and carries the counts', () => {
    const parsed = JSON.parse(formatReport(r, 'json'))
    expect(parsed.total).toBe(2)
    expect(parsed.passed).toBe(1)
    expect(parsed.failed).toBe(1)
    expect(parsed.results[1].error).toBe('nope')
  })

  it('text names each test and ends with a summary line', () => {
    const text = formatReport(r, 'text')
    expect(text).toContain('PASS  Login')
    expect(text).toContain('FAIL  Pay')
    expect(text).toContain('1 passed, 1 failed, 2 total')
  })
})

// =====================================================================
// § data-driven tests through the CLI
//
// The CLI has no renderer, so it rebuilds the spec itself. It got this wrong:
// it handed the exporter `columns: []` while passing the rows correctly, and
// the exporter only treats `{{username}}` as a row reference when "username"
// is in `columns`. Every token therefore fell through to a literal, and the
// run typed the eleven characters `{{username}}` into the username box.
//
// What made it expensive to diagnose is that nothing failed at the typing. The
// field accepted the text, the click submitted, and the run died on the URL
// assertion several steps later — pointing at the assertion rather than at the
// step that actually went wrong.
//
// This guards the CONTRACT between the two functions, not the CLI's plumbing:
// the columns the app derives must be the ones the exporter needs.
// =====================================================================
describe('a data-driven test rebuilt the way the CLI rebuilds it', () => {
  const steps = [
    { type: 'navigate', value: 'https://www.saucedemo.com/' },
    { type: 'type', value: '{{username}}', selector: "getByTestId('username')" }
  ] as unknown as Parameters<typeof generatePlaywrightTest>[0]
  const rows = [{ username: 'standard_user', password: 'x' }]
  const fillLine = (code: string): string =>
    code.split('\n').find((l) => l.includes('.fill(')) ?? ''

  it('binds the token to the row instead of typing it literally', () => {
    const code = generatePlaywrightTest(steps, {
      name: 'T',
      data: { columns: dataColumns(steps), rows }
    })
    expect(fillLine(code)).toContain('.fill(data.username)')
    expect(fillLine(code)).not.toContain('{{username}}')
  })

  it('derives "username" as a column from the steps', () => {
    // Asserting the fixture's own premise first: if dataColumns ever stopped
    // finding this token, the test above would still pass for the wrong reason
    // only if the exporter changed too — but this makes the drift visible.
    expect(dataColumns(steps)).toEqual(['username'])
  })
})

// =====================================================================
// § environment variables a spec depends on
//
// A generated spec never carries a password: a secret step compiles to
// `process.env.PASSWORD ?? ''`. That is right, and it has a sharp edge — an
// unset variable does not fail, it fills the field with '' and the run dies
// several steps later on something unrelated. Sixteen of eighteen tests once
// failed this way, every one reported as a 30s timeout on an innocent step.
//
// So the CLI reads what the specs actually reference and refuses up front.
// =====================================================================
describe('environment variables the generated specs need', () => {
  const spec = (name: string, code: string): { name: string; code: string } => ({ name, code })
  const PW = `await page.locator('#password').fill(process.env.PASSWORD ?? '')`

  it('spots the variable a password step depends on', () => {
    const missing = missingEnvRefs([spec('Login', PW)], {})
    expect(missing).toEqual([{ name: 'PASSWORD', tests: ['Login'] }])
  })

  it('stays quiet once it is set', () => {
    expect(missingEnvRefs([spec('Login', PW)], { PASSWORD: 'secret_sauce' })).toEqual([])
  })

  it('counts an empty string as unset', () => {
    // '' is exactly what a missing password looks like by the time it reaches
    // the page, so treating it as "set" would defeat the whole check.
    expect(missingEnvRefs([spec('Login', PW)], { PASSWORD: '' })).toHaveLength(1)
  })

  it('ignores a reference that has a fallback', () => {
    // BASE_URL is emitted as `process.env.BASE_URL || "https://…"`. It cannot
    // silently empty anything, so warning about it would be noise — and noise
    // is how a real warning gets ignored.
    const code = `test.use({ baseURL: process.env.BASE_URL || "https://www.saucedemo.com" })`
    expect(missingEnvRefs([spec('Anything', code)], {})).toEqual([])
  })

  it('groups every test that needs the same variable', () => {
    const missing = missingEnvRefs([spec('Login', PW), spec('Checkout', PW)], {})
    expect(missing).toEqual([{ name: 'PASSWORD', tests: ['Login', 'Checkout'] }])
  })

  it('finds the reference in a later spec as well as the first', () => {
    // Every spec is scanned, not just the first. NOTE: this does NOT prove the
    // `ENV_REF.lastIndex = 0` line does anything — removing it keeps this test
    // green, because exec() zeroes lastIndex itself when it returns null and the
    // loop always drains to null. The reset stays as a guard against a future
    // early `break` inside the loop, but it is untested by design, not by
    // accident: a teeth check showed it, so it is said here rather than left
    // looking like coverage it does not have.
    const missing = missingEnvRefs([spec('A', PW), spec('B', PW), spec('C', PW)], {})
    expect(missing[0].tests).toEqual(['A', 'B', 'C'])
  })

  it('names the variable and an example test in the message', () => {
    const text = describeMissingEnv([{ name: 'PASSWORD', tests: ['Login', 'Checkout'] }])
    expect(text).toContain('PASSWORD')
    expect(text).toContain('needed by 2 tests')
    expect(text).toContain('"Login"')
    expect(text).toContain('Nothing was run.')
  })
})
