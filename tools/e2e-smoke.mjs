// END-TO-END SMOKE TEST of the built app: does RECORDING work?
//
//   npm run build && node tools/e2e-smoke.mjs
//
// The unit and DOM suites test the recorder's parts; none of them drives the
// real app, because the page under test lives in a native WebContentsView that
// Playwright's Electron API can't script. This does it from the other side:
// main-process `sendInputEvent` delivers REAL (isTrusted) mouse and keyboard
// input into the view, exactly as a user's hand would — and the recorded steps
// are then read back from the app's own step list.
//
// It needs a desktop session and the Electron binary, so it is a local tool,
// not a CI job. Run it before hand-testing anything that touches recording.
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'

const PAGE1 = `<!doctype html><html lang="en"><head><title>Smoke 1</title></head><body style="font:16px sans-serif">
  <h1>Smoke page</h1>
  <p><button id="go" data-test="go-btn">Go button</button></p>
  <p><input id="name" data-test="name" placeholder="Your name"></p>
  <p><input id="agree" type="checkbox"><label for="agree">I agree</label></p>
  <iframe id="frame" src="/frame.html" style="width:320px;height:70px;border:1px solid #999"></iframe>
  <iframe id="written" name="editor" style="width:320px;height:60px;border:1px solid #999"></iframe>
  <iframe id="touched" src="/touched.html" style="width:320px;height:60px;border:1px solid #999"></iframe>
  <p><button id="ask" onclick="window.answer = prompt('Your city?', 'Pune')">Ask</button></p>
  <p><a id="next" href="/page2.html">Next page</a></p>
  <script>
    // A script-written iframe (about:blank + document.write) — the kind that
    // gets no preload of its own, so its parent's recorder must adopt it.
    const d = document.getElementById('written').contentDocument
    d.open(); d.write('<button id="wbtn" data-test="written-btn">Written button</button>'); d.close()
    // A page script touching a src iframe's window while it is still the
    // initial about:blank (as Google's ad scripts do to every frame): Electron
    // then never runs the preload in it, so its parent must adopt it.
    void document.getElementById('touched').contentWindow.name
  </script>
</body></html>`
const FRAME = `<!doctype html><html lang="en"><body><button id="inner" data-test="inner-btn">Inside frame</button></body></html>`
const TOUCHED = `<!doctype html><html lang="en"><body><button id="tbtn" data-test="touched-btn">Touched button</button></body></html>`
const PAGE2 =`<!doctype html><html lang="en"><head><title>Smoke 2</title></head><body style="font:16px sans-serif">
  <h1>Second page</h1><button id="done" data-test="done-btn">Done</button></body></html>`

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(req.url === '/touched.html' ? TOUCHED : req.url === '/frame.html' ? FRAME : req.url === '/page2.html' ? PAGE2 : PAGE1)
}).listen(0, '127.0.0.1')
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}/`

const app = await electron.launch({ args: ['.'] })
const ui = await app.firstWindow()
await ui.waitForLoadState('domcontentloaded')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const report = { base, problems: [] }

try {
  // Open the page through the app's own welcome form.
  await ui.locator('.welcome-form input').first().fill(base)
  await ui.locator('.welcome-form input').first().press('Enter')
  await ui.waitForSelector('.workspace')
  await sleep(2500)

  // --- helpers that act on the VISIBLE page view, from the main process ---
  const viewEval = (js) =>
    app.evaluate(async ({ BrowserWindow }, code) => {
      const v = BrowserWindow.getAllWindows()[0].contentView.children.find((c) => c.getBounds().width > 0)
      return v.webContents.executeJavaScript(code)
    }, js)
  const clickAt = (x, y) =>
    app.evaluate(({ BrowserWindow }, p) => {
      const v = BrowserWindow.getAllWindows()[0].contentView.children.find((c) => c.getBounds().width > 0)
      v.webContents.focus()
      v.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
      v.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    }, { x, y })
  const typeText = (text) =>
    app.evaluate(({ BrowserWindow }, t) => {
      const v = BrowserWindow.getAllWindows()[0].contentView.children.find((c) => c.getBounds().width > 0)
      for (const ch of t) v.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    }, text)
  const centre = async (selector, inFrame) =>
    viewEval(`(() => {
      const doc = ${inFrame ? `document.getElementById(${JSON.stringify(inFrame === true ? 'frame' : inFrame)}).contentDocument` : 'document'}
      const off = ${inFrame ? `document.getElementById(${JSON.stringify(inFrame === true ? 'frame' : inFrame)}).getBoundingClientRect()` : '{left:0,top:0}'}
      const r = doc.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()
      return { x: Math.round(off.left + r.left + r.width / 2), y: Math.round(off.top + r.top + r.height / 2) }
    })()`)

  // Diagnostics: what main receives from which frame (reported on failure).
  await app.evaluate(({ ipcMain }) => {
    globalThis.__smokeSpy = []
    ipcMain.on('recorder:event', (e, p) =>
      globalThis.__smokeSpy.push(`${e.senderFrame ? e.senderFrame.url : '?'} → ${p && p.type} ${p && p.facts ? p.facts.text || p.facts.id || '' : ''}`)
    )
  })

  // --- record ---
  await ui.locator('.record-btn').click()
  await sleep(700)

  let p = await centre('#go'); await clickAt(p.x, p.y); await sleep(400)
  p = await centre('#name'); await clickAt(p.x, p.y); await sleep(200)
  await typeText('Surbhi'); await sleep(200)
  p = await centre('label[for=agree]'); await clickAt(p.x, p.y); await sleep(400)   // commits the typing (blur) + ticks
  p = await centre('#inner', true); await clickAt(p.x, p.y); await sleep(500)
  p = await centre('#wbtn', 'written'); await clickAt(p.x, p.y); await sleep(500)   // adopted frame
  p = await centre('#tbtn', 'touched'); await clickAt(p.x, p.y); await sleep(500)   // adopted src frame (no preload)
  // A page that FORGES a click must not become a step…
  await viewEval(`document.getElementById('go').click(); true`); await sleep(400)
  // …nor one that imitates the OLD recorder message format (page-world postMessage).
  await viewEval(`window.top.postMessage({ __qaflow: true, nonce: 'guess', channel: 'recorder:event',
    payload: { type: 'click', facts: { tag: 'button', text: 'FORGED BY PAGE' } } }, '*'); true`); await sleep(400)
  // prompt(): the page-world shim draws its own box; answer it like a user.
  p = await centre('#ask'); await clickAt(p.x, p.y); await sleep(600)
  const box = await viewEval(`(() => { const i = document.querySelector('input[data-qaflow-ui]'); if (!i) return null;
    const r = i.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) } })()`)
  if (box) {
    await clickAt(box.x, box.y); await sleep(150)
    await viewEval(`(() => { const i = document.querySelector('input[data-qaflow-ui]'); i.select(); return true })()`)
    await typeText('Delhi'); await sleep(150)
    const ok = await viewEval(`(() => { const b = [...document.querySelectorAll('button[data-qaflow-ui]')].find((x) => x.textContent === 'OK');
      const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    await clickAt(ok.x, ok.y); await sleep(500)
  } else report.problems.push('prompt(): the in-page prompt box never appeared')
  p = await centre('#next'); await clickAt(p.x, p.y); await sleep(2000)             // navigation
  p = await centre('#done'); await clickAt(p.x, p.y); await sleep(600)             // after navigation

  await ui.locator('.record-btn').click()
  await sleep(500)

  report.steps = await ui.locator('.step-item').evaluateAll((els) =>
    els.map((e) => (e.querySelector('.step-text') ?? e).textContent.replace(/\s+/g, ' ').trim().slice(0, 70))
  )
  const want = [
    [/Click Go button/i, 'click on the page'],
    [/Type "Surbhi"/i, 'typing'],
    [/Tick I agree/i, 'checkbox via its label → one Tick step'],
    [/Inside frame/i, 'click inside the iframe'],
    [/Written button/i, 'click inside a script-written (adopted) iframe'],
    [/Touched button/i, 'click inside a src iframe the page touched early (adopted, no preload)'],
    [/Your city\?/i, 'prompt() answered in the in-page box'],
    [/Next page/i, 'click on the link'],
    [/Done/i, 'click AFTER the page navigated']
  ]
  for (const [re, what] of want) if (!report.steps.some((s) => re.test(s))) report.problems.push(`missing: ${what}`)
  if (report.problems.length) report.mainReceived = await app.evaluate(() => globalThis.__smokeSpy)
  const goClicks = report.steps.filter((s) => /Click Go button/i.test(s)).length
  if (goClicks > 1) report.problems.push(`a page-forged click was recorded (${goClicks} "Click Go button" steps)`)
  if (report.steps.some((s) => /"on"/.test(s))) report.problems.push('checkbox recorded as typing "on" (QF-001 regression)')
  if (report.steps.some((s) => /FORGED/i.test(s))) report.problems.push('a page-imitated recorder message became a step')

  // The exported code shows which FRAME each step was filed under.
  await ui.locator('.export-btn').click()
  await ui.waitForSelector('.modal-code')
  report.frameLines = (await ui.locator('.modal-code').innerText())
    .split('\n')
    .filter((l) => /frameLocator|contentFrame/.test(l))
    .map((l) => l.trim())
  await ui.keyboard.press('Escape')
  await sleep(300)

  // REPLAY what was just recorded. Recording right is half the job: each step
  // must also carry the right frame, or replay can't find its element — and an
  // adopted (script-written) frame is the one most likely to be filed wrong.
  await ui.locator('.replay-btn').click()
  const deadline = Date.now() + 90_000
  let banner = ''
  while (Date.now() < deadline) {
    banner = await ui
      .locator('.replay-status.passed, .replay-status.failed, .replay-status.error')
      .first()
      .innerText()
      .catch(() => '')
    if (banner) break
    // A failed step pauses for recovery rather than ending the run.
    if (await ui.locator('.recovery-panel, .recovery').count().catch(() => 0)) {
      const failed = await ui
        .locator('.step-item.failed')
        .first()
        .innerText()
        .catch(() => '?')
      const why = await ui
        .locator('.recovery-panel, .recovery')
        .first()
        .innerText()
        .catch(() => '')
      banner = `paused for recovery at "${failed.replace(/\s+/g, ' ').slice(0, 60)}": ${why.replace(/\s+/g, ' ').slice(0, 240)}`
      break
    }
    await sleep(500)
  }
  report.replay = banner.replace(/\s+/g, ' ').trim() || 'no result within 90s'
  if (!/passed/i.test(report.replay)) report.problems.push(`replay did not pass: ${report.replay}`)

  // Sandbox actually on for both windows?
  report.sandboxed = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const views = w.contentView.children.filter((c) => c.webContents)
    return {
      appWindow: w.webContents.getLastWebPreferences().sandbox,
      pageViews: views.map((v) => v.webContents.getLastWebPreferences().sandbox)
    }
  })
  if (report.sandboxed.appWindow !== true || report.sandboxed.pageViews.some((s) => s !== true)) {
    report.problems.push('sandbox is not on for every window')
  }
} catch (e) {
  report.problems.push(`harness error: ${e.message}`)
} finally {
  await app.close().catch(() => {})
  server.close()
}
console.log(JSON.stringify(report, null, 2))
process.exit(report.problems.length ? 1 : 0)
