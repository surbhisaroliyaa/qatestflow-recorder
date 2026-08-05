import { describe, it, expect } from 'vitest'
import { generateSuiteDoc } from '../src/renderer/src/livingDocs'

// The "N tests verify nothing" warning is the most useful line the suite doc
// produces — and it had become untrustworthy, because roughly half the 34 it
// reported were deliberate mechanics fixtures (F36/F37/F39) that have no checks
// BY DESIGN. A warning you have learned to ignore hides the genuine cases inside
// it, so the two are now counted separately.

const entry = (
  name: string,
  steps: unknown[],
  tags?: string[]
): { name: string; suite: string; flat: never[]; meta: { tags?: string[] } } =>
  ({ name, suite: 'S', flat: steps, meta: { tags } }) as never

const click = { type: 'click', selector: "getByRole('button')" }
const assertVisible = { type: 'assert', assertKind: 'visible', selector: "getByText('x')", label: 'x' }

describe('generateSuiteDoc — the "verifies nothing" warning', () => {
  it('flags a test that performs actions but asserts nothing', () => {
    const doc = generateSuiteDoc([entry('cart check', [click, click])])
    expect(doc).toContain('verifies nothing')
    expect(doc).toMatch(/1 test has no checks that can fail/)
  })

  it('does not flag a test that has a real check', () => {
    const doc = generateSuiteDoc([entry('login', [click, assertVisible])])
    expect(doc).not.toContain('verifies nothing')
    expect(doc).not.toMatch(/no checks that can fail/)
  })

  it('counts a @fixture test SEPARATELY instead of as a gap', () => {
    // F37-6 "Nested loops 2x3" exists to prove loops loop, not to test the site.
    const doc = generateSuiteDoc([entry('F37-6 Nested loops', [click], ['@f37', '@fixture'])])
    expect(doc).not.toMatch(/1 test has no checks that can fail/)
    expect(doc).toContain('mechanics fixture')
  })

  it('reports both numbers when a suite has each kind', () => {
    const doc = generateSuiteDoc([
      entry('cart check', [click]),
      entry('F37-6', [click], ['@fixture']),
      entry('F36-1', [click], ['@fixture'])
    ])
    // The real gap stays visible…
    expect(doc).toMatch(/1 test has no checks that can fail/)
    // …and the deliberate ones are accounted for, not silently dropped.
    expect(doc).toMatch(/2 more are deliberate 🔧 mechanics fixtures, not counted here/)
  })

  it('accepts the tag with or without the @, and any case', () => {
    for (const tag of ['@fixture', 'fixture', '@Fixture', 'FIXTURE']) {
      const doc = generateSuiteDoc([entry('m', [click], [tag])])
      expect(doc, `tag ${tag} should mark a fixture`).toContain('mechanics fixture')
    }
  })

  it('never hides a fixture that DOES have checks — it is just a normal test then', () => {
    const doc = generateSuiteDoc([entry('F37-x', [click, assertVisible], ['@fixture'])])
    expect(doc).not.toContain('mechanics fixture')
    expect(doc).not.toContain('verifies nothing')
  })
})

describe('generateSuiteDoc — teardown warning', () => {
  it('flags data created with no teardown', () => {
    const doc = generateSuiteDoc([
      entry('checkout', [{ ...click, createsData: 'cart item' }, assertVisible])
    ])
    expect(doc).toMatch(/no teardown/)
    expect(doc).toContain('creates cart item')
  })

  it('does NOT accept a teardown marked on a UI step', () => {
    // The runner and the exporter both honour teardown on API steps only. A doc
    // that says "cleaned up ✓" for cleanup that never runs is a false all-clear —
    // worse than the warning it replaces.
    const doc = generateSuiteDoc([
      entry('checkout', [
        { ...click, createsData: 'cart item' },
        { ...click, teardown: true },
        assertVisible
      ])
    ])
    expect(doc).toMatch(/no teardown/)
    expect(doc).not.toContain('cleaned up ✓')
  })

  it('says it is cleaned up when a teardown step exists', () => {
    const doc = generateSuiteDoc([
      entry('checkout', [
        { ...click, createsData: 'cart item' },
        { type: 'api', teardown: true, url: 'https://x.test/reset' },
        assertVisible
      ])
    ])
    expect(doc).toContain('cleaned up ✓')
    expect(doc).not.toMatch(/no teardown/)
  })
})
