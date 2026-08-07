import { describe, it, expect } from 'vitest'
import { textCheckIsCircular } from '../src/renderer/src/checkAdvice'

// Candidates are score-ordered, exactly as buildSelectors emits them.
const cand = (kind: string, score: number): never => ({ kind, score, locator: 'x' }) as never
const kind = (k: string): never => k as never

const TEXT_ONLY = [cand('text', 50), cand('css', 15)] as never[]
const HAS_ROLE = [cand('role', 80), cand('text', 50), cand('css', 15)] as never[]
const HAS_ID = [cand('id', 90), cand('css', 15)] as never[]

describe('a text check on a text-found element is circular', () => {
  // Recorded on practice.expandtesting.com: the popup's only element is an h1
  // with no id and no role, so the step is found by its words — and the check
  // then asserted those same words back.
  //   expect(page.getByText('Example of a new window…')).toHaveText('Example of a new window…')
  // It cannot fail on wording, only on absence.
  it('flags text-equals and text-contains', () => {
    expect(textCheckIsCircular(TEXT_ONLY, kind('text-equals'))).toBe(true)
    expect(textCheckIsCircular(TEXT_ONLY, kind('text-contains'))).toBe(true)
  })

  it('says nothing about a check that is NOT about text', () => {
    for (const k of ['visible', 'hidden', 'enabled', 'count', 'value', 'attribute', 'class']) {
      expect(textCheckIsCircular(TEXT_ONLY, kind(k)), k).toBe(false)
    }
  })

  it('says nothing when the element has a real hook — the text is then verified', () => {
    // Found by role, asserted on text: those are two different facts, so the
    // check does real work and must NOT be nagged about.
    expect(textCheckIsCircular(HAS_ROLE, kind('text-equals'))).toBe(false)
    expect(textCheckIsCircular(HAS_ID, kind('text-equals'))).toBe(false)
  })

  it('ignores the css last-resort when deciding which hook is primary', () => {
    // css is the bare-tag fallback that sits under everything; it never decides.
    expect(textCheckIsCircular([cand('css', 15), cand('text', 50)] as never[], kind('text-equals')))
      .toBe(true)
  })

  it('handles a missing / empty ladder without throwing', () => {
    expect(textCheckIsCircular(undefined, kind('text-equals'))).toBe(false)
    expect(textCheckIsCircular([], kind('text-equals'))).toBe(false)
    expect(textCheckIsCircular(TEXT_ONLY, undefined)).toBe(false)
  })
})
