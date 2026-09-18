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
  payload: { type?: string; facts?: ElementFacts; value?: string; secret?: boolean }
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

  test('installs only once even if created repeatedly for the same document', async ({ page }) => {
    // Duplicate listeners would record every click twice.
    await record(page, '<button id="b">Go</button>')
    await page.evaluate(`window.__qaCreate(window, document, { send: window.__qaSend, recording: true })`)
    await page.evaluate(`window.__qaCreate(window, document, { send: window.__qaSend, recording: true })`)
    await page.click('#b')
    expect(await steps(page)).toHaveLength(1)
  })

  test('records nothing at all when recording is off, and resumes when switched on', async ({ page }) => {
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
    await page.evaluate(`window.__qaCreate(window, document, { send: window.__qaSend, recording: true })`)
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
