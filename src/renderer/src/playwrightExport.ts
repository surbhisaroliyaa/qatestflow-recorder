// =====================================================================
// PLAYWRIGHT EXPORT
// Turns the recorded steps into a real, runnable Playwright test file.
// This is pure translation: each canonical step already carries a
// Playwright-style locator (its primary `selector`, built on Day 4), so
// we mostly wrap it with the right action (click / fill / selectOption).
// =====================================================================

// Safely wrap a value in quotes (handles quotes/newlines inside it).
function quote(value: string): string {
  return JSON.stringify(value)
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
        default:
          return `Check ${step.label} is visible`
      }
    case 'wait':
      return `Wait ${step.value ?? '1'}s`
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
// `test.use({ baseURL })` (added by the generator) resolves it at runtime, so
// retargeting the suite at another environment means editing ONE line.
function actionFor(
  step: RecorderStep,
  baseURL: string | undefined,
  pageVar: string,
  // Day 17 (page-object export): when set, the step's element is referenced via
  // this pre-declared const (e.g. `loginButton`) instead of an inline locator.
  elementLocator?: string
): string | null {
  if (step.type === 'navigate') {
    let url = step.url ?? ''
    if (baseURL && url.startsWith(baseURL)) {
      url = url.slice(baseURL.length) || '/'
    }
    return `await ${pageVar}.goto(${quote(url)})`
  }

  if (step.type === 'wait') {
    const ms = Math.max(0, (parseFloat(step.value ?? '0') || 0) * 1000)
    return `await ${pageVar}.waitForTimeout(${ms})`
  }

  // Page-level checks assert on the page itself — no element, so they must run
  // BEFORE the no-selector bail-out below.
  if (step.type === 'assert' && step.assertKind === 'url-contains') {
    return `await expect(${pageVar}).toHaveURL(${regexContains(step.value ?? '')})`
  }
  if (step.type === 'assert' && step.assertKind === 'title') {
    return `await expect(${pageVar}).toHaveTitle(${quote(step.value ?? '')})`
  }

  if (!step.selector) return null
  const base = pageBase(pageVar, step.frame)
  const locator = elementLocator ?? `${base}.${step.selector}`

  // Assertions translate 1:1 to Playwright's expect() matchers.
  if (step.type === 'assert') {
    switch (step.assertKind) {
      case 'text-equals':
        return `await expect(${locator}).toHaveText(${quote(step.value ?? '')})`
      case 'text-contains':
        return `await expect(${locator}).toContainText(${quote(step.value ?? '')})`
      case 'value':
        return `await expect(${locator}).toHaveValue(${quote(step.value ?? '')})`
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
        return `await expect(${locator}).toHaveAttribute(${quote(step.attrName ?? '')}, ${quote(step.value ?? '')})`
      case 'class':
        // toContainClass matches ONE class token (Playwright ≥1.52) — unlike
        // toHaveClass, which demands the element's ENTIRE class string.
        return `await expect(${locator}).toContainClass(${quote(step.value ?? '')})`
      case 'count': {
        // The recorded selector pinpoints ONE element (maybe via .nth) — a
        // count check is about the GROUP, so assert on the selector minus nth.
        const group = (step.selector ?? '').replace(/\.nth\(\d+\)$/, '')
        const n = Math.max(0, parseInt(step.value ?? '0', 10) || 0)
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
      return `await ${locator}.fill(${quote(step.value ?? '')})`
    case 'select':
      // We stored the option's VISIBLE text, so select by label.
      return `await ${locator}.selectOption({ label: ${quote(step.value ?? '')} })`
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
// test.use — the single line to edit when pointing at another environment).
export function generatePlaywrightTest(
  steps: RecorderStep[],
  options?: {
    name?: string
    baseURL?: string
    storageState?: string
    viewport?: { width: number; height: number }
  }
): string {
  const baseURL = options?.baseURL?.replace(/\/+$/, '') || undefined
  const enabled = steps.filter((step) => !step.disabled)

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
    const action = actionFor(step, baseURL, pageVar)
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
    lines.push(`  // ${stepText(step)}\n  ${action}`)
  }

  // Day 17: in multi-window mode, alias the fixture as page0 and grab its
  // context (used to await newly-opened pages). Prepended to the test body.
  const prelude = multiWindow ? '  const page0 = page\n  const context = page.context()\n\n' : ''
  const body = prelude + lines.join('\n\n')

  // Only import expect when an assertion (or a download check) uses it; pull in
  // fs only when a download check needs a file-size assertion.
  const hasDownload = enabled.some((step) => step.type === 'download')
  const hasAssert = enabled.some((step) => step.type === 'assert') || hasDownload
  const imports = hasAssert ? '{ test, expect }' : '{ test }'
  const header =
    `import ${imports} from '@playwright/test'\n` + (hasDownload ? "import fs from 'fs'\n" : '')
  // Day 17: test.use carries baseURL and (when a session is attached) the
  // storageState path, so the exported test starts logged in.
  const useProps: string[] = []
  if (baseURL) useProps.push(`baseURL: ${quote(baseURL)}`)
  if (options?.storageState) {
    useProps.push(`storageState: ${quote(`sessions/${options.storageState}`)}`)
  }
  if (options?.viewport) {
    useProps.push(
      `viewport: { width: ${options.viewport.width}, height: ${options.viewport.height} }`
    )
  }
  const use = useProps.length ? `\ntest.use({ ${useProps.join(', ')} })\n` : ''

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
// =====================================================================
export function generatePageObjectTest(
  steps: RecorderStep[],
  options?: {
    name?: string
    baseURL?: string
    storageState?: string
    viewport?: { width: number; height: number }
  }
): { spec: string; page: string; pageFileName: string; className: string } | null {
  const enabled = steps.filter((s) => !s.disabled)
  const multiWindow = enabled.some((s) => (s.windowId ?? 0) > 0 || s.opensWindow !== undefined)
  const hasFrames = enabled.some((s) => s.frame?.length)
  const hasAwkward = enabled.some((s) => s.type === 'dialog' || s.type === 'download')
  if (multiWindow || hasFrames || hasAwkward) return null

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
  const methods: { name: string; body: string[] }[] = []
  const specBody: string[] = []
  let buffer: string[] = []
  let lastActionLabel = ''
  let actionsSeq = 0
  const flush = (): void => {
    if (!buffer.length) return
    const base = lastActionLabel ? camelName(lastActionLabel) : `actions${++actionsSeq}`
    let name = base
    let n = 2
    while (used.has(name)) name = `${base}${n++}`
    used.add(name)
    methods.push({ name, body: buffer })
    specBody.push(`  await app.${name}()`)
    buffer = []
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
      const line = actionFor(step, baseURL, 'app.page', name ? `app.${name}` : undefined)
      if (line) specBody.push(`  ${line}`)
      continue
    }
    // An action step → into the current method buffer.
    if (step.type === 'wait') {
      const line = actionFor(step, baseURL, 'this.page')
      if (line) buffer.push(`    ${line}`)
      continue
    }
    if (!step.selector) continue
    const name = nameForElement(step, step.type === 'click')
    const line = actionFor(step, baseURL, 'this.page', `this.${name}`)
    if (line) buffer.push(`    ${line}`)
    if (step.type === 'click' || step.type === 'press') lastActionLabel = step.label || ''
  }
  flush()

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
    pageLines.push(`  async ${m.name}(): Promise<void> {`)
    for (const b of m.body) pageLines.push(b)
    pageLines.push(`  }`)
  }
  pageLines.push(`}`)
  const page = `${pageLines.join('\n')}\n`

  // === Build the spec file ===
  const hasAssert = enabled.some((s) => s.type === 'assert')
  const imports = hasAssert ? '{ test, expect }' : '{ test }'
  const useProps: string[] = []
  if (baseURL) useProps.push(`baseURL: ${quote(baseURL)}`)
  if (options?.storageState) {
    useProps.push(`storageState: ${quote(`sessions/${options.storageState}`)}`)
  }
  if (options?.viewport) {
    useProps.push(
      `viewport: { width: ${options.viewport.width}, height: ${options.viewport.height} }`
    )
  }
  const use = useProps.length ? `\ntest.use({ ${useProps.join(', ')} })\n` : ''
  const spec =
    `import ${imports} from '@playwright/test'\n` +
    `import { ${className} } from './pages/${className}'\n` +
    `${use}\n` +
    `test(${quote(options?.name || 'recorded flow')}, async ({ page }) => {\n` +
    `  const app = new ${className}(page)\n` +
    `${specBody.join('\n')}\n` +
    `})\n`

  return { spec, page, pageFileName, className }
}
