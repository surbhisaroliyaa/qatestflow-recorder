import { test, expect, type Page } from '@playwright/test'
import {
  buildActionScript,
  buildCollectionScript,
  buildFailureMarkScript,
  type ReplayStep
} from '../src/main/replay'

const s = (o: Record<string, unknown>): ReplayStep => o as ReplayStep
type Result = { ok: boolean; error?: string }

async function run(page: Page, step: ReplayStep): Promise<Result> {
  return (await page.evaluate(buildActionScript(step))) as Result
}
const css = (sel: string, score = 90): Record<string, unknown> => ({ kind: 'id', score, css: sel })

test.describe('count vs shadow DOM — do the finder and the counter agree?', () => {
  test('counts elements inside an open shadow root', async ({ page }) => {
    await page.setContent('<div id="host"></div>')
    await page.evaluate(
      "const r = document.getElementById('host').attachShadow({ mode: 'open' });" +
        "r.innerHTML = '<li class=\"row\">a</li><li class=\"row\">b</li><li class=\"row\">c</li>';"
    )
    // The finder pierces shadow roots (deepQueryAll). If the counter doesn't,
    // a group check on the same element reports 0 while the click works.
    const r = await run(
      page,
      s({ type: 'assert', assertKind: 'count', value: '3', candidates: [css('.row')] })
    )
    expect(r.ok, r.error).toBe(true)
  })
})

test.describe('page-level checks', () => {
  test('url-contains passes and fails with the actual url', async ({ page }) => {
    await page.goto('https://example.com/')
    expect((await run(page, s({ type: 'assert', assertKind: 'url-contains', value: 'example' }))).ok)
      .toBe(true)
    const bad = await run(page, s({ type: 'assert', assertKind: 'url-contains', value: '/nope' }))
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('example.com')
  })

  test('title check normalises whitespace', async ({ page }) => {
    await page.setContent('<title>  Order   complete  </title><p>x</p>')
    const r = await run(page, s({ type: 'assert', assertKind: 'title', value: 'Order complete' }))
    expect(r.ok, r.error).toBe(true)
  })
})

test.describe('the remaining check kinds', () => {
  const check = async (page: Page, kind: string, value?: string): Promise<Result> =>
    run(page, s({ type: 'assert', assertKind: kind, value, candidates: [css('#t')] }))

  test('value', async ({ page }) => {
    await page.setContent('<input id="t" value="abc">')
    expect((await check(page, 'value', 'abc')).ok).toBe(true)
    expect((await check(page, 'value', 'xyz')).ok).toBe(false)
  })

  test('empty', async ({ page }) => {
    await page.setContent('<input id="t" value="">')
    expect((await check(page, 'empty')).ok).toBe(true)
  })

  test('text-contains', async ({ page }) => {
    await page.setContent('<p id="t">Your order is complete</p>')
    expect((await check(page, 'text-contains', 'order is')).ok).toBe(true)
    expect((await check(page, 'text-contains', 'cancelled')).ok).toBe(false)
  })

  test('enabled and editable', async ({ page }) => {
    await page.setContent('<input id="t">')
    expect((await check(page, 'enabled')).ok).toBe(true)
    expect((await check(page, 'editable')).ok).toBe(true)
  })

  test('checked and unchecked', async ({ page }) => {
    await page.setContent('<input id="t" type="checkbox" checked>')
    expect((await check(page, 'checked')).ok).toBe(true)
    expect((await check(page, 'unchecked')).ok).toBe(false)
  })

  test('focused', async ({ page }) => {
    await page.setContent('<input id="t"><input id="other">')
    await page.focus('#t')
    expect((await check(page, 'focused')).ok).toBe(true)
  })
})

test.describe('keyboard', () => {
  test('press fires a real keydown the page can see', async ({ page }) => {
    await page.setContent('<input id="t">')
    await page.evaluate(
      "document.getElementById('t').addEventListener('keydown', (e) => { document.title = 'KEY:' + e.key });"
    )
    const r = await run(page, s({ type: 'press', key: 'Enter', candidates: [css('#t')] }))
    expect(r.ok, r.error).toBe(true)
    expect(await page.title()).toBe('KEY:Enter')
  })
})

test.describe('for-each collection', () => {
  test('collects every match, in DOM order', async ({ page }) => {
    await page.setContent('<li class="r">a</li><li class="r">b</li><li class="r">c</li>')
    const out = (await page.evaluate(
      buildCollectionScript(s({ type: 'repeat', repeatKind: 'each', candidates: [css('.r')] }))
    )) as Record<string, unknown>
    expect(out).toBeTruthy()
    expect(JSON.stringify(out)).toContain('3')
  })
})

test.describe('the failure banner', () => {
  test('injects something visible naming the error', async ({ page }) => {
    await page.setContent('<p id="t">hello</p>')
    await page.evaluate(
      buildFailureMarkScript(s({ type: 'click', candidates: [css('#t')] }), 'Element not found')
    )
    const body = await page.evaluate('document.body.innerText')
    expect(String(body)).toContain('Element not found')
  })
})
