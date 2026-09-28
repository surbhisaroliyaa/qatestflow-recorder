import { describe, it, expect } from 'vitest'
import {
  downloadNameMatches,
  downloadNameRegexSource,
  loosenDownloadName,
  describeDownloadExpectation
} from '../src/shared/downloadName'

// Round 13, 2026-09-23. The real pair, from the real run:
const RECORDED = 'swag-labs-order-2026-09-23_08-46-16.pdf'
const REPLAYED = 'swag-labs-order-2026-09-23_08-46-52.pdf'

describe('downloadNameMatches', () => {
  // THE case. Same receipt, generated 36 seconds later. Before this, the step
  // could only ever pass on the run that recorded it.
  it('matches the same file downloaded at a different time', () => {
    expect(downloadNameMatches(RECORDED, REPLAYED)).toBe(true)
  })

  it('still matches an identical name', () => {
    expect(downloadNameMatches(RECORDED, RECORDED)).toBe(true)
  })

  // The other half: loosening the rule must not make it useless. If these ever
  // pass, the check has stopped being a check.
  it('rejects a different file', () => {
    expect(downloadNameMatches(RECORDED, 'invoice.pdf')).toBe(false)
    expect(downloadNameMatches(RECORDED, 'swag-labs-order-2026-09-23_08-46-16.csv')).toBe(false)
    expect(downloadNameMatches('report.pdf', 'report.csv')).toBe(false)
  })

  it('rejects a name that merely shares its numbers', () => {
    expect(downloadNameMatches(RECORDED, 'refund-2026-09-23_08-46-16.pdf')).toBe(false)
  })

  // The value is editable, and a tester who shortens it means "contains this".
  // That behaviour predates this fix and must survive it.
  it('keeps substring semantics for a hand-shortened expectation', () => {
    expect(downloadNameMatches('swag-labs-order', REPLAYED)).toBe(true)
    expect(downloadNameMatches('swag-labs-refund', REPLAYED)).toBe(false)
  })

  it('checks nothing when the expectation is empty', () => {
    expect(downloadNameMatches('', 'anything.pdf')).toBe(true)
    expect(downloadNameMatches('   ', 'anything.pdf')).toBe(true)
  })

  // Surbhi's option 2: opt back into the literal comparison when the digits
  // carry meaning. This is the case loose matching genuinely cannot judge.
  describe('exact mode', () => {
    it('distinguishes names that differ only in their digits', () => {
      expect(downloadNameMatches('statement-2024.pdf', 'statement-2025.pdf')).toBe(true) // loose
      expect(downloadNameMatches('statement-2024.pdf', 'statement-2025.pdf', true)).toBe(false)
    })

    it('rejects the timestamp case it is opted into', () => {
      expect(downloadNameMatches(RECORDED, REPLAYED, true)).toBe(false)
    })

    it('still passes on an identical name', () => {
      expect(downloadNameMatches(RECORDED, RECORDED, true)).toBe(true)
    })
  })
})

describe('loosenDownloadName', () => {
  it('collapses each run of digits to one marker', () => {
    expect(loosenDownloadName('a-1-22-333.pdf')).toBe('a-#-#-#.pdf')
  })

  it('leaves a name with no digits alone', () => {
    expect(loosenDownloadName('receipt.pdf')).toBe('receipt.pdf')
  })
})

describe('downloadNameRegexSource', () => {
  it('escapes the literal text and wildcards the digits', () => {
    expect(downloadNameRegexSource(RECORDED)).toBe(
      'swag-labs-order-\\d+-\\d+-\\d+_\\d+-\\d+-\\d+\\.pdf'
    )
  })

  // A spec that does not parse aborts the ENTIRE Playwright batch, not just its
  // own test — so the escaping is load-bearing well beyond this one assertion.
  it('escapes characters that would otherwise be regex syntax', () => {
    const src = downloadNameRegexSource('report (final) [v2].pdf')
    expect(src).toBe('report \\(final\\) \\[v\\d+\\]\\.pdf')
    expect(() => new RegExp(src)).not.toThrow()
  })

  // The generated regex must agree with the engine's own answer, or the app and
  // the exported spec are two different rules again — the exact disease this
  // module exists to cure.
  it('accepts and rejects exactly what the engine does', () => {
    const re = new RegExp(downloadNameRegexSource(RECORDED))
    expect(re.test(REPLAYED)).toBe(downloadNameMatches(RECORDED, REPLAYED))
    expect(re.test('invoice.pdf')).toBe(downloadNameMatches(RECORDED, 'invoice.pdf'))
    expect(re.test('refund-2026-09-23_08-46-16.pdf')).toBe(
      downloadNameMatches(RECORDED, 'refund-2026-09-23_08-46-16.pdf')
    )
  })
})

describe('describeDownloadExpectation', () => {
  // The old message named only the filename, which is what sent Surbhi hunting
  // for a difference between two names that differed by 36 seconds.
  it('says which part of the name was compared', () => {
    expect(describeDownloadExpectation(RECORDED)).toContain('numbers may differ')
    expect(describeDownloadExpectation(RECORDED, true)).toContain('exactly')
  })
})
