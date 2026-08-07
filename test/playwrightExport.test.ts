import { describe, it, expect } from 'vitest'
import ts from 'typescript'
import {
  anyApiChecks,
  dataRowTitles,
  generateCiWorkflow,
  generateEdgeSuite,
  generatePageObjectTest,
  generatePlaywrightConfig,
  generatePlaywrightTest,
  osEnvCollisions,
  repairSelector,
  repairSteps,
  runtimeTokenPreamble,
  runtimeTokenUse,
  stepText,
  testIdPolicy
} from '../src/renderer/src/playwrightExport'

// =====================================================================
// The exporter's output is a FILE OF CODE, so most of what can go wrong
// here isn't "a wrong value" — it's "the spec doesn't compile" or "the
// spec compiles but quietly lost a feature the app applied". Those two
// are what this file tests, in that order:
//
//   1. everything it emits parses as TypeScript          (§ compiles)
//   2. every identifier it uses, it also declares        (§ declares)
//   3. the POM export kept the features the inline one got (§ parity)
//
// (3) is this module's signature bug — three shipped export bugs were
// all "the inline exporter got the feature, the POM export didn't".
//
// The exact bytes live in golden files under __snapshots__/ (§ golden),
// which are readable specs: open one and you see what a user gets.
// =====================================================================

// The module is typed against the ambient RecorderStep; tests build partials.
const s = (o: Record<string, unknown>): never => o as never

/** Syntax-only parse of an emitted spec. Empty array = it would compile. */
function syntaxErrors(code: string): string[] {
  const sf = ts.createSourceFile('spec.ts', code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []
  return diags.map((d) => {
    const { line } = sf.getLineAndCharacterOfPosition(d.start ?? 0)
    return `line ${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')} — ${
      code.split('\n')[line]
    }`
  })
}

// ── fixtures ─────────────────────────────────────────────────────────
// A SauceDemo-shaped login: the flow every other case is a variation of.
const LOGIN = [
  s({ type: 'navigate', url: 'https://www.saucedemo.com/' }),
  s({
    type: 'type',
    selector: "getByTestId('username')",
    value: 'standard_user',
    label: 'Username',
    candidates: [{ kind: 'testId', testIdAttr: 'data-test', css: '[data-test="username"]' }]
  }),
  s({
    type: 'type',
    selector: "getByTestId('password')",
    value: 'secret_sauce',
    secret: true,
    label: 'Password',
    candidates: [{ kind: 'testId', testIdAttr: 'data-test', css: '[data-test="password"]' }]
  }),
  s({
    type: 'click',
    selector: "getByTestId('login-button')",
    label: 'Login',
    candidates: [{ kind: 'testId', testIdAttr: 'data-test', css: '[data-test="login-button"]' }]
  }),
  s({ type: 'assert', assertKind: 'visible', selector: "getByText('Products')", label: 'Products' })
]

// An api step carrying every F24 sub-feature that emits an identifier.
const API_FLOW = [
  s({ type: 'navigate', url: 'https://shop.test/' }),
  s({
    type: 'api',
    apiMethod: 'POST',
    url: 'https://api.shop.test/orders/{{uuid}}',
    apiHeaders: 'Content-Type: application/json',
    apiBody: '{"item":"backpack"}',
    apiExpectStatus: '201',
    apiChecks: 'status equals CONFIRMED',
    apiSave: 'orderId = id',
    apiMaxMs: 800,
    label: 'Create order'
  }),
  s({
    type: 'assert',
    assertKind: 'text-contains',
    selector: "getByTestId('order-id')",
    value: '{{saved:orderId}}',
    label: 'Order id'
  }),
  s({
    type: 'api',
    apiMethod: 'DELETE',
    url: 'https://api.shop.test/orders/{{saved:orderId}}',
    apiExpectStatus: '204,404',
    teardown: true,
    label: 'Delete order'
  })
]

// F37 loops + branching, nested — the case where indentation and the
// paired end-markers have to line up or the file won't parse.
const CONTROL_FLOW = [
  s({ type: 'navigate', url: 'https://shop.test/' }),
  s({ type: 'repeat', repeatKind: 'times', value: '3', label: 'thrice' }),
  s({ type: 'if', condKind: 'element-visible', selector: "getByText('Cookie banner')" }),
  s({ type: 'click', selector: "getByRole('button', { name: 'Accept' })", label: 'Accept' }),
  s({ type: 'else' }),
  s({ type: 'click', selector: "getByRole('button', { name: 'Skip' })", label: 'Skip' }),
  s({ type: 'endIf' }),
  s({ type: 'endRepeat' }),
  s({ type: 'assert', assertKind: 'visible', selector: "getByText('Done')", label: 'Done' })
]

const DATA = {
  columns: ['username'],
  rows: [{ username: 'standard_user' }, { username: 'locked_out_user' }]
}

const DATA_FLOW = [
  s({ type: 'navigate', url: 'https://www.saucedemo.com/' }),
  s({ type: 'type', selector: "getByTestId('username')", value: '{{username}}', label: 'Username' }),
  s({
    type: 'type',
    selector: "getByTestId('password')",
    value: '{{env:PASSWORD}}',
    label: 'Password'
  }),
  s({ type: 'click', selector: "getByTestId('login-button')", label: 'Login' })
]

// =====================================================================
// § harness
// A green "it compiles" is worthless if the checker can't see a break.
// =====================================================================
describe('the syntax checker itself', () => {
  it('reports a broken file and stays silent on a good one', () => {
    expect(syntaxErrors('const a = (')).not.toEqual([])
    expect(syntaxErrors('test("x", async ({ page }) => { await page.goto("/") })')).toEqual([])
  })

  it('catches the specific break this module can produce — a comment that spills onto code', () => {
    // A `// comment` whose text contains a newline turns the rest of that
    // line into code. This is the shape of the failure §compiles guards.
    expect(syntaxErrors('// Type "a\nb" into Field\nawait x.fill("a")')).not.toEqual([])
  })
})

// =====================================================================
// § compiles
// Every artifact this module hands the user must parse. A spec that
// doesn't parse fails at COLLECTION time, which takes down every other
// test in the same Playwright run, not just the broken one.
// =====================================================================
describe('emitted specs parse as TypeScript', () => {
  const flows: Array<[string, RecorderStep[], Parameters<typeof generatePlaywrightTest>[1]]> = [
    ['a plain login', LOGIN, { name: 'Login', baseURL: 'https://www.saucedemo.com' }],
    ['api + teardown + saved values', API_FLOW, { name: 'Orders' }],
    ['nested loop and if/else', CONTROL_FLOW, { name: 'Banner' }],
    ['data-driven rows', DATA_FLOW, { name: 'Login', data: DATA }],
    [
      'every option at once',
      LOGIN,
      {
        name: 'Login',
        baseURL: 'https://www.saucedemo.com',
        storageState: 'auth.json',
        device: { playwrightDevice: 'iPhone 13', label: 'iPhone 13' },
        viewport: { width: 390, height: 844 },
        tags: ['@smoke', '@login'],
        har: 'run.har',
        data: DATA
      }
    ]
  ] as never

  for (const [title, steps, options] of flows) {
    it(`inline export — ${title}`, () => {
      expect(syntaxErrors(generatePlaywrightTest(steps, options))).toEqual([])
    })

    it(`page-object export — ${title}`, () => {
      const pom = generatePageObjectTest(steps, options)
      if (!pom) return // out of POM scope (multi-tab / iframe / dialog) — §parity covers that
      expect(syntaxErrors(pom.spec)).toEqual([])
      expect(syntaxErrors(pom.page)).toEqual([])
    })
  }

  it('edge-case suite — including an api step, which needs the request fixture', () => {
    const out = generateEdgeSuite(
      [
        { baseline: true, fieldLabel: 'Username', edgeLabel: 'baseline', value: 'ok', steps: LOGIN },
        {
          baseline: false,
          fieldLabel: 'Username',
          edgeLabel: 'SQL injection',
          value: "' OR 1=1 --",
          steps: API_FLOW
        }
      ],
      { name: 'Login', baseURL: 'https://www.saucedemo.com' }
    )
    expect(syntaxErrors(out)).toEqual([])
  })

  it('the generated playwright.config parses too', () => {
    expect(syntaxErrors(generatePlaywrightConfig(['chromium', 'firefox', 'webkit']))).toEqual([])
  })
})

// =====================================================================
// § hostile values
// Everything a user types can land inside a string literal, a template
// literal, a regex or a comment in the emitted file. None of it may
// break out. (A recorded value is untrusted input to a code generator.)
// =====================================================================
describe('a recorded value cannot break out of the code it is embedded in', () => {
  const nasties: Array<[string, string]> = [
    ['double quotes', 'he said "hi"'],
    ['a backslash path', 'C:\\Users\\samee'],
    ['a backtick and a ${}', '`${process.env.HOME}`'],
    ['a comment terminator', 'a */ b // c'],
    ['a newline', 'line one\nline two'],
    ['a lone brace token', '{{ not_a_column }}'],
    ['a unicode quote and emoji', '“quoted” 🧪']
  ]

  for (const [title, value] of nasties) {
    it(`inline export survives ${title}`, () => {
      const steps = [
        s({ type: 'navigate', url: 'https://shop.test/' }),
        s({ type: 'type', selector: "getByTestId('field')", value, label: 'Field' }),
        s({
          type: 'assert',
          assertKind: 'text-contains',
          selector: "getByTestId('out')",
          value,
          label: 'Output'
        }),
        s({ type: 'assert', assertKind: 'url-contains', value, label: 'URL' })
      ]
      expect(syntaxErrors(generatePlaywrightTest(steps, { name: 'Hostile' }))).toEqual([])
    })

    it(`edge suite survives ${title}`, () => {
      const steps = [
        s({ type: 'navigate', url: 'https://shop.test/' }),
        s({ type: 'type', selector: "getByTestId('field')", value, label: 'Field' }),
        s({ type: 'assert', assertKind: 'visible', selector: "getByText('ok')", label: 'ok' })
      ]
      const out = generateEdgeSuite(
        [{ baseline: false, fieldLabel: 'Field', edgeLabel: title, value, steps }],
        { name: 'Hostile' }
      )
      expect(syntaxErrors(out)).toEqual([])
    })
  }

  it('a value that looks like an env token is still just text when no token matches', () => {
    const steps = [
      s({ type: 'type', selector: "getByTestId('f')", value: '{{ nope }}', label: 'F' })
    ]
    // Unrecognized → a quoted literal, NOT a reference to an undeclared name.
    expect(generatePlaywrightTest(steps, { name: 'T' })).toContain('.fill("{{ nope }}")')
  })

  it('a dot in a url-contains check is escaped, so it matches a literal dot', () => {
    const steps = [s({ type: 'assert', assertKind: 'url-contains', value: '/inventory.html' })]
    expect(generatePlaywrightTest(steps, { name: 'T' })).toContain('inventory\\\\.html')
  })
})

// =====================================================================
// § declares
// The compile-lie class: the spec references `request` / `runUuid` /
// `saved` / `AxeBuilder` / `devices` / `__expectChecks` and never
// declares them. Each of these shipped at least once.
// =====================================================================
describe('every identifier the spec uses, the spec declares', () => {
  /** The invariants, checked against ANY emitted file. */
  function assertSelfContained(code: string, where: string): void {
    const usesInBody = (name: string): boolean =>
      new RegExp(`(?<![\\w.])${name}\\b`).test(code.replace(/^import .*$/gm, ''))

    if (/\brequest\.(get|post|put|patch|delete)\(/.test(code)) {
      expect(code, `${where}: uses the request fixture`).toMatch(/async \(\{[^}]*\brequest\b/)
    }
    if (usesInBody('runUuid')) {
      expect(code, `${where}: uses runUuid`).toContain("import { randomUUID } from 'node:crypto'")
      expect(code, `${where}: declares runUuid`).toContain('const runUuid = randomUUID()')
    }
    if (/\bsaved[.[]/.test(code)) {
      expect(code, `${where}: declares saved`).toContain('const saved: Record<string, string> = {}')
    }
    if (usesInBody('AxeBuilder')) {
      expect(code, `${where}: imports AxeBuilder`).toContain(
        "import AxeBuilder from '@axe-core/playwright'"
      )
    }
    if (/\bdevices\[/.test(code)) {
      expect(code, `${where}: imports devices`).toMatch(
        /import \{[^}]*\bdevices\b[^}]*\} from '@playwright\/test'/
      )
    }
    if (usesInBody('__expectChecks')) {
      expect(code, `${where}: inlines the check helper`).toContain('function __expectChecks(')
    }
    if (/\bexpect\(/.test(code)) {
      expect(code, `${where}: imports expect`).toMatch(
        /import \{[^}]*\bexpect\b[^}]*\} from '@playwright\/test'/
      )
    }
    if (/\bdata\.\w/.test(code.replace(/^\s*\/\/.*$/gm, ''))) {
      expect(code, `${where}: declares the dataset loop`).toMatch(/for \(const \[i, data\]|\(data\)/)
    }
  }

  const EVERYTHING = [
    ...API_FLOW.slice(0, 2),
    s({ type: 'a11y', value: 'serious' }),
    s({ type: 'perf', value: 'good' }),
    s({ type: 'snapshot', value: '1', label: 'Home' }),
    ...API_FLOW.slice(2)
  ]

  it('inline export is self-contained', () => {
    assertSelfContained(generatePlaywrightTest(EVERYTHING, { name: 'Everything' }), 'inline')
  })

  it('page-object export is self-contained', () => {
    const pom = generatePageObjectTest(EVERYTHING, { name: 'Everything' })!
    expect(pom).not.toBeNull()
    assertSelfContained(pom.spec, 'pom spec')
    // The page class imports its own types and must not lean on the spec's.
    expect(pom.page).toContain("from '@playwright/test'")
  })

  it('data-driven export declares `data` before using it', () => {
    assertSelfContained(generatePlaywrightTest(DATA_FLOW, { name: 'L', data: DATA }), 'inline data')
    const pom = generatePageObjectTest(DATA_FLOW, { name: 'L', data: DATA })!
    assertSelfContained(pom.spec, 'pom data')
    // The class stays data-agnostic: the row is passed IN as a parameter.
    expect(pom.page).toMatch(/\(data: Record<string, string>\)/)
  })

  it('edge suite is self-contained', () => {
    const out = generateEdgeSuite(
      [{ baseline: false, fieldLabel: 'F', edgeLabel: 'x', value: 'x', steps: API_FLOW }],
      { name: 'Edge' }
    )
    assertSelfContained(out, 'edge suite')
  })

  it('an ordinary test declares none of the runtime helpers', () => {
    // The other half of the invariant: nothing unused gets emitted, so a
    // plain export stays as small and readable as it was before F24.
    const out = generatePlaywrightTest(LOGIN, { name: 'Login' })
    expect(out).not.toContain('randomUUID')
    expect(out).not.toContain('const saved')
    expect(out).not.toContain('__expectChecks')
    expect(out).not.toContain('request')
  })
})

// =====================================================================
// § parity
// This module's signature bug: a feature is wired into the inline
// exporter and the POM exporter is forgotten. Each case below is
// "the app applied X, so BOTH exports must show X".
// =====================================================================
describe('the page-object export keeps what the inline export got', () => {
  const OPTIONS = {
    name: 'Login',
    baseURL: 'https://www.saucedemo.com',
    storageState: 'auth.json',
    device: { playwrightDevice: 'iPhone 13', label: 'iPhone 13' },
    tags: ['@smoke', '@login'],
    har: 'run.har'
  }

  const features: Array<[string, RegExp]> = [
    ['the base URL', /baseURL: process\.env\.BASE_URL \|\| "https:\/\/www\.saucedemo\.com"/],
    ['the saved session', /storageState: "sessions\/auth\.json"/],
    ['the device preset', /\.\.\.devices\["iPhone 13"\]/],
    ['the tags', /\{ tag: \["@smoke", "@login"\] \}/],
    ['the HAR replay', /routeFromHAR\('hars\/run\.har', \{ notFound: 'fallback' \}\)/]
  ]

  for (const [title, pattern] of features) {
    it(`both exports carry ${title}`, () => {
      expect(generatePlaywrightTest(LOGIN, OPTIONS), 'inline').toMatch(pattern)
      expect(generatePageObjectTest(LOGIN, OPTIONS)!.spec, 'pom').toMatch(pattern)
    })
  }

  it('both exports run one test per data row, with the same titles', () => {
    const titles = dataRowTitles('Login', DATA.rows, 'username')
    const inline = generatePlaywrightTest(DATA_FLOW, { name: 'Login', data: DATA })
    const pom = generatePageObjectTest(DATA_FLOW, { name: 'Login', data: DATA })!.spec
    for (const t of titles) {
      expect(inline, 'inline').toContain(t)
      expect(pom, 'pom').toContain(t)
    }
  })

  it('both exports mask a secret value behind an env var, never the password itself', () => {
    const inline = generatePlaywrightTest(LOGIN, { name: 'Login' })
    const pom = generatePageObjectTest(LOGIN, { name: 'Login' })!
    for (const [where, code] of [
      ['inline', inline],
      ['pom spec', pom.spec],
      ['pom page', pom.page]
    ] as const) {
      expect(code, `${where} leaked the password`).not.toContain('secret_sauce')
    }
    expect(inline + pom.page).toContain("process.env.PASSWORD ?? ''")
  })

  it('the POM export no longer bows out of the four flows it used to refuse', () => {
    // It returned null for these and fell back to inline — which meant the
    // flows a generator gives up on were exactly the ones a tester had to
    // hand-write, in the style they actually use.
    const multiTab = [...LOGIN, s({ type: 'click', selector: "getByText('x')", windowId: 1 })]
    const inFrame = [s({ type: 'click', selector: "getByText('x')", frame: [{ name: 'f' }] })]
    const dialog = [
      s({ type: 'click', selector: "getByText('Delete')", label: 'Delete' }),
      s({ type: 'dialog', dialogKind: 'confirm', value: 'accept', label: 'Sure?' })
    ]
    const download = [
      s({ type: 'click', selector: "getByText('Export')", label: 'Export' }),
      s({ type: 'download', value: 'orders.csv', label: 'orders.csv' })
    ]
    for (const steps of [multiTab, inFrame, dialog, download]) {
      const pom = generatePageObjectTest(steps, { name: 'T' })
      expect(pom).not.toBeNull()
      expect(syntaxErrors(pom!.spec)).toEqual([])
      expect(syntaxErrors(pom!.page)).toEqual([])
      // …and the inline export still handles all four, unchanged.
      expect(syntaxErrors(generatePlaywrightTest(steps, { name: 'T' }))).toEqual([])
    }
  })
})

// =====================================================================
// § POM — the four flows it used to refuse
// Each has a standard hand-written page-object shape. The tests below say
// what that shape IS, because "it compiles" would pass on a page object
// that quietly does the wrong thing.
// =====================================================================
describe('page objects for iframes, dialogs, downloads and tabs', () => {
  const FRAME = [{ name: 'checkout', url: 'https://shop.test/frame.html' }]
  const SHOP = [
    s({ type: 'navigate', url: 'https://shop.test/' }),
    s({ type: 'click', selector: "getByTestId('open-help')", label: 'Open help', opensWindow: 1 }),
    s({
      type: 'assert',
      assertKind: 'text-equals',
      selector: "getByTestId('help-heading')",
      value: 'Help centre',
      label: 'Help centre',
      windowId: 1
    }),
    s({ type: 'click', selector: "getByTestId('contact-us')", label: 'Contact us', windowId: 1 }),
    s({ type: 'closeTab', windowId: 1 }),
    s({ type: 'type', selector: "getByTestId('card')", value: '4111', label: 'Card number', frame: FRAME }),
    s({ type: 'click', selector: "getByTestId('pay')", label: 'Pay', frame: FRAME })
  ]
  const shop = (): NonNullable<ReturnType<typeof generatePageObjectTest>> =>
    generatePageObjectTest(SHOP, { name: 'Shop', baseURL: 'https://shop.test' })!

  describe('iframes', () => {
    it('declares the frame ONCE as a field, and hangs its locators off it', () => {
      const { page } = shop()
      expect(page).toContain('readonly checkoutFrame: FrameLocator')
      expect(page).toContain('this.checkoutFrame = page.frameLocator("iframe[name=\\"checkout\\"]")')
      // The point of the whole exercise: the frame is named once, not repeated
      // at every locator the way the inline export must.
      expect(page).toMatch(/this\.cardNumberInput = this\.checkoutFrame\./)
      expect(page).toMatch(/this\.payButton = this\.checkoutFrame\./)
    })

    it('imports FrameLocator only when a frame is actually used', () => {
      expect(shop().page).toContain('type FrameLocator')
      expect(generatePageObjectTest(LOGIN, { name: 'Login' })!.page).not.toContain('FrameLocator')
    })

    it('the same selector in two different frames is two different fields', () => {
      // Keying a field by selector alone would collapse these into one, and the
      // second frame's control would be driven through the first frame.
      const twoFrames = [
        s({ type: 'type', selector: "getByTestId('code')", value: '1', label: 'Code', frame: [{ name: 'left' }] }),
        s({ type: 'type', selector: "getByTestId('code')", value: '2', label: 'Code', frame: [{ name: 'right' }] })
      ]
      const { page } = generatePageObjectTest(twoFrames, { name: 'T' })!
      expect(page).toContain('this.codeInput = this.leftFrame.')
      expect(page).toContain('this.codeInput2 = this.rightFrame.')
    })
  })

  describe('a second tab', () => {
    it('gets a class of its own, in a file of its own', () => {
      // One class per file is the convention every page-object codebase follows;
      // a generated POM that piles them into one file is something a team has to
      // tidy up before adopting.
      const { pages } = shop()
      expect(pages.map((p) => p.fileName)).toEqual(['ShopPage.ts', 'ShopTab1Page.ts'])
      expect(pages[0].source).toContain('export class ShopPage {')
      expect(pages[1].source).toContain('export class ShopTab1Page {')
      // Each file declares exactly one class.
      for (const p of pages) expect(p.source.match(/export class /g)).toHaveLength(1)
    })

    it("tab 0's file imports the class its method returns", () => {
      const { pages } = shop()
      expect(pages[0].source).toContain("import { ShopTab1Page } from './ShopTab1Page'")
      // …and the popup's own file imports nothing of the sort — it returns nothing.
      expect(pages[1].source).not.toContain('ShopPage')
    })

    it('`page` and `pageFileName` still mean the MAIN class', () => {
      // Callers that only ever handled one page file keep working.
      const pom = shop()
      expect(pom.page).toBe(pom.pages[0].source)
      expect(pom.pageFileName).toBe('ShopPage.ts')
      expect(pom.className).toBe('ShopPage')
    })

    it('a single-page test still produces exactly one file', () => {
      const pom = generatePageObjectTest(LOGIN, { name: 'Login' })!
      expect(pom.pages).toHaveLength(1)
      expect(pom.pages[0].fileName).toBe('LoginPage.ts')
    })

    it('is RETURNED by the method that opens it — the standard popup pattern', () => {
      const { page, spec } = shop()
      expect(page).toContain('async openHelp(): Promise<ShopTab1Page> {')
      expect(page).toContain('return new ShopTab1Page(popup)')
      expect(spec).toContain('const tab1 = await app.openHelp()')
    })

    it('arms the page wait BEFORE the click, inside the method', () => {
      const { page } = shop()
      const method = page.slice(page.indexOf('async openHelp'), page.indexOf('return new'))
      expect(method).toContain("this.page.context().waitForEvent('page')")
      expect(method).toMatch(/Promise\.all\(\[\s*\n\s*this\.page\.context\(\)\.waitForEvent/)
      // The click sits inside the Promise.all with its `await` stripped.
      expect(method).toContain('this.openHelpButton.click()')
      expect(method).not.toContain('await this.openHelpButton')
    })

    it('routes each step to the page object for the tab it happened in', () => {
      const { spec, pages } = shop()
      expect(spec, 'the check ran on tab 1').toContain('await expect(tab1.helpCentre)')
      expect(spec, 'so did the click').toContain('await tab1.contactUs()')
      expect(spec, 'and the close').toContain('await tab1.page.close()')
      expect(spec, 'the framed steps went back to tab 0').toContain('await app.pay()')
      // Tab 1's locators belong to tab 1's class, not tab 0's.
      expect(pages[1].source).toContain('this.helpCentre =')
      expect(pages[0].source).not.toContain('helpCentre')
    })

    it('only tab 0 gets a goto() — a popup arrives already pointed at its URL', () => {
      const { page } = shop()
      expect(page.match(/async goto\(\)/g)).toHaveLength(1)
    })

    it('the spec imports only the classes IT constructs', () => {
      // Tab 1 is built inside the page file by openHelp(), so importing it into
      // the spec would be an unused import — a lint error in the user's repo.
      expect(shop().spec).toContain("import { ShopPage } from './pages/ShopPage'")
      expect(shop().spec).not.toContain('ShopTab1Page')
    })

    it('a tab nothing opened is still declared, with a warning', () => {
      // Defensive: a hand-edited test, or a popup the recorder missed. Without
      // this the spec references a name that was never declared.
      const orphan = [s({ type: 'click', selector: "getByTestId('x')", label: 'X', windowId: 1 })]
      const { spec } = generatePageObjectTest(orphan, { name: 'T' })!
      expect(spec).toContain('no recorded step opened tab 1')
      expect(spec).toContain('new TTab1Page(page.context().pages()[1])')
      expect(syntaxErrors(spec)).toEqual([])
    })
  })

  describe('dialogs and downloads', () => {
    const ORDERS = [
      s({ type: 'navigate', url: 'https://shop.test/' }),
      s({ type: 'click', selector: "getByTestId('delete')", label: 'Delete' }),
      s({ type: 'dialog', dialogKind: 'confirm', value: 'accept', label: 'Are you sure?' }),
      s({ type: 'click', selector: "getByTestId('export-csv')", label: 'Export CSV' }),
      s({ type: 'download', value: 'orders.csv', label: 'orders.csv' })
    ]
    const orders = (): NonNullable<ReturnType<typeof generatePageObjectTest>> =>
      generatePageObjectTest(ORDERS, { name: 'Orders', baseURL: 'https://shop.test' })!

    it('registers the dialog handler inside the method, BEFORE its trigger', () => {
      const { page } = orders()
      const method = page.slice(page.indexOf('async delete('), page.indexOf('async exportCsv'))
      const handlerAt = method.indexOf("this.page.once('dialog'")
      const clickAt = method.indexOf('this.deleteButton.click()')
      expect(handlerAt).toBeGreaterThan(-1)
      // Order is the whole point — a handler registered after the click is a
      // handler that never fires, and the test hangs on the open dialog.
      expect(handlerAt).toBeLessThan(clickAt)
    })

    it('a download method returns the Download and the SPEC asserts on it', () => {
      const { page, spec } = orders()
      expect(page).toContain('async exportCsv(): Promise<Download> {')
      expect(page).toContain("const downloadPromise = this.page.waitForEvent('download')")
      expect(page).toContain('return downloadPromise')
      // The assertion stays in the test — the separation this whole export is for.
      expect(spec).toContain('const download1 = await app.exportCsv()')
      expect(spec).toContain('expect(download1.suggestedFilename()).toContain("orders.csv")')
      expect(spec).toContain('expect(fs.statSync(await download1.path()).size).toBeGreaterThan(0)')
      expect(spec).toContain("import fs from 'fs'")
    })

    it('starts waiting for the download BEFORE the click that triggers it', () => {
      const { page } = orders()
      const method = page.slice(page.indexOf('async exportCsv('))
      expect(method.indexOf('waitForEvent')).toBeLessThan(method.indexOf('.click()'))
    })

    it('a flow with neither imports neither type', () => {
      const { page } = generatePageObjectTest(LOGIN, { name: 'Login' })!
      expect(page).not.toContain('Download')
      expect(page).not.toContain("import fs")
    })
  })

  it('a closeTab step is no longer dropped without a trace', () => {
    // It had no selector, so it fell through the no-selector skip and vanished —
    // the same silent-drop shape as the snapshot bug. Single-tab flows reached
    // this path even before multi-tab support, so the close was simply lost.
    const steps = [...LOGIN, s({ type: 'closeTab' })]
    expect(generatePageObjectTest(steps, { name: 'Login' })!.spec).toContain(
      'await app.page.close()'
    )
  })

  it('golden — page object with a tab and a frame', async () => {
    await expect(shop().spec).toMatchFileSnapshot('./__snapshots__/shop.pom.spec.ts')
    await expect(shop().pages[0].source).toMatchFileSnapshot('./__snapshots__/ShopPage.ts')
    await expect(shop().pages[1].source).toMatchFileSnapshot('./__snapshots__/ShopTab1Page.ts')
  })
})

// =====================================================================
// § tokens
// {{env:…}} / {{saved:…}} / {{uuid}} are the bridge between what the app
// resolves at run time and what CI resolves. A mismatch here is a test
// that is green in the app and red (or falsely green) in CI.
// =====================================================================
describe('runtime tokens', () => {
  it('finds tokens hiding in an api CHECK, not just in a value', () => {
    // The app's own resolver missed this: a token that lives only inside
    // apiChecks compiled to a reference to an undeclared `saved`.
    const steps = [s({ type: 'api', url: 'https://a.test', apiChecks: 'id equals {{saved:oid}}' })]
    expect(runtimeTokenUse(steps).saved).toBe(true)
  })

  it('an api step that SAVES declares `saved` even when nothing reads it yet', () => {
    expect(runtimeTokenUse([s({ type: 'api', url: 'https://a.test', apiSave: 'oid = id' })]).saved)
      .toBe(true)
  })

  it('declares only the helpers actually used', () => {
    const pre = runtimeTokenPreamble([s({ type: 'navigate', url: 'https://a.test/{{uuid}}' })])
    expect(pre).toContain('const runUuid = randomUUID()')
    expect(pre).not.toContain('runTimestamp')
    expect(pre).not.toContain('const saved')
  })

  it('an {{env:…}} name the OS also defines is redirected to QA_<NAME> and guarded', () => {
    // Verified on a real export: reading USERNAME straight picked up the
    // Windows login name, typed it into the form, and the test went green.
    const steps = [s({ type: 'type', selector: "getByTestId('u')", value: '{{env:USERNAME}}' })]
    expect(osEnvCollisions(steps)).toEqual(['USERNAME'])
    const out = generatePlaywrightTest(steps, { name: 'T' })
    expect(out).toContain("process.env.QA_USERNAME ?? ''")
    expect(out).toContain("throw new Error(")
    // It must NOT silently fall back to the ambiguous name.
    expect(out).not.toMatch(/process\.env\.USERNAME(?!\w)/)
  })

  it('a name the OS does not define is read as-is', () => {
    const steps = [s({ type: 'type', selector: "getByTestId('u')", value: '{{env:QA_USER}}' })]
    expect(osEnvCollisions(steps)).toEqual([])
    expect(generatePlaywrightTest(steps, { name: 'T' })).toContain("process.env.QA_USER ?? ''")
  })

  it('a whole-string token becomes a bare reference; a mixed one a template literal', () => {
    const whole = [s({ type: 'navigate', url: '{{env:QA_BASE}}' })]
    const mixed = [s({ type: 'navigate', url: 'https://a.test/{{env:QA_ID}}/edit' })]
    expect(generatePlaywrightTest(whole, { name: 'T' })).toContain(
      "goto(process.env.QA_BASE ?? '')"
    )
    expect(generatePlaywrightTest(mixed, { name: 'T' })).toContain(
      'goto(`https://a.test/${process.env.QA_ID ?? \'\'}/edit`)'
    )
  })

  it('anyApiChecks decides whether the 100-line check helper is worth emitting', () => {
    expect(anyApiChecks([s({ type: 'api', url: 'https://a.test' })])).toBe(false)
    expect(anyApiChecks([s({ type: 'api', url: 'https://a.test', apiChecks: 'id exists' })])).toBe(
      true
    )
  })
})

// =====================================================================
// § selectors
// The raw-selector bug: `selector` is an expression appended to `page.`,
// and a step carrying bare CSS compiled to `page.[data-test="x"]` — a
// SyntaxError that aborted the whole spec before a single test ran.
// =====================================================================
describe('selector repair', () => {
  it('wraps a raw CSS selector in locator()', () => {
    expect(repairSelector('[data-test="username"]')).toBe('locator("[data-test=\\"username\\"]")')
    expect(repairSelector('#login > .btn')).toBe('locator("#login > .btn")')
  })

  it('leaves a real locator expression alone', () => {
    expect(repairSelector("getByRole('button', { name: 'Login' })")).toBe(
      "getByRole('button', { name: 'Login' })"
    )
  })

  it('quotes a bare getBy… argument — unquoted it referenced a variable that never existed', () => {
    expect(repairSelector('getByTestId(username)')).toBe('getByTestId("username")')
    expect(repairSelector('getByText(Products)')).toBe('getByText("Products")')
  })

  it('repairSteps copies rather than mutating the caller’s steps', () => {
    const original = [s({ type: 'click', selector: '[data-test="x"]' })]
    const repaired = repairSteps(original)
    expect(repaired[0].selector).toBe('locator("[data-test=\\"x\\"]")')
    expect((original[0] as { selector: string }).selector).toBe('[data-test="x"]')
  })

  it('an unrepaired raw selector would NOT compile — which is why repair exists', () => {
    // Proof the repair earns its keep: same step, repair bypassed.
    expect(syntaxErrors('await page.[data-test="x"].click()')).not.toEqual([])
  })

  it('keeps getByTestId when every step agrees on the attribute, and declares it', () => {
    expect(testIdPolicy(LOGIN)).toEqual({ portable: false, attr: 'data-test' })
    expect(generatePlaywrightTest(LOGIN, { name: 'T' })).toContain('testIdAttribute: "data-test"')
  })

  it('falls back to a both-attribute CSS locator when the attribute is unknown or mixed', () => {
    const legacy = [s({ type: 'click', selector: "getByTestId('login')" })]
    expect(testIdPolicy(legacy)).toEqual({ portable: true })
    expect(generatePlaywrightTest(legacy, { name: 'T' })).toContain(
      '[data-test=\\"login\\"], [data-testid=\\"login\\"]'
    )
    const mixed = [
      s({
        type: 'click',
        selector: "getByTestId('a')",
        candidates: [{ kind: 'testId', testIdAttr: 'data-test' }]
      }),
      s({
        type: 'click',
        selector: "getByTestId('b')",
        candidates: [{ kind: 'testId', testIdAttr: 'data-testid' }]
      })
    ]
    expect(testIdPolicy(mixed)).toEqual({ portable: true })
  })
})

// =====================================================================
// § titles
// Playwright aborts the ENTIRE run on a duplicate test title — not just
// the offending file — so row titles have to be unique by construction.
// =====================================================================
describe('data row titles', () => {
  it('names each row by its discriminator cell', () => {
    expect(dataRowTitles('Login', DATA.rows, 'username')).toEqual([
      'Login — standard_user',
      'Login — locked_out_user'
    ])
  })

  it('disambiguates repeated cells by row number instead of colliding', () => {
    expect(
      dataRowTitles('Login', [{ u: 'bob' }, { u: 'bob' }, { u: 'BOB' }], 'u')
    ).toEqual(['Login — bob', 'Login — bob (row 2)', 'Login — BOB (row 3)'])
  })

  it('labels an empty cell rather than emitting a title ending in a dash', () => {
    expect(dataRowTitles('Login', [{ u: '   ' }], 'u')).toEqual(['Login — (empty)'])
  })
})

// =====================================================================
// § CI
// =====================================================================
describe('CI workflow', () => {
  it('wires each env token to a repo secret, never a literal', () => {
    const wf = generateCiWorkflow(['PASSWORD', 'API_TOKEN'])
    expect(wf).toContain('PASSWORD: ${{ secrets.PASSWORD }}')
    expect(wf).toContain('API_TOKEN: ${{ secrets.API_TOKEN }}')
  })

  it('omits the env block entirely when the tests need no secrets', () => {
    expect(generateCiWorkflow([])).not.toContain('secrets.')
  })

  it('the config emits one project per requested browser', () => {
    const cfg = generatePlaywrightConfig(['chromium', 'webkit'])
    expect(cfg).toContain("{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }")
    expect(cfg).toContain("{ name: 'webkit', use: { ...devices['Desktop Safari'] } }")
    expect(cfg).not.toContain('firefox')
  })
})

// =====================================================================
// § golden
// The exact bytes, as readable .ts files under __snapshots__/. Update
// with `npx vitest run -u` — and READ the diff: it is exactly what
// changes in the user's exported spec.
// =====================================================================
describe('golden files', () => {
  it('login — inline', async () => {
    await expect(
      generatePlaywrightTest(LOGIN, { name: 'Login', baseURL: 'https://www.saucedemo.com' })
    ).toMatchFileSnapshot('./__snapshots__/login.inline.spec.ts')
  })

  it('login — page object', async () => {
    const pom = generatePageObjectTest(LOGIN, {
      name: 'Login',
      baseURL: 'https://www.saucedemo.com'
    })!
    await expect(pom.spec).toMatchFileSnapshot('./__snapshots__/login.pom.spec.ts')
    await expect(pom.page).toMatchFileSnapshot('./__snapshots__/LoginPage.ts')
    expect(pom.pageFileName).toBe('LoginPage.ts')
    expect(pom.className).toBe('LoginPage')
  })

  it('data-driven — inline', async () => {
    await expect(
      generatePlaywrightTest(DATA_FLOW, { name: 'Login', data: DATA })
    ).toMatchFileSnapshot('./__snapshots__/login.data.spec.ts')
  })

  it('nested loop and if/else — inline', async () => {
    await expect(generatePlaywrightTest(CONTROL_FLOW, { name: 'Banner' })).toMatchFileSnapshot(
      './__snapshots__/controlflow.spec.ts'
    )
  })

  it('api + teardown — inline', async () => {
    await expect(generatePlaywrightTest(API_FLOW, { name: 'Orders' })).toMatchFileSnapshot(
      './__snapshots__/api.spec.ts'
    )
  })

  it('edge-case suite', async () => {
    const out = generateEdgeSuite(
      [
        { baseline: true, fieldLabel: 'Username', edgeLabel: 'baseline', value: 'ok', steps: LOGIN },
        {
          baseline: false,
          fieldLabel: 'Username',
          edgeLabel: 'SQL injection',
          value: "' OR 1=1 --",
          steps: LOGIN
        }
      ],
      { name: 'Login', baseURL: 'https://www.saucedemo.com' }
    )
    await expect(out).toMatchFileSnapshot('./__snapshots__/login.edge.spec.ts')
  })
})

// =====================================================================
// § multi-tab
// Day 17. The POM export refuses these flows (see §parity), so the
// inline export is the ONLY thing covering them — worth more than
// "it parses". Order is the whole game here: Playwright can only catch
// a new tab if the wait was armed BEFORE the click that opens it.
// =====================================================================
describe('multi-tab flows (inline export only — the POM export refuses them)', () => {
  const MULTI_TAB = [
    s({ type: 'navigate', url: 'https://shop.test/' }),
    s({
      type: 'click',
      selector: "getByRole('link', { name: 'Open help' })",
      label: 'Open help',
      opensWindow: 1
    }),
    s({ type: 'assert', assertKind: 'visible', selector: "getByText('Help')", label: 'Help', windowId: 1 }),
    s({ type: 'closeTab', windowId: 1 }),
    s({ type: 'click', selector: "getByTestId('cart')", label: 'Cart', windowId: 0 })
  ]

  const out = (): string => generatePlaywrightTest(MULTI_TAB, { name: 'Two tabs' })

  it('aliases the fixture as page0 and grabs the context to await new tabs', () => {
    expect(out()).toContain('const page0 = page')
    expect(out()).toContain('const context = page.context()')
  })

  it('arms the page wait BEFORE the click, not after — the whole reason for Promise.all', () => {
    const code = out()
    expect(code).toContain('const [page1] = await Promise.all([')
    expect(code).toContain("context.waitForEvent('page'),")
    // The click must sit INSIDE the Promise.all, with its `await` stripped.
    const block = code.slice(code.indexOf('Promise.all(['), code.indexOf('])'))
    expect(block).toContain("page0.getByRole('link', { name: 'Open help' }).click()")
    expect(block).not.toContain('await page0.getByRole')
  })

  it('routes each step to the tab it was recorded in', () => {
    const code = out()
    expect(code, 'the assertion happened in tab 1').toContain('expect(page1.getByText(')
    expect(code, 'the last click went back to tab 0').toMatch(/\/\/ Click Cart\n\s+await page0\./)
    expect(code, 'closing tab 1 closes page1').toContain('await page1.close()')
  })

  it('a single-tab test is left alone — no page0, no context', () => {
    // The back-compat half: EXACTLY as it exported before Day 17.
    const single = generatePlaywrightTest(LOGIN, { name: 'Login' })
    expect(single).not.toContain('page0')
    expect(single).not.toContain('page.context()')
    expect(single).toContain('await page.goto(')
  })

  it('golden — multi-tab', async () => {
    await expect(out()).toMatchFileSnapshot('./__snapshots__/multitab.spec.ts')
  })
})

// =====================================================================
// § iframes
// Day 15. Also inline-only. An element inside an <iframe> is invisible
// to a plain page locator, so a missing frameLocator is not a syntax
// error — it is a test that fails at run time for a reason that reads
// like "the app is broken".
// =====================================================================
describe('iframe flows (inline export only — the POM export refuses them)', () => {
  const IN_FRAME = [
    s({ type: 'navigate', url: 'https://shop.test/' }),
    s({
      type: 'type',
      selector: "getByTestId('card')",
      value: '4111',
      label: 'Card number',
      frame: [{ name: 'checkout' }],
      candidates: [{ kind: 'testId', testIdAttr: 'data-test' }]
    }),
    s({
      type: 'click',
      selector: "getByRole('button', { name: 'Pay' })",
      label: 'Pay',
      frame: [{ url: 'https://psp.test/widget' }]
    })
  ]

  it('scopes the locator to its frame by name', () => {
    expect(generatePlaywrightTest(IN_FRAME, { name: 'Checkout' })).toContain(
      'page.frameLocator("iframe[name=\\"checkout\\"]").getByTestId('
    )
  })

  it('falls back to the frame src when the iframe has no name', () => {
    // Matched on the src's TAIL — see "an unnamed frame is matched on the END
    // of its src" below for why an exact match was wrong.
    expect(generatePlaywrightTest(IN_FRAME, { name: 'Checkout' })).toContain(
      'page.frameLocator("iframe[src$=\\"/widget\\"]").getByRole('
    )
  })

  it('chains nested frames outside-in', () => {
    const nested = [
      s({
        type: 'click',
        selector: "getByText('Deep')",
        label: 'Deep',
        frame: [{ name: 'outer' }, { name: 'inner' }]
      })
    ]
    expect(generatePlaywrightTest(nested, { name: 'Nested' })).toContain(
      'page.frameLocator("iframe[name=\\"outer\\"]").frameLocator("iframe[name=\\"inner\\"]").getByText('
    )
  })

  it('a step with no frame is NOT wrapped — the common case stays clean', () => {
    expect(generatePlaywrightTest(LOGIN, { name: 'Login' })).not.toContain('frameLocator')
  })

  // The recorder stores the frame's ABSOLUTE url; pages usually write a RELATIVE
  // src. An exact [src="…"] match then finds nothing, and the exported test fails
  // at the frame — reading like the app is broken. Found on a real site
  // (practice.expandtesting.com embeds src="/iframe-email-subscribe").
  describe('an unnamed frame is matched on the END of its src', () => {
    const inFrame = (url: string): string =>
      generatePlaywrightTest([s({ type: 'click', selector: "getByText('Go')", label: 'Go', frame: [{ url }] })], {
        name: 'T'
      })

    it('matches a relative src by suffix', () => {
      expect(inFrame('https://practice.expandtesting.com/iframe-email-subscribe')).toContain(
        'frameLocator("iframe[src$=\\"/iframe-email-subscribe\\"]")'
      )
    })

    it('keeps the query string — it can be the only thing telling two frames apart', () => {
      expect(inFrame('https://pay.test/widget?merchant=42')).toContain(
        'iframe[src$=\\"/widget?merchant=42\\"]'
      )
    })

    it('falls back to the whole url when the frame is at the site root', () => {
      expect(inFrame('https://widget.test/')).toContain('iframe[src=\\"https://widget.test/\\"]')
    })

    it('leaves a non-url src alone rather than mangling it', () => {
      expect(inFrame('about:blank')).toContain('iframe[src=\\"about:blank\\"]')
    })

    it('a NAMED frame still wins — a name is exact, a src suffix is a guess', () => {
      expect(
        generatePlaywrightTest(
          [s({ type: 'click', selector: "getByText('Go')", label: 'Go', frame: [{ name: 'checkout', url: 'https://x.test/f' }] })],
          { name: 'T' }
        )
      ).toContain('iframe[name=\\"checkout\\"]')
    })
  })

  it('golden — iframe', async () => {
    await expect(generatePlaywrightTest(IN_FRAME, { name: 'Checkout' })).toMatchFileSnapshot(
      './__snapshots__/iframe.spec.ts'
    )
  })
})

// =====================================================================
// § step text
// The one-liner above each emitted line — also what the live panel, the
// living docs and the failure report show, so it is read far more often
// than it is generated.
// =====================================================================
describe('step descriptions', () => {
  it('masks a secret value so it never reaches the screen or the file', () => {
    const step = s({ type: 'type', selector: 'x', value: 'hunter2', secret: true, label: 'Pw' })
    expect(stepText(step)).not.toContain('hunter2')
    expect(stepText(step)).toContain('••')
  })

  it('describes a navigation by its URL', () => {
    expect(stepText(s({ type: 'navigate', url: 'https://a.test/' }))).toBe('Go to https://a.test/')
  })

  // An element with no accessible name (an icon button, a bare input, an
  // AI-picked step) records without a `label`, and every sentence used to
  // interpolate it raw — "Click undefined", in the step list, the living docs,
  // the failure report AND a comment above every line of the exported spec.
  describe('a step with no label names its element from the selector', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['getByRole uses the accessible name, not the role', { selector: "getByRole('button', { name: 'Add to cart' })" }, 'Click Add to cart'],
      ['getByTestId uses the test id', { selector: "getByTestId('login-button')" }, 'Click login-button'],
      ['getByText uses the text', { selector: "getByText('Products')" }, 'Click Products'],
      ['locator() uses the raw selector', { selector: 'locator("#cart .badge")' }, 'Click #cart .badge'],
      ['nothing at all still reads as a sentence', {}, 'Click the element']
    ]

    for (const [title, extra, expected] of cases) {
      it(title, () => {
        expect(stepText(s({ type: 'click', ...extra }))).toBe(expected)
      })
    }

    it('never emits the word "undefined" — for any step type or assert kind', () => {
      const kinds = [
        'visible', 'hidden', 'text-equals', 'text-contains', 'value', 'empty', 'count',
        'enabled', 'disabled', 'editable', 'focused', 'checked', 'unchecked', 'attribute',
        'class', 'url-contains', 'title', 'nl'
      ]
      const bare = [
        ...['click', 'type', 'select', 'press', 'hover', 'upload', 'download', 'navigate',
          'back', 'closeTab', 'snapshot', 'a11y', 'perf', 'api', 'wait', 'dialog',
          'repeat', 'endRepeat', 'if', 'else', 'endIf', 'block'].map((type) => s({ type })),
        ...kinds.map((assertKind) => s({ type: 'assert', assertKind }))
      ]
      for (const step of bare) {
        expect(stepText(step), JSON.stringify(step)).not.toContain('undefined')
      }
    })

    it('a long selector is truncated so one comment cannot run off the page', () => {
      const long = `locator("${'div > span.very-long-class-name '.repeat(6)}")`
      const text = stepText(s({ type: 'click', selector: long }))
      expect(text.length).toBeLessThan(80)
      expect(text).toContain('…')
    })

    it('a label still wins when there is one', () => {
      expect(stepText(s({ type: 'click', selector: "getByTestId('x')", label: 'Login' }))).toBe(
        'Click Login'
      )
    })

    it('the fallback reaches the exported spec, not just the screen', () => {
      const steps = [s({ type: 'click', selector: "getByRole('button', { name: 'Buy now' })" })]
      expect(generatePlaywrightTest(steps, { name: 'T' })).toContain('// Click Buy now')
    })
  })
})
