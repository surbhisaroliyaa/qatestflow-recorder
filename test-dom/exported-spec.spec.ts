import { test, expect } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  generatePageObjectTest,
  generatePlaywrightConfig,
  generatePlaywrightTest
} from '../src/renderer/src/playwrightExport'

// =====================================================================
// THE EXPORT CONTRACT GATE  (audit finding QF-001)
// =====================================================================
// Every other test in this repo asks "did we generate the right text?".
// This one asks the only question that actually matters to a user:
//
//        DOES THE EXPORTED SPEC PASS WHEN PLAYWRIGHT RUNS IT?
//
// That gap is what the audit caught. Ticking a checkbox recorded a click
// plus a type whose value was the HTML default "on"; the app replayed it
// green, and the exported spec called .fill('on') on a checkbox, which
// Playwright rejects outright. Green in the app, red in CI — the single
// failure mode that destroys the product's whole promise. Not one unit
// test could see it, because the emitted text was perfectly well-formed
// TypeScript. It was just WRONG.
//
// So this gate does the whole round trip for real:
//   1. serve a fixture page holding every HTML form control
//   2. build the steps a recording of it produces
//   3. run them through the REAL exporters — inline AND page-object
//   4. run the generated files with a REAL `npx playwright test`
//   5. require a green exit
//
// One spec per control, so a failure names the control that broke rather
// than just "the suite went red". Both exporters, always: three shipped
// bugs in this repo were all "the inline exporter got the feature, the
// POM export didn't".
//
// It is deliberately slow and deliberately end-to-end. It belongs to
// `npm run test:dom`, not the one-second `npm test`.
// =====================================================================

// The module is typed against the ambient RecorderStep; tests build partials.
const s = (o: Record<string, unknown>): never => o as never

const GATE_DIR = join(process.cwd(), '.export-gate')

// ── the fixture page ─────────────────────────────────────────────────
// Local and deterministic on purpose: a third-party site going down, or
// quietly restyling a control, would turn this gate into a liar.
const FIXTURE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Every control</title></head>
<body>
  <h1>Every control</h1>
  <form id="f">
    <input id="text" type="text">
    <input id="email" type="email">
    <input id="password" type="password">
    <input id="search" type="search">
    <input id="tel" type="tel">
    <input id="url" type="url">
    <input id="number" type="number">
    <input id="date" type="date">
    <input id="time" type="time">
    <textarea id="textarea"></textarea>
    <select id="select"><option>One</option><option>Two</option></select>
    <input id="checkbox" type="checkbox">
    <label for="labelled-checkbox">I agree</label>
    <input id="labelled-checkbox" type="checkbox">
    <input id="radio-basic" type="radio" name="plan" value="basic">
    <input id="radio-pro" type="radio" name="plan" value="pro">
    <input id="file" type="file">
    <button id="submit" type="button">Submit</button>
  </form>
  <p id="result"></p>
  <script>
    document.getElementById('submit').addEventListener('click', () => {
      document.getElementById('result').textContent = 'Submitted';
    });
  </script>
</body>
</html>`

// ── what a recording of each control looks like ──────────────────────
// `selector` is a locator EXPRESSION (it is appended to `page.`), which is
// exactly what the recorder stores. #id selectors keep this gate focused on
// the ACTION each control produces rather than on selector strategy.
interface Control {
  name: string
  steps: (base: string) => unknown[]
}

const controls: Control[] = [
  // Text-like inputs: these were always fine, and they are here to prove the
  // fix for the checkbox didn't quietly break ordinary text entry.
  ...[
    ['text', 'hello'],
    ['email', 'qa@example.com'],
    ['password', 'hunter2'],
    ['search', 'shoes'],
    ['tel', '+441234567890'],
    ['url', 'https://example.com'],
    ['number', '42'],
    ['date', '2026-09-17'],
    ['time', '14:30']
  ].map(([id, value]) => ({
    name: `input-${id}`,
    steps: (base: string) => [
      s({ type: 'navigate', url: base }),
      s({ type: 'type', selector: `locator("#${id}")`, value, label: id })
    ]
  })),

  {
    name: 'textarea',
    steps: (base) => [
      s({ type: 'navigate', url: base }),
      s({
        type: 'type',
        selector: 'locator("#textarea")',
        value: 'a longer note',
        label: 'Notes'
      })
    ]
  },

  {
    name: 'select',
    steps: (base) => [
      s({ type: 'navigate', url: base }),
      s({ type: 'select', selector: 'locator("#select")', value: 'Two', label: 'Choice' })
    ]
  },

  // ── the blocker itself ─────────────────────────────────────────────
  // Before the fix these steps were a `click` + a `type` of "on", and the
  // generated spec died here with "Cannot fill input[type=checkbox]".
  {
    name: 'checkbox-tick',
    steps: (base) => [
      s({ type: 'navigate', url: base }),
      s({ type: 'check', selector: 'locator("#checkbox")', value: 'true', label: 'Checkbox' })
    ]
  },
  {
    name: 'checkbox-untick',
    steps: (base) => [
      s({ type: 'navigate', url: base }),
      // Tick it, then untick it — proves .uncheck() reaches a ticked box, which
      // asserting on a box that was never ticked would not.
      s({ type: 'check', selector: 'locator("#checkbox")', value: 'true', label: 'Checkbox' }),
      s({ type: 'check', selector: 'locator("#checkbox")', value: 'false', label: 'Checkbox' }),
      s({
        type: 'assert',
        selector: 'locator("#checkbox")',
        assertKind: 'unchecked',
        label: 'Checkbox'
      })
    ]
  },
  {
    name: 'checkbox-via-label',
    steps: (base) => [
      s({ type: 'navigate', url: base }),
      s({
        type: 'check',
        selector: 'locator("#labelled-checkbox")',
        value: 'true',
        label: 'I agree'
      }),
      s({
        type: 'assert',
        selector: 'locator("#labelled-checkbox")',
        assertKind: 'checked',
        label: 'I agree'
      })
    ]
  },
  {
    name: 'radio',
    steps: (base) => [
      s({ type: 'navigate', url: base }),
      s({ type: 'check', selector: 'locator("#radio-pro")', value: 'true', label: 'Pro' }),
      s({
        type: 'assert',
        selector: 'locator("#radio-pro")',
        assertKind: 'checked',
        label: 'Pro'
      })
    ]
  },

  {
    name: 'button',
    steps: (base) => [
      s({ type: 'navigate', url: base }),
      s({ type: 'click', selector: 'locator("#submit")', label: 'Submit' }),
      s({
        type: 'assert',
        selector: 'locator("#result")',
        assertKind: 'text-equals',
        value: 'Submitted',
        label: 'Result'
      })
    ]
  },

  {
    name: 'file-upload',
    steps: (base) => [
      s({ type: 'navigate', url: base }),
      // The exporter rewrites an upload to a PORTABLE `fixtures/<name>` path,
      // so the gate writes that fixture next to the spec exactly as a real
      // export does.
      s({ type: 'upload', selector: 'locator("#file")', value: 'invoice.txt', label: 'Invoice' })
    ]
  }
]

// Write a clean gate folder and export every flow into it, inline AND (when the
// exporter offers one) page-object. Returns the spec names written.
function exportInto(
  flows: {
    name: string
    steps: unknown[]
    data?: { columns: string[]; rows: Record<string, string>[] }
  }[]
): string[] {
  rmSync(GATE_DIR, { recursive: true, force: true })
  mkdirSync(join(GATE_DIR, 'fixtures'), { recursive: true })
  // The POM spec imports its classes from './pages/<Class>' while `fileName` is
  // the bare class file — so they belong in a pages/ folder, exactly as the app
  // writes them on disk.
  mkdirSync(join(GATE_DIR, 'pages'), { recursive: true })

  // The app's OWN config generator — so the gate exercises the file a user
  // actually receives. Chromium only: this is a contract check on the generated
  // code, not a cross-browser sweep.
  writeFileSync(join(GATE_DIR, 'playwright.config.ts'), generatePlaywrightConfig(['chromium']))
  writeFileSync(join(GATE_DIR, 'fixtures', 'invoice.txt'), 'invoice\n')

  const written: string[] = []
  for (const flow of flows) {
    const steps = flow.steps as never[]
    const options = { name: flow.name, data: flow.data }

    writeFileSync(
      join(GATE_DIR, `${flow.name}.inline.spec.ts`),
      generatePlaywrightTest(steps, options)
    )
    written.push(`${flow.name}.inline`)

    // A null POM means the exporter declined this flow and the app falls back
    // to inline — legitimate, and not something to fail the gate over.
    const pom = generatePageObjectTest(steps, options)
    if (pom) {
      for (const p of pom.pages) writeFileSync(join(GATE_DIR, 'pages', p.fileName), p.source)
      writeFileSync(join(GATE_DIR, `${flow.name}.pom.spec.ts`), pom.spec)
      written.push(`${flow.name}.pom`)
    }
  }
  return written
}

// Run whatever is in the gate folder with a REAL `npx playwright test`.
//
// spawn, NOT spawnSync: the fixture server lives in THIS process, and a
// synchronous child blocks the event loop — so the server could not answer a
// single request and every generated spec died at page.goto. The harness
// failing in a way that looks exactly like the product failing is the whole
// reason this gate had to be proven before it could be trusted.
async function runGeneratedSpecs(
  extraEnv: Record<string, string> = {}
): Promise<{ status: number | null; output: string }> {
  // Strip the parent run's Playwright env before shelling out, or the child
  // decides it is a nested call and refuses to start.
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv }
  for (const key of Object.keys(env)) {
    if (key.startsWith('PLAYWRIGHT') || key.startsWith('PW_') || key === 'TEST_WORKER_INDEX') {
      delete env[key]
    }
  }
  env.FORCE_COLOR = '0'

  return new Promise((resolve) => {
    const child = spawn(
      'npx',
      ['playwright', 'test', '--config', join(GATE_DIR, 'playwright.config.ts'), '--reporter=list'],
      { cwd: GATE_DIR, env, shell: true }
    )
    let text = ''
    child.stdout.on('data', (d) => (text += d))
    child.stderr.on('data', (d) => (text += d))
    child.on('error', (e) => resolve({ status: 1, output: `${text}\n${e.message}` }))
    child.on('close', (code) => resolve({ status: code, output: text }))
  })
}

test.describe('the exported spec passes when Playwright actually runs it', () => {
  // A nested browser run per control, twice over. This is minutes, not seconds.
  test.setTimeout(10 * 60_000)

  let server: Server
  let base: string

  test.beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(FIXTURE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('fixture server has no port')
    base = `http://127.0.0.1:${addr.port}/`
  })

  test.afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(GATE_DIR, { recursive: true, force: true })
  })

  test('every form control, exported both ways, runs green in real Playwright', async () => {
    const written = exportInto(controls.map((c) => ({ name: c.name, steps: c.steps(base) })))
    const { status, output } = await runGeneratedSpecs()

    expect(
      status,
      `The exported spec FAILED under real Playwright.\n` +
        `This is the QF-001 class of bug: the app can replay a step green while ` +
        `the code it exports does not run at all.\n\n` +
        `Specs generated: ${written.join(', ')}\n\n${output}`
    ).toBe(0)

    // Every spec written must be a spec that ran. A file the runner quietly
    // skipped is indistinguishable from a file that passed, if you only look
    // at the exit code.
    expect(output, `expected all ${written.length} generated specs to run`).toContain(
      `${written.length} passed`
    )

  })

  // A gate nobody has watched fail is decoration. This runs the checkbox model
  // AS IT WAS BEFORE THE FIX — a click plus a type of the HTML default "on" —
  // and requires it to go red. If this test ever passes-by-going-green, the
  // gate above has stopped being able to see the bug it exists to catch.
  test('the gate has teeth: the pre-fix checkbox model still fails under real Playwright', async () => {
    exportInto([
      {
        name: 'legacy-checkbox',
        steps: [
          s({ type: 'navigate', url: base }),
          s({ type: 'click', selector: 'locator("#checkbox")', label: 'Checkbox' }),
          // The exact step the recorder used to produce. `.fill('on')` on a
          // checkbox is what Playwright refuses.
          s({ type: 'type', selector: 'locator("#checkbox")', value: 'on', label: 'Checkbox' })
        ]
      }
    ])
    const { status, output } = await runGeneratedSpecs()

    expect(status, 'the old broken export somehow passed — the gate is blind').not.toBe(0)
    expect(output).toMatch(/fill|checkbox/i)
  })

  // Option A: a protected password column exports as process.env reads — one
  // name per DISTINCT value. This proves the part text-matching can't: that in
  // a real run EACH ROW still gets ITS OWN password. `expected` is an ordinary
  // column carrying what that row's password should be, so a spec that handed
  // every row the same PASSWORD would fail on the second row.
  const matrix = (env: Record<string, string>) => ({
    flows: [
      {
        name: 'protected-matrix',
        steps: [
          s({ type: 'navigate', url: base }),
          s({ type: 'type', selector: 'locator("#password")', value: '{{password}}', label: 'Password', secret: true }),
          s({ type: 'assert', assertKind: 'value', selector: 'locator("#password")', value: '{{expected}}', label: 'Password' })
        ],
        data: {
          columns: ['password', 'expected'],
          rows: [
            { password: '{{secret:sec_alpha}}', expected: 'alpha' },
            { password: '{{secret:sec_beta}}', expected: 'beta' },
            { password: '', expected: '' }
          ]
        }
      }
    ],
    env
  })

  test('a protected password column: every row still gets its own value', async () => {
    const { flows, env } = matrix({ PASSWORD_1: 'alpha', PASSWORD_2: 'beta' })
    const written = exportInto(flows)
    const { status, output } = await runGeneratedSpecs(env)
    expect(status, `a row got the wrong password under real Playwright\n\n${output}`).toBe(0)
    // 3 rows × (inline + POM, when offered)
    expect(output).toContain(`${written.length * 3} passed`)
  })

  test('…and has teeth: one shared PASSWORD for every row goes red', async () => {
    // What the old bundle scrub did. If this goes green, the check above can
    // no longer tell per-value names from a single shared one.
    const { flows } = matrix({})
    exportInto(flows)
    const { status } = await runGeneratedSpecs({ PASSWORD_1: 'alpha', PASSWORD_2: 'alpha' })
    expect(status, 'every row got the same password and it still passed — blind check').not.toBe(0)
  })
})
