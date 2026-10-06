// A STAND-IN FOR PLAYWRIGHT'S _electron, for the local tools in this folder.
//
// Playwright 1.56 cannot attach to Electron 44 (Chrome 152): both
// `_electron.launch` and `chromium.connectOverCDP` connect and then hang until
// they time out. That silently killed tools/e2e-smoke.mjs on the 2026-09-18
// Electron upgrade. Nothing in the app depends on this — only these tools.
//
// So this speaks the two debugging protocols directly, which is all Playwright
// was doing underneath:
//   · the MAIN process through Node's inspector (--inspect) — `app.evaluate`
//   · the app WINDOW through Chrome's DevTools protocol — a small `ui` object
//     with the handful of Page/Locator methods the tools use
//
// It is deliberately the same SHAPE as Playwright's objects, so a tool written
// against `_electron` changes one import, not its body. When Playwright catches
// up, the tools can go back to it.
import { spawn } from 'node:child_process'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A minimal CDP/inspector client over one WebSocket. */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const waiting = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    const w = msg.id && waiting.get(msg.id)
    if (!w) return
    waiting.delete(msg.id)
    if (msg.error) w.rej(new Error(msg.error.message))
    else w.res(msg.result)
  }
  const open = new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error(`could not connect to ${wsUrl}`))
  })
  return {
    async send(method, params = {}) {
      await open
      const n = ++id
      ws.send(JSON.stringify({ id: n, method, params }))
      return new Promise((res, rej) => waiting.set(n, { res, rej }))
    },
    close: () => ws.close()
  }
}

/** Evaluate an expression and return its value, or throw the page's error. */
async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  }
  return r.result.value
}

async function poll(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn().catch(() => undefined)
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
    await sleep(200)
  }
}

const KEYS = {
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9 }
}

/**
 * Launch the app and attach to both processes.
 *
 * @param {{ args?: string[], cwd?: string, executablePath?: string,
 *           inspectPort?: number, cdpPort?: number }} opts
 *   `args` as for `_electron.launch` — usually `['.']`, the app folder.
 * @returns {Promise<{ app: { evaluate: Function, close: Function }, ui: object }>}
 */
export async function launchElectron(opts = {}) {
  const exe = opts.executablePath ?? (await import('electron')).default
  const inspectPort = opts.inspectPort ?? 9339
  const cdpPort = opts.cdpPort ?? 9338
  const proc = spawn(
    exe,
    [`--inspect=${inspectPort}`, `--remote-debugging-port=${cdpPort}`, ...(opts.args ?? ['.'])],
    { cwd: opts.cwd ?? process.cwd(), stdio: 'ignore' }
  )
  const exited = new Promise((r) => proc.once('exit', r))

  const list = async (port) => (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const mainTarget = await poll(async () => (await list(inspectPort))[0], 15000, 'the main process')
  const main = connect(mainTarget.webSocketDebuggerUrl)
  const uiTarget = await poll(
    async () => (await list(cdpPort)).find((t) => t.type === 'page' && t.url.startsWith('file:')),
    15000,
    'the app window'
  )
  const page = connect(uiTarget.webSocketDebuggerUrl)
  const ev = (expr) => evaluate(page, expr)

  const app = {
    /** Like ElectronApplication.evaluate: fn(electronModule, arg), in main. */
    evaluate: (fn, arg) =>
      evaluate(
        main,
        `(async () => (${fn.toString()})(process.mainModule.require('electron'), ${JSON.stringify(arg)}))()`
      ),
    async close() {
      main.close()
      page.close()
      proc.kill()
      await Promise.race([exited, sleep(3000)])
    }
  }

  const press = async (key) => {
    const k = KEYS[key] ?? { code: key }
    for (const type of ['keyDown', 'keyUp']) {
      await page.send('Input.dispatchKeyEvent', {
        type,
        key,
        ...k,
        ...(type === 'keyUp' ? { text: undefined } : {})
      })
    }
  }

  const locator = (sel) => {
    const q = JSON.stringify(sel)
    const loc = {
      first: () => loc,
      async count() {
        return ev(`document.querySelectorAll(${q}).length`)
      },
      async click() {
        await poll(() => ev(`!!document.querySelector(${q})`), 10000, sel)
        await ev(
          `(() => { const e = document.querySelector(${q}); e.scrollIntoView({ block: 'center' }); e.click(); return true })()`
        )
      },
      async fill(value) {
        await poll(() => ev(`!!document.querySelector(${q})`), 10000, sel)
        await ev(`(() => { const e = document.querySelector(${q}); e.focus();
          const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'value').set;
          set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
      },
      async press(key) {
        await ev(`(() => { document.querySelector(${q}).focus(); return true })()`)
        await press(key)
      },
      async innerText() {
        const t = await ev(`document.querySelector(${q})?.innerText ?? null`)
        if (t === null) throw new Error(`no element matches ${sel}`)
        return t
      },
      async evaluateAll(fn) {
        return ev(`(${fn.toString()})([...document.querySelectorAll(${q})])`)
      }
    }
    return loc
  }

  const ui = {
    locator,
    async waitForLoadState() {
      await poll(() => ev(`document.readyState !== 'loading'`), 15000, 'the window to load')
    },
    async waitForSelector(sel, o = {}) {
      await poll(
        () => ev(`!!document.querySelector(${JSON.stringify(sel)})`),
        o.timeout ?? 30000,
        sel
      )
    },
    keyboard: { press },
    evaluate: (fn, arg) => ev(`(${fn.toString()})(${JSON.stringify(arg)})`)
  }
  await ui.waitForLoadState()
  return { app, ui }
}
