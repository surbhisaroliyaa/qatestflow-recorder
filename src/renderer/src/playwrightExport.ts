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

// The OS-collision list moved to src/shared/osEnvNames.ts so main's own
// {{env:…}} resolution uses the SAME list — the app had the identical hole and
// it went unnoticed because the fix landed only here. Imported (used below) AND
// re-exported, so existing importers of this module are unaffected.
import { collidesWithOsEnv } from '../../shared/osEnvNames'
export { collidesWithOsEnv }

/**
 * Every `{{env:NAME}}` in these steps that collides with an OS variable.
 * Drives the export-time warning; the emitted spec also guards at runtime.
 */
export function osEnvCollisions(steps: RecorderStep[]): string[] {
  const found = new Set<string>()
  for (const s of steps) {
    for (const field of [s.value, s.url, s.apiHeaders, s.apiBody, s.apiChecks, s.apiExpectBody]) {
      if (typeof field !== 'string') continue
      for (const t of extractTokens(field)) {
        if (t.startsWith('env:')) {
          const v = t.slice('env:'.length).trim()
          if (collidesWithOsEnv(v)) found.add(v)
        }
      }
    }
  }
  return [...found]
}

// === Data-driven values (Day 20) ===
// A recognized {{token}} becomes a JS reference; everything else is a literal.
//   {{env:NAME}}  → process.env.NAME ?? ''   (a real secret, never inlined)
//   {{column}}    → data.column              (when `column` is a data column)
//   {{unknown}}   → null                     (left as literal text)
function tokenRef(name: string, columns: string[]): string | null {
  if (name.startsWith('env:')) {
    const v = name.slice('env:'.length).trim()
    // A name the OS also defines reads the OS value, not the user's — see
    // OS_ENV_NAMES. Read the QA_-prefixed variable instead, which nothing else
    // sets; the preamble throws when it's missing, so this can't fall back to
    // the ambiguous one and silently type an OS string into a form.
    if (collidesWithOsEnv(v)) {
      const safe = `QA_${v}`
      return isIdent(safe) ? `process.env.${safe} ?? ''` : `process.env[${quote(safe)}] ?? ''`
    }
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
  // A {{env:…}} name the OS also defines is a trap the `?? ''` fallback cannot
  // catch: the variable IS set, just to the wrong thing (on Windows USERNAME is
  // the logged-in account name). The spec then fills that into the form and the
  // run either fails as "wrong credentials" or — with no assertion after it —
  // passes outright. Verified on a real export: it typed `samee` and went green.
  //
  // Nothing at runtime can tell "the OS set this" from "the user set this to the
  // same string", so this guard does NOT claim to. It requires an explicit,
  // app-scoped variable (QA_<NAME>) and refuses to fall back to the ambiguous
  // one — turning a silent wrong value into a one-line instruction. The export
  // also warns at authoring time, which is where the name can actually be fixed.
  const collisions = osEnvCollisions(steps)
  if (collisions.length) {
    lines.push(
      `${indent}// ⚠ ${collisions.join(', ')} ${collisions.length === 1 ? 'is also an OS' : 'are also OS'} environment variable${collisions.length === 1 ? '' : 's'} (on Windows USERNAME is your`,
      `${indent}// login name), so reading it directly can silently pick up the OS value. This test`,
      `${indent}// requires the QA_-prefixed name instead. Rename the {{env:…}} token in the app to`,
      `${indent}// something app-specific to drop this guard entirely.`,
      `${indent}for (const name of ${JSON.stringify(collisions)}) {`,
      `${indent}  if (!process.env['QA_' + name]) {`,
      `${indent}    throw new Error(\`Set QA_\${name} — \${name} on its own collides with an OS variable.\`)`,
      `${indent}  }`,
      `${indent}}`
    )
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
  return frame.reduce((base, f) => `${base}.frameLocator(${quote(frameSelector(f))})`, pageVar)
}

/**
 * The CSS selector that finds one iframe, from what the recorder saved about it.
 *
 * `url` is the frame's ABSOLUTE url (Electron's WebFrameMain.url), but the page's
 * markup usually writes a RELATIVE src — practice.expandtesting.com embeds
 * `src="/iframe-email-subscribe"`. `[src="https://…/iframe-email-subscribe"]` is
 * a literal attribute match, so it found nothing and the exported test failed at
 * the frame, reading as "the app is broken". In-app replay never noticed: it
 * re-finds frames by comparing urls, not by an attribute selector.
 *
 * So match the END of the src instead. `[src$="/iframe-email-subscribe"]` is true
 * for the relative form AND the absolute one, which is what "this frame" means.
 * A query string is kept (it can be the only thing telling two frames apart);
 * only the origin — the part the markup is free to omit — is dropped.
 */
function frameSelector(f: FrameRef[number]): string {
  if (f.name) return `iframe[name=${quote(f.name)}]`
  let tail = f.url
  try {
    const u = new URL(f.url)
    // http(s) only. `about:blank` parses too, and its "pathname" is `blank` —
    // suffix-matching that would produce iframe[src$="blank"], which matches any
    // frame whose src happens to end in those letters.
    // A frame at the site root has no path to match on; keep the whole url.
    if (/^https?:$/.test(u.protocol) && u.pathname.startsWith('/') && u.pathname !== '/') {
      tail = `${u.pathname}${u.search}`
    }
  } catch {
    // Not a url at all (srcdoc, a relative src already) — use it as-is.
  }
  return tail === f.url && !tail.startsWith('/')
    ? `iframe[src=${quote(f.url)}]`
    : `iframe[src$=${quote(tail)}]`
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
// What to call a step's element in a human sentence.
//
// `label` is the recorded accessible name, and it is NOT always there: an
// element with no text/aria-label (an icon button, a bare input, an F18/F21
// AI-picked step) records without one. Every sentence below interpolated it
// straight, so those steps read "Click undefined" — in the step list, in living
// docs, in the failure report, and in a `//` comment above every line of every
// exported spec. It was never a crash, just a word that told the reader nothing.
//
// The selector already names the element (that is what a selector IS), so fall
// back to the useful part of it rather than to a placeholder.
function elementName(step: RecorderStep): string {
  const label = (step.label ?? '').trim()
  if (label) return label
  const sel = (step.selector ?? '').trim()
  if (!sel) return 'the element'
  // getByRole('button', { name: 'Add to cart' }) → the NAME, not the role: it's
  // what a reader would have called the thing.
  const named = /name:\s*(['"])([\s\S]*?)\1/.exec(sel)
  // getByTestId('login-button') / getByText('Products') / locator('#cart') → arg.
  const firstArg = /^[A-Za-z_$][\w$]*\(\s*(['"])([\s\S]*?)\1/.exec(sel)
  const pick = named?.[2] ?? firstArg?.[2] ?? sel
  const flat = pick.replace(/\s+/g, ' ').trim()
  if (!flat) return 'the element'
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat
}

export function stepText(step: RecorderStep): string {
  const name = elementName(step)
  switch (step.type) {
    case 'navigate':
      return `Go to ${step.url || '(no URL)'}`
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
      return `Click ${name}`
    case 'type':
      return `Type "${step.secret ? '••••••••' : (step.value ?? '')}" into ${name}`
    case 'select':
      return `Select "${step.value ?? ''}" in ${name}`
    case 'press':
      return `Press ${step.key ?? 'Enter'} in ${name}`
    case 'hover':
      return `Hover over ${name}`
    case 'assert':
      switch (step.assertKind) {
        case 'text-equals':
          return `Check ${name} text is "${step.value ?? ''}"`
        case 'text-contains':
          return `Check ${name} contains "${step.value ?? ''}"`
        case 'value':
          return `Check ${name} value is "${step.value ?? ''}"`
        case 'enabled':
          return `Check ${name} is enabled`
        case 'disabled':
          return `Check ${name} is disabled`
        case 'checked':
          return `Check ${name} is checked`
        case 'unchecked':
          return `Check ${name} is not checked`
        case 'hidden':
          return `Check ${name} is hidden`
        case 'count':
          return `Check ${name} matches ${step.value ?? '0'} element(s)`
        case 'focused':
          return `Check ${name} is focused`
        case 'editable':
          return `Check ${name} is editable`
        case 'empty':
          return `Check ${name} is empty`
        case 'attribute':
          return `Check ${name} attribute ${step.attrName ?? ''} is "${step.value ?? ''}"`
        case 'class':
          return `Check ${name} has class "${step.value ?? ''}"`
        case 'url-contains':
          return `Check URL contains "${step.value ?? ''}"`
        case 'title':
          return `Check page title is "${step.value ?? ''}"`
        case 'nl':
          return `AI check: "${step.value ?? ''}"`
        default:
          return `Check ${name} is visible`
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

// The same description, safe to put after `//` in the generated file.
//
// Every emitted line carries a one-line comment describing its step, and that
// description quotes the RECORDED VALUE. A value with a line break in it (a
// textarea — an address, a comment box, pasted JSON) ended the comment early and
// left the rest of the text sitting in the file AS CODE: "Unterminated string
// literal", and Playwright treats a spec it cannot parse as a fatal LOAD error —
// it abandons the WHOLE run, not just that test. The action line itself was
// always fine (quote() escapes it); only the comment broke.
//
// Collapsing the whitespace is the whole fix: a description is a one-line label,
// so a value's internal line breaks were never meaningful here.
function stepComment(step: RecorderStep): string {
  return stepText(step).replace(/\s*[\r\n]+\s*/g, ' ')
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

/**
 * Put the quotes back on a bare `getBy…()` argument.
 *
 * A handful of tests carry `getByTestId(username)` instead of
 * `getByTestId("username")`. The app's replay engine parses the selector itself
 * and doesn't care — but the EXPORT is real JavaScript, so `getByTestId(username)`
 * is a reference to a variable that was never declared. The spec dies with
 * `ReferenceError: username is not defined` before a single step runs, and
 * `getByTestId(login-button)` is worse still: valid syntax, read as subtraction.
 *
 * That made those tests silently un-exportable — their generated spec had never
 * compiled, in CI or anywhere else. F39 (parallel) was simply the first thing
 * that ever RAN an export, which is how it surfaced (Surbhi, Test 7).
 *
 * Only rewrites an argument that is a plain unquoted token: no quotes, commas,
 * braces or parens. `getByRole('button', { name: 'Go' })` is already quoted and
 * is left exactly as it is.
 */
export function repairSelector(sel: string | undefined): string | undefined {
  if (!sel) return sel
  const s = sel.trim()
  if (!s) return sel
  // A RAW selector where a locator expression belongs.
  //
  // `selector` is always an expression appended to `page.` — `getByTestId('x')`,
  // `locator('#y')`. F18 (AI step) and F21 (Bug check) stored the candidate's raw
  // CSS instead, so the spec compiled to `page.[data-test="username"]`: a
  // SyntaxError that aborts the ENTIRE spec before any test runs. The app's own
  // replay parses selectors leniently, so those steps replayed GREEN in-app while
  // never having produced runnable Playwright — export, headless, parallel,
  // monitors and cross-browser all died on them.
  //
  // Fixed at the source, but kept here too: drafts and tests already carry these,
  // and self-heal / re-pick / a hand-edited selector field can reintroduce one.
  // Anything that isn't a method call is a raw selector — `locator()` accepts
  // CSS, XPath and `text=` engines alike, so wrapping is always correct.
  if (!/^[A-Za-z_$][\w$]*\s*\(/.test(s)) return `locator(${quote(s)})`
  return s.replace(
    /^(getBy(?:TestId|Text|Label|Placeholder|AltText|Title))\(\s*([A-Za-z0-9_\-.:#[\] ]+?)\s*\)/,
    (_m, fn: string, arg: string) => `${fn}(${quote(arg)})`
  )
}

/** Same, for a whole step list — the one place every exporter starts from. */
export function repairSteps(steps: RecorderStep[]): RecorderStep[] {
  return steps.map((s) =>
    s.selector && repairSelector(s.selector) !== s.selector
      ? { ...s, selector: repairSelector(s.selector) }
      : s
  )
}

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

/**
 * How long an exported optional step waits before giving up. Mirrors the app's
 * own `step.optional ? 2500 : 8000` (replay.ts) — WITHOUT it the exported step
 * inherits Playwright's 30s default, so an absent element (the only case
 * optional exists for) stalls for 30s, exhausts the test's own 30s budget, and
 * every later step runs against a closed page. Proven, not theorised.
 */
const OPTIONAL_TIMEOUT_MS = 2500

/**
 * Add `{ timeout: … }` to the action call on `line`.
 *
 * Every step type that CAN be optional (click / type / select / press / hover /
 * assert — see canBeOptional) ends in a call whose last parameter is an options
 * object, so appending one is always valid. `toHaveScreenshot`, whose second
 * parameter is NOT options, is excluded from optional and can't reach here.
 */
function withOptionalTimeout(line: string): string {
  // A trailing `// comment` (the password step carries one). Matched only when
  // it holds no ")", so a ")" inside a string value can't be mistaken for the
  // call's closing paren. Anything else is treated as pure code.
  const withComment = /^(.*\))(\s*\/\/[^)]*)$/.exec(line)
  const code = withComment ? withComment[1] : line
  const comment = withComment ? withComment[2] : ''
  const close = code.lastIndexOf(')')
  if (close < 0) return line // not a call — leave it exactly as it is
  const head = code.slice(0, close)
  const opts = `{ timeout: ${OPTIONAL_TIMEOUT_MS} }`
  // `foo()` takes the object as its only argument; `foo(x)` needs a comma.
  const sep = head.trimEnd().endsWith('(') ? '' : ', '
  return `${head}${sep}${opts})${comment}`
}

function wrapOptional(line: string, pad: string): string {
  return (
    `${pad}try {\n` +
    `${pad}  ${withOptionalTimeout(line)}\n` +
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
    // Matches the COMMENT that was emitted, so it must be sanitized the same
    // way — a teardown step with a multi-line label would otherwise never be
    // found here, and would silently stay out of the finally block.
    const text = stepComment(s)
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

// Day 20 named each row's test after its first column, built at RUNTIME as a
// template literal. Two rows with the same value in that column therefore
// produced two identical test titles — and Playwright treats a duplicate title
// as a fatal LOAD error that aborts the entire run, not just that file. One
// negative-login table with `standard_user` twice took down all 12 tests in the
// batch, every one reported as failed (Surbhi, Test 7).
//
// So titles are computed HERE, where every row is visible at once, and a repeat
// gets its row number appended. An empty cell (a legitimate negative case —
// "username is required") becomes "(empty)" rather than a title that trails off
// after the dash.
//
// This lives in ONE place because the first fix only reached the inline
// exporter: the page-object exporter kept emitting the runtime template literal,
// so exporting the SAME table as a POM still produced the fatal duplicate. Both
// generators now call this, so they cannot drift apart again.
export function dataRowTitles(
  base: string,
  rows: Record<string, string>[],
  disc: string
): string[] {
  const seen = new Map<string, number>()
  return rows.map((r, i) => {
    const cell = (r[disc] ?? '').trim()
    const label = cell === '' ? '(empty)' : cell
    const n = (seen.get(label.toLowerCase()) ?? 0) + 1
    seen.set(label.toLowerCase(), n)
    return `${base} — ${label}${n > 1 ? ` (row ${i + 1})` : ''}`
  })
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
  // Quote any bare getBy…() argument before anything reads a selector — an
  // unquoted one compiles to a reference to a variable that doesn't exist.
  const enabled = repairSteps(steps).filter((step) => !step.disabled)
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
            `  // ${stepComment(step)}\n` +
              `  const ${items} = ${pageBase(pageVar, step.frame)}.${(idPolicy.portable && portableTestIdSelector(step)) || step.selector}\n` +
              // Count ONCE up front, matching the app: a live count could loop
              // forever if the body adds matching elements.
              `  const ${items}Count = await ${items}.count()\n` +
              `  for (let ${v} = 0; ${v} < ${items}Count; ${v}++) {`
          )
        } else {
          const n = parseInt(step.value ?? '1', 10)
          const times = Number.isFinite(n) && n > 0 ? n : 1
          lines.push(`  // ${stepComment(step)}\n  for (let ${v} = 0; ${v} < ${times}; ${v}++) {`)
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
          `  // ${stepComment(step)}\n  if (${conditionExpr(step, pageVar, idPolicy.portable)}) {`
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
        `  // ${stepComment(step)}\n` +
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
      lines.push(`  // ${stepComment(next)}\n  ${dialogHandler(next, pv(next.windowId))}`)
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
        `  // ${stepComment(step)}\n` +
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
        `${healNote}  // ${stepComment(step)} (optional — skipped if not present)\n` +
          wrapOptional(indented, '  ')
      )
      continue
    }
    lines.push(`${healNote}  // ${stepComment(step)}\n  ${action}`)
  }
  // F37: close any block whose end marker is missing. A 🔁 Repeat or 🔀 If with
  // no matching end left the file with an unbalanced `{`, and Playwright treats a
  // spec that won't parse as a fatal LOAD error — it abandons the WHOLE run, so
  // one malformed test took down all 58 (Surbhi, Test 7). The app itself refuses
  // to run a test with a mismatched marker; the exporter didn't check at all.
  //
  // Closing to the end of the test is the only reading that loses nothing: every
  // remaining step stays inside the block, which is what "the author never closed
  // it" most plausibly meant. The comment says so out loud, so nobody reads the
  // exported file as the author's own structure.
  while (depth > 0) {
    depth--
    syncDepth()
    lines.push(`  } // ⚠ auto-closed — this block had no matching end marker`)
    syncDepth()
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
    const base = options?.name || 'recorded flow'
    // Day 20 named each row's test after its first column, built at RUNTIME as a
    // template literal. Two rows with the same value in that column therefore
    // produced two identical test titles — and Playwright treats a duplicate
    // title as a fatal LOAD error that aborts the entire run, not just that file.
    // One negative-login table with `standard_user` twice took down all 12 tests
    // in the batch, every one of them reported as failed (Surbhi, Test 7).
    //
    // So titles are now computed HERE, where every row is visible at once, and a
    // repeat gets its row number appended. An empty cell (a legitimate negative
    // case — "username is required") becomes "(empty)" rather than a title that
    // trails off after the dash.
    const titles = dataRowTitles(base, rows, disc)
    const titleList = titles.map((t) => `  ${quote(t)}`).join(',\n')
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

// One test per row. Titles are pre-computed so no two can collide — Playwright
// aborts the whole run on a duplicate test title, not just the offending file.
const titles = [
${titleList}
]

for (const [i, data] of dataset.entries()) {
  test(titles[i]${tagArg}, async (${fixtures}) => {
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
  const idPolicy = testIdPolicy(
    cases.flatMap((c) => repairSteps(c.steps)).filter((s) => !s.disabled)
  )

  const testBlocks: string[] = []
  for (const c of variants) {
    const enabled = repairSteps(c.steps).filter((s) => !s.disabled)
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
      actionLines.push(`  // ${stepComment(step)}\n  ${action}`)
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
// Scope: everything the inline export handles. It used to refuse iframes,
// multi-tab, dialogs and downloads and fall back to inline — which was the
// wrong trade: page objects are how real suites are written, so the flows a
// generator gives up on are exactly the ones a tester then hand-writes. Each of
// the four has a standard page-object shape, and this now emits it:
//
//   iframe    → a FrameLocator field; every locator inside it hangs off that
//               field, so the frame plumbing lives in ONE place.
//   dialog    → page.once('dialog', …) inside the method that triggers it.
//   download  → the method returns the Download; the spec asserts on it (the
//               assertion stays in the test, like every other check here).
//   new tab   → a class per tab, and the method that opens one RETURNS the new
//               page object: `const help = await shop.openHelp()`.
//
// All the classes live in the one page file, exported side by side.
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
): {
  spec: string
  // Every page-object class, one per file — tab 0's first. Write them all.
  pages: { fileName: string; className: string; source: string }[]
  // The MAIN class, repeated for callers that only ever handled one page file.
  page: string
  pageFileName: string
  className: string
} | null {
  // Same bare-selector repair as the inline export — a POM class field would
  // otherwise compile to `page.getByTestId(username)` just the same.
  const enabled = repairSteps(steps).filter((s) => !s.disabled)

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
  const baseName = pascalName(options?.name || 'recorded flow')
  const className = `${baseName}Page`
  const pageFileName = `${className}.ts`
  // Test-id portability — same policy as the inline export (see testIdPolicy).
  const idPolicy = testIdPolicy(enabled)
  // F38: POM/inline parity — the same tags reach both exports.
  const tagArg = tagArgFor(options?.tags)

  // The class's Locator fields must use the SAME portable rewrite as the inline
  // export, or a data-test app's POM locators resolve to nothing.
  const exprOf = (step: RecorderStep): string =>
    ((idPolicy.portable && portableTestIdSelector(step)) || step.selector) as string

  // === Which tab, which frame ==========================================
  // An element is only "the same element" if the selector, the FRAME and the
  // TAB all match — the same `getByTestId('submit')` inside two different
  // iframes is two different controls, and would otherwise share one field.
  const tabOf = (step: RecorderStep): number => step.windowId ?? 0
  const frameKeyOf = (step: RecorderStep): string =>
    (step.frame ?? []).map((f) => f.name || f.url).join('>')
  const keyOf = (step: RecorderStep): string =>
    `${tabOf(step)}|${frameKeyOf(step)}|${exprOf(step)}`

  // What IS each element? Decided by every action performed on it across the
  // WHOLE test — not by the one step we happen to name it from.
  //
  // The old rule suffixed "Button" onto anything that was CLICKED, so a text
  // input you clicked into before typing came out as `usernameButton` — and the
  // class then read `await this.usernameButton.fill("standard_user")`, which is
  // nonsense a reviewer would flag instantly. A click tells you what the tester
  // DID; it does not tell you what the element IS. Typing into it does.
  type ElKind = 'input' | 'select' | 'button'
  const kindByKey = new Map<string, ElKind>()
  for (const s of enabled) {
    if (!s.selector) continue
    const e = keyOf(s)
    // `type` wins unconditionally — you cannot fill a button, so a fill is proof.
    if (s.type === 'type') kindByKey.set(e, 'input')
    else if (s.type === 'select' && kindByKey.get(e) !== 'input') kindByKey.set(e, 'select')
    else if ((s.type === 'click' || s.type === 'press') && !kindByKey.has(e)) {
      kindByKey.set(e, 'button')
    }
  }
  const SUFFIX: Record<ElKind, string> = { input: 'Input', select: 'Select', button: 'Button' }

  // === One class per tab ===============================================
  // A page object models ONE page, so a flow that opens a popup needs a second
  // class. They share this shape; tab 0's is the one the spec instantiates, and
  // every other is returned by the method that opens its tab.
  interface TabCtx {
    windowId: number
    className: string
    specVar: string
    // Member names are per CLASS: a property and a method can't share a name.
    used: Set<string>
    frameDefs: { name: string; expr: string }[]
    frameNameByKey: Map<string, string>
    locatorDefs: { name: string; base: string; selector: string }[]
    methods: {
      name: string
      body: string[]
      usesData: boolean
      returns?: { type: string; expr: string }
    }[]
    actionsSeq: number
    // Set once the spec has a variable holding this tab's page object.
    declared: boolean
    // …and set only when the SPEC is the thing that constructs it, which is the
    // only case where the spec file has to import the class. A tab opened by a
    // method is constructed inside the page file, beside its own class.
    specConstructs: boolean
  }
  const tabs = new Map<number, TabCtx>()
  const tabCtx = (windowId: number): TabCtx => {
    const existing = tabs.get(windowId)
    if (existing) return existing
    const ctx: TabCtx = {
      windowId,
      // "Popup", not "Tab": it is what Playwright calls a page opened by another
      // page (context.waitForEvent('page') / page.on('popup')), it matches the
      // `const [popup]` the opener method already emits, and it doesn't collide
      // with the other meaning of "tab" — the export dialog's one-per-FILE tabs.
      className: windowId === 0 ? className : `${baseName}Popup${windowId}Page`,
      specVar: windowId === 0 ? 'app' : `popup${windowId}`,
      used: new Set<string>(['page', 'goto', 'constructor']),
      frameDefs: [],
      frameNameByKey: new Map(),
      locatorDefs: [],
      methods: [],
      actionsSeq: 0,
      declared: windowId === 0,
      specConstructs: windowId === 0
    }
    tabs.set(windowId, ctx)
    return ctx
  }
  // Tab 0 always exists, even for a flow that never touches it.
  tabCtx(0)

  const uniqueName = (ctx: TabCtx, base: string): string => {
    let name = base
    let n = 2
    while (ctx.used.has(name)) name = `${base}${n++}`
    ctx.used.add(name)
    return name
  }

  // The FrameLocator field an element inside an <iframe> hangs off. Declared
  // once per distinct frame chain, so the frame plumbing lives in one place and
  // every locator in that frame reads like any other locator.
  const frameFieldFor = (ctx: TabCtx, step: RecorderStep): string | null => {
    if (!step.frame?.length) return null
    const key = frameKeyOf(step)
    const existing = ctx.frameNameByKey.get(key)
    if (existing) return existing
    const last = step.frame[step.frame.length - 1]
    // Prefer the iframe's name/id; a src URL makes a poor identifier, so fall
    // back to a numbered frame rather than mangling a URL into a variable.
    const raw = last.name ? camelName(last.name) : `frame${ctx.frameDefs.length + 1}`
    const name = uniqueName(ctx, `${raw}Frame`)
    ctx.frameNameByKey.set(key, name)
    ctx.frameDefs.push({ name, expr: pageBase('page', step.frame) })
    return name
  }

  // Member names shared across locators + methods (a class can't have a property
  // and a method with the same name), plus reserved members.
  const nameByKey = new Map<string, string>()
  const nameForElement = (step: RecorderStep): string => {
    const key = keyOf(step)
    const existing = nameByKey.get(key)
    if (existing) return existing
    const ctx = tabCtx(tabOf(step))
    const kind = kindByKey.get(key)
    // An element only ever ASSERTED on gets no suffix — it isn't a control.
    const name = uniqueName(
      ctx,
      camelName(step.label || step.type) + (kind ? SUFFIX[kind] : '')
    )
    nameByKey.set(key, name)
    const frameField = frameFieldFor(ctx, step)
    ctx.locatorDefs.push({
      name,
      base: frameField ? `this.${frameField}` : 'page',
      selector: exprOf(step)
    })
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
  const specBody: string[] = []
  // F24.4: which specBody lines are 🧹 teardown (hoisted into a `finally` below).
  const specTeardownIdx = new Set<number>()
  let buffer: string[] = []
  let bufferUsesData = false
  let lastActionLabel = ''
  // Which tab the buffered actions belong to — a method lives on exactly one
  // class, so switching tabs mid-buffer has to flush first.
  let bufferTab = 0
  // F37: how deeply nested in loops / if-blocks the CURRENT spec line is. The
  // control flow lives in the SPEC, wrapping the `await app.method()` calls;
  // page-object methods stay flat, so each method is still one readable intent.
  // Emitting it here (rather than not at all) is what makes a POM export of a
  // looping test mean the same thing the inline export means.
  let depth = 0
  const ind = (): string => '  '.repeat(depth + 1)
  // `returns` turns the flushed method into one that hands something back — the
  // new tab's page object, or a Download — so the spec can name it.
  const flush = (returns?: { type: string; expr: string; assignTo: string }): void => {
    if (!buffer.length) return
    const ctx = tabCtx(bufferTab)
    const base = lastActionLabel ? camelName(lastActionLabel) : `actions${++ctx.actionsSeq}`
    const name = uniqueName(ctx, base)
    ctx.methods.push({
      name,
      body: buffer,
      usesData: bufferUsesData,
      returns: returns ? { type: returns.type, expr: returns.expr } : undefined
    })
    // A data-using method receives the row: `await app.login(data)`. tabVar()
    // rather than ctx.specVar so a tab that no step opened still gets declared
    // before the first call on it.
    const call = `${tabVar(bufferTab)}.${name}(${bufferUsesData ? 'data' : ''})`
    specBody.push(`${ind()}${returns ? `const ${returns.assignTo} = ` : ''}await ${call}`)
    buffer = []
    bufferUsesData = false
    lastActionLabel = ''
  }
  // Every step that isn't buffered still has to respect the buffer's tab.
  const flushIfTabChanges = (windowId: number): void => {
    if (buffer.length && windowId !== bufferTab) flush()
    if (!buffer.length) bufferTab = windowId
  }
  // The spec-side handle for a tab. Tab 0 is `app`, created by the spec itself;
  // any other tab is created by the method that opened it. If a step names a tab
  // nothing ever opened (a hand-edited test, or a popup the recorder missed), we
  // still have to declare SOMETHING or the spec references an undefined name.
  const tabVar = (windowId: number): string => {
    const ctx = tabCtx(windowId)
    if (!ctx.declared) {
      ctx.declared = true
      ctx.specConstructs = true
      specBody.push(
        `${ind()}// ⚠ no recorded step opened browser tab ${windowId} — taking it from the context by`,
        `${ind()}// position. Re-record the click that opens it to get the proper wait.`,
        `${ind()}const ${ctx.specVar} = new ${ctx.className}(page.context().pages()[${windowId}])`
      )
    }
    return ctx.specVar
  }

  let firstNavSeen = false
  let loopSeq = 0
  let downloadSeq = 0
  for (let stepIdx = 0; stepIdx < enabled.length; stepIdx++) {
    const step = enabled[stepIdx]
    const next = enabled[stepIdx + 1]
    // Which page object this step talks to, and the page behind it.
    const ctxVar = (): string => tabVar(tabOf(step))
    const pageOf = (): string => `${ctxVar()}.page`
    // Day 16: a dialog step ANSWERS the action before it — the handler is
    // emitted just ahead of its trigger (below), never as a step of its own.
    if (step.type === 'dialog') continue
    // Day 16(+): a download step VERIFIES the file the previous action started.
    // The method returned the Download; the check belongs in the spec, with
    // every other assertion.
    if (step.type === 'download') {
      const want = (step.value ?? step.label ?? 'file').trim()
      const v = `download${downloadSeq}`
      specBody.push(`${ind()}expect(${v}.suggestedFilename()).toContain(${quote(want)})`)
      specBody.push(`${ind()}expect(fs.statSync(await ${v}.path()).size).toBeGreaterThan(0)`)
      continue
    }
    // Day 17: closing a tab is a lifecycle step, not an intent — it reads
    // better in the spec than hidden inside a method.
    if (step.type === 'closeTab') {
      flush()
      specBody.push(`${ind()}await ${pageOf()}.close()`)
      continue
    }
    // === F37: loops + branching, emitted as REAL control flow ===
    // Every control marker flushes the action buffer first, so a method never
    // straddles a block boundary (half its steps inside the loop, half outside).
    if (isControlStep(step)) {
      if (step.type === 'repeat') {
        flush()
        const v = `i${depth}`
        if (step.repeatKind === 'each' && step.selector) {
          const items = `items${loopSeq++}`
          const sel = (idPolicy.portable && portableTestIdSelector(step)) || step.selector
          specBody.push(`${ind()}// ${stepComment(step)}`)
          specBody.push(`${ind()}const ${items} = ${pageBase(pageOf(), step.frame)}.${sel}`)
          // Count ONCE up front, matching the app and the inline export: a live
          // count could loop forever if the body adds matching elements.
          specBody.push(`${ind()}const ${items}Count = await ${items}.count()`)
          specBody.push(`${ind()}for (let ${v} = 0; ${v} < ${items}Count; ${v}++) {`)
        } else {
          const n = parseInt(step.value ?? '1', 10)
          const times = Number.isFinite(n) && n > 0 ? n : 1
          specBody.push(`${ind()}// ${stepComment(step)}`)
          specBody.push(`${ind()}for (let ${v} = 0; ${v} < ${times}; ${v}++) {`)
        }
        depth++
        continue
      }
      if (step.type === 'if') {
        flush()
        specBody.push(`${ind()}// ${stepComment(step)}`)
        specBody.push(
          `${ind()}if (${conditionExpr(step, pageBase(pageOf(), step.frame), idPolicy.portable)}) {`
        )
        depth++
        continue
      }
      if (step.type === 'else') {
        flush()
        depth = Math.max(0, depth - 1)
        specBody.push(`${ind()}} else {`)
        depth++
        continue
      }
      if (step.type === 'endRepeat' || step.type === 'endIf') {
        flush()
        depth = Math.max(0, depth - 1)
        specBody.push(`${ind()}}`)
        continue
      }
    }
    if (step.type === 'navigate') {
      flush()
      if (!firstNavSeen && tabOf(step) === 0) {
        firstNavSeen = true
        specBody.push(`${ind()}await app.goto()`)
      } else {
        let url = step.url ?? ''
        if (baseURL && url.startsWith(baseURL)) url = url.slice(baseURL.length) || '/'
        specBody.push(`${ind()}await ${pageOf()}.goto(${quote(url)})`)
      }
      continue
    }
    if (step.type === 'assert') {
      flush()
      const name = usesElement(step) ? nameForElement(step) : ''
      // The assert lives in the spec, where `data` is in scope (inside the
      // per-row loop), so a tokenized expected value can stay a `data.*` ref.
      // The element locator is already frame- and tab-scoped by its class.
      const line = actionFor(
        step,
        baseURL,
        pageOf(),
        name ? `${ctxVar()}.${name}` : undefined,
        columns,
        idPolicy.portable
      )
      if (line) specBody.push(step.optional ? wrapOptional(line, ind()) : `${ind()}${line}`)
      continue
    }
    // F13/F14/F15: a page-level accessibility, performance or VISUAL check —
    // like an assert, it lives in the spec (where `expect`/AxeBuilder are
    // imported), not a page-object method.
    //
    // `snapshot` used to be missing from this list. A snapshot step carries no
    // selector, so it fell through to the `if (!step.selector) continue` below
    // and was dropped WITHOUT A TRACE — no toHaveScreenshot, not even a comment.
    // A visual-regression test exported as a page object therefore did no visual
    // checking at all and reported green. Found by diffing inline vs POM output.
    if (step.type === 'a11y' || step.type === 'perf' || step.type === 'snapshot') {
      flush()
      const line = actionFor(step, baseURL, pageOf(), undefined, columns, idPolicy.portable)
      if (line) specBody.push(`${ind()}${line}`)
      continue
    }
    // F24: an api step uses the `request` fixture (in the spec's test signature),
    // not the page object — so it lives in the spec body, like an assert.
    if (step.type === 'api') {
      flush()
      const line = actionFor(step, baseURL, pageOf(), undefined, columns, idPolicy.portable)
      if (line) {
        specBody.push(`${ind()}${line}`)
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
      flushIfTabChanges(tabOf(step))
      const line = actionFor(step, baseURL, 'this.page', undefined, columns, idPolicy.portable)
      if (line) buffer.push(`    ${line}`)
      if (stepUsesData(step)) bufferUsesData = true
      continue
    }
    if (!step.selector) continue
    flushIfTabChanges(tabOf(step))
    const name = nameForElement(step)
    // Day 16: a dialog is answered by a handler REGISTERED BEFORE the action
    // that raises it, so it goes into the method just above its trigger.
    if (next && next.type === 'dialog') {
      buffer.push(`    ${dialogHandler(next, 'this.page')}`)
    }
    // Day 16(+): same ordering rule for a download — start waiting before the
    // click, or the event has already fired by the time you listen.
    const startsDownload = !!next && next.type === 'download'
    if (startsDownload) {
      downloadSeq++
      buffer.push(`    const downloadPromise = this.page.waitForEvent('download')`)
    }
    const line = actionFor(step, baseURL, 'this.page', `this.${name}`, columns, idPolicy.portable)
    if (line) buffer.push(step.optional ? wrapOptional(line, '    ') : `    ${line}`)
    if (stepUsesData(step)) bufferUsesData = true
    // Day 17: this click opens a tab. The method awaits the new page alongside
    // the click (arming the wait first, as Playwright requires) and hands back
    // that tab's page object — the classic POM shape for a popup.
    if (step.opensWindow !== undefined && line) {
      const opened = tabCtx(step.opensWindow)
      opened.declared = true
      // Re-wrap the action we just pushed: it has to sit INSIDE the Promise.all.
      buffer.pop()
      buffer.push(
        `    const [popup] = await Promise.all([`,
        `      this.page.context().waitForEvent('page'),`,
        `      ${line.replace(/^await /, '')}`,
        `    ])`
      )
      lastActionLabel = step.label || ''
      flush({
        type: opened.className,
        expr: `new ${opened.className}(popup)`,
        assignTo: opened.specVar
      })
      continue
    }
    if (startsDownload) {
      lastActionLabel = step.label || ''
      flush({ type: 'Download', expr: 'downloadPromise', assignTo: `download${downloadSeq}` })
      continue
    }
    // A method should be ONE intent, named for it. The old rule flushed only at a
    // navigate/assert boundary and named the method after its LAST step — so
    // "fill user, fill password, click Login, click Add to cart" became a single
    // `addToCart()` that secretly logs you in. A page object that lies about what
    // its methods do is worse than no page object.
    //
    // A click on a real BUTTON is what completes an intent (submit / add / save);
    // a click on an input is just focus, and must not end anything or name it.
    if (step.type === 'click' || step.type === 'press') {
      if (kindByKey.get(keyOf(step)) === 'button') {
        lastActionLabel = step.label || ''
        flush()
      }
    }
  }
  flush()
  // F37: a block the author never closed. Same reading as the inline export —
  // close to the end of the test, so every remaining step stays inside the
  // block, and SAY SO in the file so nobody mistakes it for the author's own
  // structure. Without this the spec would be missing a `}` and fail to load,
  // which in Playwright takes down the entire run, not just this file.
  while (depth > 0) {
    depth--
    specBody.push(`${ind()}} // ⚠ auto-closed — this block had no matching end marker`)
  }

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

  // === Build the page class files ===
  // ONE CLASS PER FILE — the convention every page-object codebase follows, and
  // what makes a generated POM something a team can adopt rather than tidy up.
  // Tab 0's class is the one the spec instantiates; each other tab gets its own
  // file, and tab 0's file imports the ones its methods construct.
  const orderedTabs = [...tabs.values()].sort((a, b) => a.windowId - b.windowId)
  const usedTabs = orderedTabs.filter(
    (t) => t.windowId === 0 || t.locatorDefs.length || t.methods.length || t.frameDefs.length
  )
  const classFile = (ctx: TabCtx): string => {
    // Only import the types this file uses — an unused import trips a lint rule
    // in the user's repo, and these files are meant to be committed as-is.
    const types = ['Page', 'Locator']
    if (ctx.frameDefs.length) types.push('FrameLocator')
    if (ctx.methods.some((m) => m.returns?.type === 'Download')) types.push('Download')
    const lines: string[] = []
    lines.push(`import { ${types.map((t) => `type ${t}`).join(', ')} } from '@playwright/test'`)
    // A method that opens a tab returns that tab's page object, which now lives
    // next door rather than lower down the same file.
    for (const m of ctx.methods) {
      const returned = m.returns?.type
      if (returned && returned !== 'Download') lines.push(`import { ${returned} } from './${returned}'`)
    }
    lines.push('')
    lines.push(`export class ${ctx.className} {`)
    lines.push(`  readonly page: Page`)
    // Frames first: every locator below is scoped to one of them.
    for (const f of ctx.frameDefs) lines.push(`  readonly ${f.name}: FrameLocator`)
    for (const d of ctx.locatorDefs) lines.push(`  readonly ${d.name}: Locator`)
    lines.push('')
    lines.push(`  constructor(page: Page) {`)
    lines.push(`    this.page = page`)
    // …and assigned first too, or a locator would read an undefined field.
    for (const f of ctx.frameDefs) lines.push(`    this.${f.name} = ${f.expr}`)
    for (const d of ctx.locatorDefs) lines.push(`    this.${d.name} = ${d.base}.${d.selector}`)
    lines.push(`  }`)
    // Only the tab the test STARTS in has somewhere to navigate to; a popup
    // arrives already pointed at its URL.
    if (ctx.windowId === 0) {
      lines.push('')
      lines.push(`  async goto(): Promise<void> {`)
      lines.push(`    await this.page.goto(${quote(gotoUrl)})`)
      lines.push(`  }`)
    }
    for (const m of ctx.methods) {
      lines.push('')
      // A data-using method receives the current row; its body already references
      // `data.column` (env tokens read process.env directly, so they need no arg).
      const params = m.usesData ? 'data: Record<string, string>' : ''
      lines.push(`  async ${m.name}(${params}): Promise<${m.returns?.type ?? 'void'}> {`)
      for (const b of m.body) lines.push(b)
      if (m.returns) lines.push(`    return ${m.returns.expr}`)
      lines.push(`  }`)
    }
    lines.push(`}`)
    return `${lines.join('\n')}\n`
  }
  const pages = usedTabs.map((ctx) => ({
    fileName: `${ctx.className}.ts`,
    className: ctx.className,
    source: classFile(ctx)
  }))
  // The main class, also returned on its own for every caller that only ever
  // dealt with one page file.
  const page = pages[0].source

  // === Build the spec file ===
  const hasA11y = enabled.some((s) => s.type === 'a11y')
  const hasPerf = enabled.some((s) => s.type === 'perf')
  const needsRequest = enabled.some((s) => s.type === 'api')
  const specFixtures = needsRequest ? '{ page, request }' : '{ page }'
  // `snapshot` counts too — a test whose only check is a 📸 visual snapshot
  // still emits `await expect(page).toHaveScreenshot(...)` and so still needs
  // `expect` imported. (It was absent from this list back when the POM export
  // dropped snapshot steps entirely, so the gap never showed.)
  // Day 16(+): a download check asserts on the returned Download and reads the
  // file off disk, so it needs `expect` and `fs` exactly like the inline export.
  const hasDownload = enabled.some((s) => s.type === 'download')
  const hasAssert =
    enabled.some((s) => s.type === 'assert' || s.type === 'snapshot') ||
    hasA11y ||
    hasPerf ||
    hasDownload ||
    needsRequest
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
    (hasDownload ? "import fs from 'fs'\n" : '') +
    // F24.1: parity with the inline export — the POM spec runs the same API steps.
    (runtimeTokenUse(enabled).uuid ? "import { randomUUID } from 'node:crypto'\n" : '') +
    // Every tab's class the spec NAMES — tab 0 to instantiate it, and any other
    // tab only when the spec has to build one itself (see tabVar). One import
    // per file, since each class now lives in its own.
    usedTabs
      .filter((t) => t.specConstructs)
      .map((t) => `import { ${t.className} } from './pages/${t.className}'\n`)
      .join('') +
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
    // Pre-computed, NOT a runtime template literal — see dataRowTitles(). The
    // inline exporter was fixed for this in Test 7; this path was missed, so a
    // POM export of a table with a repeated (or empty) first column still
    // emitted duplicate titles and took down the whole Playwright run.
    const titles = dataRowTitles(options?.name || 'recorded flow', rows, disc)
    const titleList = titles.map((t) => `  ${quote(t)}`).join(',\n')
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
      `// One test per row. Titles are pre-computed so no two can collide — Playwright\n` +
      `// aborts the whole run on a duplicate test title, not just the offending file.\n` +
      `const titles = [\n${titleList}\n]\n\n` +
      `for (const [i, data] of dataset.entries()) {\n` +
      `  test(titles[i]${tagArg}, async (${specFixtures}) => {\n` +
      `${runtimeTokenPreamble(enabled, '    ')}${inner}\n` +
      `  })\n` +
      `}\n`
    return { spec, pages, page, pageFileName, className }
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

  return { spec, pages, page, pageFileName, className }
}
