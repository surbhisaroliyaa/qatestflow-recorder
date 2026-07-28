// =====================================================================
// PLAYWRIGHT EXPORT
// Turns the recorded steps into a real, runnable Playwright test file.
// This is pure translation: each canonical step already carries a
// Playwright-style locator (its primary `selector`, built on Day 4), so
// we mostly wrap it with the right action (click / fill / selectOption).
// =====================================================================

import { TOKEN_RE, extractTokens } from './dataDriven'
// F37: shared with the replay engine in main, so the exported spec and the
// in-app run can never disagree about how a loop or an if-block behaves.
import { isControlStep, conditionText, repeatText } from '../../shared/controlFlow'

// F33 (CI export): a standard GitHub Actions workflow that runs the exported
// Playwright tests on every push / PR — the official Playwright CI template, so
// a team can drop the exported spec into their repo and it runs in CI unchanged.
// `secretNames` = any {{env:NAME}} tokens the tests use, wired to repo secrets so
// they're never hard-coded (matches how the export reads process.env.NAME).
export function generateCiWorkflow(secretNames: string[] = []): string {
  const envBlock = secretNames.length
    ? '\n        env:\n' +
      secretNames.map((n) => `          ${n}: \${{ secrets.${n} }}`).join('\n')
    : ''
  return `# GitHub Actions — run the exported Playwright tests on every push / PR.
# Place this file at your repo root as .github/workflows/playwright.yml
# (GitHub only picks up workflows under .github/workflows/ at the repo root).
# Assumes a Playwright project (package.json + a playwright config). If the
# exported spec uses {{env:NAME}} values, add each NAME under repo Settings →
# Secrets and variables → Actions.
# To run against a specific environment (F25), give the "Run Playwright tests"
# step a BASE_URL — the exported spec reads process.env.BASE_URL and otherwise
# falls back to the recorded URL. Example:
#   - name: Run Playwright tests
#     run: npx playwright test
#     env:
#       BASE_URL: https://staging.example.com
name: Playwright Tests
on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]
jobs:
  test:
    timeout-minutes: 60
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: lts/*
      - name: Install dependencies
        run: npm ci
      - name: Install Playwright browsers
        run: npx playwright install --with-deps
      - name: Run Playwright tests
        run: npx playwright test${envBlock}
      - uses: actions/upload-artifact@v4
        if: \${{ !cancelled() }}
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 30
`
}

// F17 (cross-browser): a playwright.config.ts with one project per engine, so
// `npx playwright test` runs the exported spec on Chromium + Firefox + WebKit.
// Emitted beside the spec when the export's "cross-browser config" is ticked —
// the same three projects the in-app cross-browser runner uses.
export function generatePlaywrightConfig(
  browsers: ('chromium' | 'firefox' | 'webkit')[] = ['chromium', 'firefox', 'webkit']
): string {
  const DEVICE: Record<string, string> = {
    chromium: 'Desktop Chrome',
    firefox: 'Desktop Firefox',
    webkit: 'Desktop Safari'
  }
  const projects = browsers
    .map((b) => `    { name: '${b}', use: { ...devices['${DEVICE[b]}'] } }`)
    .join(',\n')
  return `// Playwright config — runs the exported test on every browser engine.
// Install once:  npm i -D @playwright/test && npx playwright install
// Run:           npx playwright test            (all projects)
//                npx playwright test --project=webkit   (just one)
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  reporter: [['html', { open: 'never' }]],
  use: { trace: 'on-first-retry' },
  projects: [
${projects}
  ]
})
`
}

// Safely wrap a value in quotes (handles quotes/newlines inside it).
function quote(value: string): string {
  return JSON.stringify(value)
}

// F24: "Name: value" header lines → [name, value] pairs (mirrors main/apiStep
// parseHeaders, kept renderer-local since the export is renderer-side).
function parseHeaderLines(text?: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const line of (text ?? '').split('\n')) {
    const t = line.trim()
    const i = t.indexOf(':')
    if (i <= 0) continue
    out.push([t.slice(0, i).trim(), t.slice(i + 1).trim()])
  }
  return out
}

// F24: the status assertion for an exported API step, given the response var.
//   blank         → res.ok() (any 2xx)
//   "Nxx" family  → a range check
//   exact number  → toBe
function apiStatusAssertion(expect: string | undefined, resVar: string): string {
  const e = (expect ?? '').trim().toLowerCase()
  if (!e) return `expect(${resVar}.ok(), 'status is 2xx').toBeTruthy()`
  // F24.1: a comma-separated list ("204,404") means ANY of them — the idempotent
  // teardown form. Emitted as a membership check so the exported test is just as
  // re-runnable as the in-app one.
  const parts = e
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length > 1) {
    const codes: string[] = []
    for (const p of parts) {
      const fam = /^([1-5])xx$/.exec(p)
      if (fam) {
        const lo = Number(fam[1]) * 100
        for (let c = lo; c < lo + 100; c++) codes.push(String(c))
      } else if (Number.isFinite(Number(p))) {
        codes.push(String(Number(p)))
      }
    }
    // A whole family expands to 100 codes — keep the emitted line readable by
    // range-checking instead when that happens.
    if (codes.length > 8) {
      return `expect([${parts.map((p) => quote(p)).join(', ')}].some((s) => s.endsWith('xx') ? Math.floor(${resVar}.status() / 100) === Number(s[0]) : Number(s) === ${resVar}.status()), 'status is one of ${e}').toBeTruthy()`
    }
    return `expect([${codes.join(', ')}], 'status is one of ${e}').toContain(${resVar}.status())`
  }
  const fam = /^([1-5])xx$/.exec(e)
  if (fam) {
    const lo = Number(fam[1]) * 100
    return (
      `expect(${resVar}.status(), 'status ${e}').toBeGreaterThanOrEqual(${lo})\n` +
      `    expect(${resVar}.status()).toBeLessThan(${lo + 100})`
    )
  }
  return `expect(${resVar}.status(), 'status').toBe(${Number(e)})`
}

// F13 (a11y assertion step): severities worst→least. The step's `value` is the
// budget — the least severe impact that still fails; unknown/absent → 'serious'.
const A11Y_LEVELS = ['critical', 'serious', 'moderate', 'minor']
function a11yThreshold(value?: string): string {
  return value && A11Y_LEVELS.includes(value) ? value : 'serious'
}
// The impacts that COUNT as a failure at a given budget (the level + everything
// worse than it). 'serious' → ['critical','serious'].
function a11yBlockingImpacts(value?: string): string[] {
  return A11Y_LEVELS.slice(0, A11Y_LEVELS.indexOf(a11yThreshold(value)) + 1)
}

// WCAG tags the exported AxeBuilder runs — mirrors the in-app scan.
const A11Y_WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

// F14 (perf gate): budget → the Core Web Vitals ceilings the exported test
// asserts. 'good' is strict (good thresholds); anything else = the default,
// fail only when a metric is 'poor' (assert against the poor floors).
function perfBudget(value?: string): { label: string; lcp: number; cls: number } {
  return value === 'good'
    ? { label: 'good', lcp: 2500, cls: 0.1 }
    : { label: 'needs-improvement', lcp: 4000, cls: 0.25 }
}

// A valid JS identifier? Decides `data.col` vs `data["col"]` (and the same for
// process.env access).
function isIdent(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
}

// === Data-driven values (Day 20) ===
// A recognized {{token}} becomes a JS reference; everything else is a literal.
//   {{env:NAME}}  → process.env.NAME ?? ''   (a real secret, never inlined)
//   {{column}}    → data.column              (when `column` is a data column)
//   {{unknown}}   → null                     (left as literal text)
function tokenRef(name: string, columns: string[]): string | null {
  if (name.startsWith('env:')) {
    const v = name.slice('env:'.length).trim()
    return isIdent(v) ? `process.env.${v} ?? ''` : `process.env[${quote(v)}] ?? ''`
  }
  // F24.1: the runtime tokens the app resolves mid-run must have an equivalent in
  // the exported spec, or a test that runs green in the app would fail in CI —
  // the export is a PROMISE that the two behave the same.
  if (name.startsWith('saved:')) {
    const v = name.slice('saved:'.length).trim()
    return isIdent(v) ? `saved.${v}` : `saved[${quote(v)}]`
  }
  if (name === 'uuid') return 'runUuid'
  if (name === 'timestamp') return 'runTimestamp'
  if (name === 'randomInt') return 'runRandomInt'
  if (columns.includes(name)) return isIdent(name) ? `data.${name}` : `data[${quote(name)}]`
  return null
}

// F24.1: which runtime helpers does this test actually need? Only the ones used
// get declared, so an ordinary export stays byte-for-byte unchanged.
export function runtimeTokenUse(steps: RecorderStep[]): {
  uuid: boolean
  timestamp: boolean
  randomInt: boolean
  saved: boolean
} {
  const all = steps
    // apiChecks/apiExpectBody belong here too: a token can live ONLY in a check
    // (`id equals {{saved:objId}}`), and if this list misses it, the spec compiles a
    // reference to `saved` / `runUuid` that was never declared — a spec that doesn't
    // even build. Same omission as the app's own token resolver had.
    .flatMap((s) => [s.value, s.url, s.apiHeaders, s.apiBody, s.apiChecks, s.apiExpectBody])
    .filter((f): f is string => typeof f === 'string')
    .flatMap((f) => extractTokens(f))
  return {
    uuid: all.includes('uuid'),
    timestamp: all.includes('timestamp'),
    randomInt: all.includes('randomInt'),
    // `saved` is needed to READ a value, and also to WRITE one (an api step with
    // a save spec declares the object even if nothing reads it yet).
    saved:
      all.some((t) => t.startsWith('saved:')) ||
      steps.some((s) => (s.apiSave ?? '').trim().length > 0)
  }
}

// The `const` block that opens a test body when runtime tokens are in play.
export function runtimeTokenPreamble(steps: RecorderStep[], indent = '  '): string {
  const use = runtimeTokenUse(steps)
  const lines: string[] = []
  if (use.uuid || use.timestamp || use.randomInt) {
    lines.push(
      `${indent}// Fresh every run, so a re-run never collides with the data the last one left behind.`
    )
  }
  if (use.uuid) lines.push(`${indent}const runUuid = randomUUID()`)
  if (use.timestamp) lines.push(`${indent}const runTimestamp = String(Date.now())`)
  if (use.randomInt) {
    lines.push(`${indent}const runRandomInt = String(Math.floor(Math.random() * 1_000_000))`)
  }
  if (use.saved) {
    lines.push(`${indent}// Values lifted out of API responses (the server invents them).`)
    lines.push(`${indent}const saved: Record<string, string> = {}`)
  }
  return lines.length ? lines.join('\n') + '\n\n' : ''
}

// A dot path ("data.items.0.sku") as a JS member expression on `body`.
function pathExpr(path: string): string {
  let expr = 'body'
  for (const rawSeg of path.split('.')) {
    const seg = rawSeg.trim()
    if (!seg) continue
    if (/^\d+$/.test(seg)) expr += `[${seg}]`
    else if (isIdent(seg)) expr += `.${seg}`
    else expr += `[${quote(seg)}]`
  }
  return expr
}

// F24.2: the response checks, as real Playwright assertions. Each one names the
// path in its message, so a CI failure reads the same as the in-app one.
// Does any api step carry response checks? (Decides whether the shared check
// helper is emitted at the top of the file.)
export function anyApiChecks(steps: RecorderStep[]): boolean {
  return steps.some(
    (s) =>
      s.type === 'api' &&
      (s.apiChecks ?? '')
        .split('\n')
        .some((l) => l.trim() && !l.trim().startsWith('#'))
  )
}

// F24.2: the response-check engine, emitted ONCE into the exported spec.
//
// It used to be hand-translated per operator into the nearest Playwright matcher
// — `not-empty` → toBeTruthy(), `empty` → toBeFalsy(), and so on. Those aren't the
// same thing: `[]` is truthy in JS, so the app failed `items not-empty` on an empty
// list while the export PASSED it; `0` is falsy, so the export failed `count empty`
// on zero while the app passed. An unknown operator was a red step in the app and a
// `// comment` in CI. The app and its own export disagreed about what the test meant.
//
// So the export now ships the SAME implementation the app runs (mirrors runCheck in
// src/main/apiChecks.ts). One meaning, two places to run it.
const API_CHECK_HELPER = `// ── QATestFlow: API response checks (mirrors the in-app engine exactly) ──
const __MISSING = Symbol('missing')
function __readField(body: unknown, path: string): unknown {
  let cur: unknown = body
  for (const seg of path.split('.')) {
    const key = seg.trim()
    if (!key) continue
    if (cur == null) return __MISSING
    if (Array.isArray(cur)) {
      const i = Number(key)
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return __MISSING
      cur = cur[i]
    } else if (typeof cur === 'object') {
      const o = cur as Record<string, unknown>
      if (!(key in o)) return __MISSING
      cur = o[key]
    } else return __MISSING
  }
  return cur
}
const __show = (v: unknown): string =>
  v === __MISSING ? '(absent)' : v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : String(v)
// null takes no article — "is null", never "is a null". (Mirrors apiChecks.ts.)
const __article = (t: string): string =>
  t === 'null' ? t : /^[aeiou]/i.test(t) ? \`an \${t}\` : \`a \${t}\`
function __why(body: unknown, headers: Record<string, string>, path: string, op: string, expected: string): string | null {
  if (!op) return \`"\${path}" isn't a check — write it as: <field> <operator> [value]\`
  if (path.toLowerCase().startsWith('header:')) {
    const name = path.slice(7).toLowerCase()
    const actual = headers[name]
    if (actual === undefined) return op === 'not-exists' ? null : \`the response has no "\${name}" header\`
    if (op === 'exists') return null
    if (op === 'not-exists') return \`header "\${name}" IS present ("\${actual}") — expected it to be absent\`
    if (op === 'equals') {
      return actual.toLowerCase() === expected.toLowerCase() ? null : \`header "\${name}" is "\${actual}", expected "\${expected}"\`
    }
    if (op === 'contains') {
      return actual.toLowerCase().includes(expected.toLowerCase()) ? null : \`header "\${name}" is "\${actual}", which does not contain "\${expected}"\`
    }
    return \`unknown operator "\${op}" for a header check\`
  }
  const value = __readField(body, path)
  const absent = value === __MISSING
  switch (op) {
    case 'exists':
      return absent ? \`"\${path}" is not in the response\` : null
    case 'not-exists':
      return absent ? null : \`"\${path}" IS in the response (\${__show(value)}) — expected it to be absent\`
    case 'not-empty':
      if (absent) return \`"\${path}" is not in the response\`
      if (value === null || value === '') return \`"\${path}" is \${__show(value)} — expected a value\`
      if (Array.isArray(value) && value.length === 0) return \`"\${path}" is an empty array\`
      return null
    case 'empty':
      if (absent || value === null || value === '') return null
      if (Array.isArray(value) && value.length === 0) return null
      return \`"\${path}" is \${__show(value)} — expected it to be empty\`
    case 'equals':
      if (absent) return \`"\${path}" is not in the response (expected "\${expected}")\`
      return String(value) === expected ? null : \`"\${path}" is \${__show(value)}, expected "\${expected}"\`
    case 'not-equals':
      if (absent) return \`"\${path}" is not in the response — a not-equals check can't pass on a field that isn't there\`
      return String(value) !== expected ? null : \`"\${path}" is "\${expected}" — expected it not to be\`
    case 'contains':
      if (absent) return \`"\${path}" is not in the response\`
      return String(value).includes(expected) ? null : \`"\${path}" is \${__show(value)}, which does not contain "\${expected}"\`
    case 'not-contains':
      if (absent) return \`"\${path}" is not in the response — a not-contains check can't pass on a field that isn't there\`
      return !String(value).includes(expected) ? null : \`"\${path}" is \${__show(value)}, which contains "\${expected}"\`
    case 'gt':
    case 'lt': {
      if (absent) return \`"\${path}" is not in the response\`
      if (value === null || typeof value === 'boolean' || typeof value === 'object' || value === '') {
        return \`"\${path}" is \${__show(value)}, which is not a number\`
      }
      const n = Number(value)
      const target = Number(expected)
      if (!Number.isFinite(n)) return \`"\${path}" is \${__show(value)}, which is not a number\`
      if (!Number.isFinite(target)) return \`"\${expected}" is not a number\`
      if (op === 'gt') return n > target ? null : \`"\${path}" is \${n}, expected greater than \${target}\`
      return n < target ? null : \`"\${path}" is \${n}, expected less than \${target}\`
    }
    case 'count-eq':
    case 'count-gt':
    case 'count-lt': {
      if (absent) return \`"\${path}" is not in the response\`
      if (!Array.isArray(value)) return \`"\${path}" is \${__show(value)}, which is not an array\`
      const n = value.length
      const target = Number(expected)
      if (!Number.isFinite(target)) return \`"\${expected}" is not a number\`
      if (op === 'count-eq') return n === target ? null : \`"\${path}" has \${n} items, expected \${target}\`
      if (op === 'count-gt') return n > target ? null : \`"\${path}" has \${n} items, expected more than \${target}\`
      return n < target ? null : \`"\${path}" has \${n} items, expected fewer than \${target}\`
    }
    case 'is-number':
    case 'is-string':
    case 'is-boolean':
    case 'is-array': {
      if (absent) return \`"\${path}" is not in the response\`
      const want = op.slice(3)
      const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
      return actual === want ? null : \`"\${path}" is \${__article(actual)}, expected \${__article(want)}\`
    }
    default:
      return \`unknown check "\${op}"\`
  }
}
// Reports EVERY failing check at once, not just the first — you fix them in one pass.
function __expectChecks(body: unknown, headers: Record<string, string>, list: [string, string, string][]): void {
  const failures = list
    .map(([p, op, exp]) => {
      const why = __why(body, headers, p, op, exp)
      return why ? \`\${[p, op, exp].filter(Boolean).join(' ')} — \${why}\` : null
    })
    .filter(Boolean)
  expect(failures, 'API response checks').toEqual([])
}
`

// `columns` is here so a check line's TOKENS compile to real references, exactly as
// the url/headers/body already do. Without it the export emitted
// ["id", "equals", "{{saved:objId}}"] — the LITERAL token — so the single most
// natural API assertion there is ("the GET returns the id my POST just created")
// passed in the app and failed in CI. The app learned to resolve tokens in check
// lines; the exporter didn't. Same feature, two implementations, one got the fix.
function apiCheckLines(step: RecorderStep, ind: string, columns: string[] = []): string {
  const lines: string[] = []
  const raw = (step.apiChecks ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  const contract = step.apiContract && Object.keys(step.apiContract).length ? step.apiContract : null
  if (!raw.length && !contract) return ''

  // A line that doesn't parse is kept with an empty op, exactly as the app keeps it
  // — so the exported test FAILS on it too, instead of quietly not running it.
  const parsed = raw.map((line) => {
    const m = /^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(line)
    if (!m) return { path: line, op: '', expected: '' }
    return { path: m[1], op: m[2].toLowerCase(), expected: (m[3] ?? '').trim() }
  })

  const needsBody =
    !!contract || parsed.some((c) => !!c.op && !/^header:/i.test(c.path)) || parsed.some((c) => !c.op)
  if (needsBody) lines.push(`${ind}const body = await res.json()`)

  if (parsed.length) {
    // valueExpr, NOT quote: `{{saved:objId}}` has to compile to `saved.objId`, a
    // {{column}} to `data.column`, {{uuid}} to `runUuid` — the same substitution the
    // app performs at run time. quote() froze the token into a string literal, and
    // the check then compared the response against the text "{{saved:objId}}".
    const table = parsed
      .map(
        (c) =>
          `${ind}  [${valueExpr(c.path, columns)}, ${quote(c.op)}, ${valueExpr(c.expected, columns)}]`
      )
      .join(',\n')
    lines.push(
      `${ind}__expectChecks(${needsBody ? 'body' : 'null'}, res.headers(), [\n${table}\n${ind}])`
    )
  }

  // The contract: every captured field must still be there, with the same type.
  // Emitted as data + a loop rather than N assertions, so a 40-field contract
  // doesn't bury the rest of the test.
  if (contract) {
    const entries = Object.entries(contract)
      .map(([p, t]) => `${ind}  [${quote(p)}, ${quote(t)}]`)
      .join(',\n')
    lines.push(
      `${ind}// 📐 Contract — fails if a field was renamed, dropped, or changed type.`,
      `${ind}const contract: [string, string][] = [\n${entries}\n${ind}]`,
      `${ind}const shapeOf = (v: unknown): string =>`,
      `${ind}  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v`,
      `${ind}const readShape = (o: unknown, p: string): unknown =>`,
      `${ind}  p.split('.').reduce<unknown>((cur, k) => {`,
      `${ind}    if (cur == null) return undefined`,
      `${ind}    if (k.endsWith('[]')) {`,
      `${ind}      const arr = (cur as Record<string, unknown>)[k.slice(0, -2)]`,
      `${ind}      return Array.isArray(arr) ? arr[0] : undefined`,
      `${ind}    }`,
      `${ind}    return (cur as Record<string, unknown>)[k]`,
      `${ind}  }, o)`,
      `${ind}for (const [p, want] of contract) {`,
      `${ind}  const actual = shapeOf(readShape(body, p))`,
      `${ind}  expect(actual, \`contract: \${p} (was \${want})\`).toBe(want)`,
      `${ind}}`
    )
  }

  return lines.length ? '\n' + lines.join('\n') : ''
}

// The lines that lift saved values out of an API response in the exported spec.
// `bodyDeclared` says whether apiCheckLines already emitted `const body = …` in
// this block — declaring it twice would be a duplicate-const syntax error.
function apiSaveLines(step: RecorderStep, indentStr: string, bodyDeclared: boolean): string {
  const specs = (step.apiSave ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const eq = l.indexOf('=')
      return eq > 0
        ? { name: l.slice(0, eq).trim(), path: l.slice(eq + 1).trim() }
        : { name: '', path: '' }
    })
    .filter((s) => s.name && s.path)
  if (!specs.length) return ''
  const out = bodyDeclared ? [] : [`\n${indentStr}const body = await res.json()`]
  for (const { name, path } of specs) {
    const key = isIdent(name) ? `saved.${name}` : `saved[${quote(name)}]`
    out.push(`\n${indentStr}${key} = String(${pathExpr(path)})`)
  }
  return out.join('')
}

// Does this step's check block declare `body`? (Mirrors apiCheckLines' own rule.)
// F24.3: hand an API login's session to the BROWSER, in the exported spec.
//
// This used to be emitted NOWHERE. The exported test fired the login request and
// threw its cookies away, so every UI step after it ran LOGGED OUT — green in the
// app, failing in CI for reasons ("can't find the Add to Cart button") that look
// nothing like the cause. Cross-browser runs go through this exporter too, so they
// inherited it three times over.
//
// Cookies: Playwright's `request` fixture keeps its own cookie jar and follows
// redirects, so storageState() already holds every Set-Cookie from the whole chain
// (including the 302 hop a form login answers with). Copy that jar into the browser
// context and the next navigation is authenticated.
function apiInjectLines(
  step: RecorderStep,
  ind: string,
  pageVar: string,
  columns: string[]
): string {
  const lines: string[] = []

  if (step.apiInjectCookies) {
    lines.push(`// 🔑 Log the browser in with this response's cookies.`)
    lines.push(`const { cookies } = await request.storageState()`)
    // Fail LOUDLY on an empty jar. A silent no-op here leaves the browser logged
    // out and turns every later step into a mystery. (This is the same guard the
    // app runs — they must agree.)
    lines.push(
      `expect(cookies, '🔑 the API login returned no cookies — the browser would run logged OUT').not.toHaveLength(0)`
    )
    lines.push(`await ${pageVar}.context().addCookies(cookies)`)
  }

  // localStorage: "key = value" per line. It belongs to an ORIGIN, so the browser
  // has to already be on the app — same rule (and same loud failure) as the app.
  const entries: Array<[string, string]> = []
  for (const line of (step.apiInjectStorage ?? '').split('\n')) {
    const t = line.trim()
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const key = t.slice(0, eq).trim()
    if (key) entries.push([key, t.slice(eq + 1).trim()])
  }
  if (entries.length) {
    const pairs = entries.map(([k, v]) => `[${quote(k)}, ${valueExpr(v, columns)}]`).join(', ')
    lines.push(`// 🔑 Log the browser in with a token from this response's body.`)
    lines.push(
      `expect(${pageVar}.url(), 'localStorage needs an origin — navigate to the app first').toMatch(/^https?:/)`
    )
    lines.push(
      `await ${pageVar}.evaluate((entries) => { for (const [k, v] of entries) localStorage.setItem(k, v) }, [${pairs}])`
    )
  }

  if (!lines.length) return ''
  return `\n${lines.map((l) => `${ind}${l}`).join('\n')}`
}

function checksDeclareBody(step: RecorderStep): boolean {
  const checks = (step.apiChecks ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  const hasContract = !!(step.apiContract && Object.keys(step.apiContract).length)
  return hasContract || checks.some((l) => !/^header:/i.test(l))
}

// Turn a possibly-tokenized user value into a JS EXPRESSION for the export:
//   "secret_sauce"        → "secret_sauce"            (a quoted string)
//   "{{password}}"        → data.password             (a bare reference)
//   "Hi {{name}}!"        → `Hi ${data.name}!`        (a template literal)
// With no recognized tokens it's identical to quote(), so a normal (non-data)
// export is byte-for-byte unchanged.
function valueExpr(raw: string, columns: string[]): string {
  const recognized = extractTokens(raw).some((t) => tokenRef(t, columns) !== null)
  if (!recognized) return quote(raw)
  // Whole string is exactly one recognized token → a bare reference.
  const whole = raw.match(/^\s*\{\{\s*([A-Za-z0-9_:.\- ]+?)\s*\}\}\s*$/)
  if (whole) {
    const ref = tokenRef(whole[1].trim(), columns)
    if (ref) return ref
  }
  // Mixed text + tokens → a template literal. Escape the literal parts first
  // (backtick / backslash / $), then swap each recognized token for ${ref}.
  const tpl = raw.replace(/[`\\$]/g, '\\$&').replace(TOKEN_RE, (m, name) => {
    const ref = tokenRef(String(name).trim(), columns)
    return ref ? '${' + ref + '}' : m
  })
  return '`' + tpl + '`'
}

// Whether a value carries at least one recognized token (so a regex/number
// spot must build an expression instead of a compile-time literal).
function hasRefs(raw: string, columns: string[]): boolean {
  return extractTokens(raw).some((t) => tokenRef(t, columns) !== null)
}

// A data row as an object literal for the exported `dataset` array. Cells can
// only carry env tokens (not data refs — that would be circular), so columns
// is empty here: a {{env:…}} cell becomes process.env, anything else a string.
function rowLiteral(row: Record<string, string>, columns: string[]): string {
  const props = columns.map((c) => {
    const key = isIdent(c) ? c : quote(c)
    return `${key}: ${valueExpr(row[c] ?? '', [])}`
  })
  return `{ ${props.join(', ')} }`
}

// Day 17 (page-object export): turn a step's human label into a camelCase JS
// identifier for a named locator const, e.g. "Login button" -> "loginButton".
function camelName(label: string): string {
  const words = (label || 'el')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return 'el'
  const camel = words
    .map((w, i) =>
      i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    )
    .join('')
  // A JS identifier can't start with a digit.
  return /^[a-zA-Z_]/.test(camel) ? camel : `el${camel.charAt(0).toUpperCase()}${camel.slice(1)}`
}

// PascalCase version for a class name, e.g. "saucedemo login" -> "SaucedemoLogin".
function pascalName(label: string): string {
  const c = camelName(label)
  return c.charAt(0).toUpperCase() + c.slice(1)
}

// Day 15/17: scope a locator to the right page AND frame. `pageVar` is the page
// the step runs in (`page` for single-tab tests, `page0`/`page1`/… for multi-
// window ones — see generatePlaywrightTest). Day 15: if the step happened inside
// an <iframe>, chain page.frameLocator(...) onto it (name/id preferred, src URL
// fallback; nested frames chain).
function pageBase(pageVar: string, frame?: FrameRef): string {
  if (!frame || !frame.length) return pageVar
  return frame.reduce((base, f) => {
    const sel = f.name ? `iframe[name=${quote(f.name)}]` : `iframe[src=${quote(f.url)}]`
    return `${base}.frameLocator(${quote(sel)})`
  }, pageVar)
}

// Playwright's toHaveURL(string) demands the FULL exact URL — too brittle for
// a "URL contains" check (query params, session ids). A regex does partial
// matching, so we export one — with the user's text escaped, or "/inventory.html"
// would treat its dot as "any character".
function regexContains(value: string): string {
  return `new RegExp(${quote(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))})`
}

// One readable line describing a step — used both in the live panel and as a
// comment above each generated line of code. Secret (password) values are
// shown masked so they never appear on screen or in code comments.
export function stepText(step: RecorderStep): string {
  switch (step.type) {
    case 'navigate':
      return `Go to ${step.url}`
    case 'back':
      return 'Go back'
    // === F37: loops + branching ===
    case 'repeat':
      return `🔁 Repeat ${repeatText(step.repeatKind, step.label, step.value)}`
    case 'endRepeat':
      return '🔁 End repeat'
    case 'if':
      return `🔀 If ${conditionText(step.condKind, step.label, step.value)}`
    case 'else':
      return '🔀 Otherwise'
    case 'endIf':
      return '🔀 End if'
    case 'block':
      // A live reference to a saved block — shown in the UI; expanded to the
      // block's real steps before any code is generated (never reaches actionFor).
      return `🧩 ${step.label ?? 'Block'} — linked block`
    case 'closeTab':
      return `Close tab ${step.windowId ?? ''}`.trim()
    case 'snapshot':
      return `Visual snapshot${step.value ? ` (≤ ${step.value}% diff)` : ''}`
    case 'a11y':
      return `Check accessibility — no ${a11yThreshold(step.value)}+ violations`
    case 'perf':
      return `Check performance — Core Web Vitals within "${perfBudget(step.value).label}"`
    case 'api': {
      const method = step.apiMethod ?? 'GET'
      const status = (step.apiExpectStatus ?? '').trim() || '2xx'
      const body = (step.apiExpectBody ?? '').trim() ? `, body contains "${step.apiExpectBody!.trim()}"` : ''
      return `API ${method} ${step.url ?? ''} → expect ${status}${body}`
    }
    case 'click':
      return `Click ${step.label}`
    case 'type':
      return `Type "${step.secret ? '••••••••' : step.value}" into ${step.label}`
    case 'select':
      return `Select "${step.value}" in ${step.label}`
    case 'press':
      return `Press ${step.key ?? 'Enter'} in ${step.label}`
    case 'hover':
      return `Hover over ${step.label}`
    case 'assert':
      switch (step.assertKind) {
        case 'text-equals':
          return `Check ${step.label} text is "${step.value}"`
        case 'text-contains':
          return `Check ${step.label} contains "${step.value}"`
        case 'value':
          return `Check ${step.label} value is "${step.value}"`
        case 'enabled':
          return `Check ${step.label} is enabled`
        case 'disabled':
          return `Check ${step.label} is disabled`
        case 'checked':
          return `Check ${step.label} is checked`
        case 'unchecked':
          return `Check ${step.label} is not checked`
        case 'hidden':
          return `Check ${step.label} is hidden`
        case 'count':
          return `Check ${step.label} matches ${step.value} element(s)`
        case 'focused':
          return `Check ${step.label} is focused`
        case 'editable':
          return `Check ${step.label} is editable`
        case 'empty':
          return `Check ${step.label} is empty`
        case 'attribute':
          return `Check ${step.label} attribute ${step.attrName} is "${step.value}"`
        case 'class':
          return `Check ${step.label} has class "${step.value}"`
        case 'url-contains':
          return `Check URL contains "${step.value}"`
        case 'title':
          return `Check page title is "${step.value}"`
        case 'nl':
          return `AI check: "${step.value}"`
        default:
          return `Check ${step.label} is visible`
      }
    case 'wait': {
      const kind = step.waitKind ?? 'time'
      if (kind === 'network-idle') return 'Wait for network to go idle'
      if (kind === 'text') return `Wait for text "${step.value ?? ''}" to appear`
      if (kind === 'manual') return `Manual step: ${step.value ?? 'wait for a human'}`
      return `Wait ${step.value ?? '1'}s`
    }
    case 'dialog':
      switch (step.dialogKind) {
        case 'alert':
          return `Dismiss alert "${step.label ?? ''}"`
        case 'confirm':
          return `${step.value === 'dismiss' ? 'Dismiss' : 'Accept'} confirm "${step.label ?? ''}"`
        case 'prompt':
          return `Answer prompt "${step.label ?? ''}" with "${step.value ?? ''}"`
        default:
          return 'Handle dialog'
      }
    case 'upload': {
      const n = (step.value ?? '').split('\n').filter(Boolean).length
      return `Upload ${n > 1 ? `${n} files` : `"${step.label ?? 'file'}"`}`
    }
    case 'download': {
      // Day 16(+): the step VERIFIES the download on replay — phrase it as the
      // check we run, not a claim about the file. `value` is the expected
      // filename (defaults to the recorded name).
      const want = (step.value ?? step.label ?? 'file').trim()
      return `Download "${want}" — verify it's not empty`
    }
    default:
      return JSON.stringify(step)
  }
}

// Day 16: a dialog is answered by a handler REGISTERED BEFORE the action that
// triggers it (Playwright's page.once('dialog', …)), so it's emitted just ahead
// of its trigger by the generator — not as its own line here.
function dialogHandler(step: RecorderStep, pageVar: string): string {
  if (step.dialogKind === 'confirm' && step.value === 'dismiss') {
    return `${pageVar}.once('dialog', (dialog) => dialog.dismiss())`
  }
  if (step.dialogKind === 'prompt') {
    return `${pageVar}.once('dialog', (dialog) => dialog.accept(${quote(step.value ?? '')}))`
  }
  return `${pageVar}.once('dialog', (dialog) => dialog.accept())`
}

// =====================================================================
// TEST-ID PORTABILITY
// The recorder reads a test id from EITHER `data-test` or `data-testid`, but
// real Playwright's `getByTestId()` resolves exactly ONE attribute (default
// `data-testid`). So an exported `getByTestId('username')` silently matches
// nothing on a site using `data-test` — the locator just times out.
//
// Fix: when every test-id step agrees on the attribute (recorded as
// `testIdAttr`), the file declares it once via `test.use({ testIdAttribute })`
// and keeps the idiomatic `getByTestId(...)`. When the attribute is UNKNOWN
// (tests recorded before we captured it) or MIXED across steps, we fall back to
// a both-attribute CSS locator, which is correct without any config.
// =====================================================================

// Does this step's primary selector use getByTestId? Returns the trailing
// modifiers (e.g. `.nth(1)`) so a rewrite can preserve them.
function testIdParts(step: RecorderStep): { value: string; suffix: string } | null {
  const m = /^getByTestId\((['"])([\s\S]*?)\1\)([\s\S]*)$/.exec(step.selector ?? '')
  return m ? { value: m[2], suffix: m[3] ?? '' } : null
}

function testIdAttrOf(step: RecorderStep): 'data-test' | 'data-testid' | undefined {
  return step.candidates?.find((c) => c.kind === 'testId')?.testIdAttr
}

// A both-attribute locator for a getByTestId step (the portable fallback).
function portableTestIdSelector(step: RecorderStep): string | null {
  const parts = testIdParts(step)
  if (!parts) return null
  const cand = step.candidates?.find((c) => c.kind === 'testId')
  const css = cand?.css ?? `[data-test="${parts.value}"], [data-testid="${parts.value}"]`
  return `locator(${quote(css)})${parts.suffix}`
}

// Decide, for a whole file: keep getByTestId (+ declare the attribute), or emit
// portable locators. `attr` is undefined when there are no test-id steps.
export function testIdPolicy(steps: RecorderStep[]): {
  portable: boolean
  attr?: 'data-test' | 'data-testid'
} {
  const idSteps = steps.filter((s) => testIdParts(s) !== null)
  if (idSteps.length === 0) return { portable: false }
  const attrs = new Set(idSteps.map((s) => testIdAttrOf(s)).filter(Boolean))
  const allKnown = idSteps.every((s) => !!testIdAttrOf(s))
  if (allKnown && attrs.size === 1) {
    return { portable: false, attr: [...attrs][0] as 'data-test' | 'data-testid' }
  }
  return { portable: true } // unknown (legacy) or mixed → no single attribute works
}

// F26: an optional step (a cookie banner that may not appear) is wrapped in
// try/catch so its ABSENCE is skipped rather than failing the test — matching
// how replay treats it. Shared by the inline and page-object exports so the
// same test exported two ways behaves the same way.
//
// Caveat, same as in-app: this catch swallows any error from the action, not
// only "element not found". Playwright has no "fail only if present" primitive
// short of an explicit count()/isVisible() guard, so a wrapped optional ASSERT
// is weaker in the export than it is in the app (where the run loop gates the
// skip on a selector break). Optional is meant for dismissal steps.
/**
 * F37 — an `if` step's condition, as a Playwright expression.
 *
 * Element checks use `.isVisible()` with a `.catch(() => false)`, mirroring
 * replay's probe: a condition asks a QUESTION, so "the element isn't there" is
 * an answer (false → take the else branch), never a thrown failure. Without the
 * catch, a detached/navigating element would abort the whole test at exactly
 * the moment the author was trying to handle gracefully.
 */
/**
 * F38 — the second argument to `test()`, carrying its tags.
 *
 * Playwright's native form is `test('name', { tag: ['@smoke'] }, async …)`,
 * which `--grep @smoke` matches and which shows up in the HTML report. Emitting
 * nothing when there are no tags keeps an untagged test byte-identical to what
 * it exported before F38.
 */
function tagArgFor(tags: string[] | undefined): string {
  const clean = (tags ?? []).filter((t) => t && t.startsWith('@'))
  if (!clean.length) return ''
  return `, { tag: [${clean.map((t) => quote(t)).join(', ')}] }`
}

/** Did anything actually nest? Lets a plain test skip the re-indent entirely
 *  and stay byte-identical to what it exported before F37. */
function depthUsed(depths: number[]): boolean {
  return depths.some((d) => d > 0)
}

function conditionExpr(step: RecorderStep, pageVar: string, portableTestId: boolean): string {
  const kind = step.condKind ?? 'element-visible'
  if (kind === 'url-contains') {
    return `${pageVar}.url().includes(${quote(step.value ?? '')})`
  }
  if (kind === 'text-present' || kind === 'text-absent') {
    const expr = `(await ${pageVar}.locator('body').innerText()).includes(${quote(step.value ?? '')})`
    return kind === 'text-present' ? expr : `!${expr}`
  }
  const sel = (portableTestId && portableTestIdSelector(step)) || step.selector
  if (!sel) return kind === 'element-absent' ? 'true' : 'false'
  const visible = `await ${pageBase(pageVar, step.frame)}.${sel}.isVisible().catch(() => false)`
  return kind === 'element-absent' ? `!(${visible})` : `(${visible})`
}

function wrapOptional(line: string, pad: string): string {
  return (
    `${pad}try {\n` +
    `${pad}  ${line}\n` +
    `${pad}} catch { /* optional step: element not present, skipped */ }`
  )
}

// The actual Playwright action for one step (without the leading comment).
// `baseURL`: when a navigate's URL lives under it, emit just the PATH —
// `test.use({ baseURL })` (added by the generator, itself reading
// process.env.BASE_URL — F25) resolves it at runtime, so retargeting the whole
// suite at another environment is one BASE_URL env var, no file edit.
function actionFor(
  step: RecorderStep,
  baseURL: string | undefined,
  pageVar: string,
  // Day 17 (page-object export): when set, the step's element is referenced via
  // this pre-declared const (e.g. `loginButton`) instead of an inline locator.
  elementLocator?: string,
  // Day 20 (data-driven): the data columns in play. A value containing a
  // {{column}} or {{env:…}} token is emitted as an expression (data.x /
  // process.env.X) instead of a quoted literal. Empty = no data → quote().
  columns: string[] = [],
  // When true, rewrite getByTestId(…) to a both-attribute CSS locator (see above).
  portableTestId = false
): string | null {
  if (step.type === 'navigate') {
    let url = step.url ?? ''
    if (baseURL && url.startsWith(baseURL)) {
      url = url.slice(baseURL.length) || '/'
    }
    return `await ${pageVar}.goto(${valueExpr(url, columns)})`
  }

  if (step.type === 'back') {
    return `await ${pageVar}.goBack()`
  }

  if (step.type === 'closeTab') {
    return `await ${pageVar}.close()`
  }

  if (step.type === 'snapshot') {
    // Day 19: Playwright manages its own baseline (created on first run, then
    // compared) — a clean 1:1 mapping for our visual snapshot.
    // F15: mask dynamic regions + control animations, mapping to Playwright's
    // own toHaveScreenshot options.
    // The app captures the FULL scrollable page (scroll-independent), so the
    // exported test must too — Playwright's toHaveScreenshot is viewport-only by
    // default. Keep them in lockstep or the exported baseline won't match the app.
    const opts: string[] = ['fullPage: true']
    const masks = (step.maskSelectors ?? '')
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (masks.length) {
      opts.push(`mask: [${masks.map((s) => `${pageVar}.locator(${quote(s)})`).join(', ')}]`)
    }
    // Playwright disables animations by default; only emit when the user turned
    // freeze OFF (wants animations to render).
    if (step.freezeAnimations === false) opts.push(`animations: 'allow'`)
    // Absolute changed-pixel floor — the app fails past this many pixels so a small
    // localized change on a big full-page image isn't diluted below the % bar. Emit
    // it as Playwright's maxDiffPixels so the exported test matches the app. (The %
    // threshold maps to maxDiffPixelRatio.)
    const maxDiffPixels = Number(step.maxDiffPixels)
    opts.push(`maxDiffPixels: ${Number.isFinite(maxDiffPixels) && maxDiffPixels >= 0 ? maxDiffPixels : 200}`)
    const thresholdPct = parseFloat(step.value ?? '1')
    if (Number.isFinite(thresholdPct) && thresholdPct > 0) {
      opts.push(`maxDiffPixelRatio: ${+(thresholdPct / 100).toFixed(4)}`)
    }
    return `await expect(${pageVar}).toHaveScreenshot(${opts.length ? `{ ${opts.join(', ')} }` : ''})`
  }

  if (step.type === 'a11y') {
    // F13: the exported test uses @axe-core/playwright's AxeBuilder (the
    // official integration) and asserts no violation at/above the budget.
    // One self-contained expression, so repeated a11y steps never collide.
    const impacts = JSON.stringify(a11yBlockingImpacts(step.value))
    const tags = JSON.stringify(A11Y_WCAG_TAGS)
    return (
      `expect(\n` +
      `    (await new AxeBuilder({ page: ${pageVar} }).withTags(${tags}).analyze())\n` +
      `      .violations.filter((v) => ${impacts}.includes(v.impact)).map((v) => v.id),\n` +
      `    'accessibility (${a11yThreshold(step.value)}+) violations'\n` +
      `  ).toEqual([])`
    )
  }

  if (step.type === 'perf') {
    // F14: measure Core Web Vitals in the page (built-in Performance API, no
    // extra library) and assert LCP + CLS within budget. A bare block scopes
    // `vitals`, so repeated perf steps never collide.
    const b = perfBudget(step.value)
    return `{
    const vitals = await ${pageVar}.evaluate(() => new Promise((resolve) => {
      let lcp = 0, cls = 0;
      try { new PerformanceObserver((l) => { const e = l.getEntries(); lcp = e[e.length - 1].startTime; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch {}
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch {}
      setTimeout(() => resolve({ lcp, cls }), 600);
    }));
    expect(vitals.lcp, \`LCP \${Math.round(vitals.lcp)}ms\`).toBeLessThanOrEqual(${b.lcp});
    expect(vitals.cls, \`CLS \${vitals.cls.toFixed(3)}\`).toBeLessThanOrEqual(${b.cls});
  }`
  }

  if (step.type === 'api') {
    // F24: uses Playwright's `request` fixture (added to the test signature when
    // any api step exists), NOT the page — so it runs independent of the browser.
    // Wrapped in a block so `res` can be reused across repeated api steps.
    const method = (step.apiMethod ?? 'GET').toLowerCase()
    const hasBody =
      method !== 'get' && method !== 'delete' && !!(step.apiBody && step.apiBody.length)
    const headers = parseHeaderLines(step.apiHeaders)
    const optParts: string[] = []
    if (headers.length) {
      optParts.push(
        `headers: { ${headers.map(([k, v]) => `${quote(k)}: ${valueExpr(v, columns)}`).join(', ')} }`
      )
    }
    if (hasBody) optParts.push(`data: ${valueExpr(step.apiBody!, columns)}`)
    // F24.2: a hard timeout, so a dead endpoint can't hang the exported suite
    // either (Playwright's request fixture has its own default, but an explicit
    // per-step budget is what the tester actually asked for).
    if (step.apiTimeoutMs) optParts.push(`timeout: ${step.apiTimeoutMs}`)
    const opts = optParts.length ? `, { ${optParts.join(', ')} }` : ''
    const bodyCheck = (step.apiExpectBody ?? '').trim()
      ? `\n    expect(await res.text()).toContain(${valueExpr(step.apiExpectBody!.trim(), columns)})`
      : ''
    // F24.2: the real assertions (field / header / count / type), the contract,
    // and the SLA — all of which must survive into CI or the export is a lie.
    const checks = apiCheckLines(step, '    ', columns)
    // F24.1: lift saved values out of the response, so the exported test can also
    // GET/DELETE the record it just created. It reuses `body` when the checks
    // above already parsed it — declaring it twice would not compile.
    const saves = apiSaveLines(step, '    ', checksDeclareBody(step))
    // F24.2: SLA — time the call and assert the budget.
    const sla = step.apiMaxMs
      ? `\n    expect(Date.now() - t0, 'response time').toBeLessThanOrEqual(${step.apiMaxMs})`
      : ''
    const t0 = step.apiMaxMs ? `    const t0 = Date.now()\n` : ''
    // F24.3: the 🔑 session handoff. Emitted LAST, so it only runs once the status
    // and the assertions have passed — handing a failed login's cookies to the
    // browser would be worse than not handing anything over at all.
    const inject = apiInjectLines(step, '    ', pageVar, columns)
    return (
      `{\n` +
      t0 +
      `    const res = await request.${method}(${valueExpr(step.url ?? '', columns)}${opts})\n` +
      `    ${apiStatusAssertion(step.apiExpectStatus, 'res')}${sla}${bodyCheck}${checks}${saves}${inject}\n` +
      `  }`
    )
  }

  if (step.type === 'wait') {
    const kind = step.waitKind ?? 'time'
    if (kind === 'network-idle') return `await ${pageVar}.waitForLoadState('networkidle')`
    if (kind === 'text') {
      return `await ${pageVar}.getByText(${quote(step.value ?? '')}).first().waitFor()`
    }
    // F30: a manual (human) step can't be automated in CI. Emit page.pause()
    // (opens the Playwright Inspector for a human to act, then Resume) with the
    // instruction inline — commented, since it would hang an unattended CI run.
    if (kind === 'manual') {
      return (
        `// 🙋 MANUAL STEP — ${step.value ?? 'wait for a human (2FA / CAPTCHA / manual check)'}\n` +
        `  // Handle it yourself when running headed, then resume:\n` +
        `  // await ${pageVar}.pause()`
      )
    }
    const ms = Math.max(0, (parseFloat(step.value ?? '0') || 0) * 1000)
    return `await ${pageVar}.waitForTimeout(${ms})`
  }

  // Page-level checks assert on the page itself — no element, so they must run
  // BEFORE the no-selector bail-out below.
  if (step.type === 'assert' && step.assertKind === 'url-contains') {
    const v = step.value ?? ''
    // A tokenized expected URL can't be regex-escaped at codegen time — wrap
    // the runtime value in a RegExp instead.
    const arg = hasRefs(v, columns) ? `new RegExp(${valueExpr(v, columns)})` : regexContains(v)
    return `await expect(${pageVar}).toHaveURL(${arg})`
  }
  if (step.type === 'assert' && step.assertKind === 'title') {
    return `await expect(${pageVar}).toHaveTitle(${valueExpr(step.value ?? '', columns)})`
  }
  // F19: an AI (natural-language) assertion is judged by an LLM at replay time —
  // there is no deterministic Playwright matcher for it. Export it as an honest
  // comment so the reader knows a semantic check lived here (and can wire their
  // own LLM/manual check if they need it in CI).
  if (step.type === 'assert' && step.assertKind === 'nl') {
    return `// ↑ AI check — judged by an LLM at replay; no deterministic Playwright equivalent, so not exported`
  }

  if (!step.selector) return null
  const base = pageBase(pageVar, step.frame)
  // In portable mode a getByTestId(…) selector becomes a both-attribute CSS
  // locator, so the exported test resolves without a testIdAttribute setting.
  const sel = (portableTestId && portableTestIdSelector(step)) || step.selector
  const locator = elementLocator ?? `${base}.${sel}`

  // Assertions translate 1:1 to Playwright's expect() matchers.
  if (step.type === 'assert') {
    switch (step.assertKind) {
      case 'text-equals':
        return `await expect(${locator}).toHaveText(${valueExpr(step.value ?? '', columns)})`
      case 'text-contains':
        return `await expect(${locator}).toContainText(${valueExpr(step.value ?? '', columns)})`
      case 'value':
        return `await expect(${locator}).toHaveValue(${valueExpr(step.value ?? '', columns)})`
      case 'enabled':
        return `await expect(${locator}).toBeEnabled()`
      case 'disabled':
        return `await expect(${locator}).toBeDisabled()`
      case 'checked':
        return `await expect(${locator}).toBeChecked()`
      case 'unchecked':
        // No toBeUnchecked() exists — Playwright negates any matcher with .not
        return `await expect(${locator}).not.toBeChecked()`
      case 'hidden':
        // Passes for invisible AND for not-in-DOM (unlike not.toBeVisible's
        // stricter cousin patterns) — matches our replay semantics.
        return `await expect(${locator}).toBeHidden()`
      case 'focused':
        return `await expect(${locator}).toBeFocused()`
      case 'editable':
        return `await expect(${locator}).toBeEditable()`
      case 'empty':
        return `await expect(${locator}).toBeEmpty()`
      case 'attribute':
        return `await expect(${locator}).toHaveAttribute(${quote(step.attrName ?? '')}, ${valueExpr(step.value ?? '', columns)})`
      case 'class':
        // toContainClass matches ONE class token (Playwright ≥1.52) — unlike
        // toHaveClass, which demands the element's ENTIRE class string.
        return `await expect(${locator}).toContainClass(${valueExpr(step.value ?? '', columns)})`
      case 'count': {
        // The recorded selector pinpoints ONE element (maybe via .nth) — a
        // count check is about the GROUP, so assert on the selector minus nth.
        const group = sel.replace(/\.nth\(\d+\)$/, '')
        const v = step.value ?? '0'
        // A tokenized count comes through as a string → coerce with Number().
        const n = hasRefs(v, columns)
          ? `Number(${valueExpr(v, columns)})`
          : Math.max(0, parseInt(v, 10) || 0)
        return `await expect(${base}.${group}).toHaveCount(${n})`
      }
      default:
        return `await expect(${locator}).toBeVisible()`
    }
  }

  switch (step.type) {
    case 'click':
      return `await ${locator}.click()`
    case 'type':
      if (step.secret) {
        // Don't leak secrets — read the password from an environment variable.
        return `await ${locator}.fill(process.env.PASSWORD ?? '') // password field — set the PASSWORD env var`
      }
      return `await ${locator}.fill(${valueExpr(step.value ?? '', columns)})`
    case 'select':
      // We stored the option's VISIBLE text, so select by label.
      return `await ${locator}.selectOption({ label: ${valueExpr(step.value ?? '', columns)} })`
    case 'press':
      // Playwright's .press() is a real key press — it triggers form submit.
      return `await ${locator}.press(${quote(step.key ?? 'Enter')})`
    case 'hover':
      // Playwright's .hover() moves the real mouse — CSS :hover reveals work.
      return `await ${locator}.hover()`
    case 'upload': {
      // Day 16: Playwright sets a file input directly with setInputFiles.
      // Day 16(+): reference the file by a PORTABLE relative path. On save, the
      // app copies each file into a fixtures/ folder next to the spec, so the
      // exported test is self-contained (no machine-specific absolute paths).
      const paths = (step.value ?? '').split('\n').filter(Boolean)
      if (!paths.length) return null
      const rel = paths.map((p) => `fixtures/${p.split(/[\\/]/).pop()}`)
      const arg = rel.length === 1 ? quote(rel[0]) : `[${rel.map(quote).join(', ')}]`
      return `await ${locator}.setInputFiles(${arg})`
    }
    default:
      return null
  }
}

// Build the whole test file from the recorded steps. Day 11: a saved test
// contributes its NAME (the test title) and its BASE URL (emitted once as
// test.use, reading process.env.BASE_URL so CI can point it at any environment).
// F24.4 — pull the 🧹 teardown lines out of the emitted body so they can go in a
// `finally`. Shared by BOTH the inline and the page-object exports: the POM export
// used to skip this entirely, so exporting as POM silently threw the cleanup
// guarantee away and a failed CI run orphaned its data — the exact thing F24.4
// exists to prevent.
//
// `lines` and `enabled` can drift (a dialog/download step folds into its
// neighbour), so a teardown step is matched by its emitted text. Each teardown step
// CLAIMS one line: two identical api steps where only one is 🧹 used to hoist both.
// `downIdx` — the indices of `lines` that ARE teardown — is the reliable path, and
// callers that build their own line list should pass it. Text matching is only a
// fallback for the inline exporter, whose lines carry a `// <stepText>` comment.
function splitTeardown(
  enabled: RecorderStep[],
  lines: string[],
  downIdx?: Set<number>
): { main: string[]; down: string[] } {
  if (downIdx) {
    if (!downIdx.size) return { main: lines, down: [] }
    return {
      main: lines.filter((_, i) => !downIdx.has(i)),
      down: lines.filter((_, i) => downIdx.has(i))
    }
  }
  const downSteps = enabled.filter((s) => s.teardown && s.type === 'api')
  if (!downSteps.length || !lines.length) return { main: lines, down: [] }
  const claimed = new Set<number>()
  const down: string[] = []
  for (const s of downSteps) {
    const text = stepText(s)
    const at = lines.findIndex((l, i) => !claimed.has(i) && l.includes(text))
    if (at >= 0) {
      claimed.add(at)
      down.push(lines[at])
    }
  }
  return { main: lines.filter((_, i) => !claimed.has(i)), down }
}

// Wrap a body in try/finally when there are teardown lines. Indents by one level.
function withTeardown(main: string[], down: string[], joiner = '\n\n'): string {
  if (!down.length) return main.join(joiner)
  const reindent = (ls: string[]): string =>
    ls
      .join(joiner)
      .split('\n')
      .map((l) => (l ? `  ${l}` : l))
      .join('\n')
  return (
    `  try {\n${reindent(main)}\n  } finally {\n` +
    `    // 🧹 Teardown — runs even if the test failed above, so the data this\n` +
    `    // test created is never left behind in the environment.\n` +
    `${reindent(down)}\n  }`
  )
}

/**
 * F36 — what a device contributes to the exported `test.use({ … })`.
 *
 * A named Playwright preset wins: `...devices['iPhone 13']` brings userAgent,
 * viewport, deviceScaleFactor, isMobile and hasTouch in one spread, so the
 * exported spec is emulating the same phone the app was. It MUST be spread
 * first so later props (baseURL, storageState) override it rather than being
 * overridden by it.
 *
 * Without a preset we fall back to the bare `viewport:` — which is exactly what
 * the size-only presets and every pre-F36 test mean.
 */
function deviceUse(
  device: { playwrightDevice?: string; label?: string } | undefined,
  viewport: { width: number; height: number } | undefined
): { spread: string | null; viewportProp: string | null; usesPreset: boolean } {
  if (device?.playwrightDevice) {
    return {
      spread: `...devices[${quote(device.playwrightDevice)}]`,
      viewportProp: null,
      usesPreset: true
    }
  }
  return {
    spread: null,
    viewportProp: viewport
      ? `viewport: { width: ${viewport.width}, height: ${viewport.height} }`
      : null,
    usesPreset: false
  }
}

export function generatePlaywrightTest(
  steps: RecorderStep[],
  options?: {
    name?: string
    baseURL?: string
    storageState?: string
    viewport?: { width: number; height: number }
    // F36: the full device this test runs as. When it names a Playwright preset
    // the spec emits `...devices['iPhone 13']` — carrying UA + touch + pixel
    // density, not just size. Falls back to `viewport` for the size-only
    // presets and for every test saved before F36.
    device?: { playwrightDevice?: string; label?: string }
    // F38: cross-cutting labels → Playwright's own `{ tag: [...] }` option, so
    // `npx playwright test --grep @smoke` in CI selects the same set the app's
    // tag filter does.
    tags?: string[]
    // Day 20 (data-driven): a table of rows. When present (and non-empty), the
    // test body is wrapped in `for (const data of dataset)` and tokenized
    // values become data.* / process.env.* references.
    data?: { columns: string[]; rows: Record<string, string>[] }
    // F1 (HAR): a captured archive filename. When set, the test serves matched
    // network responses from it via Playwright's routeFromHAR (deterministic
    // replay), falling back to the live network for anything not in the HAR.
    har?: string
  }
): string {
  const baseURL = options?.baseURL?.replace(/\/+$/, '') || undefined
  const enabled = steps.filter((step) => !step.disabled)
  // Day 20: data mode is on only when there are both columns and rows.
  const dataMode = !!(options?.data && options.data.rows.length && options.data.columns.length)
  const columns = dataMode ? options!.data!.columns : []

  // Day 17 (multiple windows): is this a multi-tab test? Only then do we switch
  // from the single `page` fixture to per-tab `page0`/`page1`/… variables (and
  // a `context` to open new pages). A single-tab test exports EXACTLY as before.
  const multiWindow = enabled.some(
    (step) => (step.windowId ?? 0) > 0 || step.opensWindow !== undefined
  )
  const pv = (windowId?: number): string => (multiWindow ? `page${windowId ?? 0}` : 'page')

  // Test-id portability: declare the attribute, or fall back to CSS locators.
  const idPolicy = testIdPolicy(enabled)
  // F38: tags become Playwright's own test-level tag option.
  const tagArg = tagArgFor(options?.tags)

  const lines: string[] = []
  // F37: how deep in loops/if-blocks each emitted line-group sits, so the final
  // code is indented like hand-written JS. Tracked separately because the
  // emitters below all push at a fixed two-space indent; re-indenting once at
  // the end is far less invasive than threading a pad through every one.
  const lineDepth: number[] = []
  let depth = 0
  const syncDepth = (): void => {
    while (lineDepth.length < lines.length) lineDepth.push(depth)
  }
  // A unique loop variable per nesting level, so nested loops don't collide.
  const loopVar = (level: number): string => `i${level}`

  for (let i = 0; i < enabled.length; i++) {
    syncDepth()
    const step = enabled[i]
    const pageVar = pv(step.windowId)

    // === F37: loops + branching ===
    // These emit real JavaScript control flow, so the exported spec loops and
    // branches the same way the app did — not a comment saying it did.
    if (isControlStep(step)) {
      if (step.type === 'repeat') {
        const v = loopVar(depth)
        if (step.repeatKind === 'each' && step.selector) {
          const items = `items${depth}`
          lines.push(
            `  // ${stepText(step)}\n` +
              `  const ${items} = ${pageBase(pageVar, step.frame)}.${(idPolicy.portable && portableTestIdSelector(step)) || step.selector}\n` +
              // Count ONCE up front, matching the app: a live count could loop
              // forever if the body adds matching elements.
              `  const ${items}Count = await ${items}.count()\n` +
              `  for (let ${v} = 0; ${v} < ${items}Count; ${v}++) {`
          )
        } else {
          const n = parseInt(step.value ?? '1', 10)
          const times = Number.isFinite(n) && n > 0 ? n : 1
          lines.push(`  // ${stepText(step)}\n  for (let ${v} = 0; ${v} < ${times}; ${v}++) {`)
        }
        syncDepth()
        depth++
        continue
      }
      if (step.type === 'endRepeat') {
        syncDepth()
        depth = Math.max(0, depth - 1)
        lines.push(`  }`)
        syncDepth()
        continue
      }
      if (step.type === 'if') {
        lines.push(
          `  // ${stepText(step)}\n  if (${conditionExpr(step, pageVar, idPolicy.portable)}) {`
        )
        syncDepth()
        depth++
        continue
      }
      if (step.type === 'else') {
        syncDepth()
        depth = Math.max(0, depth - 1)
        lines.push(`  } else {`)
        syncDepth()
        depth++
        continue
      }
      if (step.type === 'endIf') {
        syncDepth()
        depth = Math.max(0, depth - 1)
        lines.push(`  }`)
        syncDepth()
        continue
      }
    }

    // A dialog step has no action of its own — its handler is emitted just
    // before the action that triggers it (the previous loop iteration).
    if (step.type === 'dialog') continue
    // Day 16(+): a download VERIFIES the file triggered by the preceding action
    // (the `download<j>Promise` set up before that click) — assert it arrived
    // with the expected name and is not empty.
    if (step.type === 'download') {
      const want = (step.value ?? step.label ?? 'file').trim()
      lines.push(
        `  // ${stepText(step)}\n` +
          `  const download${i} = await download${i}Promise\n` +
          `  expect(download${i}.suggestedFilename()).toContain(${quote(want)})\n` +
          `  expect(fs.statSync(await download${i}.path()).size).toBeGreaterThan(0)`
      )
      continue
    }
    // Day 16: if the NEXT step is a dialog, register the handler BEFORE this
    // action, because Playwright dialog handlers must be set up in advance.
    const next = enabled[i + 1]
    if (next && next.type === 'dialog') {
      lines.push(`  // ${stepText(next)}\n  ${dialogHandler(next, pv(next.windowId))}`)
    }
    // Day 16(+): if the NEXT step is a download, this action triggers it — start
    // waiting for the download BEFORE clicking (Playwright requires that order).
    if (next && next.type === 'download') {
      lines.push(`  const download${i + 1}Promise = ${pageVar}.waitForEvent('download')`)
    }
    const action = actionFor(step, baseURL, pageVar, undefined, columns, idPolicy.portable)
    if (!action) continue
    // Day 17: a step that OPENS a tab must set up the page wait BEFORE the click,
    // so wrap it in Promise.all([context.waitForEvent('page'), <action>]) and
    // capture the new page as page<N>.
    if (step.opensWindow !== undefined) {
      const inner = action.replace(/^await /, '')
      lines.push(
        `  // ${stepText(step)}\n` +
          `  const [page${step.opensWindow}] = await Promise.all([\n` +
          `    context.waitForEvent('page'),\n` +
          `    ${inner}\n` +
          `  ])`
      )
      continue
    }
    // F4: flag a selector this tool auto-repaired, so a reader of the exported
    // spec knows the locator was AI-derived (not hand-authored) and worth a look.
    const healNote = step.healedByAi
      ? `  // ⚠ selector auto-healed by QATestFlow AI (matched on ${step.healedByAi.signals.join(' + ')}) — verify it still targets the intended element\n`
      : ''
    // F26: an optional step is wrapped so its absence is skipped, not a failure.
    // The action can be multi-line, so indent its continuations into the try.
    if (step.optional) {
      const indented = action.replace(/\n/g, '\n  ')
      lines.push(
        `${healNote}  // ${stepText(step)} (optional — skipped if not present)\n` +
          wrapOptional(indented, '  ')
      )
      continue
    }
    lines.push(`${healNote}  // ${stepText(step)}\n  ${action}`)
  }
  syncDepth()
  // F37: apply the nesting indent once, at the end. Each entry may be several
  // lines, so every line inside it is padded — blank lines are left blank
  // rather than becoming trailing whitespace.
  if (depthUsed(lineDepth)) {
    for (let n = 0; n < lines.length; n++) {
      const pad = '  '.repeat(lineDepth[n] ?? 0)
      if (!pad) continue
      lines[n] = lines[n]
        .split('\n')
        .map((l) => (l.trim() ? pad + l : l))
        .join('\n')
    }
  }

  // Day 17: in multi-window mode, alias the fixture as page0 and grab its
  // context (used to await newly-opened pages). Prepended to the test body.
  const prelude = multiWindow ? '  const page0 = page\n  const context = page.context()\n\n' : ''
  // F1 (HAR): before anything else, serve saved responses from the archive for
  // deterministic replay; anything not in it falls through to the live network.
  const harSetup = options?.har
    ? `  // F1: deterministic replay — serve recorded network from the HAR\n` +
      `  await ${pv(0)}.routeFromHAR('hars/${options.har}', { notFound: 'fallback' })\n\n`
    : ''
  // F24.1: declare the run-scoped helpers ({{uuid}}/{{timestamp}} and the `saved`
  // store) at the TOP of the test body, so every run gets fresh values and a
  // re-run never collides with the data the last one left behind.
  const tokenPrelude = runtimeTokenPreamble(enabled)

  // F24.4: teardown steps must run even when the test FAILED — otherwise the
  // exported spec quietly behaves differently from the app, and every failed CI
  // run leaves its data behind. A `finally` is the Playwright-native way to say
  // that. `lines` is emitted in step order, so the teardown ones are pulled out
  // by index (they were tagged while the list was walked).
  const { main: mainLines, down: downLines } = splitTeardown(enabled, lines)
  const body = tokenPrelude + prelude + harSetup + withTeardown(mainLines, downLines)

  // Only import expect when an assertion (or a download check) uses it; pull in
  // fs only when a download check needs a file-size assertion.
  const hasDownload = enabled.some((step) => step.type === 'download')
  const hasA11y = enabled.some((step) => step.type === 'a11y')
  const hasPerf = enabled.some((step) => step.type === 'perf')
  // F24: an api step needs the `request` fixture in the signature and `expect`
  // for its status/body assertions.
  const needsRequest = enabled.some((step) => step.type === 'api')
  const fixtures = needsRequest ? '{ page, request }' : '{ page }'
  const hasAssert =
    enabled.some((step) => step.type === 'assert' || step.type === 'snapshot') ||
    hasDownload ||
    hasA11y ||
    hasPerf ||
    needsRequest
  // F36: `devices` is only imported when a preset is actually spread — an unused
  // import would trip a lint rule in the user's repo.
  const usesDevicePreset = !!options?.device?.playwrightDevice
  const importNames = ['test', hasAssert ? 'expect' : null, usesDevicePreset ? 'devices' : null]
    .filter(Boolean)
    .join(', ')
  const imports = `{ ${importNames} }`
  const header =
    (hasA11y ? '// Accessibility checks need: npm i -D @axe-core/playwright\n' : '') +
    `import ${imports} from '@playwright/test'\n` +
    (hasA11y ? "import AxeBuilder from '@axe-core/playwright'\n" : '') +
    (hasDownload ? "import fs from 'fs'\n" : '') +
    // F24.1: only when a {{uuid}} token is actually used.
    (runtimeTokenUse(enabled).uuid ? "import { randomUUID } from 'node:crypto'\n" : '') +
    // F24.2: the shared response-check engine, so the exported spec judges a check
    // exactly the way the app did.
    (anyApiChecks(enabled) ? `\n${API_CHECK_HELPER}` : '')
  // Day 17: test.use carries baseURL and (when a session is attached) the
  // storageState path, so the exported test starts logged in.
  // F25: the baseURL reads process.env.BASE_URL first, defaulting to the recorded
  // base — so CI can point the SAME spec at dev/staging/prod with
  // `BASE_URL=https://staging… npx playwright test`, no file edit (the export
  // twin of the in-app "Run against" environment switch). Navigations are already
  // emitted relative to the base, so overriding this one value retargets them all.
  const useProps: string[] = []
  // F36: the device spread goes FIRST so the props below win over it.
  const dev = deviceUse(options?.device, options?.viewport)
  if (dev.spread) useProps.push(dev.spread)
  if (baseURL) useProps.push(`baseURL: process.env.BASE_URL || ${quote(baseURL)}`)
  // Tell Playwright which attribute getByTestId() should read — without this it
  // looks for `data-testid` and a `data-test` app's locators never resolve.
  if (idPolicy.attr) useProps.push(`testIdAttribute: ${quote(idPolicy.attr)}`)
  if (options?.storageState) {
    useProps.push(`storageState: ${quote(`sessions/${options.storageState}`)}`)
  }
  if (dev.viewportProp) useProps.push(dev.viewportProp)
  const useComment = baseURL
    ? '// Base URL — override per environment in CI with the BASE_URL env var.\n'
    : ''
  // F36: an iPhone/iPad preset is a WebKit device in Playwright's own catalogue.
  // Run this spec on the webkit project to get the engine as well as the shape.
  const devComment = dev.usesPreset
    ? `// Device: ${options?.device?.label ?? options?.device?.playwrightDevice} — includes userAgent, touch and pixel density, not just size.\n`
    : ''
  const use = useProps.length
    ? `\n${devComment}${useComment}test.use({ ${useProps.join(', ')} })\n`
    : ''

  // Day 20 (data-driven): emit a `dataset` array and run the same body once per
  // row inside a for-loop, giving each row its own test (named by the first
  // column so a failing row is identifiable). The body references `data.*`.
  if (dataMode) {
    const rows = options!.data!.rows
    const dataset = rows.map((r) => `  ${rowLiteral(r, columns)}`).join(',\n')
    const disc = columns[0]
    const discRef = isIdent(disc) ? `data.${disc}` : `data[${quote(disc)}]`
    const base = (options?.name || 'recorded flow').replace(/[`\\$]/g, '\\$&')
    const title = '`' + base + ' — ${' + discRef + '}`'
    // Re-indent the body one level deeper (inside the for-loop). Indentation is
    // cosmetic to Playwright; this just keeps the file readable.
    const inner = body
      .split('\n')
      .map((l) => (l ? `  ${l}` : l))
      .join('\n')
    return `${header}${use}
const dataset = [
${dataset}
]

for (const data of dataset) {
  test(${title}${tagArg}, async (${fixtures}) => {
${inner}
  })
}
`
  }

  return `${header}${use}
test(${quote(options?.name || 'recorded flow')}${tagArg}, async (${fixtures}) => {
${body}
})
`
}

// =====================================================================
// F20 — EDGE-CASE NEGATIVE SUITE EXPORT
// Turn the edge-case variants into runnable Playwright tests so the
// validation/security checks live in CI, not just in the app. Each variant
// becomes ONE test that runs the flow with a single field set to a hostile
// value (empty / boundary / invalid / SQL / XSS) and asserts the app REJECTED
// it: the happy-path success check must NOT pass. If it does pass, the app
// accepted bad input and the test FAILS — surfacing the bug (worst case, an
// accepted SQL/XSS). So a fully GREEN suite means your validation holds.
//
// Reuses actionFor() for both the actions and the (positive) success checks —
// each check is wrapped in try/catch and we assert it did NOT succeed, so no
// per-matcher negation logic is needed. v1 scope: single-page form flows (what
// F20 targets). NL/AI and visual-snapshot checks can't be auto-negated, so a
// variant built only from those emits a TODO note instead of a false assertion.
// =====================================================================
export interface EdgeSuiteCase {
  baseline: boolean
  fieldLabel: string
  edgeLabel: string
  value: string
  steps: RecorderStep[]
}

export function generateEdgeSuite(
  cases: EdgeSuiteCase[],
  options?: {
    name?: string
    baseURL?: string
    viewport?: { width: number; height: number }
    device?: { playwrightDevice?: string; label?: string } // F36
  }
): string {
  const baseURL = options?.baseURL?.replace(/\/+$/, '') || undefined
  const variants = cases.filter((c) => !c.baseline)
  // Test-id portability, decided once across every variant's steps (they share
  // the same flow, so the policy is uniform for the whole file).
  const idPolicy = testIdPolicy(cases.flatMap((c) => c.steps).filter((s) => !s.disabled))

  const testBlocks: string[] = []
  for (const c of variants) {
    const enabled = c.steps.filter((s) => !s.disabled)
    // Split the flow: the actions drive the form; the (deterministic) assert
    // steps are the success criteria we negate. Snapshots/a11y/perf aren't a
    // pass/fail signal for "was the input accepted", so they're left out here.
    const actionSteps = enabled.filter((s) => s.type !== 'assert' && s.type !== 'snapshot')
    const checkSteps = enabled.filter((s) => s.type === 'assert')

    const actionLines: string[] = []
    // F24.4: an edge variant re-runs the whole flow, so it re-creates whatever the
    // flow creates. If an earlier action throws, the cleanup line below it never
    // runs — one orphan per hostile input, per run.
    const edgeTeardownIdx = new Set<number>()
    for (const step of actionSteps) {
      const action = actionFor(step, baseURL, 'page', undefined, [], idPolicy.portable)
      if (!action) continue
      actionLines.push(`  // ${stepText(step)}\n  ${action}`)
      if (step.teardown && step.type === 'api') edgeTeardownIdx.add(actionLines.length - 1)
    }
    const edgeSplit = splitTeardown(actionSteps, actionLines, edgeTeardownIdx)

    const checkLines = checkSteps
      .map((s) => actionFor(s, baseURL, 'page', undefined, [], idPolicy.portable))
      .filter((x): x is string => !!x)

    const safeVal = (c.value || '').replace(/\s+/g, ' ').trim().slice(0, 50) || '(empty)'
    let rejection: string
    if (checkLines.length) {
      rejection =
        `  // ✋ Negative test: the app should REJECT this input, so the happy-path\n` +
        `  // success check must NOT pass. If it passes, hostile input was accepted.\n` +
        `  let reachedSuccess = true\n` +
        `  try {\n` +
        checkLines.map((l) => `    ${l}`).join('\n') +
        `\n  } catch {\n` +
        `    reachedSuccess = false\n` +
        `  }\n` +
        `  expect(reachedSuccess, ${quote(
          `app accepted "${safeVal}" in ${c.fieldLabel} — expected it to be rejected`
        )}).toBe(false)`
    } else {
      rejection =
        `  // ⚠ No deterministic success check to negate here. Add your own assertion\n` +
        `  // that the app rejected the input (e.g. an error message is visible, or the\n` +
        `  // URL did NOT advance to the post-submit page).`
    }

    const title = `${c.fieldLabel} rejects ${c.edgeLabel}`
    // F24: an api step in the flow emits `await request.…`, and its {{uuid}}/
    // {{saved:…}} tokens compile to `runUuid` / `saved`. Without the `request`
    // fixture and the token preamble, this file referenced three identifiers that
    // were never declared — so ANY recorded flow containing an api step produced an
    // edge suite that didn't compile.
    const caseNeedsRequest = actionSteps.some((s) => s.type === 'api')
    const caseFixtures = caseNeedsRequest ? '{ page, request }' : '{ page }'
    // The rejection assertion is part of the MAIN body — if it fails (hostile input
    // was accepted), the teardown still has to run.
    const caseBody = withTeardown([...edgeSplit.main, rejection], edgeSplit.down)
    testBlocks.push(
      `test(${quote(title)}, async (${caseFixtures}) => {\n` +
        runtimeTokenPreamble(actionSteps) +
        caseBody +
        `\n})`
    )
  }

  const useProps: string[] = []
  // F36: device spread first so the props below override it (see deviceUse).
  const edgeDev = deviceUse(options?.device, options?.viewport)
  if (edgeDev.spread) useProps.push(edgeDev.spread)
  if (baseURL) useProps.push(`baseURL: process.env.BASE_URL || ${quote(baseURL)}`)
  // Same reason as generatePlaywrightTest: getByTestId needs the right attribute.
  if (idPolicy.attr) useProps.push(`testIdAttribute: ${quote(idPolicy.attr)}`)
  if (edgeDev.viewportProp) useProps.push(edgeDev.viewportProp)
  const use = useProps.length
    ? `\n// Base URL — override per environment in CI with the BASE_URL env var.\ntest.use({ ${useProps.join(', ')} })\n`
    : ''

  // F24: the same imports/helper the other exports emit, for the same reason — an
  // api step in the recorded flow compiles to `request.…`, `runUuid`, `saved` and
  // (with checks) `__expectChecks`, and every one of those has to be declared.
  const allSteps = variants.flatMap((c) => c.steps.filter((s) => !s.disabled))
  const header =
    `// Negative / edge-case suite${options?.name ? ` — ${options.name}` : ''}\n` +
    `// Auto-generated by QATestFlow (F20). Each test feeds ONE hostile value and\n` +
    `// asserts the app REJECTS it. A fully passing suite means your input\n` +
    `// validation holds; a FAILURE means bad/malicious input was accepted.\n` +
    `import { test, expect${edgeDev.usesPreset ? ', devices' : ''} } from '@playwright/test'\n` +
    (runtimeTokenUse(allSteps).uuid ? "import { randomUUID } from 'node:crypto'\n" : '') +
    (anyApiChecks(allSteps) ? `\n${API_CHECK_HELPER}` : '')

  return `${header}${use}\n${testBlocks.join('\n\n')}\n`
}

// =====================================================================
// Day 17 — FULL Page Object Model export (two files)
// A real POM: a Page class holding the locators (+ a goto() and action
// methods grouped from the recorded steps) in pages/<Name>Page.ts, and a spec
// that imports it, instantiates it, calls the methods, and keeps the ASSERTIONS
// (the "what we're checking") in the test — the classic separation.
//
// Scope: single-page, no-iframe, no-multi-tab tests, and no dialog/download
// steps (those need handlers registered around actions, which don't fit a clean
// auto-POM). Returns null for anything outside that — the caller falls back to
// the normal inline export.
//
// Day 20: DATA-DRIVEN tests ARE supported. The page class stays data-agnostic
// (locators + methods); the spec emits a `dataset` array and runs one test per
// row inside `for (const data of dataset)`. A method that fills a {{column}}
// value takes the row as a `data` parameter (the class holds no data of its
// own), while {{env:…}} tokens read process.env directly and need no parameter.
// =====================================================================
export function generatePageObjectTest(
  steps: RecorderStep[],
  options?: {
    name?: string
    baseURL?: string
    storageState?: string
    viewport?: { width: number; height: number }
    // F36: the full device this test runs as. When it names a Playwright preset
    // the spec emits `...devices['iPhone 13']` — carrying UA + touch + pixel
    // density, not just size. Falls back to `viewport` for the size-only
    // presets and for every test saved before F36.
    device?: { playwrightDevice?: string; label?: string }
    // F38: cross-cutting labels → Playwright's own `{ tag: [...] }` option, so
    // `npx playwright test --grep @smoke` in CI selects the same set the app's
    // tag filter does.
    tags?: string[]
    // Day 20: present (with rows) for a data-driven test — the spec wraps the
    // page-object calls in a `for (const data of dataset)` loop.
    data?: { columns: string[]; rows: Record<string, string>[] }
    // F1 (HAR): serve saved network responses from this archive (routeFromHAR).
    har?: string
  }
): { spec: string; page: string; pageFileName: string; className: string } | null {
  const enabled = steps.filter((s) => !s.disabled)
  const multiWindow = enabled.some((s) => (s.windowId ?? 0) > 0 || s.opensWindow !== undefined)
  const hasFrames = enabled.some((s) => s.frame?.length)
  const hasAwkward = enabled.some((s) => s.type === 'dialog' || s.type === 'download')
  if (multiWindow || hasFrames || hasAwkward) return null

  // Day 20: data mode is on only when there are both columns and rows. `columns`
  // drives which {{tokens}} become `data.*` references (vs. quoted literals).
  const dataMode = !!(options?.data && options.data.rows.length && options.data.columns.length)
  const columns = dataMode ? options!.data!.columns : []
  // A step whose value/URL fills a DATA column (not just an env token) — its
  // method must take the `data` row as a parameter, since the class has no data.
  const stepUsesData = (step: RecorderStep): boolean =>
    dataMode &&
    [step.value, step.url].some(
      (f) => typeof f === 'string' && extractTokens(f).some((t) => columns.includes(t))
    )

  const baseURL = options?.baseURL?.replace(/\/+$/, '') || undefined
  const className = `${pascalName(options?.name || 'recorded flow')}Page`
  const pageFileName = `${className}.ts`
  // Test-id portability — same policy as the inline export (see testIdPolicy).
  const idPolicy = testIdPolicy(enabled)
  // F38: POM/inline parity — the same tags reach both exports.
  const tagArg = tagArgFor(options?.tags)

  // The class's Locator fields must use the SAME portable rewrite as the inline
  // export, or a data-test app's POM locators resolve to nothing.
  const exprOf = (step: RecorderStep): string =>
    ((idPolicy.portable && portableTestIdSelector(step)) || step.selector) as string

  // What IS each element? Decided by every action performed on it across the
  // WHOLE test — not by the one step we happen to name it from.
  //
  // The old rule suffixed "Button" onto anything that was CLICKED, so a text
  // input you clicked into before typing came out as `usernameButton` — and the
  // class then read `await this.usernameButton.fill("standard_user")`, which is
  // nonsense a reviewer would flag instantly. A click tells you what the tester
  // DID; it does not tell you what the element IS. Typing into it does.
  type ElKind = 'input' | 'select' | 'button'
  const kindByExpr = new Map<string, ElKind>()
  for (const s of enabled) {
    if (!s.selector) continue
    const e = exprOf(s)
    // `type` wins unconditionally — you cannot fill a button, so a fill is proof.
    if (s.type === 'type') kindByExpr.set(e, 'input')
    else if (s.type === 'select' && kindByExpr.get(e) !== 'input') kindByExpr.set(e, 'select')
    else if ((s.type === 'click' || s.type === 'press') && !kindByExpr.has(e)) {
      kindByExpr.set(e, 'button')
    }
  }
  const SUFFIX: Record<ElKind, string> = { input: 'Input', select: 'Select', button: 'Button' }

  // Member names shared across locators + methods (a class can't have a property
  // and a method with the same name), plus reserved members.
  const used = new Set<string>(['page', 'goto', 'constructor'])
  const locatorDefs: { name: string; selector: string }[] = []
  const nameByExpr = new Map<string, string>()
  const nameForElement = (step: RecorderStep): string => {
    const expr = exprOf(step)
    const existing = nameByExpr.get(expr)
    if (existing) return existing
    const kind = kindByExpr.get(expr)
    // An element only ever ASSERTED on gets no suffix — it isn't a control.
    const baseName = camelName(step.label || step.type) + (kind ? SUFFIX[kind] : '')
    let name = baseName
    let n = 2
    while (used.has(name)) name = `${baseName}${n++}`
    used.add(name)
    nameByExpr.set(expr, name)
    locatorDefs.push({ name, selector: expr })
    return name
  }
  // A step that targets a single named element (so it gets a locator property).
  // Page-level asserts (url/title) and 'count' (a group check) use page directly.
  const usesElement = (step: RecorderStep): boolean =>
    !!step.selector &&
    !(
      step.type === 'assert' &&
      (step.assertKind === 'url-contains' ||
        step.assertKind === 'title' ||
        step.assertKind === 'count')
    )

  // Walk the steps: accumulate consecutive ACTIONS into a method buffer, and
  // flush it (as a method + a call in the spec) at each navigate/assert boundary.
  const methods: { name: string; body: string[]; usesData: boolean }[] = []
  const specBody: string[] = []
  // F24.4: which specBody lines are 🧹 teardown (hoisted into a `finally` below).
  const specTeardownIdx = new Set<number>()
  let buffer: string[] = []
  let bufferUsesData = false
  let lastActionLabel = ''
  let actionsSeq = 0
  const flush = (): void => {
    if (!buffer.length) return
    const base = lastActionLabel ? camelName(lastActionLabel) : `actions${++actionsSeq}`
    let name = base
    let n = 2
    while (used.has(name)) name = `${base}${n++}`
    used.add(name)
    methods.push({ name, body: buffer, usesData: bufferUsesData })
    // A data-using method receives the row: `await app.login(data)`.
    specBody.push(`  await app.${name}(${bufferUsesData ? 'data' : ''})`)
    buffer = []
    bufferUsesData = false
    lastActionLabel = ''
  }

  let firstNavSeen = false
  for (const step of enabled) {
    if (step.type === 'navigate') {
      flush()
      if (!firstNavSeen) {
        firstNavSeen = true
        specBody.push('  await app.goto()')
      } else {
        let url = step.url ?? ''
        if (baseURL && url.startsWith(baseURL)) url = url.slice(baseURL.length) || '/'
        specBody.push(`  await app.page.goto(${quote(url)})`)
      }
      continue
    }
    if (step.type === 'assert') {
      flush()
      const name = usesElement(step) ? nameForElement(step) : ''
      // The assert lives in the spec, where `data` is in scope (inside the
      // per-row loop), so a tokenized expected value can stay a `data.*` ref.
      const line = actionFor(
        step,
        baseURL,
        'app.page',
        name ? `app.${name}` : undefined,
        columns,
        idPolicy.portable
      )
      if (line) specBody.push(step.optional ? wrapOptional(line, '  ') : `  ${line}`)
      continue
    }
    // F13/F14: a page-level accessibility or performance check — like an
    // assert, it lives in the spec (where `expect`/AxeBuilder are imported),
    // not a page-object method.
    if (step.type === 'a11y' || step.type === 'perf') {
      flush()
      const line = actionFor(step, baseURL, 'app.page', undefined, columns, idPolicy.portable)
      if (line) specBody.push(`  ${line}`)
      continue
    }
    // F24: an api step uses the `request` fixture (in the spec's test signature),
    // not the page object — so it lives in the spec body, like an assert.
    if (step.type === 'api') {
      flush()
      const line = actionFor(step, baseURL, 'app.page', undefined, columns, idPolicy.portable)
      if (line) {
        specBody.push(`  ${line}`)
        // F24.4: remember WHICH emitted line this teardown step became, so it can be
        // hoisted into a `finally`. (The POM lines carry no `// stepText` comment, so
        // the text-matching fallback would never find them — which is exactly why the
        // POM export silently had no teardown at all.)
        if (step.teardown) specTeardownIdx.add(specBody.length - 1)
      }
      continue
    }
    // An action step → into the current method buffer. wait + back have no
    // element of their own (page-level actions), so handle them before the
    // no-selector skip below.
    if (step.type === 'wait' || step.type === 'back') {
      const line = actionFor(step, baseURL, 'this.page', undefined, columns, idPolicy.portable)
      if (line) buffer.push(`    ${line}`)
      if (stepUsesData(step)) bufferUsesData = true
      continue
    }
    if (!step.selector) continue
    const name = nameForElement(step)
    const line = actionFor(step, baseURL, 'this.page', `this.${name}`, columns, idPolicy.portable)
    if (line) buffer.push(step.optional ? wrapOptional(line, '    ') : `    ${line}`)
    if (stepUsesData(step)) bufferUsesData = true
    // A method should be ONE intent, named for it. The old rule flushed only at a
    // navigate/assert boundary and named the method after its LAST step — so
    // "fill user, fill password, click Login, click Add to cart" became a single
    // `addToCart()` that secretly logs you in. A page object that lies about what
    // its methods do is worse than no page object.
    //
    // A click on a real BUTTON is what completes an intent (submit / add / save);
    // a click on an input is just focus, and must not end anything or name it.
    if (step.type === 'click' || step.type === 'press') {
      if (kindByExpr.get(exprOf(step)) === 'button') {
        lastActionLabel = step.label || ''
        flush()
      }
    }
  }
  flush()

  // F1 (HAR): serve saved responses before anything runs (deterministic replay).
  if (options?.har) {
    specBody.unshift(`  await page.routeFromHAR('hars/${options.har}', { notFound: 'fallback' })`)
  }

  // The goto() destination = the first navigate (as a path under baseURL).
  let gotoUrl = '/'
  const firstNav = enabled.find((s) => s.type === 'navigate')
  if (firstNav?.url) {
    let u = firstNav.url
    if (baseURL && u.startsWith(baseURL)) u = u.slice(baseURL.length) || '/'
    gotoUrl = u
  }

  // === Build the page class file ===
  const pageLines: string[] = []
  pageLines.push(`import { type Page, type Locator } from '@playwright/test'`)
  pageLines.push('')
  pageLines.push(`export class ${className} {`)
  pageLines.push(`  readonly page: Page`)
  for (const d of locatorDefs) pageLines.push(`  readonly ${d.name}: Locator`)
  pageLines.push('')
  pageLines.push(`  constructor(page: Page) {`)
  pageLines.push(`    this.page = page`)
  for (const d of locatorDefs) pageLines.push(`    this.${d.name} = page.${d.selector}`)
  pageLines.push(`  }`)
  pageLines.push('')
  pageLines.push(`  async goto(): Promise<void> {`)
  pageLines.push(`    await this.page.goto(${quote(gotoUrl)})`)
  pageLines.push(`  }`)
  for (const m of methods) {
    pageLines.push('')
    // A data-using method receives the current row; its body already references
    // `data.column` (env tokens read process.env directly, so they need no arg).
    const params = m.usesData ? 'data: Record<string, string>' : ''
    pageLines.push(`  async ${m.name}(${params}): Promise<void> {`)
    for (const b of m.body) pageLines.push(b)
    pageLines.push(`  }`)
  }
  pageLines.push(`}`)
  const page = `${pageLines.join('\n')}\n`

  // === Build the spec file ===
  const hasA11y = enabled.some((s) => s.type === 'a11y')
  const hasPerf = enabled.some((s) => s.type === 'perf')
  const needsRequest = enabled.some((s) => s.type === 'api')
  const specFixtures = needsRequest ? '{ page, request }' : '{ page }'
  const hasAssert = enabled.some((s) => s.type === 'assert') || hasA11y || hasPerf || needsRequest
  // F36: keep POM/inline parity — the same device reaches both exports.
  const pomDev = deviceUse(options?.device, options?.viewport)
  const importNames = ['test', hasAssert ? 'expect' : null, pomDev.usesPreset ? 'devices' : null]
    .filter(Boolean)
    .join(', ')
  const imports = `{ ${importNames} }`
  const useProps: string[] = []
  if (pomDev.spread) useProps.push(pomDev.spread)
  if (baseURL) useProps.push(`baseURL: process.env.BASE_URL || ${quote(baseURL)}`)
  // Same reason as the inline export: getByTestId needs the right attribute.
  if (idPolicy.attr) useProps.push(`testIdAttribute: ${quote(idPolicy.attr)}`)
  if (options?.storageState) {
    useProps.push(`storageState: ${quote(`sessions/${options.storageState}`)}`)
  }
  if (pomDev.viewportProp) useProps.push(pomDev.viewportProp)
  // F25: same env-overridable baseURL as the inline export (see there).
  const useComment = baseURL
    ? '// Base URL — override per environment in CI with the BASE_URL env var.\n'
    : ''
  const use = useProps.length ? `\n${useComment}test.use({ ${useProps.join(', ')} })\n` : ''
  const importLines =
    (hasA11y ? '// Accessibility checks need: npm i -D @axe-core/playwright\n' : '') +
    `import ${imports} from '@playwright/test'\n` +
    (hasA11y ? "import AxeBuilder from '@axe-core/playwright'\n" : '') +
    // F24.1: parity with the inline export — the POM spec runs the same API steps.
    (runtimeTokenUse(enabled).uuid ? "import { randomUUID } from 'node:crypto'\n" : '') +
    `import { ${className} } from './pages/${className}'\n` +
    // F24.2: same shared check engine as the inline export — an api step must mean
    // the same thing whichever export style you picked.
    (anyApiChecks(enabled) ? `\n${API_CHECK_HELPER}` : '')
  // F24.1: run-scoped uuid/timestamp/saved helpers, declared inside each test.
  const tokenPrelude = runtimeTokenPreamble(enabled)

  // Day 20: a data-driven spec — a `dataset` array and one test per row (named
  // by the first column so a failing row is identifiable), each instantiating
  // the page object and driving it with that row's `data`.
  if (dataMode) {
    const rows = options!.data!.rows
    const dataset = rows.map((r) => `  ${rowLiteral(r, columns)}`).join(',\n')
    const disc = columns[0]
    const discRef = isIdent(disc) ? `data.${disc}` : `data[${quote(disc)}]`
    const titleBase = (options?.name || 'recorded flow').replace(/[`\\$]/g, '\\$&')
    const title = '`' + titleBase + ' — ${' + discRef + '}`'
    // The per-row body (build the page object, then the recorded calls), indented
    // one level deeper to sit inside the for-loop's test().
    // F24.4: the 🧹 guarantee has to survive a POM export too — it used to be
    // emitted only by the inline exporter, so choosing "page object" silently
    // dropped the cleanup and a failed run orphaned its data.
    const dd = splitTeardown(enabled, specBody, specTeardownIdx)
    const inner = [
      `  const app = new ${className}(page)`,
      ...(dd.down.length ? [withTeardown(dd.main, dd.down, '\n')] : dd.main)
    ]
      .map((l) => (l ? `  ${l}` : l))
      .join('\n')
    const spec =
      `${importLines}${use}\n` +
      `const dataset = [\n${dataset}\n]\n\n` +
      `for (const data of dataset) {\n` +
      `  test(${title}${tagArg}, async (${specFixtures}) => {\n` +
      `${runtimeTokenPreamble(enabled, '    ')}${inner}\n` +
      `  })\n` +
      `}\n`
    return { spec, page, pageFileName, className }
  }

  const { main: specMain, down: specDown } = splitTeardown(enabled, specBody, specTeardownIdx)
  const spec =
    `${importLines}` +
    `${use}\n` +
    `test(${quote(options?.name || 'recorded flow')}${tagArg}, async (${specFixtures}) => {\n` +
    `${tokenPrelude}` +
    `  const app = new ${className}(page)\n` +
    `${withTeardown(specMain, specDown, '\n')}\n` +
    `})\n`

  return { spec, page, pageFileName, className }
}
