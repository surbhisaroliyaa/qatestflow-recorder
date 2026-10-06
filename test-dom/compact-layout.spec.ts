import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'

// =====================================================================
// NOTHING CLIPPED AT THE SMALLEST WINDOW  (audit QF-007)
// =====================================================================
// At 800×600 the toolbar used to run off the right edge and Coverage / Net /
// Mock were simply unreachable. The fix was a minimum window of 1024×680 and a
// toolbar that stays in view (first by wrapping, now by a one-line tool row
// with a "More ⋯" menu for what does not fit) — but the audit asked for a
// test, because a fix nobody measures regresses the day someone adds one
// more button.
//
// This loads the BUILT renderer (run `npx electron-vite build` first) the same
// way app-shell-a11y.spec.ts does, shrinks the viewport to the minimum, and
// measures: no sideways scroll, every visible control fully on screen (and not
// cut off by a clipping parent), and no two toolbar controls on top of each
// other. It runs in three pane states, because the step pane is the thing that
// competes with the toolbar and page for width: default, dragged to its
// widest, and collapsed to the rail.
//
// Two sizes: 1024×680 is the window minimum as set in main, but that is the
// OUTER window — on Windows the frame and title bar eat ~16 px of width and
// ~40 px of height, so 1008×640 is roughly what the page really gets.
// =====================================================================

const RENDERER = join(process.cwd(), 'out', 'renderer')
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
}

// The same "answer everything with nothing" bridge as app-shell-a11y.spec.ts —
// see the comments there. What is measured is the app's markup and CSS.
const BRIDGE_STUB = `(() => {
  const empty = () => new Proxy([], {
    get(t, prop) {
      if (prop in t || typeof prop === 'symbol') {
        const v = t[prop]
        return typeof v === 'function' ? v.bind(t) : v
      }
      return empty()
    }
  })
  const make = () => {
    const fn = function () { return make() }
    return new Proxy(fn, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve(empty()).then(res, rej)
        if (prop === 'catch') return (rej) => Promise.resolve(empty()).catch(rej)
        if (prop === 'finally') return (f) => Promise.resolve(empty()).finally(f)
        if (prop === Symbol.toPrimitive) return () => ''
        return make()
      },
      apply() { return make() }
    })
  }
  // Except one call is RECORDED: browser.setOverlay, which hides the native
  // page. The "More ⋯" menu drops down over the page area, so the tests check
  // that opening it hides the page and closing it brings the page back.
  window.__overlayCalls = []
  const api = make()
  const realBrowser = api.browser
  const browser = new Proxy(realBrowser, {
    get(_t, prop) {
      if (prop === 'setOverlay') {
        return (open) => { window.__overlayCalls.push(!!open); return Promise.resolve() }
      }
      return realBrowser[prop]
    }
  })
  // And the start-up password migration reports "nothing moved" — the generic
  // stub answers with a truthy object, which opens the F40 report dialog over
  // the toolbar and blocks every click these tests make on it.
  const realX = api.xbrowser
  const xbrowser = new Proxy(realX, {
    get(_t, prop) {
      return prop === 'migrateSecrets' ? () => Promise.resolve({}) : realX[prop]
    }
  })
  window.api = new Proxy(api, {
    get(_t, prop) {
      return prop === 'browser' ? browser : prop === 'xbrowser' ? xbrowser : api[prop]
    }
  })
  window.electron = make()
})()`

let server: Server
let base = ''

test.beforeAll(async () => {
  if (!existsSync(join(RENDERER, 'index.html'))) {
    throw new Error('out/renderer is missing — run `npx electron-vite build` first.')
  }
  server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(
      /^([/\\])+/,
      ''
    )
    const file = join(RENDERER, rel || 'index.html')
    if (!file.startsWith(RENDERER) || !existsSync(file)) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  base = `http://127.0.0.1:${addr.port}/`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

type PaneState = 'default' | 'widest' | 'collapsed'

async function openApp(page: Page, pane: PaneState): Promise<void> {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.addInitScript(BRIDGE_STUB)
  // The pane reads its width / collapsed state from localStorage on first
  // render. 99999 is clamped by the app to the widest it allows at this size —
  // which is exactly the case under test.
  const seed =
    pane === 'widest'
      ? `localStorage.setItem('qaflow.paneWidth','99999');localStorage.setItem('qaflow.paneCollapsed','0')`
      : pane === 'collapsed'
        ? `localStorage.setItem('qaflow.paneCollapsed','1')`
        : `localStorage.removeItem('qaflow.paneWidth');localStorage.removeItem('qaflow.paneCollapsed')`
  await page.addInitScript(`try{${seed}}catch{}`)
  await page.goto(base)
  await page.waitForSelector('#root > *', { timeout: 15_000 }).catch(() => {
    throw new Error(`the app did not render:\n${errors.join('\n') || '(no error reported)'}`)
  })
}

async function toWorkspace(page: Page): Promise<void> {
  const url = page.locator('.welcome-form input').first()
  await url.fill('https://example.com')
  await url.press('Enter')
  await page.waitForSelector('.workspace', { timeout: 10_000 })
  // Let the pane's resize effects and the toolbar's wrap settle.
  await page.waitForTimeout(200)
}

interface Problem {
  what: string
  detail: string
}

/**
 * Everything wrong with the layout right now, one line per offending control,
 * so a failure names what to fix instead of just "false".
 *
 * `scope` = the controls to measure; `overlapScope` = the controls that must
 * not sit on top of each other (the toolbar — a list or a form can legitimately
 * stack a label inside a row).
 */
async function layoutProblems(page: Page, scope: string, overlapScope: string): Promise<Problem[]> {
  return page.evaluate(
    ({ scope, overlapScope }) => {
      const out: { what: string; detail: string }[] = []
      const vw = document.documentElement.clientWidth
      const name = (el: Element): string => {
        const label =
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          (el as HTMLElement).innerText?.trim().slice(0, 30) ||
          (el as HTMLInputElement).placeholder ||
          ''
        return `<${el.tagName.toLowerCase()}${el.className ? ` .${String(el.className).split(' ').join('.')}` : ''}> "${label}"`
      }
      const visible = (el: Element): boolean => {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) return false
        const cs = getComputedStyle(el)
        return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0
      }

      // (a) no sideways scroll, for the page or the body.
      const se = document.scrollingElement ?? document.documentElement
      if (se.scrollWidth > se.clientWidth + 1) {
        out.push({
          what: 'horizontal overflow',
          detail: `document is ${se.scrollWidth}px wide in a ${se.clientWidth}px viewport`
        })
      }

      const controls = Array.from(
        document.querySelectorAll(
          `${scope} :is(button, input, select, textarea, a[href], [role="button"], [role="separator"])`
        )
      ).filter(visible)

      for (const el of controls) {
        const r = el.getBoundingClientRect()
        // (b) inside the viewport horizontally…
        if (r.left < -0.5 || r.right > vw + 0.5) {
          out.push({
            what: 'off screen',
            detail: `${name(el)} spans x ${Math.round(r.left)}–${Math.round(r.right)} (viewport ${vw})`
          })
          continue
        }
        // …and not cut off by a parent that clips (overflow hidden/auto). A
        // SCROLLING parent may hide it vertically — you can scroll to it — so
        // only a horizontal cut counts, plus a vertical one by a parent that
        // cannot scroll (that control is unreachable).
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const cs = getComputedStyle(p)
          const pr = p.getBoundingClientRect()
          const clipsX = cs.overflowX !== 'visible'
          const clipsY = cs.overflowY === 'hidden' || cs.overflowY === 'clip'
          if (clipsX && (r.left < pr.left - 0.5 || r.right > pr.right + 0.5)) {
            out.push({
              what: 'clipped',
              detail: `${name(el)} is cut off horizontally by ${name(p)}`
            })
            break
          }
          if (clipsY && (r.top < pr.top - 0.5 || r.bottom > pr.bottom + 0.5)) {
            out.push({
              what: 'clipped',
              detail: `${name(el)} is cut off vertically by ${name(p)} (which cannot scroll)`
            })
            break
          }
        }
      }

      // (c) no two toolbar controls on top of each other. Nested controls (an
      // input inside a label-button) are one control, so skip ancestor pairs.
      const bar = Array.from(
        document.querySelectorAll(
          `${overlapScope} :is(button, input, select, a[href], [role="button"])`
        )
      ).filter(visible)
      for (let i = 0; i < bar.length; i++) {
        for (let j = i + 1; j < bar.length; j++) {
          const a = bar[i]
          const b = bar[j]
          if (a.contains(b) || b.contains(a)) continue
          const ra = a.getBoundingClientRect()
          const rb = b.getBoundingClientRect()
          const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
          const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
          // > 1px each way: sub-pixel rounding at a shared edge is not overlap.
          if (w > 1 && h > 1) {
            out.push({ what: 'overlap', detail: `${name(a)} overlaps ${name(b)}` })
          }
        }
      }
      return out
    },
    { scope, overlapScope }
  )
}

// =====================================================================
// THE "MORE ⋯" MENU  (QF-007, second half)
// =====================================================================
// The tool row used to wrap, which cost the page ~40 px of height per extra
// line. It now stays ONE line and whatever does not fit moves, rightmost
// first, into a "More ⋯" menu. These helpers prove three things at any size:
// the row really is one line, the order is kept (visible = a prefix, menu =
// the rest), and every tool is reachable — in the row or in the menu, with the
// same enabled/disabled state it would have as a button.
// =====================================================================

/** Every tool in the row, in display order (the `id`s in App.tsx). */
const ALL_TOOLS = [
  'check',
  'ai-step',
  'draft',
  'snapshot',
  'bug-check',
  'a11y',
  'perf',
  'coverage',
  'net',
  'mock'
]

interface RowState {
  shown: string[]
  hasMore: boolean
  tops: number[]
  rowHeight: number
  buttonHeight: number
}

async function toolRow(page: Page): Promise<RowState> {
  return page.evaluate(() => {
    const row = document.querySelector('.chrome-row.tools')
    if (!row) throw new Error('no tools row')
    const shownEls = Array.from(row.querySelectorAll(':scope > .tool-group [data-tool]'))
    const more = row.querySelector(':scope > .tool-more > .tool-more-btn')
    const all = [...shownEls, ...(more ? [more] : [])]
    return {
      shown: shownEls.map((b) => b.getAttribute('data-tool') ?? '?'),
      hasMore: !!more,
      tops: all.map((b) => b.getBoundingClientRect().top),
      rowHeight: row.getBoundingClientRect().height,
      buttonHeight: Math.max(...all.map((b) => b.getBoundingClientRect().height))
    }
  })
}

/** Is the tool `id` disabled as a BUTTON? (Read off the measuring copy, which
 *  always holds every tool with its live state — the real button of an
 *  overflowed tool isn't rendered.) */
async function buttonDisabled(page: Page, id: string): Promise<boolean> {
  return page
    .locator(`.tools-measure [data-tool="${id}"]`)
    .evaluate((b) => (b as HTMLButtonElement).disabled)
}

async function overlayCalls(page: Page): Promise<boolean[]> {
  return page.evaluate(() => (window as unknown as { __overlayCalls: boolean[] }).__overlayCalls)
}

/**
 * The row is one line, in order, and every tool is reachable. Opens the menu
 * (if there is one), checks its items, and closes it again.
 */
async function expectAllToolsReachable(page: Page): Promise<RowState> {
  const st = await toolRow(page)
  // ONE line: every control starts at the same height, and the row is no
  // taller than a single button.
  expect(Math.max(...st.tops) - Math.min(...st.tops)).toBeLessThanOrEqual(1)
  expect(st.rowHeight).toBeLessThanOrEqual(st.buttonHeight + 1)
  // Order kept: what is shown is the LEFT part of the list.
  expect(st.shown).toEqual(ALL_TOOLS.slice(0, st.shown.length))
  // A More button exactly when something is missing from the row.
  expect(st.hasMore).toBe(st.shown.length < ALL_TOOLS.length)
  if (!st.hasMore) return st

  const more = page.getByRole('button', { name: 'More ⋯' })
  await expect(more).toHaveAttribute('aria-haspopup', 'menu')
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await more.click()
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  const menu = page.getByRole('menu', { name: 'More tools' })
  await expect(menu).toBeVisible()
  // Opening the menu hid the native page (it would paint over the menu).
  await expect.poll(async () => (await overlayCalls(page)).at(-1)).toBe(true)

  const inMenu = await menu
    .locator('[data-menuitem]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-menuitem') ?? '?'))
  // The menu holds exactly the rest, in the same order.
  expect([...st.shown, ...inMenu]).toEqual(ALL_TOOLS)
  for (const id of inMenu) {
    const item = menu.locator(`[data-menuitem="${id}"]`)
    const disabled = await buttonDisabled(page, id)
    // Same disabled state as the button it stands in for.
    expect((await item.getAttribute('aria-disabled')) === 'true', `${id} disabled`).toBe(disabled)
  }
  // The menu itself is fully on screen.
  expect(await layoutProblems(page, '.tool-more-menu', '.tool-more-menu')).toEqual([])

  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect.poll(async () => (await overlayCalls(page)).at(-1)).toBe(false)
  return st
}

const SIZES = [
  { width: 1024, height: 680, label: '1024×680 (window minimum)' },
  { width: 1008, height: 640, label: '1008×640 (its content area on Windows)' }
]
const PANES: PaneState[] = ['default', 'widest', 'collapsed']

for (const size of SIZES) {
  test.describe(`compact layout at ${size.label}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, bypassCSP: true })

    test('the welcome screen fits — nothing clipped, nothing sideways', async ({ page }) => {
      await openApp(page, 'default')
      await expect(page.locator('h1')).toContainText('QATestFlow Recorder')
      expect(await layoutProblems(page, 'body', '.welcome-form')).toEqual([])
    })

    for (const pane of PANES) {
      test(`the workspace fits with the step pane ${pane}`, async ({ page }) => {
        await openApp(page, pane)
        await toWorkspace(page)
        const collapsed = await page.locator('.pane-rail').isVisible()
        expect(collapsed).toBe(pane === 'collapsed')
        if (pane === 'widest') {
          // Prove the seed took: the pane really is at its widest, not default.
          const w = await page
            .locator('.steps-panel')
            .evaluate((e) => e.getBoundingClientRect().width)
          expect(w).toBeGreaterThan(340)
        }
        // Guard against a vacuous pass: if the toolbar selector ever stops
        // matching, "no problems found" would mean "nothing was measured".
        expect(await page.locator('.chrome button:visible').count()).toBeGreaterThan(10)
        expect(await layoutProblems(page, 'body', '.chrome')).toEqual([])
        // Wherever the toolbar ends, the page area must start below it, or the
        // native browser view (placed over .browser-area) would cover a row.
        const chromeBottom = await page
          .locator('.chrome')
          .evaluate((e) => e.getBoundingClientRect().bottom)
        const areaTop = await page
          .locator('.browser-area')
          .evaluate((e) => e.getBoundingClientRect().top)
        expect(areaTop).toBeGreaterThanOrEqual(chromeBottom - 0.5)
        // And the page must keep usable room — a toolbar that wrapped into
        // five rows would pass every check above while leaving no page.
        const area = await page.locator('.browser-area').evaluate((e) => ({
          w: e.getBoundingClientRect().width,
          h: e.getBoundingClientRect().height
        }))
        expect(area.w).toBeGreaterThanOrEqual(400)
        expect(area.h).toBeGreaterThanOrEqual(300)
        // The tool row is one line and every tool is reachable (row or menu).
        const st = await expectAllToolsReachable(page)
        console.log(
          `${size.label} / pane ${pane}: row ${st.shown.length}, menu ${ALL_TOOLS.length - st.shown.length}`
        )
      })
    }
  })
}

// ---------------------------------------------------------------------
// The More menu's behaviour: a wide window needs none; a menu item does what
// its button does; and the keyboard works the way a menu button should.
// ---------------------------------------------------------------------

test.describe('the "More ⋯" tools menu', () => {
  test.describe('in a wide window', () => {
    test.use({ viewport: { width: 1600, height: 900 }, bypassCSP: true })

    test('there is no More button — every tool is in the row', async ({ page }) => {
      await openApp(page, 'default')
      await toWorkspace(page)
      const st = await expectAllToolsReachable(page)
      expect(st.shown).toEqual(ALL_TOOLS)
      await expect(page.getByRole('button', { name: 'More ⋯' })).toHaveCount(0)
    })

    test('resizing the window moves tools into the menu and back', async ({ page }) => {
      await openApp(page, 'default')
      await toWorkspace(page)
      const more = page.getByRole('button', { name: 'More ⋯' })
      await expect(more).toHaveCount(0)
      await page.setViewportSize({ width: 1008, height: 640 })
      await expect(more).toHaveCount(1)
      await expectAllToolsReachable(page)
      await page.setViewportSize({ width: 1600, height: 900 })
      await expect(more).toHaveCount(0)
      expect((await toolRow(page)).shown).toEqual(ALL_TOOLS)
    })
  })

  test.describe('at the smallest content area', () => {
    test.use({ viewport: { width: 1008, height: 640 }, bypassCSP: true })

    test.beforeEach(async ({ page }) => {
      await openApp(page, 'default')
      await toWorkspace(page)
      // Everything below needs something in the menu; say so plainly if a
      // future layout change means nothing overflows here any more.
      const st = await toolRow(page)
      expect(st.hasMore, 'expected at least one tool in the More menu at 1008 px').toBe(true)
    })

    test('a menu item runs the same action as its button (Net toggles)', async ({ page }) => {
      const st = await toolRow(page)
      expect(st.shown, 'Net is expected to be in the menu at this width').not.toContain('net')
      const more = page.getByRole('button', { name: 'More ⋯' })
      await more.click()
      const net = page.getByRole('menuitemcheckbox', { name: /Net/ })
      await expect(net).toHaveAttribute('aria-checked', 'false')
      await expect(net).not.toHaveAttribute('aria-disabled', 'true')
      await net.click()
      // Choosing it closed the menu and gave focus back to More…
      await expect(page.getByRole('menu')).toHaveCount(0)
      await expect(more).toBeFocused()
      // …brought the page back (it was hidden while the menu was open)…
      await expect.poll(async () => (await overlayCalls(page)).at(-1)).toBe(false)
      // …and flipped the SAME state the button shows: the (hidden) button now
      // reads "Net ON" and is pressed, and so does the item when reopened.
      const btn = page.locator('.tools-measure [data-tool="net"]')
      await expect(btn).toHaveText('🌐 Net ON')
      await expect(btn).toHaveAttribute('aria-pressed', 'true')
      await more.click()
      const again = page.getByRole('menuitemcheckbox', { name: /Net ON/ })
      await expect(again).toHaveAttribute('aria-checked', 'true')
    })

    test('a disabled tool is disabled in the menu too (Mock needs captured traffic)', async ({
      page
    }) => {
      const st = await toolRow(page)
      expect(st.shown).not.toContain('mock')
      expect(await buttonDisabled(page, 'mock')).toBe(true)
      await page.getByRole('button', { name: 'More ⋯' }).click()
      const mock = page.getByRole('menuitem', { name: /Mock/ })
      await expect(mock).toHaveAttribute('aria-disabled', 'true')
      // Clicking it does nothing — the menu stays open, no modal appears.
      await mock.click({ force: true }) // Playwright itself refuses an aria-disabled target
      await expect(page.getByRole('menu')).toBeVisible()
      await expect(page.locator('.modal-backdrop')).toHaveCount(0)
    })

    test('keyboard: Enter opens, arrows / Home / End move, Escape returns to More', async ({
      page
    }) => {
      const more = page.getByRole('button', { name: 'More ⋯' })
      await more.focus()
      await page.keyboard.press('Enter')
      const menu = page.getByRole('menu', { name: 'More tools' })
      await expect(menu).toBeVisible()
      await expect(more).toHaveAttribute('aria-expanded', 'true')
      const items = menu.locator('[data-menuitem]')
      const n = await items.count()
      await expect(items.first()).toBeFocused()
      if (n > 1) {
        await page.keyboard.press('ArrowDown')
        await expect(items.nth(1)).toBeFocused()
      }
      await page.keyboard.press('End')
      await expect(items.last()).toBeFocused()
      await page.keyboard.press('ArrowDown') // wraps round
      await expect(items.first()).toBeFocused()
      await page.keyboard.press('ArrowUp') // …both ways
      await expect(items.last()).toBeFocused()
      await page.keyboard.press('Home')
      await expect(items.first()).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
      await expect(more).toBeFocused()
      await expect(more).toHaveAttribute('aria-expanded', 'false')
    })

    test('keyboard: Space and ArrowDown open it too; Tab closes it', async ({ page }) => {
      const more = page.getByRole('button', { name: 'More ⋯' })
      const menu = page.getByRole('menu', { name: 'More tools' })
      await more.focus()
      await page.keyboard.press('ArrowDown')
      await expect(menu).toBeVisible()
      await expect(menu.locator('[data-menuitem]').first()).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(menu).toHaveCount(0)
      await more.focus()
      await page.keyboard.press(' ')
      await expect(menu).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
    })

    test('a click outside closes it and brings the page back', async ({ page }) => {
      await page.getByRole('button', { name: 'More ⋯' }).click()
      await expect(page.getByRole('menu')).toBeVisible()
      await expect.poll(async () => (await overlayCalls(page)).at(-1)).toBe(true)
      await page.locator('.url-input').click()
      await expect(page.getByRole('menu')).toHaveCount(0)
      await expect.poll(async () => (await overlayCalls(page)).at(-1)).toBe(false)
    })
  })
})
