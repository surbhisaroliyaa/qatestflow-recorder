import { describe, it, expect } from 'vitest'
import {
  a11yImpactRank,
  assertNeedsValue,
  clip,
  formatBytes,
  isThirdPartyLine,
  primaryCandidate,
  siteFirstLines,
  stabilityClass
} from '../src/renderer/src/uiFormat'
import { ASSERT_KINDS, ASSERT_LABELS, CATEGORY_LABELS, CATEGORY_WHY } from '../src/renderer/src/uiLabels'

// These lived inside App.tsx, where nothing could reach them without launching
// Electron — so nothing ever did. Being testable is the point of moving them.

describe('clip', () => {
  it('leaves short text alone', () => {
    expect(clip('short', 300)).toBe('short')
  })

  it('breaks at a word boundary, not mid-word', () => {
    // A blunt slice() produced "…8 × loca", which reads as broken rather than
    // trimmed. Mirrors clip() in main/xbrowser.ts.
    const source = 'the quick brown fox jumps over the lazy dog'
    const out = clip(source, 20)
    expect(out.endsWith('…')).toBe(true)
    // Whatever it ends on must be a WHOLE word from the source, not a fragment.
    const lastWord = out.slice(0, -1).trim().split(' ').pop()
    expect(source.split(' ')).toContain(lastWord)
  })

  it('falls back to a hard cut when the only space is very early', () => {
    // Guard against a single early space throwing away most of the budget.
    const out = clip('a' + ' ' + 'b'.repeat(60), 20)
    expect(out.length).toBeLessThanOrEqual(21)
    expect(out.endsWith('…')).toBe(true)
  })

  it('never leaves trailing whitespace before the ellipsis', () => {
    expect(clip('hello world again', 12)).not.toMatch(/ …$/)
  })
})

describe('formatBytes', () => {
  it('uses bytes below 1 KB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('switches to KB and MB at the right thresholds', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    // The browser download this exists for is ~400 MB.
    expect(formatBytes(400 * 1024 * 1024)).toBe('400.0 MB')
  })
})

describe('siteFirstLines', () => {
  it('sorts third-party evidence last without hiding it', () => {
    // The tag is a fact, not a judgment — third-party noise is dimmed and sorted
    // last, never dropped.
    const lines = ['[third-party] cdn.js 404', '[site] api/login 500', '[third-party] ads 403']
    expect(siteFirstLines(lines)[0]).toContain('[site]')
    expect(siteFirstLines(lines)).toHaveLength(3)
  })

  it('does not mutate the caller’s array', () => {
    const lines = ['[third-party] a', '[site] b']
    siteFirstLines(lines)
    expect(lines[0]).toBe('[third-party] a')
  })

  it('recognises the tag exactly as main stamps it', () => {
    expect(isThirdPartyLine('[third-party] x')).toBe(true)
    expect(isThirdPartyLine('[site] x')).toBe(false)
  })
})

describe('a11yImpactRank', () => {
  it('orders worst-first', () => {
    expect(a11yImpactRank('critical')).toBeLessThan(a11yImpactRank('serious'))
    expect(a11yImpactRank('serious')).toBeLessThan(a11yImpactRank('moderate'))
    expect(a11yImpactRank('moderate')).toBeLessThan(a11yImpactRank('minor'))
  })

  it('sorts anything unrated last', () => {
    expect(a11yImpactRank('nonsense')).toBeGreaterThan(a11yImpactRank('minor'))
  })

  it('is what makes a "serious" threshold include critical', () => {
    // The a11y step fails when a violation is at the threshold "or worse", i.e.
    // rank <= budget. Critical must therefore rank below serious, or a critical
    // violation would pass a "serious" gate.
    expect(a11yImpactRank('critical')).toBeLessThanOrEqual(a11yImpactRank('serious'))
  })
})

describe('stabilityClass', () => {
  it('maps scores to traffic lights', () => {
    expect(stabilityClass(95)).toBe('high')
    expect(stabilityClass(80)).toBe('high')
    expect(stabilityClass(79)).toBe('med')
    expect(stabilityClass(50)).toBe('med')
    expect(stabilityClass(49)).toBe('low')
    expect(stabilityClass(0)).toBe('low')
  })

  it('returns no class when there is no score, rather than claiming "low"', () => {
    // An unknown score is not a bad score — showing a red dot for "unknown"
    // would be the same class of lie the app exists to avoid.
    expect(stabilityClass(undefined)).toBe('')
  })
})

describe('primaryCandidate', () => {
  const cand = (locator: string): unknown => ({ kind: 'id', score: 90, locator, css: null })

  it('returns the candidate the step’s selector actually points at', () => {
    // After a hand-pick the primary is NOT necessarily the top-scored one.
    const step = {
      selector: "locator('#second')",
      candidates: [cand("locator('#first')"), cand("locator('#second')")]
    }
    expect((primaryCandidate(step as never) as { locator: string }).locator).toBe(
      "locator('#second')"
    )
  })

  it('falls back to the top-scored candidate when nothing matches', () => {
    const step = { selector: "locator('#gone')", candidates: [cand("locator('#first')")] }
    expect((primaryCandidate(step as never) as { locator: string }).locator).toBe(
      "locator('#first')"
    )
  })

  it('survives a step with no candidates', () => {
    expect(primaryCandidate({ selector: 'x' } as never)).toBeUndefined()
  })
})

describe('assertNeedsValue', () => {
  it('is true for the kinds that compare against an expected value', () => {
    for (const k of ['text-equals', 'text-contains', 'value', 'count', 'attribute', 'class', 'url-contains', 'title', 'nl']) {
      expect(assertNeedsValue(k as never), `${k} should need a value`).toBe(true)
    }
  })

  it('is false for the state-only checks', () => {
    for (const k of ['visible', 'hidden', 'empty', 'enabled', 'disabled', 'checked']) {
      expect(assertNeedsValue(k as never), `${k} should not need a value`).toBe(false)
    }
  })
})

describe('label tables', () => {
  it('every assert kind offered by the chooser has a label', () => {
    // A kind with no label renders as blank in the UI.
    for (const k of ASSERT_KINDS) expect(ASSERT_LABELS[k], `no label for ${k}`).toBeTruthy()
  })

  it('every failure category has both a label and a stated reason', () => {
    // The reason must travel with the label: two tests can fail with the same
    // message and land in different categories, which looks arbitrary without it.
    for (const k of Object.keys(CATEGORY_LABELS) as (keyof typeof CATEGORY_LABELS)[]) {
      expect(CATEGORY_LABELS[k], `no label for ${k}`).toBeTruthy()
      expect(CATEGORY_WHY[k], `no reason for ${k}`).toBeTruthy()
    }
  })
})
