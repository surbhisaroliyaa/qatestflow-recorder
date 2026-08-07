import { test, expect, type Page } from '@playwright/test'
import { observerProgram } from '../src/main/observerSource'
import { buildSelectors, type ElementFacts } from '../src/main/selector'
import { buildActionScript, type ReplayCandidate } from '../src/main/replay'

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
