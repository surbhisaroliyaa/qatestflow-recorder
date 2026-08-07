import { describe, it, expect } from 'vitest'
import { buildSelectors, labelFrom, type ElementFacts } from '../src/main/selector'

// The selector engine decides how a recorded element is found again. Its
// candidate LADDER is what replay walks, and — less obviously — what decides
// whether the app will let you author a step at all: an element whose only
// candidate is the bare tag is refused as unreplayable (the Day 12 warning).
// So a missing candidate isn't just a weaker selector, it's a check you cannot
// add. That's the bug the text cap caused, and what these tests pin down.

const facts = (f: Partial<ElementFacts>): ElementFacts => ({ tag: 'div', ...f })
const kinds = (f: ElementFacts): string[] => buildSelectors(f).candidates.map((c) => c.kind)

describe('the visible-text candidate', () => {
  // Real page furniture from practice.expandtesting.com — 59 characters, no id,
  // no role, no name. Under the old 40-char cap this produced ONLY a bare-tag
  // candidate, so the app refused a check on it and there was nothing else on
  // the page to pick instead.
  const LONG_HEADING = 'Example of a new window page for Automation Testing Practice'

  it('is built for an ordinary long heading — the case that blocked a check', () => {
    expect(LONG_HEADING.length).toBeGreaterThan(40) // guard: still the case under test
    const built = buildSelectors(facts({ tag: 'h1', text: LONG_HEADING }))
    expect(built.candidates.map((c) => c.kind)).toContain('text')
    expect(built.primary).toBe(`getByText('${LONG_HEADING}')`)
  })

  it('means such an element is no longer "unreliable"', () => {
    // The exact rule the pick UI uses to refuse a step.
    const unreliable = (f: ElementFacts): boolean =>
      !buildSelectors(f).candidates.some((c) => c.kind !== 'css')
    expect(unreliable(facts({ tag: 'h1', text: LONG_HEADING }))).toBe(false)
    // …while a genuinely hookless element is still honestly refused.
    expect(unreliable(facts({ tag: 'div' }))).toBe(true)
  })

  it('stops at what the observer actually captures (100 chars)', () => {
    // observerSource.ts:585 keeps text up to 100, so a longer cap here would
    // describe elements the recorder never reports.
    expect(kinds(facts({ tag: 'h1', text: 'x'.repeat(100) }))).toContain('text')
    expect(kinds(facts({ tag: 'h1', text: 'x'.repeat(101) }))).not.toContain('text')
  })

  it('never displaces a better hook — it only fills a gap', () => {
    // Widening the cap must not change which selector wins anywhere.
    const built = buildSelectors(facts({ tag: 'button', id: 'submit', text: LONG_HEADING }))
    expect(built.primary).toBe("locator('#submit')")
    const withText = built.candidates.find((c) => c.kind === 'text')
    const withId = built.candidates.find((c) => c.kind === 'id')
    expect(withText!.score).toBeLessThan(withId!.score)
  })

  it('is still never built for a form field', () => {
    // getByText searches content; a field's "text" is not its content, so a
    // text selector on an input is a promise replay can't keep.
    for (const tag of ['input', 'select', 'textarea']) {
      expect(kinds(facts({ tag, text: 'Username' }))).not.toContain('text')
    }
  })
})

describe('a MACHINE-generated test id is not the gold standard', () => {
  // A test id is a promise of stability only when a human chose the name. These
  // scored 95 — above every hook that actually survives — so a recorded test
  // broke on the next render or the next upload, for reasons nothing to do with
  // the app under test.
  const generated = [
    ['a framework hash', 'row-8f3a91cc'],
    ['a timestamped filename', '1786087311623_DNDAgentFile.txt'],
    ["React's useId", ':r1:'],
    ['a long digit run', 'item-20260807']
  ]

  for (const [title, id] of generated) {
    it(`demotes ${title}`, () => {
      const built = buildSelectors(facts({ tag: 'a', testId: id, testIdAttr: 'data-testid' }))
      expect(built.candidates.find((c) => c.kind === 'testId')!.score).toBe(45)
    })
  }

  it('leaves a human-named test id alone at 95', () => {
    for (const id of ['login-button', 'cart', 'submit_form', 'product-card']) {
      const built = buildSelectors(facts({ tag: 'button', testId: id }))
      expect(built.candidates.find((c) => c.kind === 'testId')!.score, id).toBe(95)
    }
  })

  it('lets a REAL hook win over a generated one', () => {
    // The whole point: with a generated test id, role/name/text should lead.
    const built = buildSelectors(
      facts({ tag: 'button', testId: 'btn-8f3a91cc', role: 'button', text: 'Add to cart' })
    )
    expect(built.primary).toBe("getByRole('button', { name: 'Add to cart' })")
  })

  it('still beats a generated id — a test id was at least placed on purpose', () => {
    const built = buildSelectors(facts({ tag: 'div', testId: 'x-99999', id: 'y-99999' }))
    const testId = built.candidates.find((c) => c.kind === 'testId')!
    const id = built.candidates.find((c) => c.kind === 'id')!
    expect(testId.score).toBeGreaterThan(id.score)
    expect(built.primary).toBe(testId.locator)
  })

  it('is still the primary when nothing better exists — demoted, not discarded', () => {
    // Honest refusal is for elements with NO hook; a generated test id is a weak
    // hook, and a weak hook still beats nothing.
    const built = buildSelectors(facts({ tag: 'a', testId: '1786087311623_report.txt' }))
    expect(built.primary).toBe("getByTestId('1786087311623_report.txt')")
  })
})

describe('the human label', () => {
  it('still truncates at 40 — a label is for READING, not for finding', () => {
    // Deliberately independent of the selector cap: the step list has one line.
    const long = 'Example of a new window page for Automation Testing Practice'
    expect(labelFrom(facts({ tag: 'h1', text: long }))).toBe(`${long.slice(0, 40)}…`)
  })

  it('ignores a bare number, which is a count rather than a name', () => {
    expect(labelFrom(facts({ tag: 'span', text: '1', testId: 'cart-badge' }))).toBe('cart badge')
  })
})
