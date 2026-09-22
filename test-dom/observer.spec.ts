import { test, expect, type Page } from '@playwright/test'
import { createObserver, dialogShimProgram } from '../src/main/observerSource'
import { buildSelectors, labelFrom, type ElementFacts } from '../src/main/selector'
import { buildActionScript, type ReplayCandidate } from '../src/main/replay'
// QF-002: the gate main applies to every recorder message.
import { validatePageMessage } from '../src/shared/recorderMessages'

// =====================================================================
// THE OBSERVER — what actually watches the page while you record.
//
// In the app it runs in each frame's ISOLATED world, inside the recorder
// preload, and sends with ipcRenderer. Here it is stringified and run in a
// plain page with a fake `send`, because like the replay engine it can only
// be judged by running it in a real DOM. (The isolated-world plumbing itself
// — preload in every frame, adoption of script-written iframes, sandboxing —
// is exercised end to end by tools/e2e-smoke.mjs against the built app.)
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
  payload: {
    type?: string
    facts?: ElementFacts
    value?: string
    secret?: boolean
    // Phase 4: a scroll says WHAT it scrolled to; a drag says which gesture it
    // was, where the hand gripped, and what it was dropped on.
    scrollKind?: string
    // Phase 4: the page grew during this scroll, so it loaded something.
    loadedMore?: boolean
    scrollDir?: string
    dragKind?: string
    dragFrom?: string
    targetFacts?: ElementFacts
  }
}

/** The observer factory, defined ONCE per page (so its per-document guard is
 *  shared by every call, as in the preload), plus an event log. */
async function installFactory(page: Page): Promise<void> {
  await page.evaluate(`
    window.__qaflowEvents = []
    window.__qaCreate = (${createObserver.toString()})
    window.__qaSend = (channel, payload) => window.__qaflowEvents.push({ channel, payload })
  `)
}

/** Install the observer, armed for recording, collecting what it sends. */
async function record(page: Page, html: string, recording = true): Promise<void> {
  await page.setContent(html)
  await installFactory(page)
  await page.evaluate(
    `window.__qaObserver = window.__qaCreate(window, document, { send: window.__qaSend, recording: ${recording} })`
  )
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
    // With the keyboard, as a user would. Playwright's selectOption() sets the
    // value by SCRIPT and dispatches an untrusted change — which the observer
    // now rightly ignores (QF-002; see the forgery tests below).
    await page.focus('#s')
    await page.keyboard.press('ArrowDown')
    const sel = (await steps(page)).find((s) => s.type === 'select')
    expect(sel?.value).toBe('Two')
  })

  // === QF-002: only REAL input becomes a step ========================
  // The tested page can call button.click() or dispatch events itself. Those
  // arrive with isTrusted === false, and must never be recorded — before this
  // rule, a page could forge a step with one line of script, no nonce needed.
  test('a click the PAGE performs is not recorded', async ({ page }) => {
    await record(page, '<button id="b">Buy</button>')
    await page.evaluate(() => {
      document.getElementById('b')!.click()
      document.getElementById('b')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(await steps(page, 0)).toHaveLength(0)
    // …while a real one still is.
    await page.click('#b')
    expect((await steps(page)).map((s) => s.type)).toEqual(['click'])
  })

  test('a change or Enter the PAGE dispatches is not recorded', async ({ page }) => {
    await record(page, '<form><input id="q"></form>')
    await page.evaluate(() => {
      const q = document.getElementById('q') as HTMLInputElement
      q.value = 'forged'
      q.dispatchEvent(new Event('change', { bubbles: true }))
      q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await page.waitForTimeout(300)
    expect(await steps(page, 0)).toHaveLength(0)
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
    // Keyboard, not selectOption() — see "records a select by its chosen option".
    await page.focus('#c')
    await page.keyboard.press('ArrowDown')
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
    await record(
      page,
      '<label><input id="email"><span>Email</span></label><button id="b">Go</button>'
    )
    await page.fill('#email', 'qa@example.com')
    await page.click('#b')
    const typed = (await steps(page)).find((s) => s.type === 'type')
    expect(typed?.value).toBe('qa@example.com')
  })

  test('sees a click inside an open shadow root', async ({ page }) => {
    await record(page, '<div id="host"></div>')
    await page.evaluate(
      "const r = document.getElementById('host').attachShadow({ mode: 'open' });" +
        'r.innerHTML = \'<button id="deep" data-test="deep-btn">Deep</button>\';'
    )
    await page.locator('#host').locator('#deep').click()
    const [step] = await steps(page)
    expect(step?.type).toBe('click')
    expect(step?.facts?.testId).toBe('deep-btn')
  })

  test('installs only once even if created repeatedly for the same document', async ({ page }) => {
    // Duplicate listeners would record every click twice.
    await record(page, '<button id="b">Go</button>')
    await page.evaluate(
      `window.__qaCreate(window, document, { send: window.__qaSend, recording: true })`
    )
    await page.evaluate(
      `window.__qaCreate(window, document, { send: window.__qaSend, recording: true })`
    )
    await page.click('#b')
    expect(await steps(page)).toHaveLength(1)
  })

  test('records nothing at all when recording is off, and resumes when switched on', async ({
    page
  }) => {
    await record(page, '<button id="b">Go</button>', false)
    await page.click('#b')
    await page.waitForTimeout(200)
    expect(await steps(page, 0)).toHaveLength(0)
    await page.evaluate('window.__qaObserver.setActive(true)')
    await page.click('#b')
    expect(await steps(page)).toHaveLength(1)
  })
})

// =====================================================================
// QF-002 — the observer and main's gate, in a real browser.
//
// There is no nonce any more: in the app the observer runs in an isolated
// world and sends with ipcRenderer, which the page cannot reach. What these
// pin down is the half that still lives in the DOM — that a genuine recording
// gets through main's gate intact, that the observer leaves nothing on the
// page's window, and that the one page-world piece (the dialog shim) talks to
// it correctly.
// =====================================================================
test.describe('the observer and the gate', () => {
  const sent = async (page: Page, atLeast = 1): Promise<Recorded[]> => events(page, atLeast)

  test('a real recorded click passes main’s gate', async ({ page }) => {
    await record(page, '<button id="pay" data-test="pay-now">Pay now</button>')
    await page.click('#pay')
    const [msg] = await sent(page)
    const clean = validatePageMessage(msg.channel, msg.payload)
    expect(clean, 'a genuine recording was blocked by its own security fix').not.toBe(null)
    expect(clean).toMatchObject({ type: 'click', facts: { testId: 'pay-now', id: 'pay' } })
  })

  // The gate keeps only fields it knows. So a NEW fact the observer starts
  // capturing is silently thrown away until the gate is taught it too — which is
  // exactly how "Sports" got lost (labelText passed every observer test, and
  // never reached the app). Compare the WHOLE facts object, not chosen fields.
  test('the gate passes through every fact the observer captured', async ({ page }) => {
    await record(
      page,
      `<form id="f"><input id="hobbies-checkbox-1" type="checkbox">
       <label for="hobbies-checkbox-1">Sports</label>
       <input type="checkbox"><input type="checkbox"></form>`
    )
    await page.click('label')
    await page.click('#f input:not([id]) >> nth=1')
    const msgs = await sent(page, 2)
    expect(msgs.length).toBeGreaterThanOrEqual(2)
    for (const m of msgs) {
      const clean = validatePageMessage(m.channel, m.payload) as { facts: ElementFacts }
      expect(clean.facts, 'the gate dropped a fact the observer sent').toEqual(m.payload.facts)
    }
  })

  test('the observer puts nothing on the page’s window', async ({ page }) => {
    // The old page-world observer hung its API and its nonce off window.__qaflow*.
    await page.setContent('<button id="b">Go</button>')
    await installFactory(page)
    const before = (await page.evaluate('Object.keys(window)')) as string[]
    await page.evaluate(
      `window.__qaCreate(window, document, { send: window.__qaSend, recording: true })`
    )
    const after = (await page.evaluate('Object.keys(window)')) as string[]
    expect(after.filter((k) => !before.includes(k))).toEqual([])
  })

  test('a dialog reaches the observer through the page-world shim — only while recording', async ({
    page
  }) => {
    page.on('dialog', (d) => d.accept())
    await record(page, '<p>dialogs</p>', false)
    await page.evaluate(`(${dialogShimProgram.toString()})()`)
    await page.evaluate("alert('not recording')")
    await page.waitForTimeout(200)
    expect((await events(page, 0)).filter((e) => e.channel === 'recorder:dialog')).toHaveLength(0)

    await page.evaluate('window.__qaObserver.setActive(true)')
    await page.evaluate("alert('hello')")
    const dialogs = (await events(page, 1)).filter((e) => e.channel === 'recorder:dialog')
    expect(dialogs.map((d) => d.payload)).toEqual([{ kind: 'alert', message: 'hello' }])
    expect(validatePageMessage('recorder:dialog', dialogs[0].payload)).not.toBe(null)
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
  async function roundTrip(
    page: Page,
    html: string,
    clickSelector: string,
    nth = 0
  ): Promise<{
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

// =====================================================================
// PHASE 4 — the gestures the recorder used to miss entirely.
//
// Scrolling and dragging are the two the QA audit called out, and they are
// the two that cannot be judged any other way than by performing them in a
// real browser: both are defined by sequences of real input events, and a
// unit test would only be asserting that a mock was called.
//
// Scroll carries a rule none of the other listeners need. `isTrusted` is the
// gate everywhere else — the browser sets it, page script cannot — but a
// scroll event is dispatched by the browser whether a human turned the wheel
// or the page called scrollTo(), so it arrives trusted either way and says
// nothing about who scrolled. The gate is the GESTURE that preceded it, and
// the test below that proves a page-initiated scroll is ignored is the one
// that matters: without it, every smooth-scroll animation and banner reveal
// on the site under test would land in the user's recording as a step.
// =====================================================================

/** A page tall enough to scroll, with an identifiable anchor part-way down. */
const TALL = `
  <div style="height:1500px">top</div>
  <h2 id="reviews">Reviews</h2>
  <div style="height:1500px">bottom</div>`

test.describe('scrolling', () => {
  test('records a scroll the USER made', async ({ page }) => {
    await record(page, TALL)
    await page.mouse.wheel(0, 900)
    const [step] = await steps(page)
    expect(step.type).toBe('scroll')
    // Either an anchor element or a pixel offset is acceptable here — what
    // must not happen is nothing at all.
    expect(['element', 'position', 'bottom']).toContain(step.scrollKind)
  })

  test('IGNORES a scroll the PAGE made', async ({ page }) => {
    // The whole reason the gesture gate exists. A page that scrolls itself —
    // a carousel, a "skip to content" link, scroll restoration — must not be
    // able to write steps into a recording just by moving its own viewport.
    await record(page, TALL)
    await page.evaluate('window.scrollTo(0, 1200)')
    await page.waitForTimeout(700) // longer than the observer's settle timer
    expect(await steps(page, 0)).toEqual([])
  })

  test('collapses one long gesture into ONE step, at the resting place', async ({ page }) => {
    // A single flick of the wheel fires dozens of scroll events. A step per
    // event would bury the real actions in the step list — and what a test
    // cares about is where the reader CAME TO REST.
    await record(page, TALL)
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 150)
    await page.waitForTimeout(700)
    const scrolls = (await steps(page, 1)).filter((s) => s.type === 'scroll')
    expect(scrolls).toHaveLength(1)
  })

  test('names the bottom of the page as the bottom, not as a pixel count', async ({ page }) => {
    // "Scroll to 2847px" is a different place on a phone. "The bottom" is the
    // same place everywhere, and it is what the infinite-scroll case means.
    await record(page, TALL)
    await page.mouse.wheel(0, 5000)
    await page.waitForTimeout(700)
    const scrolls = (await steps(page, 1)).filter((s) => s.type === 'scroll')
    expect(scrolls[scrolls.length - 1].scrollKind).toBe('bottom')
  })
})

test.describe('dragging', () => {
  const BOARD = `
    <div id="card" draggable="true" style="width:80px;height:40px">Card</div>
    <div id="zone" style="width:120px;height:80px;margin-top:40px">Drop here</div>
    <script>
      document.getElementById('zone').addEventListener('dragover', (e) => e.preventDefault())
    </script>`

  test('records an HTML5 drag, with BOTH ends of it', async ({ page }) => {
    await record(page, BOARD)
    await page.dragAndDrop('#card', '#zone')
    const [step] = await steps(page)
    expect(step.type).toBe('drag')
    expect(step.dragKind).toBe('html5')
    expect(step.facts?.id).toBe('card')
    // The drop target becomes a second selector ladder — without it the step
    // knows what was picked up and not where it was put.
    expect(step.targetFacts?.id).toBe('zone')
  })

  test('records a pointer drag, and where the hand gripped', async ({ page }) => {
    // A slider fires no dragstart at all, which is why it needs its own path.
    // dragFrom is what makes it faithful: a knob at its minimum sits at the
    // LEFT edge, and replaying from the element's centre would move the value
    // before the drag began.
    await record(
      page,
      '<input id="vol" type="range" min="0" max="100" value="0" style="width:200px">'
    )
    const box = (await page.locator('#vol').boundingBox())!
    await page.mouse.move(box.x + 4, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    const drags = (await steps(page, 1)).filter((s) => s.type === 'drag')
    expect(drags).toHaveLength(1)
    expect(drags[0].dragKind).toBe('mouse')
    // Gripped near the left edge, so the x fraction is small — not 0.5.
    const fx = parseFloat((drags[0].dragFrom ?? '').split(',')[0])
    expect(fx).toBeLessThan(0.2)
  })

  test('a drag does not ALSO record the click it ends with', async ({ page }) => {
    // Releasing the mouse fires a click. That click is part of the drag, not a
    // separate action — recording both would make every drag replay twice.
    await record(page, '<div id="knob" style="width:200px;height:40px">knob</div>')
    const box = (await page.locator('#knob').boundingBox())!
    await page.mouse.move(box.x + 10, box.y + 20)
    await page.mouse.down()
    await page.mouse.move(box.x + 150, box.y + 20, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(200)
    const all = await steps(page, 1)
    expect(all.filter((s) => s.type === 'click')).toEqual([])
    expect(all.filter((s) => s.type === 'drag')).toHaveLength(1)
  })

  test('dragging a slider records the drag ONLY, not a value change too', async ({ page }) => {
    // Round 4, and it is QF-001's shape all over again. Dragging a form
    // control changes its value, the browser fires `change`, and the change
    // listener recorded a SECOND step — so a slider came out as a drag plus
    // `Type "3.5" into input`.
    //
    // That second step is not merely redundant. Playwright refuses .fill() on
    // an input[type=range] ("Malformed value"), so the exported spec died on a
    // line the in-app replay was perfectly happy with: green here, red in CI.
    await record(
      page,
      '<input id="vol" type="range" min="0" max="5" value="0" style="width:300px">'
    )
    const box = (await page.locator('#vol').boundingBox())!
    await page.mouse.move(box.x + 4, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + 200, box.y + box.height / 2, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(900)

    const all = await steps(page, 1)
    // The value really did change — so the change event really did fire, and
    // this test is exercising the suppression rather than a page that never
    // triggered it.
    expect(await page.inputValue('#vol')).not.toBe('0')
    expect(all.filter((s) => s.type === 'drag')).toHaveLength(1)
    expect(
      all.filter((s) => s.type === 'type'),
      JSON.stringify(all)
    ).toEqual([])
    expect(all.filter((s) => s.type === 'click')).toEqual([])
  })

  test('typing into an ordinary field is untouched by that suppression', async ({ page }) => {
    // The suppression is scoped to the dragged element and a short window. A
    // normal edit elsewhere must still record, or fixing the slider would have
    // quietly broken every form test.
    await record(page, '<input id="name" type="text"><input id="vol" type="range">')
    await page.fill('#name', 'Priya')
    await page.click('body')
    await page.waitForTimeout(400)
    const typed = (await steps(page, 1)).filter((s) => s.type === 'type')
    expect(typed).toHaveLength(1)
    expect(typed[0].value).toBe('Priya')
  })

  test('a small wobble is still a CLICK, not a drag', async ({ page }) => {
    // Hands shake. Below the distance threshold this has to stay an ordinary
    // click, or every click on the site becomes a one-pixel drag step.
    await record(page, '<button id="pay">Pay now</button>')
    const box = (await page.locator('#pay').boundingBox())!
    await page.mouse.move(box.x + 10, box.y + 10)
    await page.mouse.down()
    await page.mouse.move(box.x + 13, box.y + 11)
    await page.mouse.up()
    const all = await steps(page, 1)
    expect(all.filter((s) => s.type === 'drag')).toEqual([])
    expect(all.filter((s) => s.type === 'click')).toHaveLength(1)
  })
})

// ── The page that broke it (Round 2a) ────────────────────────────────
// the-internet.herokuapp.com/infinite_scroll: every paragraph lives inside ONE
// tall `<div id="content">`. The original anchor search climbed to "the nearest
// thing with an id" and found that container from every scroll position, so
// seventeen steps all read "Scroll to Infinite Scroll" AND all meant "scroll to
// the top of the content" — nowhere near where the user was.
//
// The first fixture for these tests had a distinct `<h2 id="reviews">` sitting
// alone mid-page, which is the friendliest possible shape and hid both bugs.
// This one is modelled on the real page instead.
const TALL_ONE_CONTAINER = `
  <div id="content">
    <h3>Infinite Scroll</h3>
    ${Array.from({ length: 40 }, (_, i) => `<p style="height:120px">Paragraph ${i}</p>`).join('')}
  </div>`

test.describe('scrolling — the shapes that broke it', () => {
  test('a slow scroller still produces ONE step, not one per notch', async ({ page }) => {
    // THE Round 2a bug. The settle timer was 350ms, and a person reading a long
    // page pauses longer than that between wheel notches constantly — so every
    // notch settled and became its own step. The pauses below are deliberately
    // longer than the old timer and shorter than the new one.
    await record(page, TALL_ONE_CONTAINER)
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 200)
      await page.waitForTimeout(400)
    }
    await page.waitForTimeout(1200)
    const scrolls = (await steps(page, 1)).filter((s) => s.type === 'scroll')
    expect(scrolls).toHaveLength(1)
  })

  test('does not name a container taller than the viewport', async ({ page }) => {
    // The other half, and the worse one: "scroll to #content" is not a place.
    // Every step would replay to the top of the container, so the steps were
    // not merely repetitive — they were wrong.
    await record(page, TALL_ONE_CONTAINER)
    await page.mouse.wheel(0, 1500)
    await page.waitForTimeout(1200)
    const scrolls = (await steps(page, 1)).filter((s) => s.type === 'scroll')
    expect(scrolls).toHaveLength(1)
    const step = scrolls[0]
    if (step.scrollKind === 'element') {
      // If it DID pick an element, it must not be the giant container.
      expect(step.facts?.id).not.toBe('content')
    } else {
      // Falling back to the honest pixel offset is the right answer here.
      expect(step.scrollKind).toBe('position')
    }
  })

  test('two gestures with a real pause are two separate EVENTS', async ({ page }) => {
    // "scroll, read, scroll again" is two things the user did, and on an
    // infinite-scroll page it is two page loads — so both have to survive.
    //
    // SCOPE WARNING, learned the hard way. This asserts what the OBSERVER
    // emits. A version of the app then merged adjacent scroll steps one layer
    // up, in the renderer, so the user saw ONE step while this test sat green
    // with a name that claimed otherwise. A test whose name describes
    // end-to-end behaviour while it asserts one layer is worse than no test,
    // because it stops anyone looking. The merge is gone (see the note on the
    // onStep effect in App.tsx); this now says only what it can see.
    await record(page, TALL_ONE_CONTAINER)
    await page.mouse.wheel(0, 600)
    await page.waitForTimeout(1500)
    await page.mouse.wheel(0, 600)
    await page.waitForTimeout(1500)
    const scrolls = (await steps(page, 1)).filter((s) => s.type === 'scroll')
    expect(scrolls.length).toBeGreaterThanOrEqual(2)
  })

  test('still finds a real landmark when the page has one', async ({ page }) => {
    // The fix tightened what counts as an anchor. It must not have tightened so
    // far that a genuine heading is rejected — a selector survives a viewport
    // change and a pixel offset does not, so the element form is still the one
    // we want wherever it is honest.
    await record(
      page,
      `<div style="height:1200px">top</div>
       <h2 id="reviews" style="height:40px">Reviews</h2>
       <div style="height:1200px">bottom</div>`
    )
    await page.mouse.wheel(0, 1150)
    await page.waitForTimeout(1200)
    const scrolls = (await steps(page, 1)).filter((s) => s.type === 'scroll')
    expect(scrolls).toHaveLength(1)
    expect(['element', 'position', 'bottom']).toContain(scrolls[0].scrollKind)
  })
})

test.describe('scrolling — did this scroll LOAD anything', () => {
  // `loadedMore` is what lets the step list tell "reading down a page" from
  // "an infinite-scroll list", which timing cannot (see stepMerge.ts). This
  // section covers only what the OBSERVER can see: that the flag is set when
  // the page grew and absent when it did not. What the app DOES with it is
  // decided in src/renderer/src/stepMerge.ts and tested in test/stepMerge.test.ts
  // — the split is deliberate, and stated because the last time a rule spanned
  // these two layers the test on this side quietly covered neither.

  test('a page that scrolls itself AFTER A CLICK is still ignored', async ({ page }) => {
    // Round 2b Part 2, exactly as it happened: click a product, the new page
    // jumps to the top, and "Scroll to the top of the page" appeared in the
    // recording. The cause was pointerdown marking a gesture for 1200ms — and
    // a click IS a pointerdown, so every click opened a window in which the
    // page's own scrolling counted as the user's.
    //
    // Navigation-after-a-click is the most common way a page scrolls itself,
    // so this single case covered most of what the rule exists to reject.
    await record(
      page,
      `<button id="go">Open</button>
       <div style="height:3000px">filler</div>
       <script>
         document.getElementById('go').addEventListener('click', () => {
           window.scrollTo(0, 0)
         })
       </script>`
    )
    // Get somewhere down the page first, the way a user would be.
    await page.mouse.wheel(0, 1500)
    await page.waitForTimeout(1200)
    const before = (await steps(page, 1)).filter((s) => s.type === 'scroll').length
    expect(before).toBeGreaterThanOrEqual(1)

    // Now CLICK, and let the page send itself back to the top.
    await page.click('#go')
    await page.waitForTimeout(1500)

    const after = (await steps(page, 1)).filter((s) => s.type === 'scroll').length
    expect(after, 'the page scrolled itself after a click — that is not a step').toBe(before)
  })

  test('a scrollbar drag IS still recorded', async ({ page }) => {
    // The other side of the same fix. pointerdown was in the gesture list to
    // catch dragging the scrollbar; narrowing it to "while the button is held"
    // has to keep that working, or fixing the click case would have silently
    // dropped a real gesture.
    await record(page, TALL_ONE_CONTAINER)
    const box = page.viewportSize()!
    // Press on the scrollbar track at the right edge and drag downwards.
    await page.mouse.move(box.width - 4, 100)
    await page.mouse.down()
    await page.mouse.move(box.width - 4, 400, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(1200)
    const scrolls = (await steps(page, 0)).filter((s) => s.type === 'scroll')
    // Scrollbar geometry differs by platform, so this asserts the CAPABILITY
    // rather than an exact count: if the drag moved the page at all, it was
    // recorded.
    const movedAtAll = await page.evaluate(() => window.scrollY > 0)
    if (movedAtAll) expect(scrolls.length).toBeGreaterThanOrEqual(1)
  })

  test('anchors on an IDENTIFIED element, not the nearest thing with text', async ({ page }) => {
    // Round 2c, from a real SauceDemo export: the recorded anchor came out as
    // getByText('$49.99Add to cart') — a scroll step anchored to a PRICE,
    // which breaks the moment the price changes. The item name carrying
    // data-test="inventory-item-name" was one level up the whole time.
    //
    // The geometry here is deliberate and load-bearing. The first version of
    // this test put the item near the top of a filler block, mid-viewport
    // landed on plain filler, and the test passed against the BROKEN code too
    // — a fixture that does not reproduce the bug is worth nothing. The price
    // bar is made tall enough that the viewport midpoint lands inside it, so
    // the climb really does start at an unidentified text node.
    await record(
      page,
      `<div style="height:1000px">top</div>
       <div class="inventory_item">
         <div data-test="inventory-item-name" style="height:60px">Sauce Labs Fleece Jacket</div>
         <div class="pricebar" style="height:600px">$49.99<button>Add to cart</button></div>
       </div>
       <div style="height:1200px">bottom</div>`
    )
    await page.mouse.wheel(0, 1000)
    await page.waitForTimeout(1200)

    // Prove the fixture puts an UNIDENTIFIED element under the midpoint —
    // otherwise this test would pass for the wrong reason.
    const midTag = await page.evaluate(() => {
      const el = document.elementFromPoint(
        Math.round(window.innerWidth / 2),
        Math.round(window.innerHeight / 2)
      )
      return el ? el.className || el.tagName : 'none'
    })
    expect(midTag, 'fixture must land on the unidentified price bar').toContain('pricebar')

    const scrolls = (await steps(page, 1)).filter((s) => s.type === 'scroll')
    expect(scrolls).toHaveLength(1)
    const step = scrolls[0]
    expect(step.scrollKind).toBe('element')
    const f = step.facts ?? {}
    // It must have climbed PAST the price bar to the identified item name.
    expect(String(f.testId ?? ''), `anchored on ${JSON.stringify(f)}`).toBe('inventory-item-name')
    expect(String(f.text ?? '')).not.toContain('$49.99')
  })

  test('skips a landmark whose text is only a number', async ({ page }) => {
    // SauceDemo gives its PRICES a data-test as well, so price and item name
    // sit in the same tier and the price won by being nearer the cursor —
    // "Scroll to $15.99". The selector was stable; the step read like nonsense.
    //
    // The PRICE COMES FIRST here, and is the element under the midpoint. That
    // ordering is the whole test: with the name first, the search would reach
    // it anyway and this would pass against the broken code — which is exactly
    // what the first version of this fixture did.
    await record(
      page,
      `<div style="height:1000px">top</div>
       <div class="item">
         <div data-test="item-price" style="height:600px">$49.99</div>
         <div data-test="item-name" style="height:60px">Fleece Jacket</div>
       </div>
       <div style="height:1200px">bottom</div>`
    )
    await page.mouse.wheel(0, 1000)
    await page.waitForTimeout(1200)

    // Prove the fixture puts the PRICE under the midpoint, or this test is
    // asserting nothing.
    const midTest = await page.evaluate(() => {
      const el = document.elementFromPoint(
        Math.round(window.innerWidth / 2),
        Math.round(window.innerHeight / 2)
      )
      return el ? el.getAttribute('data-test') : null
    })
    expect(midTest, 'fixture must land on the price').toBe('item-price')

    const scrolls = (await steps(page, 1)).filter((s) => s.type === 'scroll')
    expect(scrolls).toHaveLength(1)
    const f = scrolls[0].facts ?? {}
    expect(String(f.testId ?? ''), `anchored on ${JSON.stringify(f)}`).toBe('item-name')
  })

  test('records WHICH WAY each scroll went', async ({ page }) => {
    // A reversal is a new action, not a continuation — scrolling down and back
    // up must not collapse into one step. The observer supplies the direction;
    // the decision itself lives in src/renderer/src/stepMerge.ts and is tested
    // in test/stepMerge.test.ts.
    await record(page, TALL_ONE_CONTAINER)
    await page.mouse.wheel(0, 1200)
    await page.waitForTimeout(1200)
    await page.mouse.wheel(0, -1200)
    await page.waitForTimeout(1200)
    const scrolls = (await steps(page, 1)).filter((s) => s.type === 'scroll')
    expect(scrolls.length).toBeGreaterThanOrEqual(2)
    expect(scrolls[0].scrollDir).toBe('down')
    expect(scrolls[scrolls.length - 1].scrollDir).toBe('up')
  })

  test('a static page never claims it loaded anything', async ({ page }) => {
    await record(page, TALL_ONE_CONTAINER)
    await page.mouse.wheel(0, 500)
    await page.waitForTimeout(1200)
    await page.mouse.wheel(0, 500)
    await page.waitForTimeout(1200)
    const scrolls = (await steps(page, 1)).filter((s) => s.type === 'scroll')
    expect(scrolls.length).toBeGreaterThanOrEqual(1)
    for (const s of scrolls) expect(s.loadedMore).toBeFalsy()
  })

  test('an infinite-scroll page flags the scroll that fetched more', async ({ page }) => {
    // The content load is driven EXPLICITLY here rather than by an in-page
    // scroll handler. The first version of this test used a handler and it
    // never fired — the page never grew, so the test passed its length check
    // and proved nothing about the flag it was named after. Appending the
    // content directly is what a fetch completing actually looks like, and it
    // happens when the test says it does.
    await record(page, '<div id="feed"><p style="height:1400px">page 1</p></div>')
    await page.mouse.wheel(0, 2000)
    await page.waitForTimeout(1200)

    // The next page arrives.
    await page.evaluate(() => {
      const p = document.createElement('p')
      p.style.height = '1400px'
      p.textContent = 'page 2'
      document.getElementById('feed')!.appendChild(p)
    })

    await page.mouse.wheel(0, 2000)
    await page.waitForTimeout(1200)

    const scrolls = (await steps(page, 1)).filter((s) => s.type === 'scroll')
    expect(scrolls.length).toBeGreaterThanOrEqual(2)
    // The scroll AFTER the page grew has to say so, or the merge rule
    // downstream collapses a genuine sequence of loads into one step.
    expect(scrolls.some((s) => s.loadedMore === true)).toBe(true)
  })
})
