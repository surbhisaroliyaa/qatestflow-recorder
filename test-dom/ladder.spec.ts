import { test, expect, type Page } from '@playwright/test'
import { buildActionScript, buildProbeScript, type ReplayStep } from '../src/main/replay'

const s = (o: Record<string, unknown>): ReplayStep => o as ReplayStep

type Result = { ok: boolean; error?: string }

async function run(page: Page, step: ReplayStep): Promise<Result> {
  return (await page.evaluate(buildActionScript(step))) as Result
}

const css = (sel: string, score = 90): Record<string, unknown> => ({ kind: 'id', score, css: sel })

test.describe('the replay ladder', () => {
  test('falls back down the ladder when the top candidate is gone', async ({ page }) => {
    await page.setContent('<button id="real">Save</button>')
    const r = await run(
      page,
      s({
        type: 'click',
        candidates: [
          css('#gone', 95),
          { kind: 'role', score: 80, css: null, role: 'button', name: 'Save' }
        ]
      })
    )
    expect(r.ok).toBe(true)
  })

  test('refuses a bare-tag-only ladder instead of clicking the first button', async ({ page }) => {
    await page.setContent('<button>First</button><button id="wanted">Second</button>')
    const r = await run(
      page,
      s({ type: 'click', candidates: [{ kind: 'css', score: 15, css: 'button' }] })
    )
    expect(r.ok).toBe(false)
    expect(r.error).toContain('No reliable selector')
  })

  test('a pinned candidate beats a higher score', async ({ page }) => {
    await page.setContent('<button id="a">A</button><button id="b">B</button>')
    await page.evaluate(
      "document.getElementById('a').addEventListener('click', () => document.title = 'A');" +
        "document.getElementById('b').addEventListener('click', () => document.title = 'B');"
    )
    await run(
      page,
      s({ type: 'click', candidates: [css('#a', 95), { ...css('#b', 50), pinned: true }] })
    )
    expect(await page.title()).toBe('B')
  })

  test('nth picks the recorded one among duplicates', async ({ page }) => {
    await page.setContent('<a href="#" class="x">Go</a><a href="#" class="x" id="second">Go</a>')
    await page.evaluate(
      "document.getElementById('second').addEventListener('click', (e) => { e.preventDefault(); document.title = 'SECOND' });"
    )
    await run(
      page,
      s({ type: 'click', candidates: [{ kind: 'text', score: 50, css: null, text: 'Go', nth: 1 }] })
    )
    expect(await page.title()).toBe('SECOND')
  })

  test('role+name prefers an exact name over a containing one', async ({ page }) => {
    await page.setContent('<button id="long">Save changes</button><button id="exact">Save</button>')
    await page.evaluate(
      "document.getElementById('exact').addEventListener('click', () => document.title = 'EXACT');" +
        "document.getElementById('long').addEventListener('click', () => document.title = 'LONG');"
    )
    await run(
      page,
      s({
        type: 'click',
        candidates: [{ kind: 'role', score: 80, css: null, role: 'button', name: 'Save' }]
      })
    )
    expect(await page.title()).toBe('EXACT')
  })

  test('text match keeps the innermost element, not the wrapper', async ({ page }) => {
    await page.setContent('<div id="outer"><span id="inner">Click me</span></div>')
    await page.evaluate(
      "document.getElementById('inner').addEventListener('click', () => document.title = 'INNER');"
    )
    await run(
      page,
      s({ type: 'click', candidates: [{ kind: 'text', score: 50, css: null, text: 'Click me' }] })
    )
    expect(await page.title()).toBe('INNER')
  })

  test('sees into an open shadow root', async ({ page }) => {
    await page.setContent('<div id="host"></div>')
    await page.evaluate(
      "const r = document.getElementById('host').attachShadow({ mode: 'open' });" +
        "r.innerHTML = '<button id=\"deep\">Deep</button>';" +
        "r.getElementById('deep').addEventListener('click', () => document.title = 'DEEP');"
    )
    await run(page, s({ type: 'click', candidates: [css('#deep')] }))
    expect(await page.title()).toBe('DEEP')
  })
})

test.describe('the three distinct failures', () => {
  // Each of these waits out the engine's full 30s find timeout before it can
  // report, so the test itself needs longer than that.
  test.setTimeout(60000)

  test('not found', async ({ page }) => {
    await page.setContent('<div>nothing</div>')
    const r = await run(page, s({ type: 'click', candidates: [css('#nope')] }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('not found')
  })

  test('found but never visible', async ({ page }) => {
    await page.setContent('<button id="x" style="display:none">Hi</button>')
    const r = await run(page, s({ type: 'click', candidates: [css('#x')] }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('never became visible')
  })

  test('visible but disabled — a real defect, not an absence', async ({ page }) => {
    await page.setContent('<button id="x" disabled>Hi</button>')
    const r = await run(page, s({ type: 'click', candidates: [css('#x')] }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('disabled')
  })
})

test.describe('actions', () => {
  test('typing sets the value and fires input', async ({ page }) => {
    await page.setContent('<input id="f">')
    await page.evaluate(
      'window.__ev = [];' +
        "const f = document.getElementById('f');" +
        "f.addEventListener('input', () => window.__ev.push('input'));" +
        "f.addEventListener('change', () => window.__ev.push('change'));"
    )
    const r = await run(page, s({ type: 'type', value: 'hello', candidates: [css('#f')] }))
    expect(r.ok).toBe(true)
    expect(await page.inputValue('#f')).toBe('hello')
    expect(await page.evaluate('window.__ev')).toContain('input')
  })

  test('a value with quotes, backslashes and a newline survives intact', async ({ page }) => {
    await page.setContent('<textarea id="f"></textarea>')
    const nasty = 'he said "hi"\nC:\\Users\\x `${1}`'
    const r = await run(page, s({ type: 'type', value: nasty, candidates: [css('#f')] }))
    expect(r.ok).toBe(true)
    expect(await page.inputValue('#f')).toBe(nasty)
  })

  test('select picks the option', async ({ page }) => {
    await page.setContent('<select id="s"><option>One</option><option>Two</option></select>')
    const r = await run(page, s({ type: 'select', value: 'Two', candidates: [css('#s')] }))
    expect(r.ok).toBe(true)
    expect(await page.inputValue('#s')).toBe('Two')
  })
})

test.describe('checks', () => {
  const check = async (
    page: Page,
    kind: string,
    value?: string,
    attr?: string
  ): Promise<Result> =>
    run(page, s({ type: 'assert', assertKind: kind, value, attrName: attr, candidates: [css('#t')] }))

  test('text-equals passes on a match and fails on a mismatch', async ({ page }) => {
    await page.setContent('<p id="t">Order complete</p>')
    expect((await check(page, 'text-equals', 'Order complete')).ok).toBe(true)
    const bad = await check(page, 'text-equals', 'Order failed')
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('Order complete')
  })

  test('count counts every match, not just the first', async ({ page }) => {
    await page.setContent('<li class="t">a</li><li class="t">b</li><li class="t">c</li>')
    const r = await run(
      page,
      s({
        type: 'assert',
        assertKind: 'count',
        value: '3',
        candidates: [{ kind: 'id', score: 90, css: '.t' }]
      })
    )
    expect(r.ok).toBe(true)
  })

  test('attribute and class checks', async ({ page }) => {
    await page.setContent('<a id="t" href="/next" class="btn primary">Go</a>')
    expect((await check(page, 'attribute', '/next', 'href')).ok).toBe(true)
    expect((await check(page, 'class', 'primary')).ok).toBe(true)
    expect((await check(page, 'class', 'prim')).ok).toBe(false)
  })

  test('hidden check passes for a hidden element', async ({ page }) => {
    await page.setContent('<div id="t" style="display:none">x</div>')
    expect((await check(page, 'hidden')).ok).toBe(true)
  })
})

test.describe('control-flow probes never throw', () => {
  test('absent element answers "not found" rather than failing', async ({ page }) => {
    await page.setContent('<div>x</div>')
    const r = (await page.evaluate(
      buildProbeScript(s({ type: 'if', candidates: [css('#nope')] }), 300)
    )) as Record<string, unknown>
    expect(r.found).toBe(false)
  })

  test('present element answers found + visible', async ({ page }) => {
    await page.setContent('<div id="banner">Cookies</div>')
    const r = (await page.evaluate(
      buildProbeScript(s({ type: 'if', candidates: [css('#banner')] }), 300)
    )) as Record<string, unknown>
    expect(r.found).toBe(true)
    expect(r.visible).toBe(true)
  })
})
