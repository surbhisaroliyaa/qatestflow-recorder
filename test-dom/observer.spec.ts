import { test, expect, type Page } from '@playwright/test'
import { observerProgram } from '../src/main/observerSource'
import { buildSelectors, labelFrom, type ElementFacts } from '../src/main/selector'
import { buildActionScript, type ReplayCandidate } from '../src/main/replay'
// QF-002: the real gate, so a real recorded event can be run through it.
import { relayDecision } from '../src/shared/recorderMessages'

// =====================================================================
// THE OBSERVER — what actually watches the page while you record.
//
// It is stringified and injected into every frame, so like the replay
// engine it can only be judged by running it in a real DOM.
//
// The last section is the one that matters most in this whole repo: a
// full ROUND TRIP. Click a real element, let the observer record it, run
// the recorded facts through the selector engine, then let the REPLAY
// engine find the element again — and assert it landed on the same one.
// Record and replay are two separate implementations of "which element
// is this", and every MIRROR WARNING in the source exists because they
// can drift apart.
// =====================================================================

interface Recorded {
  channel: string
  payload: { type?: string; facts?: ElementFacts; value?: string; secret?: boolean }
}

/** Install the observer, armed for recording, collecting what it posts. */
async function record(page: Page, html: string): Promise<void> {
  await page.setContent(html)
  await page.evaluate(`
    window.__qaflowEvents = []
    window.addEventListener('message', (e) => {
      if (e.data && e.data.__qaflow) window.__qaflowEvents.push({ channel: e.data.channel, payload: e.data.payload })
    })
    window.__qaflowInitActive = true
    ;(${observerProgram.toString()})()
  `)
}

// postMessage delivery is ASYNCHRONOUS: the observer posts, and the listener
// runs on a later task. Reading straight after a click is a race — and it fails
// intermittently in a way that looks like "this element shape isn't recorded",
// which is a very convincing lie about the app.
async function events(page: Page, atLeast = 1): Promise<Recorded[]> {
  if (atLeast > 0) {
    await page
      .waitForFunction(
        (n) => (window as unknown as { __qaflowEvents: unknown[] }).__qaflowEvents.length >= n,
        atLeast,
        { timeout: 4000 }
      )
      .catch(() => {
        /* fall through and let the assertion report what WAS captured */
      })
  }
  return (await page.evaluate('window.__qaflowEvents')) as Recorded[]
}

const steps = async (page: Page, atLeast = 1): Promise<Recorded['payload'][]> =>
  (await events(page, atLeast)).filter((e) => e.channel === 'recorder:event').map((e) => e.payload)

test.describe('what the observer notices', () => {
  test('records a click, with facts that identify the element', async ({ page }) => {
    await record(page, '<button id="pay" data-test="pay-now">Pay now</button>')
    await page.click('#pay')
    const [step] = await steps(page)
    expect(step.type).toBe('click')
    expect(step.facts?.testId).toBe('pay-now')
    expect(step.facts?.id).toBe('pay')
    expect(step.facts?.text).toBe('Pay now')
  })

  test('records typing only once the field is left', async ({ page }) => {
    // It listens for `change`, not every keystroke — otherwise one word becomes
    // twenty steps.
    await record(page, '<input id="email"><button id="next">Next</button>')
    await page.fill('#email', 'qa@example.com')
    expect(await steps(page, 0)).toHaveLength(0)
    await page.click('#next')
    const typed = (await steps(page)).find((s) => s.type === 'type')
    expect(typed?.value).toBe('qa@example.com')
  })

  test('marks a password field secret, so the value never reaches the file', async ({ page }) => {
    await record(page, '<input id="p" type="password"><button id="b">Go</button>')
    await page.fill('#p', 'hunter2')
    await page.click('#b')
    const typed = (await steps(page)).find((s) => s.type === 'type')
    expect(typed?.secret).toBe(true)
  })

  test('does NOT record a bogus value for a file input', async ({ page }) => {
    // The browser reports "C:\\fakepath\\…" for security. Recording that would
    // produce a step that can never replay.
    await record(page, '<input id="f" type="file">')
    await page.setInputFiles('#f', {
      name: 'a.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('x')
    })
    await page.waitForTimeout(300)
    expect((await steps(page, 0)).some((s) => s.type === 'type')).toBe(false)
  })

  test('records a select by its chosen option', async ({ page }) => {
    await record(page, '<select id="s"><option>One</option><option>Two</option></select>')
    await page.selectOption('#s', 'Two')
    const sel = (await steps(page)).find((s) => s.type === 'select')
    expect(sel?.value).toBe('Two')
  })

  // === QF-001: the checkbox contract =================================
  // Ticking a box used to record TWO steps — a click, and a type whose value
  // was the HTML default "on". The export then emitted .fill('on'), which
  // Playwright refuses, so a green in-app run produced a red CI test. These
  // tests exist to keep that specific double-record from coming back.

  test('records a ticked checkbox as ONE check step carrying the state', async ({ page }) => {
    await record(page, '<input id="terms" type="checkbox" data-test="terms">')
    await page.check('#terms')
    const captured = await steps(page)
    expect(captured).toHaveLength(1)
    expect(captured[0].type).toBe('check')
    expect(captured[0].value).toBe('true')
    // The regression itself: no click step, and above all no type step whose
    // value is the meaningless "on".
    expect(captured.some((s) => s.type === 'click' || s.type === 'type')).toBe(false)
  })

  test('records unticking as a check step with value false', async ({ page }) => {
    await record(page, '<input id="terms" type="checkbox" checked>')
    await page.uncheck('#terms')
    const captured = await steps(page)
    expect(captured).toHaveLength(1)
    expect(captured[0].value).toBe('false')
  })

  test('records a radio choice once, as a check step', async ({ page }) => {
    await record(
      page,
      `<input id="basic" type="radio" name="plan" value="basic">
       <input id="pro" type="radio" name="plan" value="pro">`
    )
    await page.check('#pro')
    const captured = await steps(page)
    expect(captured).toHaveLength(1)
    expect(captured[0].type).toBe('check')
    expect(captured[0].value).toBe('true')
    expect(captured[0].facts?.id).toBe('pro')
  })

  test('a LABEL click records one check step, not a click plus a check', async ({ page }) => {
    // Clicking the label toggles the control, so the click listener would
    // otherwise sneak the duplicate straight back in by another door.
    await record(page, '<input id="terms" type="checkbox"><label for="terms">I agree</label>')
    await page.click('label')
    const captured = await steps(page)
    expect(captured).toHaveLength(1)
    expect(captured[0].type).toBe('check')
  })

  test('a click on text INSIDE a wrapping label still records one check step', async ({ page }) => {
    await record(page, '<label><input id="terms" type="checkbox"><span>I agree</span></label>')
    await page.click('span')
    const captured = await steps(page)
    expect(captured).toHaveLength(1)
    expect(captured[0].type).toBe('check')
    expect(captured[0].value).toBe('true')
  })

  // === What the recorded step is CALLED ===============================
  // The step list, the export comments and the Page Object field names all come
  // from these facts, via labelFrom(). Real page shapes from the hand-test.

  test("a box is named after its <label for>, not its id (demoqa's Hobbies)", async ({ page }) => {
    await record(
      page,
      '<input id="hobbies-checkbox-1" type="checkbox"><label for="hobbies-checkbox-1">Sports</label>'
    )
    await page.click('label')
    const [step] = await steps(page)
    expect(step.facts?.labelText).toBe('Sports')
    expect(labelFrom(step.facts!)).toBe('Sports')
  })

  test('a wrapping label names its control, without the text of the options inside it', async ({
    page
  }) => {
    await record(
      page,
      '<label>Country <select id="c"><option>India</option><option>Peru</option></select></label>'
    )
    await page.selectOption('#c', 'Peru')
    const sel = (await steps(page)).find((s) => s.type === 'select')
    expect(sel?.facts?.labelText).toBe('Country')
  })

  test('two unnamed boxes are numbered by page position, not click order (the-internet)', async ({
    page
  }) => {
    await record(
      page,
      `<form id="checkboxes"><input type="checkbox"> checkbox 1<br>
       <input type="checkbox" checked> checkbox 2</form>`
    )
    // Box 2 FIRST — the order that used to swap the names.
    await page.uncheck('#checkboxes input >> nth=1')
    await page.check('#checkboxes input >> nth=0')
    const [first, second] = await steps(page, 2)
    expect(labelFrom(first.facts!)).toBe('checkbox 2')
    expect(labelFrom(second.facts!)).toBe('checkbox 1')
  })

  test('the keyboard Space toggle is recorded the same way', async ({ page }) => {
    await record(page, '<input id="terms" type="checkbox">')
    await page.focus('#terms')
    await page.keyboard.press(' ')
    const captured = await steps(page)
    expect(captured.some((s) => s.type === 'check' && s.value === 'true')).toBe(true)
  })

  test('a checkbox whose click is cancelled records nothing', async ({ page }) => {
    // The box never moved, so there is no state change to record. Recording a
    // tick here would produce a step that can never replay.
    await record(
      page,
      `<input id="terms" type="checkbox">
       <script>document.getElementById('terms').addEventListener('click', (e) => e.preventDefault())</script>`
    )
    await page.click('#terms')
    await page.waitForTimeout(300)
    expect(await steps(page, 0)).toHaveLength(0)
  })

  test('a non-checkable input is untouched by the checkbox rule', async ({ page }) => {
    // Guard against the fix over-reaching into normal text entry.
    await record(page, '<label><input id="email"><span>Email</span></label><button id="b">Go</button>')
    await page.fill('#email', 'qa@example.com')
    await page.click('#b')
    const typed = (await steps(page)).find((s) => s.type === 'type')
    expect(typed?.value).toBe('qa@example.com')
  })

  test('sees a click inside an open shadow root', async ({ page }) => {
    await record(page, '<div id="host"></div>')
    await page.evaluate(
      "const r = document.getElementById('host').attachShadow({ mode: 'open' });" +
        "r.innerHTML = '<button id=\"deep\" data-test=\"deep-btn\">Deep</button>';"
    )
    await page.locator('#host').locator('#deep').click()
    const [step] = await steps(page)
    expect(step?.type).toBe('click')
    expect(step?.facts?.testId).toBe('deep-btn')
  })

  test('installs only once even if injected repeatedly', async ({ page }) => {
    // main injects on every load event, and several fire per page. Duplicate
    // listeners would record every click twice.
    await record(page, '<button id="b">Go</button>')
    await page.evaluate(`(${observerProgram.toString()})()`)
    await page.evaluate(`(${observerProgram.toString()})()`)
    await page.click('#b')
    expect(await steps(page)).toHaveLength(1)
  })

  test('records nothing at all when recording is off', async ({ page }) => {
    await page.setContent('<button id="b">Go</button>')
    await page.evaluate(`
      window.__qaflowEvents = []
      window.addEventListener('message', (e) => { if (e.data && e.data.__qaflow) window.__qaflowEvents.push(e.data) })
      window.__qaflowInitActive = false
      ;(${observerProgram.toString()})()
    `)
    await page.click('#b')
    await page.waitForTimeout(300)
    expect(await steps(page, 0)).toHaveLength(0)
  })
})

// =====================================================================
// QF-002 — the nonce, in a real browser.
//
// The unit tests prove the arming RULE. These prove the other half: that the
// observer actually stamps the nonce onto what it posts, and that the value
// is not left lying on `window` for a page script to read. Both only exist
// once the program has really run in a document.
// =====================================================================
test.describe('the recorder nonce', () => {
  /** Install the observer the way main does, with a nonce baked in. */
  async function recordWithNonce(page: Page, html: string, nonce: string): Promise<void> {
    await page.setContent(html)
    await page.evaluate(`
      window.__qaflowEvents = []
      window.addEventListener('message', (e) => {
        if (e.data && e.data.__qaflow) window.__qaflowEvents.push(e.data)
      })
      window.__qaflowInitActive = true
      window.__qaflowNonce = ${JSON.stringify(nonce)}
      ;(${observerProgram.toString()})()
    `)
  }

  const raw = async (page: Page, atLeast = 1): Promise<{ nonce?: string; channel?: string }[]> => {
    await events(page, atLeast)
    return (await page.evaluate('window.__qaflowEvents')) as { nonce?: string; channel?: string }[]
  }

  test('stamps the session nonce onto every message it posts', async ({ page }) => {
    await recordWithNonce(page, '<button id="pay">Pay</button>', 'session-abc')
    await page.click('#pay')
    const posted = await raw(page)
    expect(posted[0].nonce).toBe('session-abc')
  })

  test('removes the nonce from window, so page script cannot read it off the global', async ({
    page
  }) => {
    // Main writes it to `window` and the observer takes it on its first
    // statement, inside the same executeJavaScript call — no page code gets a
    // turn in between. What must NOT happen is it being left there afterwards.
    await recordWithNonce(page, '<button id="pay">Pay</button>', 'session-abc')
    expect(await page.evaluate('window.__qaflowNonce')).toBeUndefined()
    expect(await page.evaluate('"__qaflowNonce" in window')).toBe(false)
  })

  test('re-injection re-arms with the NEW session nonce', async ({ page }) => {
    // Recording a second time rotates the nonce. Main re-injects, and the
    // already-installed observer takes the early-return path — which must still
    // pick up the new value or the second recording captures nothing.
    await recordWithNonce(page, '<button id="pay">Pay</button>', 'session-1')
    await page.click('#pay')
    // WAIT for that first message to actually arrive before clearing the log.
    // postMessage delivery is asynchronous, so clearing straight after the
    // click lets the session-1 message land AFTER the reset, where it poses as
    // the first message of session 2 — and the test then reports a nonce
    // rotation failure that isn't happening. (Same race the helper at the top
    // of this file exists to avoid.)
    await events(page, 1)

    await page.evaluate(`
      window.__qaflowEvents = []
      window.__qaflowInitActive = true
      window.__qaflowNonce = 'session-2'
      ;(${observerProgram.toString()})()
    `)
    await page.click('#pay')

    const posted = await raw(page)
    expect(posted[0].nonce, 'the observer kept posting the old session nonce').toBe('session-2')
    expect(await page.evaluate('window.__qaflowNonce')).toBeUndefined()
  })

  test('an un-armed observer posts an empty nonce, which the relay refuses', async ({ page }) => {
    await page.setContent('<button id="pay">Pay</button>')
    await page.evaluate(`
      window.__qaflowEvents = []
      window.addEventListener('message', (e) => {
        if (e.data && e.data.__qaflow) window.__qaflowEvents.push(e.data)
      })
      window.__qaflowInitActive = true
      ;(${observerProgram.toString()})()
    `)
    await page.click('#pay')
    const posted = await raw(page)
    expect(posted[0].nonce).toBe('')
    expect(relayDecision({ sessionNonce: 'live-session', sameTab: true, data: posted[0] })).toBe(
      null
    )
  })

  // ── the round trip ────────────────────────────────────────────────
  // A real click, captured by the real observer in a real browser, run
  // through the real gate. This is the closest these tests get to the
  // product: only Electron's IPC delivery is left out.
  test('a real recorded click passes the real gate', async ({ page }) => {
    await recordWithNonce(page, '<button id="pay" data-test="pay-now">Pay now</button>', 'live')
    await page.click('#pay')
    const [posted] = await raw(page)

    const decision = relayDecision({ sessionNonce: 'live', sameTab: true, data: posted })
    expect(decision, 'a genuine recording was blocked by its own security fix').not.toBe(null)
    expect(decision!.channel).toBe('recorder:event')
    expect(decision!.payload).toMatchObject({
      type: 'click',
      facts: { testId: 'pay-now', id: 'pay' }
    })
  })

  // The gate keeps only fields it knows. So a NEW fact the observer starts
  // capturing is silently thrown away until the gate is taught it too — which is
  // exactly how "Sports" got lost (labelText passed every observer test, and
  // never reached the app). Compare the WHOLE facts object, not chosen fields.
  test('the gate passes through every fact the observer captured', async ({ page }) => {
    await recordWithNonce(
      page,
      `<form id="f"><input id="hobbies-checkbox-1" type="checkbox">
       <label for="hobbies-checkbox-1">Sports</label>
       <input type="checkbox"><input type="checkbox"></form>`,
      'live'
    )
    await page.click('label')
    await page.click('#f input:not([id]) >> nth=1')
    const posted = await raw(page, 2)
    expect(posted.length).toBeGreaterThanOrEqual(2)
    for (const data of posted) {
      const sent = (data as { payload: { facts: ElementFacts } }).payload.facts
      const decision = relayDecision({ sessionNonce: 'live', sameTab: true, data })
      expect(decision!.payload.facts, 'the gate dropped a fact the observer sent').toEqual(sent)
    }
  })

  test('a step forged by page script does NOT pass the real gate', async ({ page }) => {
    // The audit's attack, verbatim, in a real document.
    await recordWithNonce(page, '<button id="pay">Pay</button>', 'live')
    await page.evaluate(`
      window.top.postMessage({
        __qaflow: true,
        channel: 'recorder:event',
        payload: { type: 'click', facts: { tag: 'button', text: 'Forged by page' } }
      }, '*')
    `)
    const posted = await raw(page)
    const forged = posted.find(
      (m) =>
        (m as { payload?: { facts?: { text?: string } } }).payload?.facts?.text === 'Forged by page'
    )
    expect(forged, 'the forged message should still have been POSTED — the page can do that').toBeTruthy()
    // …it just must not survive the gate.
    expect(relayDecision({ sessionNonce: 'live', sameTab: true, data: forged })).toBe(null)
  })

  test('a forged step cannot get in by guessing the nonce field', async ({ page }) => {
    await recordWithNonce(page, '<button id="pay">Pay</button>', 'live')
    await page.evaluate(`
      window.top.postMessage({
        __qaflow: true,
        nonce: 'guess',
        channel: 'recorder:event',
        payload: { type: 'click', facts: { tag: 'button', text: 'Guessed' } }
      }, '*')
    `)
    const posted = await raw(page)
    const forged = posted.find(
      (m) => (m as { payload?: { facts?: { text?: string } } }).payload?.facts?.text === 'Guessed'
    )
    expect(relayDecision({ sessionNonce: 'live', sameTab: true, data: forged })).toBe(null)
  })
})

test.describe('telling identical elements apart', () => {
  test('counts duplicates and records WHICH one was clicked', async ({ page }) => {
    // Three identical "Add" buttons: the facts have to say it was the second,
    // or replay picks the first and the test silently does the wrong thing.
    await record(
      page,
      `<button class="add">Add</button>
       <button class="add">Add</button>
       <button class="add">Add</button>`
    )
    await page.locator('.add').nth(1).click()
    const [step] = await steps(page)
    const dup = step.facts?.dup
    expect(dup, 'duplicate info was recorded').toBeTruthy()
    const anyDup = Object.values(dup ?? {})[0] as { count: number; index: number }
    expect(anyDup.count).toBeGreaterThan(1)
    expect(anyDup.index).toBe(1)
  })

  test('records no duplicate info when the element is unique', async ({ page }) => {
    // Absence means "unique" — the happy path stays small.
    await record(page, '<button id="only">Only</button>')
    await page.click('#only')
    const [step] = await steps(page)
    const dup = step.facts?.dup ?? {}
    for (const v of Object.values(dup)) expect((v as { count: number }).count).toBe(1)
  })
})

// =====================================================================
// § the round trip
// Record → build a selector → replay finds it again. Record and replay
// are separate implementations of "which element is this"; if they walk
// the DOM differently, a recorded .nth(i) lands on the WRONG element and
// the test passes while doing something else entirely.
// =====================================================================
test.describe('what was recorded is what replay finds', () => {
  /** Click a real element, then replay the recorded step and report where it landed. */
  async function roundTrip(page: Page, html: string, clickSelector: string, nth = 0): Promise<{
    recordedOn: string
    replayedOn: string
  }> {
    await record(page, html)
    // Every candidate element announces itself when clicked, so we can tell
    // exactly which one each phase hit.
    await page.evaluate(`
      window.__hits = []
      document.querySelectorAll('[data-who]').forEach((el) => {
        el.addEventListener('click', () => window.__hits.push(el.getAttribute('data-who')))
      })
    `)
    await page.locator(clickSelector).nth(nth).click()
    const recordedOn = ((await page.evaluate('window.__hits')) as string[])[0]

    const [step] = await steps(page)
    expect(step?.facts, 'the observer recorded facts').toBeTruthy()
    const { candidates } = buildSelectors(step.facts as ElementFacts)

    await page.evaluate('window.__hits = []')
    const result = (await page.evaluate(
      buildActionScript({ type: 'click', candidates: candidates as ReplayCandidate[] })
    )) as { ok: boolean; error?: string }
    expect(result.ok, result.error).toBe(true)
    const replayedOn = ((await page.evaluate('window.__hits')) as string[])[0]
    return { recordedOn, replayedOn }
  }

  test('a unique element', async ({ page }) => {
    const r = await roundTrip(
      page,
      '<button data-who="a" data-test="pay">Pay</button>',
      '[data-who="a"]'
    )
    expect(r.replayedOn).toBe(r.recordedOn)
  })

  test('the SECOND of three identical buttons', async ({ page }) => {
    // The case the MIRROR WARNINGs exist for. Capture-time duplicate counting
    // and replay-time finding must walk the DOM in the same order.
    const r = await roundTrip(
      page,
      `<button class="add" data-who="first">Add</button>
       <button class="add" data-who="second">Add</button>
       <button class="add" data-who="third">Add</button>`,
      '.add',
      1
    )
    expect(r.recordedOn).toBe('second')
    expect(r.replayedOn).toBe('second')
  })

  test('an element identified only by its visible text', async ({ page }) => {
    const r = await roundTrip(
      page,
      '<div><a href="#" data-who="link">Continue shopping</a></div>',
      '[data-who="link"]'
    )
    expect(r.replayedOn).toBe(r.recordedOn)
  })

  test('an element identified by role + accessible name', async ({ page }) => {
    const r = await roundTrip(
      page,
      '<button data-who="icon" aria-label="Close dialog"><svg></svg></button>',
      '[data-who="icon"]'
    )
    expect(r.replayedOn).toBe(r.recordedOn)
  })

  test('an element inside an open shadow root', async ({ page }) => {
    await record(page, '<div id="host"></div>')
    await page.evaluate(`
      window.__hits = []
      const r = document.getElementById('host').attachShadow({ mode: 'open' })
      r.innerHTML = '<button data-who="shadow" data-test="deep">Deep</button>'
      r.querySelector('button').addEventListener('click', () => window.__hits.push('shadow'))
    `)
    await page.locator('#host').locator('[data-who="shadow"]').click()
    const [step] = await steps(page)
    const { candidates } = buildSelectors(step.facts as ElementFacts)
    await page.evaluate('window.__hits = []')
    const result = (await page.evaluate(
      buildActionScript({ type: 'click', candidates: candidates as ReplayCandidate[] })
    )) as { ok: boolean; error?: string }
    expect(result.ok, result.error).toBe(true)
    expect((await page.evaluate('window.__hits')) as string[]).toEqual(['shadow'])
  })
})
