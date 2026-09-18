import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import axe from 'axe-core'

// =====================================================================
// THE APP'S OWN ACCESSIBILITY, SCANNED ON EVERY PUSH  (audit QF-004)
// =====================================================================
// The audit ran axe against the recorder's own window and found two SERIOUS
// violations (no document language, low contrast) — while the app's built-in
// scanner happily reported the TESTED page green. It asked for "shell-level
// axe/keyboard CI". Keyboard behaviour is covered by modal-a11y.spec.ts; this
// is the axe half.
//
// It loads the BUILT renderer (out/renderer — CI builds first) in a real
// browser. The renderer normally talks to Electron through `window.api`; here
// that bridge is a stub that answers every call with "nothing", which is
// enough for the welcome screen and the workspace to render. What is checked
// is the app's own markup and styles, not Electron.
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

// Every property is a callable that resolves to an empty array — lists come
// back empty, subscriptions return a no-op unsubscribe, and awaiting anything
// yields [] (which has .length, .map, and reads undefined for any field).
const BRIDGE_STUB = `(() => {
  // What a call resolves to: an empty list that ALSO answers any field with
  // another empty list — so state.environments.find(...), res.tests.length and
  // plain lists all work, and there is never an undefined to crash on.
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
        // Behave like a settled promise, so .then(…).catch(…) chains work.
        if (prop === 'then') return (res, rej) => Promise.resolve(empty()).then(res, rej)
        if (prop === 'catch') return (rej) => Promise.resolve(empty()).catch(rej)
        if (prop === 'finally') return (f) => Promise.resolve(empty()).finally(f)
        if (prop === Symbol.toPrimitive) return () => ''
        return make()
      },
      apply() { return make() }
    })
  }
  window.api = make()
  window.electron = make()
})()`

let server: Server
let base = ''

test.beforeAll(async () => {
  if (!existsSync(join(RENDERER, 'index.html'))) {
    throw new Error('out/renderer is missing — run `npm run build` before `npm run test:dom`.')
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

async function openApp(page: Page): Promise<string[]> {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.addInitScript(BRIDGE_STUB)
  await page.goto(base)
  // If the app throws while starting, say WHY instead of timing out blind.
  await page.waitForSelector('#root > *', { timeout: 15_000 }).catch(() => {
    throw new Error(`the app did not render:\n${errors.join('\n') || '(no error reported)'}`)
  })
  return errors
}

// WCAG 2.1 A/AA — the same rule set the app's own page scanner uses.
async function seriousViolations(page: Page): Promise<string[]> {
  await page.evaluate(axe.source)
  const result = (await page.evaluate(() =>
    (window as unknown as { axe: { run: (o: unknown) => Promise<unknown> } }).axe.run({
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }
    })
  )) as {
    violations: {
      id: string
      impact: string
      help: string
      nodes: { target: string[]; any: { message: string }[] }[]
    }[]
  }
  // One line per offending ELEMENT, with axe's own reason (for contrast: the
  // measured ratio and the colours) — a failure names exactly what to fix.
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) =>
      v.nodes.map((n) => `${v.id} · ${n.target.join(' ')} · ${n.any[0]?.message ?? v.help}`)
    )
}

test.use({ bypassCSP: true })

test('the welcome screen has no serious accessibility violations', async ({ page }) => {
  await openApp(page)
  await expect(page.locator('h1')).toContainText('QATestFlow Recorder')
  expect(await seriousViolations(page)).toEqual([])
})

test('the workspace has no serious accessibility violations', async ({ page }) => {
  await openApp(page)
  // The welcome form's URL box: submitting it switches to the workspace.
  const url = page.locator('.welcome-form input').first()
  await url.fill('https://example.com')
  await url.press('Enter')
  await page.waitForSelector('.workspace', { timeout: 10_000 })
  // The heading structure the audit found missing (QF-004).
  await expect(page.locator('h1')).toHaveCount(1)
  await expect(page.getByRole('heading', { level: 2, name: /Steps/ })).toBeVisible()
  expect(await seriousViolations(page)).toEqual([])
})

test('the page declares its language (a serious violation in the audit)', async ({ page }) => {
  await openApp(page)
  expect(await page.getAttribute('html', 'lang')).toBe('en')
})
