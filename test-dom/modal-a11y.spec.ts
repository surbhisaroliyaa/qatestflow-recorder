import { test, expect, type Page } from '@playwright/test'
import { trapFocus } from '../src/renderer/src/modalA11y'

// =====================================================================
// QF-004 — modal focus containment, driven by a real keyboard.
//
// The audit found these by TABBING through the running app, and they can only
// be verified the same way: focus, Tab order and visibility are browser
// behaviour, not logic. So the trap is injected into a real page and driven
// with real key presses, like the observer tests next door.
//
// The page below mirrors the markup every modal in the app renders —
// `.modal-backdrop > .modal`, a `.modal-title`, an optional `.modal-close` —
// plus the browser-chrome buttons that sit BEHIND it, because "Tab reached
// Back / Forward / Reload through the dialog" was the actual finding.
// =====================================================================

const PAGE = `
  <button id="opener">Open dialog</button>
  <div class="browser-chrome">
    <button id="back">Back</button>
    <button id="forward">Forward</button>
    <button id="reload">Reload</button>
  </div>
  <div id="host"></div>
`

const DIALOG = `
  <div class="modal-backdrop">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">Export test</span>
        <button class="modal-close" aria-label="Close">×</button>
      </div>
      <input id="name" />
      <button id="save">Save</button>
    </div>
  </div>
`

/** Open the dialog and switch the trap on, exactly as App.tsx does. */
async function openDialog(page: Page, html = DIALOG): Promise<void> {
  await page.evaluate((markup) => {
    document.getElementById('host')!.innerHTML = markup
  }, html)
  await page.evaluate(`window.__release = (${trapFocus.toString()})()`)
}

/** What currently has focus, as `#id` or `.class` — never a bare tag name.
 *  An earlier version of this helper fell back to `tagName`, which turned
 *  "focus is on the close button" into the string "BUTTON" and made a passing
 *  behaviour look like a failure. A test helper that blurs distinctions is a
 *  test helper that lies. */
const activeId = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el || el === document.body) return 'BODY'
    if (el.id) return el.id
    if (el.className) return `.${String(el.className).split(' ')[0]}`
    return el.tagName
  })

test.beforeEach(async ({ page }) => {
  await page.setContent(PAGE)
})

test.describe('opening a dialog', () => {
  test('moves focus INTO the dialog instead of leaving it on BODY', async ({ page }) => {
    // The audit's finding, verbatim: "Opening a modal left focus on BODY."
    await page.focus('#opener')
    await openDialog(page)
    expect(await activeId(page)).toBe('name')
  })

  test('falls back to the dialog itself when it holds nothing focusable', async ({ page }) => {
    await openDialog(
      page,
      `<div class="modal-backdrop"><div class="modal"><p>Working…</p></div></div>`
    )
    expect(await page.evaluate(() => document.activeElement?.className)).toContain('modal')
  })

  test('announces itself as a dialog, named by its own title', async ({ page }) => {
    await openDialog(page)
    const modal = page.locator('.modal')
    await expect(modal).toHaveAttribute('role', 'dialog')
    await expect(modal).toHaveAttribute('aria-modal', 'true')

    // The name a screen reader reads out — "Export test dialog", not "dialog".
    const labelledBy = await modal.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    await expect(page.locator(`#${labelledBy}`)).toHaveText('Export test')
  })
})

test.describe('Tab containment', () => {
  test('does NOT reach the browser chrome behind the dialog', async ({ page }) => {
    // The finding: "Tab moved to Back/Forward/Reload behind the modal."
    await page.focus('#opener')
    await openDialog(page)

    // Go round the dialog several times. If containment leaks even once, one of
    // these lands on a control that is visually covered.
    const seen: string[] = []
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab')
      seen.push(await activeId(page))
    }

    expect(seen).not.toContain('back')
    expect(seen).not.toContain('forward')
    expect(seen).not.toContain('reload')
    expect(seen).not.toContain('opener')
    // …and it did keep moving between the dialog's own controls.
    expect(new Set(seen).size).toBeGreaterThan(1)
  })

  test('wraps from the last control back to the first', async ({ page }) => {
    await openDialog(page)
    await page.evaluate(() => document.getElementById('save')!.focus())
    await page.keyboard.press('Tab')
    // Past the last control is the close button — first in DOM order. Initial
    // focus deliberately SKIPS it; the Tab cycle deliberately includes it.
    expect(await activeId(page)).toBe('.modal-close')
  })

  test('Shift+Tab wraps from the first control back to the last', async ({ page }) => {
    await openDialog(page)
    await page.evaluate(() => document.querySelector<HTMLElement>('.modal-close')!.focus())
    await page.keyboard.press('Shift+Tab')
    expect(await activeId(page)).toBe('save')
  })

  test('pulls focus back if it somehow lands outside', async ({ page }) => {
    await openDialog(page)
    await page.evaluate(() => document.getElementById('back')!.focus())
    await page.keyboard.press('Tab')
    // Wherever it lands, it must be back inside the dialog — that is the whole
    // property, and asserting a specific control would be over-specifying it.
    expect(
      await page.evaluate(
        () => !!document.querySelector('.modal')?.contains(document.activeElement)
      )
    ).toBe(true)
  })

  test('skips a disabled control rather than stalling on it', async ({ page }) => {
    await openDialog(
      page,
      `<div class="modal-backdrop"><div class="modal">
         <button id="first">First</button>
         <button id="nope" disabled>Disabled</button>
         <button id="last">Last</button>
       </div></div>`
    )
    expect(await activeId(page)).toBe('first')
    await page.evaluate(() => document.getElementById('last')!.focus())
    await page.keyboard.press('Tab')
    expect(await activeId(page)).toBe('first')
  })
})

test.describe('Escape', () => {
  test('closes a dialog that has a close button', async ({ page }) => {
    await openDialog(page)
    await page.evaluate(() => {
      document.querySelector('.modal-close')!.addEventListener('click', () => {
        document.getElementById('host')!.innerHTML = ''
      })
    })
    await page.keyboard.press('Escape')
    await expect(page.locator('.modal-backdrop')).toHaveCount(0)
  })

  test('leaves a blocking dialog alone when it has no close button', async ({ page }) => {
    // The environment warning and the recovery prompt have no close button
    // because every option has consequences. Dismissing one on a stray keypress
    // would be worse than not handling Escape at all.
    await openDialog(
      page,
      `<div class="modal-backdrop"><div class="modal">
         <span class="modal-title">Run against production?</span>
         <button id="cancel">Cancel</button>
         <button id="run">Run anyway</button>
       </div></div>`
    )
    await page.keyboard.press('Escape')
    await expect(page.locator('.modal-backdrop')).toHaveCount(1)
  })
})

test.describe('closing a dialog', () => {
  test('gives focus back to whatever opened it', async ({ page }) => {
    // Without this you are dumped at the top of the document and have to tab
    // all the way back to where you were.
    await page.focus('#opener')
    await openDialog(page)
    expect(await activeId(page)).toBe('name')

    await page.evaluate(() => {
      document.getElementById('host')!.innerHTML = ''
      ;(window as unknown as { __release: () => void }).__release()
    })
    expect(await activeId(page)).toBe('opener')
  })

  test('stops trapping Tab once released', async ({ page }) => {
    await page.focus('#opener')
    await openDialog(page)
    await page.evaluate(() => {
      document.getElementById('host')!.innerHTML = ''
      ;(window as unknown as { __release: () => void }).__release()
    })

    // Back to ordinary page navigation — the chrome is reachable again.
    await page.keyboard.press('Tab')
    expect(await activeId(page)).toBe('back')
  })
})
