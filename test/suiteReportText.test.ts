import { describe, it, expect } from 'vitest'
import { generateSuiteReport } from '../src/renderer/src/suiteReportText'
import type { SuiteRunState } from '../src/renderer/src/suiteTypes'

// =====================================================================
// The suite report is the artefact that leaves the app: it gets pasted into a
// ticket, a PR or a chat, and read by someone who cannot hover a chip to find
// out what a category means. So what it OMITS matters as much as what it says.
//
// Round 13 found it omitting one thing: a data column with no row behind it.
// The {{env:…}} warning did not cover those, so "Label fallback check" — a test
// carrying {{username}}/{{password}} and no data at all — was reported as a URL
// assertion failure, which points at the page.
// =====================================================================
const suite = (over: Partial<SuiteRunState['results'][number]> = {}): SuiteRunState =>
  ({
    suite: 'E2E',
    results: [
      {
        fileName: 'E2E/label-fallback-check.json',
        name: 'Label fallback check',
        status: 'failed',
        error: 'Expected URL to contain "/inventory.html"',
        ...over
      }
    ]
  }) as unknown as SuiteRunState

describe('the suite report names data columns with no value', () => {
  it('warns, and says the failure may not be the page', () => {
    const text = generateSuiteReport(suite({ unresolvedData: ['username', 'password'] }))
    expect(text).toContain('⚠ Data columns with no value')
    expect(text).toContain('{{username}}')
    expect(text).toContain('{{password}}')
    expect(text).toContain('rather than the page being wrong')
  })

  it('names which tests are affected, not just the column', () => {
    // A suite can mix tests; "username is empty somewhere" is not actionable.
    const text = generateSuiteReport(suite({ unresolvedData: ['username'] }))
    expect(text).toContain('Label fallback check')
  })

  it('stays silent when every column has data', () => {
    // A warning that appears on healthy runs is one people learn to scroll past.
    expect(generateSuiteReport(suite())).not.toContain('Data columns with no value')
  })

  it('keeps the env warning separate from the data one', () => {
    // Different fixes: an env var is set outside the app, a data column is
    // filled in the test's own table. Merging them would send readers to the
    // wrong place.
    const text = generateSuiteReport(
      suite({ unresolvedEnv: ['SAUCE_PW'], unresolvedData: ['username'] })
    )
    expect(text).toContain('⚠ Environment variables with no value')
    expect(text).toContain('⚠ Data columns with no value')
  })
})
