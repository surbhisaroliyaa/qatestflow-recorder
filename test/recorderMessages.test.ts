import { describe, it, expect } from 'vitest'
import {
  PAGE_CHANNELS,
  isPageChannel,
  relayDecision,
  validateElementFacts,
  validatePageMessage
} from '../src/shared/recorderMessages'

// =====================================================================
// QF-002 — the page → Electron trust boundary.
//
// The audit proved a tested website could post a recorder message and have
// the app accept it: a fabricated step labelled "Forged by page" appeared in
// a real recording, and the same relay reached an upload handler that copies
// caller-supplied paths into the local test library.
//
// The tests below are written from the ATTACKER's side first, because that is
// the side that was never considered. A test that only proves "a real event
// still gets through" would have passed against the broken code too.
// =====================================================================

const FACTS = { tag: 'button', id: 'pay', text: 'Pay now' }

describe('the channel allowlist', () => {
  it('accepts exactly the four channels the observer speaks on', () => {
    expect([...PAGE_CHANNELS]).toEqual([
      'recorder:event',
      'recorder:dialog',
      'recorder:picked',
      'recorder:pick-cancel'
    ])
  })

  it('REFUSES recorder:upload — the channel that reached the file copier', () => {
    // The whole escalation in one assertion. Uploads are produced by the relay
    // preload from a trusted isolated-world file event; a page naming this
    // channel was how an arbitrary path got copied into the test library.
    expect(isPageChannel('recorder:upload')).toBe(false)
    expect(validatePageMessage('recorder:upload', { facts: FACTS, paths: ['/etc/passwd'] })).toBe(
      null
    )
  })

  it('refuses every other ipcMain channel in the app', () => {
    // The old relay forwarded ANY string, so all of these were reachable.
    for (const channel of [
      'recorder:recovery',
      'recorder:manual-continue',
      'recorder:check-offer-respond',
      'recorder:toggle',
      'library:save',
      'app:quit',
      ''
    ]) {
      expect(isPageChannel(channel), channel).toBe(false)
      expect(validatePageMessage(channel, {}), channel).toBe(null)
    }
  })

  it('refuses a channel that is not even a string', () => {
    for (const channel of [null, undefined, 42, {}, ['recorder:event']]) {
      expect(isPageChannel(channel)).toBe(false)
    }
  })
})

describe('recorder:event payloads', () => {
  it('lets a genuine click through', () => {
    const clean = validatePageMessage('recorder:event', {
      type: 'click',
      facts: FACTS,
      frame: null
    })
    expect(clean).toMatchObject({ type: 'click', facts: { tag: 'button', id: 'pay' } })
  })

  it('accepts every step type the observer can actually emit', () => {
    for (const type of ['click', 'hover', 'type', 'check', 'select', 'press']) {
      expect(validatePageMessage('recorder:event', { type, facts: FACTS }), type).not.toBe(null)
    }
  })

  it('refuses a step type the observer never emits', () => {
    // A page inventing 'navigate' or 'upload' would be writing steps that no
    // interaction could have produced.
    for (const type of ['navigate', 'upload', 'api', 'snapshot', 'block', 'evil']) {
      expect(validatePageMessage('recorder:event', { type, facts: FACTS }), type).toBe(null)
    }
  })

  it('refuses an event with no element behind it', () => {
    expect(validatePageMessage('recorder:event', { type: 'click' })).toBe(null)
    expect(validatePageMessage('recorder:event', { type: 'click', facts: {} })).toBe(null)
    expect(validatePageMessage('recorder:event', { type: 'click', facts: 'button' })).toBe(null)
  })

  it('refuses a payload that is not an object at all', () => {
    for (const payload of [null, undefined, 'click', 42, ['click']]) {
      expect(validatePageMessage('recorder:event', payload)).toBe(null)
    }
  })

  it('drops unknown fields instead of passing them along', () => {
    // The payload that goes on to main is REBUILT, so nothing the page added
    // rides across the boundary. `secretRef` is the one that would matter most:
    // it is how a step points at a stored credential.
    const clean = validatePageMessage('recorder:event', {
      type: 'click',
      facts: FACTS,
      secretRef: 'stolen',
      opensWindow: 3,
      disabled: true
    }) as Record<string, unknown>
    expect(clean).not.toHaveProperty('secretRef')
    expect(clean).not.toHaveProperty('opensWindow')
    expect(clean).not.toHaveProperty('disabled')
    expect(Object.keys(clean).sort()).toEqual(['facts', 'type'])
  })

  it('carries no prototype pollution across', () => {
    // A literal `__proto__:` sets the prototype, which would make this test
    // pass against ANY implementation — JSON.parse is what produces a real own
    // property, which is also what an IPC payload from a page actually is.
    const hostile = JSON.parse('{"type":"click","__proto__":{"polluted":true}}')
    hostile.facts = JSON.parse('{"tag":"button","__proto__":{"polluted":true}}')

    const clean = validatePageMessage('recorder:event', hostile) as Record<string, unknown>
    expect(clean).not.toBe(null)
    expect(Object.prototype.hasOwnProperty.call(clean, '__proto__')).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBe(undefined)
    expect((clean.facts as Record<string, unknown>).polluted).toBe(undefined)
  })

  it('drops a field of the wrong type rather than rejecting the whole event', () => {
    const clean = validatePageMessage('recorder:event', {
      type: 'type',
      facts: FACTS,
      value: 'hello',
      secret: 'yes-please' // should be a boolean
    }) as Record<string, unknown>
    expect(clean.value).toBe('hello')
    expect(clean).not.toHaveProperty('secret')
  })

  it('refuses a value long enough to be an attack on memory', () => {
    const clean = validatePageMessage('recorder:event', {
      type: 'type',
      facts: FACTS,
      value: 'x'.repeat(50_000)
    }) as Record<string, unknown>
    expect(clean).not.toHaveProperty('value')
  })
})

describe('the frame chain', () => {
  it('accepts a real one', () => {
    const clean = validatePageMessage('recorder:event', {
      type: 'click',
      facts: FACTS,
      frame: [{ url: 'https://example.com/inner', name: 'checkout' }]
    }) as Record<string, unknown>
    expect(clean.frame).toEqual([{ url: 'https://example.com/inner', name: 'checkout' }])
  })

  it('refuses an absurdly deep one', () => {
    const deep = Array.from({ length: 100 }, () => ({ url: 'https://example.com' }))
    const clean = validatePageMessage('recorder:event', {
      type: 'click',
      facts: FACTS,
      frame: deep
    }) as Record<string, unknown>
    expect(clean).not.toHaveProperty('frame')
  })

  it('refuses a malformed entry', () => {
    const clean = validatePageMessage('recorder:event', {
      type: 'click',
      facts: FACTS,
      frame: [{ name: 'no-url-here' }]
    }) as Record<string, unknown>
    expect(clean).not.toHaveProperty('frame')
  })
})

describe('recorder:dialog payloads', () => {
  it('lets a real confirm through', () => {
    expect(
      validatePageMessage('recorder:dialog', {
        kind: 'confirm',
        message: 'Delete this?',
        accept: true
      })
    ).toEqual({ kind: 'confirm', message: 'Delete this?', accept: true })
  })

  it('refuses a dialog kind that does not exist', () => {
    expect(validatePageMessage('recorder:dialog', { kind: 'beforeunload' })).toBe(null)
    expect(validatePageMessage('recorder:dialog', {})).toBe(null)
  })
})

describe('recorder:picked payloads', () => {
  it('lets a real pick through', () => {
    const clean = validatePageMessage('recorder:picked', {
      facts: FACTS,
      text: 'Pay now',
      checked: false,
      disabled: false
    })
    expect(clean).toMatchObject({ text: 'Pay now', checked: false })
  })

  it('refuses a pick with no element', () => {
    expect(validatePageMessage('recorder:picked', { text: 'Pay now' })).toBe(null)
  })
})

describe('recorder:pick-cancel', () => {
  it('carries no payload, and is allowed to', () => {
    // It must NOT come back null — null means "drop this message".
    expect(validatePageMessage('recorder:pick-cancel', undefined)).toBe(undefined)
    expect(validatePageMessage('recorder:pick-cancel', { anything: 'ignored' })).toBe(undefined)
  })
})

// =====================================================================
// The relay's decision — the gate itself, rather than its parts.
//
// The first test here is the one that matters most to the USER: a genuine
// recording must still get through. A boundary that blocks everything is not
// a fix, it is an outage, and this one fails closed by design — so the
// happy path needs pinning harder than the attacks do.
// =====================================================================
describe('the relay gate', () => {
  const NONCE = 'session-nonce-abc'
  const REAL_MESSAGE = {
    __qaflow: true,
    nonce: NONCE,
    channel: 'recorder:event',
    payload: { type: 'click', facts: FACTS }
  }
  const gate = (over: Record<string, unknown> = {}, nonce: string | null = NONCE) =>
    relayDecision({ sessionNonce: nonce, sameTab: true, data: { ...REAL_MESSAGE, ...over } })

  it('LETS A REAL RECORDED CLICK THROUGH', () => {
    const out = gate()
    expect(out, 'a genuine recorder event was dropped — recording is broken').not.toBe(null)
    expect(out!.channel).toBe('recorder:event')
    expect(out!.payload).toMatchObject({ type: 'click', facts: { tag: 'button' } })
  })

  it('lets every legitimate channel through', () => {
    expect(gate({ channel: 'recorder:dialog', payload: { kind: 'alert', message: 'hi' } })).not.toBe(
      null
    )
    expect(gate({ channel: 'recorder:picked', payload: { facts: FACTS } })).not.toBe(null)
    expect(gate({ channel: 'recorder:pick-cancel', payload: undefined })).not.toBe(null)
  })

  it('drops everything when no session is armed', () => {
    // The state the app is in whenever the user is just browsing.
    expect(gate({}, null)).toBe(null)
    expect(gate({}, '')).toBe(null)
  })

  it('drops a message carrying the wrong nonce, or none', () => {
    expect(gate({ nonce: 'guessed' })).toBe(null)
    expect(gate({ nonce: undefined })).toBe(null)
    expect(gate({ nonce: null })).toBe(null)
  })

  it('drops a nonce from a PREVIOUS session', () => {
    // Main re-rolls per recording, so a value a page scraped off an earlier
    // recording is dead by the time it could be replayed.
    expect(relayDecision({ sessionNonce: 'new-nonce', sameTab: true, data: REAL_MESSAGE })).toBe(
      null
    )
  })

  it('drops a message from another tab or an opener', () => {
    expect(relayDecision({ sessionNonce: NONCE, sameTab: false, data: REAL_MESSAGE })).toBe(null)
  })

  it('drops untagged traffic, so ordinary page postMessage is ignored', () => {
    // Plenty of real sites postMessage to their top frame constantly.
    expect(gate({ __qaflow: undefined })).toBe(null)
    expect(gate({ __qaflow: 'true' })).toBe(null)
    expect(relayDecision({ sessionNonce: NONCE, sameTab: true, data: 'hello' })).toBe(null)
    expect(relayDecision({ sessionNonce: NONCE, sameTab: true, data: null })).toBe(null)
  })

  it('drops the forged step from the audit', () => {
    // The audit posted a __qaflow-tagged recorder:event and the app added a
    // step for an element that never existed. With no nonce to present, the
    // same message now goes nowhere.
    const forged = {
      __qaflow: true,
      channel: 'recorder:event',
      payload: { type: 'click', facts: { tag: 'button', text: 'Forged by page' } }
    }
    expect(relayDecision({ sessionNonce: NONCE, sameTab: true, data: forged })).toBe(null)
  })

  it('refuses to carry an upload even WITH a valid nonce', () => {
    // The escalation path, closed at the channel level rather than by the
    // nonce — so it stays closed even against a page that scraped one.
    expect(
      gate({ channel: 'recorder:upload', payload: { facts: FACTS, paths: ['/etc/passwd'] } })
    ).toBe(null)
  })

  it('refuses any other IPC channel even WITH a valid nonce', () => {
    for (const channel of ['recorder:recovery', 'recorder:toggle', 'library:save']) {
      expect(gate({ channel, payload: {} }), channel).toBe(null)
    }
  })

  it('forwards a rebuilt payload, never the object the page sent', () => {
    const payload = { type: 'click', facts: FACTS, secretRef: 'stolen' }
    const out = gate({ payload })
    expect(out!.payload).not.toBe(payload)
    expect(out!.payload).not.toHaveProperty('secretRef')
  })
})

describe('element facts', () => {
  it('keeps the fields the selector engine needs', () => {
    const clean = validateElementFacts({
      tag: 'input',
      testId: 'username',
      testIdAttr: 'data-test',
      id: 'user',
      name: 'username',
      role: 'textbox',
      placeholder: 'Username',
      dup: { testId: { count: 3, index: 1 } },
      anchor: { css: '#form', count: 2, index: 0 }
    })
    expect(clean).toMatchObject({
      tag: 'input',
      testId: 'username',
      testIdAttr: 'data-test',
      dup: { testId: { count: 3, index: 1 } },
      anchor: { css: '#form', count: 2, index: 0 }
    })
  })

  it("keeps the control's label text — the step is named from it", () => {
    // Dropped here once: the observer captured "Sports" and the gate threw it
    // away, so the step fell back to the id and read "hobbies checkbox 1".
    const clean = validateElementFacts({ tag: 'input', id: 'hobbies-checkbox-1', labelText: 'Sports' })
    expect(clean).toHaveProperty('labelText', 'Sports')
  })

  it('refuses a made-up testIdAttr', () => {
    // It reaches the exporter as a Playwright config value, so only the two
    // real attribute names may pass.
    const clean = validateElementFacts({ tag: 'input', testIdAttr: 'data-evil' })
    expect(clean).not.toHaveProperty('testIdAttr')
  })

  it('drops malformed dup and anchor rather than trusting them', () => {
    // These feed the replay resolver's indexing — a string where a number
    // belongs would surface much later, as a mystery replay failure.
    const clean = validateElementFacts({
      tag: 'button',
      dup: { testId: { count: 'three', index: 1 } },
      anchor: { css: '#form', count: 2 }
    })
    expect(clean).not.toHaveProperty('dup')
    expect(clean).not.toHaveProperty('anchor')
  })

  it('refuses facts with no tag', () => {
    expect(validateElementFacts({ id: 'pay' })).toBe(undefined)
    expect(validateElementFacts(null)).toBe(undefined)
  })
})
