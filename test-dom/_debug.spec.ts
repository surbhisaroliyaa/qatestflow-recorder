import { test } from '@playwright/test'
import { observerProgram } from '../src/main/observerSource'

test('capture the thrown error', async ({ page }) => {
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
  await page.setContent('<button id="only">Only</button>')
  await page.evaluate(`
    window.__err = null
    window.addEventListener('error', (e) => { window.__err = String(e.message) })
    window.__qaflowEvents = []
    window.addEventListener('message', (e) => { if (e.data && e.data.__qaflow) window.__qaflowEvents.push(e.data) })
    window.__qaflowInitActive = true
    ;(${observerProgram.toString()})()
  `)
  await page.click('#only')
  console.log('captured err:', await page.evaluate('window.__err'))
  console.log('events:', ((await page.evaluate('window.__qaflowEvents')) as unknown[]).length)
})
