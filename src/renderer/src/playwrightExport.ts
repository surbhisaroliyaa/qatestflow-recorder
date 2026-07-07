// =====================================================================
// PLAYWRIGHT EXPORT
// Turns the recorded steps into a real, runnable Playwright test file.
// This is pure translation: each canonical step already carries a
// Playwright-style locator (its primary `selector`, built on Day 4), so
// we mostly wrap it with the right action (click / fill / selectOption).
// =====================================================================

import { TOKEN_RE, extractTokens } from './dataDriven'

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

// Safely wrap a value in quotes (handles quotes/newlines inside it).
function quote(value: string): string {
  return JSON.stringify(value)
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
  if (columns.includes(name)) return isIdent(name) ? `data.${name}` : `data[${quote(name)}]`
  return null
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
  columns: string[] = []
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
    return `await expect(${pageVar}).toHaveScreenshot()`
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
  const locator = elementLocator ?? `${base}.${step.selector}`

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
        const group = (step.selector ?? '').replace(/\.nth\(\d+\)$/, '')
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
export function generatePlaywrightTest(
  steps: RecorderStep[],
  options?: {
    name?: string
    baseURL?: string
    storageState?: string
    viewport?: { width: number; height: number }
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

  const lines: string[] = []
  for (let i = 0; i < enabled.length; i++) {
    const step = enabled[i]
    const pageVar = pv(step.windowId)
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
    const action = actionFor(step, baseURL, pageVar, undefined, columns)
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
    lines.push(`${healNote}  // ${stepText(step)}\n  ${action}`)
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
  const body = prelude + harSetup + lines.join('\n\n')

  // Only import expect when an assertion (or a download check) uses it; pull in
  // fs only when a download check needs a file-size assertion.
  const hasDownload = enabled.some((step) => step.type === 'download')
  const hasA11y = enabled.some((step) => step.type === 'a11y')
  const hasPerf = enabled.some((step) => step.type === 'perf')
  const hasAssert =
    enabled.some((step) => step.type === 'assert' || step.type === 'snapshot') ||
    hasDownload ||
    hasA11y ||
    hasPerf
  const imports = hasAssert ? '{ test, expect }' : '{ test }'
  const header =
    (hasA11y ? '// Accessibility checks need: npm i -D @axe-core/playwright\n' : '') +
    `import ${imports} from '@playwright/test'\n` +
    (hasA11y ? "import AxeBuilder from '@axe-core/playwright'\n" : '') +
    (hasDownload ? "import fs from 'fs'\n" : '')
  // Day 17: test.use carries baseURL and (when a session is attached) the
  // storageState path, so the exported test starts logged in.
  // F25: the baseURL reads process.env.BASE_URL first, defaulting to the recorded
  // base — so CI can point the SAME spec at dev/staging/prod with
  // `BASE_URL=https://staging… npx playwright test`, no file edit (the export
  // twin of the in-app "Run against" environment switch). Navigations are already
  // emitted relative to the base, so overriding this one value retargets them all.
  const useProps: string[] = []
  if (baseURL) useProps.push(`baseURL: process.env.BASE_URL || ${quote(baseURL)}`)
  if (options?.storageState) {
    useProps.push(`storageState: ${quote(`sessions/${options.storageState}`)}`)
  }
  if (options?.viewport) {
    useProps.push(
      `viewport: { width: ${options.viewport.width}, height: ${options.viewport.height} }`
    )
  }
  const useComment = baseURL
    ? '// Base URL — override per environment in CI with the BASE_URL env var.\n'
    : ''
  const use = useProps.length ? `\n${useComment}test.use({ ${useProps.join(', ')} })\n` : ''

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
  test(${title}, async ({ page }) => {
${inner}
  })
}
`
  }

  return `${header}${use}
test(${quote(options?.name || 'recorded flow')}, async ({ page }) => {
${body}
})
`
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

  // Member names shared across locators + methods (a class can't have a property
  // and a method with the same name), plus reserved members.
  const used = new Set<string>(['page', 'goto', 'constructor'])
  const locatorDefs: { name: string; selector: string }[] = []
  const nameByExpr = new Map<string, string>()
  const nameForElement = (step: RecorderStep, clickTarget = false): string => {
    const expr = step.selector as string
    const existing = nameByExpr.get(expr)
    if (existing) return existing
    // A clicked element's locator gets a "Button" suffix (the POM convention for
    // clickable things) so the ACTION METHOD can keep the clean verb — e.g. the
    // login button is `loginButton`, the method that uses it is `login()`.
    const baseName = camelName(step.label || step.type) + (clickTarget ? 'Button' : '')
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
      const line = actionFor(step, baseURL, 'app.page', name ? `app.${name}` : undefined, columns)
      if (line) specBody.push(`  ${line}`)
      continue
    }
    // F13/F14: a page-level accessibility or performance check — like an
    // assert, it lives in the spec (where `expect`/AxeBuilder are imported),
    // not a page-object method.
    if (step.type === 'a11y' || step.type === 'perf') {
      flush()
      const line = actionFor(step, baseURL, 'app.page', undefined, columns)
      if (line) specBody.push(`  ${line}`)
      continue
    }
    // An action step → into the current method buffer. wait + back have no
    // element of their own (page-level actions), so handle them before the
    // no-selector skip below.
    if (step.type === 'wait' || step.type === 'back') {
      const line = actionFor(step, baseURL, 'this.page', undefined, columns)
      if (line) buffer.push(`    ${line}`)
      if (stepUsesData(step)) bufferUsesData = true
      continue
    }
    if (!step.selector) continue
    const name = nameForElement(step, step.type === 'click')
    const line = actionFor(step, baseURL, 'this.page', `this.${name}`, columns)
    if (line) buffer.push(`    ${line}`)
    if (stepUsesData(step)) bufferUsesData = true
    if (step.type === 'click' || step.type === 'press') lastActionLabel = step.label || ''
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
  const hasAssert = enabled.some((s) => s.type === 'assert') || hasA11y || hasPerf
  const imports = hasAssert ? '{ test, expect }' : '{ test }'
  const useProps: string[] = []
  if (baseURL) useProps.push(`baseURL: process.env.BASE_URL || ${quote(baseURL)}`)
  if (options?.storageState) {
    useProps.push(`storageState: ${quote(`sessions/${options.storageState}`)}`)
  }
  if (options?.viewport) {
    useProps.push(
      `viewport: { width: ${options.viewport.width}, height: ${options.viewport.height} }`
    )
  }
  // F25: same env-overridable baseURL as the inline export (see there).
  const useComment = baseURL
    ? '// Base URL — override per environment in CI with the BASE_URL env var.\n'
    : ''
  const use = useProps.length ? `\n${useComment}test.use({ ${useProps.join(', ')} })\n` : ''
  const importLines =
    (hasA11y ? '// Accessibility checks need: npm i -D @axe-core/playwright\n' : '') +
    `import ${imports} from '@playwright/test'\n` +
    (hasA11y ? "import AxeBuilder from '@axe-core/playwright'\n" : '') +
    `import { ${className} } from './pages/${className}'\n`

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
    const inner = [`  const app = new ${className}(page)`, ...specBody]
      .map((l) => (l ? `  ${l}` : l))
      .join('\n')
    const spec =
      `${importLines}${use}\n` +
      `const dataset = [\n${dataset}\n]\n\n` +
      `for (const data of dataset) {\n` +
      `  test(${title}, async ({ page }) => {\n` +
      `${inner}\n` +
      `  })\n` +
      `}\n`
    return { spec, page, pageFileName, className }
  }

  const spec =
    `${importLines}` +
    `${use}\n` +
    `test(${quote(options?.name || 'recorded flow')}, async ({ page }) => {\n` +
    `  const app = new ${className}(page)\n` +
    `${specBody.join('\n')}\n` +
    `})\n`

  return { spec, page, pageFileName, className }
}
