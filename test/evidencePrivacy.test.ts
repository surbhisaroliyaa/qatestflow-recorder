import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PRIVACY,
  REDACTED,
  describePrivacy,
  isValidPattern,
  privacyActive,
  redact,
  redactAll,
  selectorList,
  userPatterns,
  type PrivacySettings
} from '../src/shared/evidencePrivacy'

// =====================================================================
// Evidence privacy.
//
// For a privacy feature, the two ways of being wrong are not symmetrical:
//
//   · redacting too much is annoying and VISIBLE — a tester sees
//     "[redacted]" where they wanted a value, and complains;
//   · redacting too little is silent — the data goes to disk, into a bug
//     report, into a commit, and nobody finds out until it matters.
//
// So most of this file is about the second: the cases where a plausible
// implementation quietly leaves data in. The /g-regex lastIndex case below is
// a real bug this module was written to avoid, and it is invisible from the
// outside — it only drops every OTHER match.
// =====================================================================

const on = (over: Partial<PrivacySettings> = {}): PrivacySettings => ({
  ...DEFAULT_PRIVACY,
  builtins: true,
  ...over
})

describe('the built-in patterns', () => {
  it('redacts an email', () => {
    expect(redact('Signed in as priya.sharma@example.com', on())).toBe(`Signed in as ${REDACTED}`)
  })

  it('redacts a plus-tagged and apostrophed address', () => {
    // Real addresses are not [a-z]+@[a-z]+. A pattern that only matches the
    // tidy form leaves the untidy ones on disk.
    expect(redact("o'brien+qa@example.co.uk", on())).toBe(REDACTED)
  })

  it('redacts a card number however it is grouped', () => {
    for (const card of ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111']) {
      expect(redact(`paid with ${card}`, on()), card).toBe(`paid with ${REDACTED}`)
    }
  })

  it('redacts a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'
    expect(redact(`Authorization failed for ${jwt}`, on())).toContain(REDACTED)
    expect(redact(`Authorization failed for ${jwt}`, on())).not.toContain('eyJhbGci')
  })

  it('redacts an api-key header, name and all', () => {
    expect(redact('x-api-key: sk_live_abc123', on())).toBe(REDACTED)
  })

  it('redacts EVERY occurrence, not every other one', () => {
    // The invisible bug this module exists to avoid. A /g RegExp carries
    // lastIndex between calls, so a shared instance skips alternate matches —
    // and nothing about the output announces that half the data is still there.
    const text = 'a@x.com b@x.com c@x.com d@x.com'
    expect(redact(text, on())).toBe(`${REDACTED} ${REDACTED} ${REDACTED} ${REDACTED}`)
  })

  it('redacts the same text identically every time it is called', () => {
    // The same bug seen from the other side: call it twice, get the same
    // answer. A stateful regex would not.
    const text = 'one@x.com and two@x.com'
    expect(redact(text, on())).toBe(redact(text, on()))
  })

  it('leaves ordinary failure text alone', () => {
    // The visible failure mode, which is still a failure mode: a test that
    // redacted everything would make every error message useless.
    const msg = 'Expected element to be visible — it is still hidden after 8000ms'
    expect(redact(msg, on())).toBe(msg)
  })

  it('does not eat a version number or a short id', () => {
    expect(redact('build 1.2.3 of order 4471', on())).toBe('build 1.2.3 of order 4471')
  })
})

describe('patterns of your own', () => {
  it('applies them', () => {
    const s = on({ builtins: false, patterns: 'ORD-\\d+' })
    expect(redact('see ORD-88231 for detail', s)).toBe(`see ${REDACTED} for detail`)
  })

  it('applies several, one per line', () => {
    const s = on({ builtins: false, patterns: 'ORD-\\d+\nCUST-\\w+' })
    expect(redact('ORD-1 CUST-ab', s)).toBe(`${REDACTED} ${REDACTED}`)
  })

  it('ignores a half-typed regex rather than breaking capture', () => {
    // A settings box spends most of its life containing a half-typed value.
    // Throwing here would abort the capture of a run that was otherwise fine.
    const s = on({ builtins: false, patterns: 'ORD-\\d+\n([unclosed' })
    expect(() => redact('ORD-7', s)).not.toThrow()
    expect(redact('ORD-7', s)).toBe(REDACTED)
    expect(userPatterns(s)).toHaveLength(1)
  })

  it('can tell the UI that a pattern is broken', () => {
    // Ignoring a bad pattern silently would leave the user believing they are
    // covered when they are not — the dangerous direction for this feature.
    expect(isValidPattern('ORD-\\d+')).toBe(true)
    expect(isValidPattern('([unclosed')).toBe(false)
  })

  it('combines with the built-ins rather than replacing them', () => {
    const s = on({ patterns: 'ORD-\\d+' })
    expect(redact('a@x.com ORD-5', s)).toBe(`${REDACTED} ${REDACTED}`)
  })
})

describe('doing nothing, by default', () => {
  it('is off out of the box', () => {
    // Deliberate: redaction that surprises you is worse than none, because a
    // tester who doesn't know it is on will chase a bug that isn't there.
    expect(privacyActive(DEFAULT_PRIVACY)).toBe(false)
    expect(redact('a@x.com', DEFAULT_PRIVACY)).toBe('a@x.com')
  })

  it('returns the input untouched when nothing is configured', () => {
    const text = 'x'.repeat(1000)
    expect(redact(text, DEFAULT_PRIVACY)).toBe(text)
  })

  it('counts turning OFF the DOM capture as an active policy', () => {
    // Not capturing the page HTML is the single biggest reduction available,
    // and the indicator has to show it or the user can't tell it is in effect.
    expect(privacyActive({ ...DEFAULT_PRIVACY, captureDom: false })).toBe(true)
  })
})

describe('screen regions', () => {
  it('accepts newline or comma separated selectors, like F15 does', () => {
    // The same vocabulary as the per-snapshot masks on purpose — one idea
    // should not have two syntaxes.
    expect(selectorList('.name\n[data-pii], #email')).toEqual(['.name', '[data-pii]', '#email'])
    expect(selectorList('')).toEqual([])
  })
})

describe('saying what it will do', () => {
  it('describes an empty policy honestly', () => {
    expect(describePrivacy(DEFAULT_PRIVACY)).toContain('captured in full')
  })

  it('names each part that is switched on', () => {
    const text = describePrivacy(
      on({ patterns: 'ORD-\\d+', maskSelectors: '.name', captureDom: false })
    )
    expect(text).toContain('emails, card numbers and tokens')
    expect(text).toContain('1 pattern of your own')
    expect(text).toContain('1 screen region')
    expect(text).toContain('no page HTML')
  })

  // The sentence used to end with a hardcoded "from screenshots, page HTML,
  // console and network" whatever was switched on. With only text patterns set
  // it claimed to redact SCREENSHOTS — which text cannot touch. Surbhi read
  // that, checked a screenshot, found her username and asked what the point of
  // the feature was. A privacy summary that overstates its reach is worse than
  // the gap it hides, because a claim you trust is a claim you stop checking.
  it('does not claim screenshots when nothing masks them', () => {
    const text = describePrivacy(on({ patterns: 'standard_user' }))
    expect(text).not.toContain('screenshot')
    expect(text).toContain('page HTML')
    expect(text).toContain('console')
    expect(text).toContain('network')
  })

  it('claims screenshots only once a mask selector exists', () => {
    const text = describePrivacy(on({ maskSelectors: '.inventory_item_name' }))
    expect(text).toContain('screenshots')
  })

  // Round 8. She put `standard_user` in the patterns box, ran, looked at the
  // run recording and saw `Type "standard_user" into Username` still sitting
  // there — so she reported the whole feature as doing nothing. It WAS working;
  // the page HTML on disk was clean. The step titles simply were not covered,
  // and they are the one surface she reads every time. Now they are, and the
  // summary says so.
  it('names the step titles as a surface text patterns reach', () => {
    const text = describePrivacy(on({ patterns: 'standard_user' }))
    expect(text).toContain('step titles')
  })

  it('does not name step titles when only a mask selector is set', () => {
    // A mask is painted on an image. It cannot touch a line of text, so a
    // policy with NO text patterns at all must not imply the titles changed.
    // builtins is switched off explicitly: on() turns it on, and with it on the
    // titles really are covered — an earlier version of this test asserted the
    // opposite and failed for the right reason.
    const text = describePrivacy(
      on({ builtins: false, patterns: '', maskSelectors: '.inventory_item_name' })
    )
    expect(text).toContain('screenshots')
    expect(text).not.toContain('step titles')
  })

  it('does not claim to redact page HTML that is never written', () => {
    // "Don't save the page's HTML" removes the file. Saying it is being
    // redacted FROM page HTML would describe scrubbing a file that does not
    // exist, and imply a protection doing no work.
    const text = describePrivacy(on({ captureDom: false }))
    expect(text).toContain('no page HTML saved at all')
    expect(text).not.toContain('from page HTML')
  })
})

describe('lists of evidence lines', () => {
  it('redacts each line and drops none', () => {
    // The COUNT of console errors is itself evidence — "twelve errors" means
    // something even when every one of them is redacted.
    const lines = ['a@x.com failed', 'plain error', 'b@x.com failed']
    const out = redactAll(lines, on())
    expect(out).toHaveLength(3)
    expect(out[1]).toBe('plain error')
    expect(out[0]).not.toContain('a@x.com')
  })

  it('handles an empty list', () => {
    expect(redactAll([], on())).toEqual([])
  })
})
