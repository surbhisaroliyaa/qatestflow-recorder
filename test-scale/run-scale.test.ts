import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { execFileSync } from 'node:child_process'

// xbrowser imports electron for app paths. Unpackaged, it only needs these to
// exist: the runner is found from process.cwd() (the repo) and the scratch run
// folder goes beside it — exactly the dev path the app itself takes.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd()
  }
}))

const { runSuiteParallel, checkPlaywright } = await import('../src/main/xbrowser')
const { generatePlaywrightTest } = await import('../src/renderer/src/playwrightExport')
const { defaultWorkers } = await import('../src/renderer/src/headless')

// =====================================================================
// THE 100+ TEST *RUN* PROOF  (audit: "the 100-plus-test no-stall performance
// objective has not been demonstrated")
// =====================================================================
// test/scale.test.ts proves a 240-test library LISTS fast. That is half the
// claim. The other half — that 100+ tests RUN without stalling — was an
// argument, not a measurement. This is the measurement.
//
// It goes through the most real path that can run without the app window:
//
//   RecorderStep[]  →  generatePlaywrightTest  (the Export button's exporter)
//                   →  runSuiteParallel        (⚡ Run in parallel AND the CLI)
//                   →  real Playwright, real headless Chromium, N workers
//
// against a local fixture page (no internet, so a slow website can't make
// this flaky or a down one make it lie).
//
// == What is asserted, and why each one ==
//   · every one of the 120 tests PASSES — by id, not by count
//   · ONE deliberate canary FAILS, with an error. Without it, "120 green"
//     could also mean "nothing ran and the mapping said pass" — which this
//     runner has done before (see test/xbrowser.test.ts).
//   · the fixture server really served every test's page — proof the browsers
//     ran, independent of anything the runner reports about itself
//   · the whole run finishes inside a generous budget (a stall = a timeout)
//   · the number of live headless browser processes stays bounded while it
//     runs and returns to where it started. A runner that leaked a browser
//     per test would climb past 120 here; one that leaked at the end would
//     leave them behind.
//
// Slow by nature (real browsers), so it is NOT in `npm test`: run it with
// `npm run test:scale`.
// =====================================================================

const TESTS = 120
// Generous on purpose: this box and CI are not benchmarks. What this catches is
// a STALL (a hung worker, a run that never ends), not a slow second.
const BUDGET_MS = 8 * 60_000

// The module is typed against the ambient RecorderStep; the test builds partials.
const s = (o: Record<string, unknown>): never => o as never

let server: Server
let base = ''
const served = new Set<number>()

// One small form per test id: type a name, pick a size, tick a box, press
// Submit, and the page writes back what it received. Each test asserts ITS
// OWN id in that text, so a page mix-up between workers would fail.
function page(id: number): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Order ${id}</title></head>
<body>
  <h1>Order ${id}</h1>
  <input id="name" type="text" aria-label="Name">
  <select id="size" aria-label="Size"><option>S</option><option>M</option><option>L</option></select>
  <label><input id="gift" type="checkbox"> Gift wrap</label>
  <button id="go" type="button">Submit</button>
  <p id="out"></p>
  <script>
    document.getElementById('go').addEventListener('click', () => {
      const n = document.getElementById('name').value
      const z = document.getElementById('size').value
      const g = document.getElementById('gift').checked ? 'gift' : 'plain'
      // A little async, like a real app answering after a request.
      setTimeout(() => {
        document.getElementById('out').textContent = 'Order ${id}: ' + n + ' / ' + z + ' / ' + g
      }, 50)
    })
  </script>
</body></html>`
}

function stepsFor(id: number): unknown[] {
  const size = ['S', 'M', 'L'][id % 3]
  return [
    s({ type: 'navigate', url: `${base}order/${id}` }),
    s({ type: 'type', selector: 'locator("#name")', value: `Customer ${id}`, label: 'Name' }),
    s({ type: 'select', selector: 'locator("#size")', value: size, label: 'Size' }),
    s({ type: 'check', selector: 'locator("#gift")', value: 'true', label: 'Gift wrap' }),
    s({ type: 'click', selector: 'locator("#go")', label: 'Submit' }),
    s({
      type: 'assert',
      selector: 'locator("#out")',
      assertKind: 'text-equals',
      value: `Order ${id}: Customer ${id} / ${size} / gift`,
      label: 'Result'
    })
  ]
}

/** Live headless Chromium processes. Windows only (tasklist); elsewhere null,
 *  and the leak assertions are skipped rather than faked. */
function browserProcesses(): number | null {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync(
      'tasklist',
      ['/FI', 'IMAGENAME eq headless_shell.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf-8' }
    )
    return out.split('\n').filter((l) => l.includes('headless_shell.exe')).length
  } catch {
    return null
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const m = /^\/order\/(\d+)$/.exec(req.url ?? '')
    if (!m) {
      res.writeHead(404)
      res.end()
      return
    }
    served.add(Number(m[1]))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page(Number(m[1])))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  base = `http://127.0.0.1:${addr.port}/`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe(`running ${TESTS}+ tests through the real headless runner`, () => {
  it('runs them all, green, without stalling or leaking browsers', async () => {
    const status = checkPlaywright()
    // Say WHY, instead of reporting 120 failures for a missing download.
    expect(status.installed, 'Playwright runner not found under node_modules').toBe(true)
    expect(status.chromium, 'Chromium not downloaded — `npx playwright install chromium`').toBe(
      true
    )

    const specs = Array.from({ length: TESTS }, (_, i) => {
      const id = i + 1
      return {
        id: `scale-${id}.json`,
        name: `Scale order ${id}`,
        code: generatePlaywrightTest(stepsFor(id) as never, { name: `Scale order ${id}` })
      }
    })
    // The canary: a real test whose assertion is wrong. It MUST come back red.
    const canary = stepsFor(999)
    ;(canary[canary.length - 1] as { value: string }).value = 'Order 999: this text never appears'
    specs.push({
      id: 'canary.json',
      name: 'Canary (must fail)',
      code: generatePlaywrightTest(canary as never, { name: 'Canary (must fail)' })
    })

    const workers = defaultWorkers()
    const before = browserProcesses()
    let peak = before ?? 0
    const sampler = setInterval(() => {
      const n = browserProcesses()
      if (n !== null && n > peak) peak = n
    }, 1000)

    const started = Date.now()
    const heapBefore = process.memoryUsage().rss
    let run: Awaited<ReturnType<typeof runSuiteParallel>>
    try {
      run = await Promise.race([
        runSuiteParallel(specs, workers),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`STALL: not finished after ${BUDGET_MS / 1000}s`)),
            BUDGET_MS
          )
        )
      ])
    } finally {
      clearInterval(sampler)
    }
    const elapsed = Date.now() - started

    // Give Playwright a moment to finish tearing browsers down, then look.
    let after = browserProcesses()
    for (let i = 0; i < 20 && after !== null && before !== null && after > before; i++) {
      await new Promise((r) => setTimeout(r, 500))
      after = browserProcesses()
    }

    // The numbers, for the record — this is what the audit asked to see.
    console.log(
      [
        `scale run: ${specs.length} specs (${TESTS} + 1 canary), ${workers} workers`,
        `  wall time: ${(elapsed / 1000).toFixed(1)}s  (${(elapsed / specs.length).toFixed(0)} ms/test)`,
        `  pages served: ${served.size}`,
        `  headless_shell processes: before ${before ?? 'n/a'}, peak ${before === null ? 'n/a' : peak}, after ${after ?? 'n/a'}`,
        `  this process RSS: ${(heapBefore / 1e6).toFixed(0)} MB → ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`
      ].join('\n')
    )

    expect(run.message ?? '', 'the runner could not start').toBe('')
    expect(run.ran).toBe(true)
    expect(run.results).toHaveLength(TESTS + 1)

    const byId = new Map(run.results.map((r) => [r.id, r]))
    const failed = specs
      .slice(0, TESTS)
      .filter((sp) => !byId.get(sp.id)?.ok)
      .map((sp) => `${sp.id}: ${byId.get(sp.id)?.error ?? 'no result'}`)
    expect(failed).toEqual([])

    const c = byId.get('canary.json')
    expect(c?.ok, 'the canary passed — the runner is not reporting real verdicts').toBe(false)
    expect(c?.error ?? '').not.toBe('')

    // Every test really loaded its own page (ids 1..120, plus the canary's 999).
    for (let id = 1; id <= TESTS; id++)
      expect(served.has(id), `page ${id} never requested`).toBe(true)

    expect(elapsed).toBeLessThan(BUDGET_MS)
    if (before !== null && after !== null) {
      // Bounded while running: one browser per worker (each a handful of
      // processes), NOT one per test.
      expect(peak - before).toBeLessThanOrEqual(workers * 15)
      // And nothing left behind.
      expect(after).toBeLessThanOrEqual(before)
    }
  })
})
