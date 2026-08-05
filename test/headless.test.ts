import { describe, it, expect } from 'vitest'
import { headlessCategory } from '../src/renderer/src/headless'

// Before headlessCategory existed, EVERY headless failure landed in
// `unclassified` — 20 of 20 in the Test 12 batch — because translator.ts matches
// our own in-app wording ("Element not found") and Playwright says entirely
// different things. The breakdown was useless on exactly the runs that predict CI.
//
// The strings below are real Playwright output, kept verbatim. That matters: the
// value of this suite is that it is checked against what the tool actually emits,
// not against what we imagine it emits.

describe('headlessCategory', () => {
  it('returns unknown for no error at all', () => {
    expect(headlessCategory(undefined)).toBe('unknown')
    expect(headlessCategory('')).toBe('unknown')
  })

  describe('authoring problems — the spec never ran', () => {
    it('classifies an unclosed control block', () => {
      // One malformed spec aborts the ENTIRE Playwright batch, so this category
      // is the difference between "your test is broken" and "the site is broken".
      expect(headlessCategory('Step 4: "repeat" is never closed — add a matching "endRepeat".')).toBe(
        'authoring'
      )
    })

    it('classifies our own pre-pass refusal', () => {
      expect(headlessCategory('Test structure problem: loops and if-blocks cannot overlap')).toBe(
        'authoring'
      )
    })
  })

  describe('environment problems — never reached the site', () => {
    it('classifies a missing fixture file', () => {
      // Uploads and HARs never travelled into a parallel run, so every upload test
      // died on ENOENT. Reading that as "stale selector" sent you to the wrong place.
      expect(
        headlessCategory("Error: ENOENT: no such file or directory, open 'fixtures\\avatar.png'")
      ).toBe('environment')
    })

    it('classifies connection failures', () => {
      expect(headlessCategory('connect ECONNREFUSED 127.0.0.1:4517')).toBe('environment')
      expect(headlessCategory('net::ERR_NAME_NOT_RESOLVED at https://nope.test/')).toBe('environment')
    })

    it('classifies our own API-step wording for the same thing', () => {
      expect(headlessCategory('The API could not be reached — localhost:4517')).toBe('environment')
    })
  })

  describe('stale data — the check ran and lost', () => {
    it('classifies a failed URL expectation', () => {
      // The exact error the broken monitor produced today.
      expect(
        headlessCategory(
          'Error: expect(page).toHaveURL(expected) failed Expected pattern: /\\/inventory\\.html/ Received string: "https://www.saucedemo.com/"'
        )
      ).toBe('stale-data')
    })

    it('classifies a failed text expectation', () => {
      expect(
        headlessCategory('expect(locator).toHaveText(expected) failed Expected: "Products"')
      ).toBe('stale-data')
    })
  })

  describe('stale selector — the element was never there', () => {
    it('prefers "not found" over the comparison that wrapped it', () => {
      // A failed expect AND a missing element: the missing element is the cause.
      expect(
        headlessCategory(
          'expect(locator).toHaveText(expected) failed Call log: waiting for locator("#gone") locator resolved to 0 elements'
        )
      ).toBe('stale-selector')
    })

    it('classifies a bare Playwright test timeout', () => {
      expect(headlessCategory('Test timeout of 30000ms exceeded.')).toBe('stale-selector')
    })

    it('classifies a visibility check that never came true', () => {
      expect(headlessCategory('expect(locator).toBeVisible() failed')).toBe('stale-selector')
    })
  })

  describe('timing', () => {
    it('classifies a missed latency budget, not as a data failure', () => {
      // toBe\b deliberately does not catch toBeLessThanOrEqual — this must stay timing.
      expect(headlessCategory('expect(received).toBeLessThanOrEqual(500) // 599ms')).toBe('timing')
    })

    it('classifies a named wait that expired', () => {
      expect(headlessCategory('Timeout 5000ms exceeded while waiting for event "load"')).toBe(
        'timing'
      )
    })
  })

  describe('data-driven aggregates', () => {
    it('classifies by the example after the dash, not the wrapper', () => {
      // Without this, every data-driven failure landed in `unknown` no matter what
      // actually went wrong — the aggregate sentence matches none of the rules.
      expect(
        headlessCategory(
          '5/5 rows failed — e.g. Row 1: expect(page).toHaveURL(expected) failed Expected pattern: /\\/inventory\\.html/'
        )
      ).toBe('stale-data')
    })

    // KNOWN GAP, found by mutation-testing this file: deleting the row-example
    // recursion in headlessCategory breaks NO test, and cannot — the aggregate is
    // built as `N/M rows failed — e.g. <rowLabel>: <error>` (App.tsx:2554), so the
    // captured example keeps its "standard_user: " prefix, which stops the one
    // anchored rule (/^Expected /) matching there too. Every other rule is
    // unanchored and the wrapper CONTAINS the example, so the outer string already
    // matches whatever the inner one would. The recursion cannot change an answer.
    //
    // Left as-is deliberately rather than tested into a false green. The fix, if
    // wanted, is to strip the `<label>: ` prefix before recursing — that makes
    // `^Expected 5 items but found 3` reachable, which is what the comment above
    // the recursion says it was for.

    it('falls back to unknown when the example is also unrecognisable', () => {
      expect(headlessCategory('3/3 rows failed — e.g. Row 1: something we have never seen')).toBe(
        'unknown'
      )
    })
  })

  it('never claims app-bug, which needs console/network evidence a headless run lacks', () => {
    // Claiming it without that evidence would be a guess dressed as a finding.
    const samples = [
      'Test timeout of 30000ms exceeded.',
      'expect(locator).toBeVisible() failed',
      'connect ECONNREFUSED 127.0.0.1:4517',
      'Uncaught TypeError: undefined is not a function'
    ]
    for (const s of samples) expect(headlessCategory(s)).not.toBe('app-bug')
  })
})
