import { describe, it, expect } from 'vitest'
import { resolveDraftUrl, stepsFromDraft, trunc } from '../src/main/draftSteps'
import type { DraftResult } from '../src/main/translator'

// F22 turns a user story into a draft test via the model. Everything here runs
// AFTER the model answers, and its job is to be honest about a specific thing:
// the model is asked for a bare path and routinely answers in prose. A step
// whose `url` is a SENTENCE cannot navigate — it fails at replay, long after the
// mistake was made, looking like the site is broken.

const BASE = 'https://shop.test/products'

describe('getting a navigable URL out of what the model said', () => {
  it('takes a full URL out of the middle of a sentence', () => {
    expect(resolveDraftUrl('Open https://shop.test/login and sign in')).toEqual({
      url: 'https://shop.test/login',
      guessed: false
    })
  })

  it('drops trailing punctuation from that URL', () => {
    // "…go to https://shop.test/cart." — the full stop is not part of the address.
    expect(resolveDraftUrl('Go to https://shop.test/cart.').url).toBe('https://shop.test/cart')
  })

  it('accepts a bare path on its own', () => {
    expect(resolveDraftUrl('/login', BASE)).toEqual({
      url: 'https://shop.test/login',
      guessed: false
    })
  })

  it('does NOT swallow a whole sentence that happens to start with a slash', () => {
    // "/login page shows the form" starts with "/" but is prose. Taking it
    // verbatim is exactly how a sentence used to end up in a step's url.
    const out = resolveDraftUrl('/login page shows the form', BASE)
    expect(out.url).toBe('https://shop.test/login')
    expect(out.url).not.toContain(' ')
  })

  it('finds a path embedded in prose', () => {
    expect(resolveDraftUrl('Navigate to /checkout to pay', BASE).url).toBe(
      'https://shop.test/checkout'
    )
  })

  it('does not mistake the slash in "and/or" for a path', () => {
    // No real path here, so it must fall through to a GUESS rather than
    // inventing "https://shop.test/or".
    const out = resolveDraftUrl('the user can pay by card and/or wallet', BASE)
    expect(out.url).not.toContain('/or')
    expect(out.guessed).toBe(true)
  })

  it('resolves relative to the page currently open', () => {
    // The origin comes from the open page, so /cart means THIS site's cart.
    expect(resolveDraftUrl('/cart', 'https://other.test/deep/page?x=1').url).toBe(
      'https://other.test/cart'
    )
  })
})

describe('being honest about a guess', () => {
  it('marks a single bare word as a guess, not a fact', () => {
    // "login" might be a path; the story never actually said so.
    const out = resolveDraftUrl('login', BASE)
    expect(out.url).toBe('https://shop.test/login')
    expect(out.guessed).toBe(true)
  })

  it('falls back to the site root for prose with no address at all', () => {
    const out = resolveDraftUrl('the customer wants to see their orders', BASE)
    expect(out.url).toBe('https://shop.test/')
    expect(out.guessed).toBe(true)
  })

  it('returns NOTHING rather than prose when there is no page to resolve against', () => {
    // The whole point of the function: an empty url flags itself in the UI, a
    // sentence pretends to be an address and fails later.
    const out = resolveDraftUrl('the customer wants to see their orders')
    expect(out.url).toBe('')
    expect(out.guessed).toBe(true)
  })

  it('keeps a bare path even with no base — the editor can finish it', () => {
    expect(resolveDraftUrl('/orders')).toEqual({ url: '/orders', guessed: true })
  })

  it('survives an unusable base url', () => {
    expect(() => resolveDraftUrl('/x', 'not a url')).not.toThrow()
    expect(resolveDraftUrl('/x', 'not a url').url).toBe('/x')
  })
})

describe('the draft as steps', () => {
  const draft = (steps: DraftResult['steps'], note = ''): DraftResult => ({
    title: 'Checkout',
    steps,
    note
  })

  it('maps each kind to the step that can honestly represent it', () => {
    const out = stepsFromDraft(
      draft([
        { kind: 'navigate', text: '/cart' },
        { kind: 'action', text: 'click the Pay button' },
        { kind: 'check', text: 'the order confirmation appears' }
      ]),
      BASE
    )
    expect(out.steps[0]).toMatchObject({ type: 'navigate', url: 'https://shop.test/cart' })
    // The model never saw the page, so it cannot honestly produce a selector —
    // an action becomes a manual pause for the tester to ground, not a guess.
    expect(out.steps[1]).toMatchObject({ type: 'wait', waitKind: 'manual' })
    // A claim in words has no deterministic matcher; it's judged at replay.
    expect(out.steps[2]).toMatchObject({ type: 'assert', assertKind: 'nl' })
  })

  it('reports WHICH navigations were guessed, by index', () => {
    const out = stepsFromDraft(
      draft([
        { kind: 'navigate', text: '/cart' },
        { kind: 'check', text: 'a thing' },
        { kind: 'navigate', text: 'somewhere vague' }
      ]),
      BASE
    )
    expect(out.guessed).toEqual([2])
  })

  it('keeps `guessed` off the steps themselves', () => {
    // Review-only state. On the step it would be saved into the test file and
    // outlive the review it belongs to.
    const out = stepsFromDraft(draft([{ kind: 'navigate', text: 'vague' }]), BASE)
    expect(JSON.stringify(out.steps)).not.toContain('guessed')
  })

  it('tells the user how many need an address, with the right plural', () => {
    const one = stepsFromDraft(draft([{ kind: 'navigate', text: 'vague' }]), BASE)
    expect(one.note).toContain('1 “Go to” step had')
    const two = stepsFromDraft(
      draft([
        { kind: 'navigate', text: 'vague' },
        { kind: 'navigate', text: 'also vague' }
      ]),
      BASE
    )
    expect(two.note).toContain('2 “Go to” steps had')
  })

  it('keeps the model’s own note and adds to it, rather than replacing it', () => {
    const out = stepsFromDraft(draft([{ kind: 'navigate', text: 'vague' }], 'Story was thin.'), BASE)
    expect(out.note).toContain('Story was thin.')
    expect(out.note).toContain('Go to')
  })

  it('says nothing extra when every address was clear', () => {
    const out = stepsFromDraft(draft([{ kind: 'navigate', text: '/cart' }]), BASE)
    expect(out.guessed).toEqual([])
    expect(out.note).toBe('')
  })

  it('handles an empty draft without inventing anything', () => {
    expect(stepsFromDraft(draft([]), BASE)).toEqual({ steps: [], guessed: [], note: '' })
  })
})

describe('step labels', () => {
  it('shortens a long instruction but keeps it readable', () => {
    const long = 'a'.repeat(200)
    expect(trunc(long)).toHaveLength(60)
    expect(trunc(long).endsWith('…')).toBe(true)
  })

  it('leaves a short one alone', () => {
    expect(trunc('Go to /cart')).toBe('Go to /cart')
  })
})
