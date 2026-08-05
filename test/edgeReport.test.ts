import { describe, it, expect } from 'vitest'
import {
  buildEdgeReport,
  edgeBasisNote,
  edgeCtxOf,
  edgeVerdict,
  normEdgeUrl,
  type EdgeRunLike
} from '../src/renderer/src/edgeReport'

// These decide whether the app under test ACCEPTED a hostile input — the most
// consequential claim this product makes. One earlier version reported fourteen
// rejections as fourteen vulnerabilities: the same evidence read backwards.
// Everything here is about not being able to do that again.

const ctx = (over: Partial<ReturnType<typeof edgeCtxOf>> = {}): ReturnType<typeof edgeCtxOf> => ({
  baselineOk: true,
  hasAssertion: false,
  successUrl: '',
  startUrl: '',
  baselineUrl: '',
  ...over
})

describe('normEdgeUrl', () => {
  it('keeps origin and path, drops query and hash', () => {
    // Query/hash carry per-run noise (tokens, scroll anchors) that would make
    // the same page compare as different.
    expect(normEdgeUrl('https://X.test/Cart?token=abc#top')).toBe('https://x.test/cart')
  })

  it('ignores a trailing slash and case', () => {
    expect(normEdgeUrl('https://x.test/cart/')).toBe(normEdgeUrl('https://X.TEST/cart'))
  })

  it('survives a non-URL without throwing', () => {
    expect(normEdgeUrl('not a url')).toBe('not a url')
    expect(normEdgeUrl(undefined)).toBe('')
  })
})

describe('edgeVerdict — precedence', () => {
  it('reuses a STORED verdict above everything else', () => {
    // A re-opened saved run must not change meaning because the rules improved.
    const v = edgeVerdict({ ok: false, verdict: 'accepted' }, ctx({ hasAssertion: true }))
    expect(v).toEqual({ verdict: 'accepted', basis: 'stored' })
  })

  it('refuses to judge anything when the baseline failed', () => {
    // The valid input did not work, so nothing else means anything.
    const v = edgeVerdict({ ok: true }, ctx({ baselineOk: false, hasAssertion: true }))
    expect(v).toEqual({ verdict: 'unknown', basis: 'none' })
  })

  it('prefers the user’s explicit rule over the test’s own check', () => {
    const v = edgeVerdict(
      { ok: false, finalUrl: 'https://x.test/inventory.html' },
      ctx({ successUrl: '/inventory', hasAssertion: true })
    )
    expect(v).toEqual({ verdict: 'accepted', basis: 'rule' })
  })

  it('says unknown when a rule is set but the variant has no final URL', () => {
    const v = edgeVerdict({ ok: true }, ctx({ successUrl: '/inventory' }))
    expect(v.verdict).toBe('unknown')
  })

  it('uses the test’s own check when there is no rule', () => {
    expect(edgeVerdict({ ok: true }, ctx({ hasAssertion: true }))).toEqual({
      verdict: 'accepted',
      basis: 'check'
    })
    expect(edgeVerdict({ ok: false }, ctx({ hasAssertion: true }))).toEqual({
      verdict: 'rejected',
      basis: 'check'
    })
  })
})

describe('edgeVerdict — inference from the baseline', () => {
  const moved = { baselineUrl: 'https://x.test/inventory.html', startUrl: 'https://x.test/' }

  it('accepts a variant that ended where the valid input ended', () => {
    const v = edgeVerdict({ ok: true, finalUrl: 'https://x.test/inventory.html' }, ctx(moved))
    expect(v).toEqual({ verdict: 'accepted', basis: 'url' })
  })

  it('rejects a variant that ended somewhere else', () => {
    const v = edgeVerdict({ ok: false, finalUrl: 'https://x.test/' }, ctx(moved))
    expect(v).toEqual({ verdict: 'rejected', basis: 'url' })
  })

  it('REFUSES to infer when success does not move the page', () => {
    // A SPA that swaps content in place ends where it started, so the signal
    // cannot discriminate. Saying so beats guessing — this is the guard that
    // stops "rejected" being claimed on no evidence.
    const v = edgeVerdict(
      { ok: true, finalUrl: 'https://x.test/' },
      ctx({ baselineUrl: 'https://x.test/', startUrl: 'https://x.test/' })
    )
    expect(v).toEqual({ verdict: 'unknown', basis: 'none' })
  })
})

describe('edgeCtxOf', () => {
  it('derives the shared context from the run itself', () => {
    const run = {
      hasAssertion: true,
      successUrl: '/ok',
      startUrl: 'https://x.test/',
      results: [
        { case: { baseline: true }, ok: true, finalUrl: 'https://x.test/done' },
        { case: {}, ok: false }
      ]
    }
    expect(edgeCtxOf(run)).toEqual({
      baselineOk: true,
      hasAssertion: true,
      successUrl: '/ok',
      startUrl: 'https://x.test/',
      baselineUrl: 'https://x.test/done'
    })
  })

  it('reports baselineOk false when the baseline variant failed', () => {
    const run = {
      hasAssertion: false,
      results: [{ case: { baseline: true }, ok: false }]
    }
    expect(edgeCtxOf(run).baselineOk).toBe(false)
  })
})

describe('edgeBasisNote', () => {
  it('names the rule when one was typed', () => {
    expect(edgeBasisNote(ctx({ successUrl: '/inventory' }))).toMatch(/your rule/)
  })

  it('names the test’s check next', () => {
    expect(edgeBasisNote(ctx({ hasAssertion: true }))).toMatch(/own ✓ check/)
  })

  it('says an inferred verdict is inferred', () => {
    // An inferred verdict is weaker than an asserted one and the reader has to
    // be able to see which they are looking at.
    const note = edgeBasisNote(
      ctx({ baselineUrl: 'https://x.test/done', startUrl: 'https://x.test/' })
    )
    expect(note).toMatch(/^Inferred:/)
  })

  it('says nothing when the baseline failed', () => {
    expect(edgeBasisNote(ctx({ baselineOk: false, hasAssertion: true }))).toBe('')
  })
})

describe('buildEdgeReport', () => {
  const variant = (over = {}): EdgeRunLike['results'][number] =>
    ({
      case: {
        fieldLabel: 'Password',
        edgeLabel: 'SQL injection',
        value: "' OR 1=1--",
        hint: 'classic auth bypass'
      },
      ok: false,
      ...over
    }) as EdgeRunLike['results'][number]

  const run = (over: Partial<EdgeRunLike> = {}): EdgeRunLike => ({
    hasAssertion: true,
    startUrl: 'https://x.test/',
    results: [
      { case: { baseline: true, fieldLabel: '', edgeLabel: '', value: '', hint: '' }, ok: true },
      variant()
    ],
    ...over
  })

  it('returns empty string for no run rather than throwing', () => {
    expect(buildEdgeReport(null, 'x')).toBe('')
  })

  it('counts rejected variants as rejected, not as findings', () => {
    // THE bug this file exists to prevent: a handled rejection is the app doing
    // its job, and must never be reported as a vulnerability.
    const md = buildEdgeReport(run(), 'Login')
    expect(md).toContain('✓ Rejected (handled): 1')
    expect(md).toContain('⚠ Accepted (app took the bad input — review): 0')
    expect(md).toContain('✓ rejected — **Password**')
  })

  it('flags an ACCEPTED hostile input as needing review', () => {
    const md = buildEdgeReport(run({ results: [
      { case: { baseline: true, fieldLabel: '', edgeLabel: '', value: '', hint: '' }, ok: true },
      variant({ ok: true })
    ] }), 'Login')
    expect(md).toContain('⚠ Accepted (app took the bad input — review): 1')
    expect(md).toContain('⚠ ACCEPTED — **Password**')
  })

  it('does not print accepted/rejected counts when nothing could be judged', () => {
    // "0 rejected" beside "14 undetermined" reads as a finding; it isn't one.
    const md = buildEdgeReport(
      run({ hasAssertion: false, results: [
        { case: { baseline: true, fieldLabel: '', edgeLabel: '', value: '', hint: '' }, ok: true, finalUrl: 'https://x.test/' },
        variant({ finalUrl: 'https://x.test/' })
      ] }),
      'Login'
    )
    expect(md).toContain('? Undetermined: 1')
    expect(md).not.toContain('✓ Rejected (handled)')
  })

  it('says plainly when the baseline itself failed', () => {
    const md = buildEdgeReport(
      run({ results: [
        { case: { baseline: true, fieldLabel: '', edgeLabel: '', value: '', hint: '' }, ok: false },
        variant()
      ] }),
      'Login'
    )
    expect(md).toMatch(/Baseline \(happy path\) FAILED/)
  })

  it('carries the basis with the verdicts', () => {
    expect(buildEdgeReport(run(), 'Login')).toMatch(/own ✓ check/)
  })

  it('titles the report with the test name when there is one', () => {
    expect(buildEdgeReport(run(), 'Login')).toContain('# Edge-case report — Login')
    expect(buildEdgeReport(run(), '')).toContain('# Edge-case report')
  })

  it('shows (empty) rather than a blank for an empty-string variant', () => {
    const md = buildEdgeReport(
      run({ results: [
        { case: { baseline: true, fieldLabel: '', edgeLabel: '', value: '', hint: '' }, ok: true },
        variant({ case: { fieldLabel: 'Password', edgeLabel: 'empty', value: '', hint: 'blank' } })
      ] }),
      'Login'
    )
    expect(md).toContain('(empty)')
  })
})
