import { describe, it, expect } from 'vitest'
import { appendRecordedStep, supersedesPrevious } from '../src/renderer/src/stepMerge'

// =====================================================================
// When a run of scrolls is ONE action, and when it is several.
//
// This rule has two opposed failure modes and both have already happened:
//
//   · merge too little → reading down a long article produced seventeen steps
//     from a few gestures (Surbhi, Round 2a);
//   · merge too much → two deliberate scrolls became one, which on an
//     infinite-scroll page means replaying one page load where the user did
//     three (Surbhi, Round 2a retest).
//
// Both directions are tested here, side by side, because a change that fixes
// one by breaking the other looks like a fix until someone uses it.
//
// This file also exists because of HOW the second bug survived. The rule lived
// inside a React effect, and the only test near it asserted what the RECORDER
// emitted — one layer below where the merging happened. It sat green while the
// app did the opposite of what the test's name claimed. Extracting the rule is
// what makes this file possible.
// =====================================================================

type S = { type: string; loadedMore?: boolean; scrollDir?: 'up' | 'down' }
const scroll = (loadedMore?: boolean): S =>
  loadedMore === undefined ? { type: 'scroll' } : { type: 'scroll', loadedMore }
const down = (): S => ({ type: 'scroll', scrollDir: 'down' })
const up = (): S => ({ type: 'scroll', scrollDir: 'up' })
const click = (): { type: string } => ({ type: 'click' })

describe('§ reading down a page — merge', () => {
  it('a scroll that loaded nothing replaces the scroll before it', () => {
    expect(supersedesPrevious(scroll(), scroll())).toBe(true)
  })

  it('a whole run of them collapses to one step', () => {
    // The Round 2a symptom, at the layer that now decides it.
    let steps = [click()]
    for (let i = 0; i < 12; i++) steps = appendRecordedStep(steps, scroll())
    expect(steps).toHaveLength(2)
    expect(steps[0].type).toBe('click')
    expect(steps[1].type).toBe('scroll')
  })

  it('keeps the LAST position, not the first', () => {
    // Where the reader came to rest is the part the test needs.
    const first = { type: 'scroll', value: '100' }
    const second = { type: 'scroll', value: '900' }
    expect(appendRecordedStep([first], second)).toEqual([second])
  })
})

describe('§ infinite scroll — keep every one', () => {
  it('a scroll that LOADED content is its own step', () => {
    expect(supersedesPrevious(scroll(), scroll(true))).toBe(false)
  })

  it('never overwrites a scroll that loaded content', () => {
    // The earlier step fetched something; a later scroll that fetched nothing
    // must not erase the record of it.
    expect(supersedesPrevious(scroll(true), scroll())).toBe(false)
  })

  it('three loading scrolls stay three steps', () => {
    // The retest failure, stated as a test. Merged, this test would replay one
    // page load where the user did three.
    let steps: { type: string; loadedMore?: boolean }[] = []
    for (let i = 0; i < 3; i++) steps = appendRecordedStep(steps, scroll(true))
    expect(steps).toHaveLength(3)
  })
})

describe('§ direction — a reversal is a new action', () => {
  it('down then UP stays two steps', () => {
    // Round 2b Part 1: scrolling back up merged into the scroll down, and the
    // trip down disappeared entirely.
    expect(supersedesPrevious(down(), up())).toBe(false)
    expect(appendRecordedStep([down()], up())).toHaveLength(2)
  })

  it('up then DOWN stays two steps', () => {
    expect(supersedesPrevious(up(), down())).toBe(false)
  })

  it('continuing the same way still merges', () => {
    // The case merging exists for: reading down a page is one direction from
    // start to finish.
    expect(supersedesPrevious(down(), down())).toBe(true)
    expect(supersedesPrevious(up(), up())).toBe(true)
  })

  it('down, up, down is three steps', () => {
    let steps = appendRecordedStep([], down())
    steps = appendRecordedStep(steps, up())
    steps = appendRecordedStep(steps, down())
    expect(steps).toHaveLength(3)
  })

  it('a long read down is still ONE step, however many gestures', () => {
    let steps: S[] = []
    for (let i = 0; i < 10; i++) steps = appendRecordedStep(steps, down())
    expect(steps).toHaveLength(1)
  })

  it('treats a step with no recorded direction as continuing', () => {
    // Back-compat: steps recorded before direction was captured have no
    // scrollDir, and must behave exactly as they did.
    expect(supersedesPrevious(scroll(), scroll())).toBe(true)
    expect(supersedesPrevious(down(), scroll())).toBe(true)
  })
})

describe('§ never merge across anything else', () => {
  it('a click between two scrolls keeps both', () => {
    let steps = appendRecordedStep([], scroll())
    steps = appendRecordedStep(steps, click())
    steps = appendRecordedStep(steps, scroll())
    expect(steps.map((s) => s.type)).toEqual(['scroll', 'click', 'scroll'])
  })

  it('never touches a step that is not a scroll', () => {
    expect(supersedesPrevious(click(), click())).toBe(false)
    expect(supersedesPrevious(scroll(), click())).toBe(false)
    expect(supersedesPrevious(click(), scroll())).toBe(false)
  })

  it('the first step is always appended', () => {
    expect(supersedesPrevious(undefined, scroll())).toBe(false)
    expect(appendRecordedStep([], scroll())).toHaveLength(1)
  })
})
