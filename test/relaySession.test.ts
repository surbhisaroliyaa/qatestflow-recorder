import { describe, it, expect } from 'vitest'
import { createRelaySession } from '../src/shared/relaySession'
import { relayDecision } from '../src/shared/recorderMessages'

// =====================================================================
// The four lifecycle scenarios QF-002 could break.
//
// Every one of these fails SILENTLY in the product: the app looks fine and
// simply records nothing. That is worse than a crash, so each is written as
// the user's journey ("record, navigate, record again") rather than as a
// property of the state machine.
//
// What these cover: the arming rule and the gate, together. What they cannot
// cover: Electron's own IPC delivery and the native embedded-browser pane.
// =====================================================================

/** A mint that hands out predictable, distinct values so a test can SEE rotation. */
function counter(): () => string {
  let n = 0
  return () => `nonce-${++n}`
}

/** What the observer posts, given the nonce main baked into it. */
const observerMessage = (nonce: string): Record<string, unknown> => ({
  __qaflow: true,
  nonce,
  channel: 'recorder:event',
  payload: { type: 'click', facts: { tag: 'button', id: 'pay', text: 'Pay now' } }
})

/** Does a step recorded with `bakedNonce` survive a relay armed with `armed`? */
const stepGetsThrough = (bakedNonce: string, armed: string): boolean =>
  relayDecision({
    sessionNonce: armed || null,
    sameTab: true,
    data: observerMessage(bakedNonce)
  }) !== null

describe('scenario 1 — record a normal flow', () => {
  it('arms a nonce and the recorded step gets through', () => {
    const session = createRelaySession(counter())
    const nonce = session.sync({ recording: true, picking: false, fresh: true })

    expect(nonce).toBe('nonce-1')
    expect(stepGetsThrough(nonce, session.current())).toBe(true)
  })

  it('records nothing before the user presses Record', () => {
    const session = createRelaySession(counter())
    expect(session.current()).toBe('')
    expect(stepGetsThrough('anything', session.current())).toBe(false)
  })

  it('closes the relay again when recording stops', () => {
    const session = createRelaySession(counter())
    const nonce = session.sync({ recording: true, picking: false, fresh: true })
    session.sync({ recording: false, picking: false })

    expect(session.current()).toBe('')
    // The nonce that was valid a moment ago is now worthless.
    expect(stepGetsThrough(nonce, session.current())).toBe(false)
  })
})

describe('scenario 2 — navigate mid-recording', () => {
  // The one I judged most likely to break: the relay preload re-executes for
  // every new document, so its nonce resets to null and main must re-arm it.
  it('keeps the SAME nonce across a navigation, so observers stay valid', () => {
    const session = createRelaySession(counter())
    const nonce = session.sync({ recording: true, picking: false, fresh: true })

    // A navigation re-arms the relay and re-injects observers. Neither is a new
    // session, so neither passes `fresh` — the value must not move.
    const afterNav = session.sync({ recording: true, picking: false })
    expect(afterNav).toBe(nonce)

    // Steps recorded before AND after the navigation both still cross.
    expect(stepGetsThrough(nonce, session.current())).toBe(true)
    expect(stepGetsThrough(afterNav, session.current())).toBe(true)
  })

  it('survives many navigations without rotating', () => {
    const session = createRelaySession(counter())
    const nonce = session.sync({ recording: true, picking: false, fresh: true })
    for (let i = 0; i < 10; i++) session.sync({ recording: true, picking: false })

    expect(session.current()).toBe(nonce)
    expect(stepGetsThrough(nonce, session.current())).toBe(true)
  })
})

describe('scenario 3 — stop, then record again', () => {
  it('mints a DIFFERENT nonce for the second recording', () => {
    const session = createRelaySession(counter())
    const first = session.sync({ recording: true, picking: false, fresh: true })
    session.sync({ recording: false, picking: false })
    const second = session.sync({ recording: true, picking: false, fresh: true })

    expect(second).not.toBe(first)
    // The second recording works…
    expect(stepGetsThrough(second, session.current())).toBe(true)
    // …and a nonce scraped off the FIRST recording is dead, which is the
    // reason for rotating at all.
    expect(stepGetsThrough(first, session.current())).toBe(false)
  })
})

describe('scenario 4 — the element picker', () => {
  it('arms the relay even though recording is off', () => {
    // Picking an element to assert on is its own session and comes back through
    // this same relay. Gating purely on `recording` would have broken it.
    const session = createRelaySession(counter())
    const nonce = session.sync({ recording: false, picking: true, fresh: true })

    expect(nonce).not.toBe('')
    const picked = relayDecision({
      sessionNonce: session.current(),
      sameTab: true,
      data: { __qaflow: true, nonce, channel: 'recorder:picked', payload: { facts: { tag: 'h1' } } }
    })
    expect(picked, 'the picker was locked out by its own security fix').not.toBe(null)
  })

  it('does not disturb a recording already in progress', () => {
    // Turning the picker on mid-recording must NOT rotate the nonce — every
    // observer already running would stop being believed.
    const session = createRelaySession(counter())
    const recordingNonce = session.sync({ recording: true, picking: false, fresh: true })
    session.sync({ recording: true, picking: true })

    expect(session.current()).toBe(recordingNonce)
    expect(stepGetsThrough(recordingNonce, session.current())).toBe(true)
  })

  it('stays armed while recording stops but picking continues', () => {
    const session = createRelaySession(counter())
    session.sync({ recording: true, picking: true, fresh: true })
    const after = session.sync({ recording: false, picking: true })

    expect(after).not.toBe('')
    expect(stepGetsThrough(after, session.current())).toBe(true)
  })

  it('closes once BOTH recording and picking are off', () => {
    const session = createRelaySession(counter())
    session.sync({ recording: true, picking: true, fresh: true })
    session.sync({ recording: false, picking: true })
    session.sync({ recording: false, picking: false })

    expect(session.current()).toBe('')
  })
})

describe('the forged-step attack, across the whole lifecycle', () => {
  it('is refused before, during and after a recording', () => {
    const session = createRelaySession(counter())
    const forged = {
      __qaflow: true,
      channel: 'recorder:event',
      payload: { type: 'click', facts: { tag: 'button', text: 'Forged by page' } }
    }
    const tryForge = (): boolean =>
      relayDecision({ sessionNonce: session.current() || null, sameTab: true, data: forged }) !==
      null

    expect(tryForge(), 'idle').toBe(false)
    session.sync({ recording: true, picking: false, fresh: true })
    expect(tryForge(), 'while recording').toBe(false)
    session.sync({ recording: false, picking: false })
    expect(tryForge(), 'after recording').toBe(false)
  })
})
