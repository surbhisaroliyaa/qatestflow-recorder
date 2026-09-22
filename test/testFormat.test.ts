import { describe, it, expect } from 'vitest'
import {
  candidateFromLocator,
  parsePortableTest,
  parseYaml,
  stepToPortable,
  testToPortable,
  toPortableJson,
  toYaml
} from '../src/shared/testFormat'

// =====================================================================
// The portable test format — YAML / JSON round trip.
//
// The property that matters is not "it emits YAML". It is: export a test,
// import it back, and get the SAME TEST. Everything else in this file is in
// service of that, and most of the cases are values chosen because they are
// the ones a naive YAML implementation silently changes — "yes", "3.0", a
// string starting with a colon, a password with an apostrophe in it.
//
// The second property is that a HAND-WRITTEN file runs. A person editing this
// file writes a selector, never a ranked candidate ladder — and replay resolves
// through the ladder, not the selector. So a step that parses cleanly and has
// no ladder is a step that finds nothing at replay: it looks right and fails
// later, which is the worst failure this format could have. § the ladder is
// about that.
// =====================================================================

const steps = (...s: Record<string, unknown>[]): Record<string, unknown>[] => s

const LOGIN = steps(
  { type: 'navigate', url: 'https://www.saucedemo.com/' },
  {
    type: 'type',
    label: 'Username',
    value: 'standard_user',
    selector: "getByTestId('username')",
    candidates: [
      {
        kind: 'testId',
        score: 95,
        css: '[data-test="username"]',
        locator: "getByTestId('username')"
      }
    ]
  },
  {
    type: 'type',
    label: 'Password',
    secret: true,
    secretRef: 'sr_1',
    selector: "getByTestId('password')"
  },
  { type: 'click', label: 'Login', selector: "getByTestId('login-button')" },
  {
    type: 'assert',
    label: 'Products',
    assertKind: 'text-equals',
    value: 'Products',
    selector: "getByText('Products')"
  }
)

/** Export → import, the operation the whole format exists to make safe. */
function roundTrip(
  test: Record<string, unknown>,
  s: Record<string, unknown>[]
): ReturnType<typeof parsePortableTest> {
  return parsePortableTest(toYaml(testToPortable(test, s)))
}

describe('§ round trip', () => {
  it('a real login survives export and import unchanged', () => {
    const { steps: back, warnings } = roundTrip(
      { name: 'SauceDemo login', baseURL: 'https://www.saucedemo.com', tags: ['@smoke'] },
      LOGIN
    )
    expect(warnings).toEqual([])
    expect(back).toHaveLength(LOGIN.length)
    expect(back[1]).toMatchObject({
      type: 'type',
      label: 'Username',
      value: 'standard_user',
      selector: "getByTestId('username')"
    })
    expect(back[2]).toMatchObject({ secret: true, secretRef: 'sr_1' })
    expect(back[4]).toMatchObject({ assertKind: 'text-equals', value: 'Products' })
  })

  it('keeps the test-level settings', () => {
    const { test } = roundTrip(
      {
        name: 'Mobile checkout',
        baseURL: 'https://shop.test',
        tags: ['@smoke', '@checkout'],
        viewport: { width: 390, height: 844 },
        deviceId: 'iPhone 13',
        har: 'run.har'
      },
      LOGIN
    )
    expect(test.name).toBe('Mobile checkout')
    expect(test.tags).toEqual(['@smoke', '@checkout'])
    expect(test.viewport).toEqual({ width: 390, height: 844 })
    expect(test.deviceId).toBe('iPhone 13')
    expect(test.har).toBe('run.har')
  })

  it('carries data-driven rows across', () => {
    const { test } = roundTrip(
      {
        name: 'Login matrix',
        dataRows: [
          { user: 'standard_user', expect: 'pass' },
          { user: 'locked_out_user', expect: 'fail' }
        ]
      },
      LOGIN
    )
    expect(test.dataRows).toEqual([
      { user: 'standard_user', expect: 'pass' },
      { user: 'locked_out_user', expect: 'fail' }
    ])
  })

  it('the same test exported twice produces an identical file', () => {
    // A format whose key order wobbles makes every diff unreadable, which
    // defeats the point of having a reviewable format at all.
    const a = toYaml(testToPortable({ name: 'T' }, LOGIN))
    const b = toYaml(testToPortable({ name: 'T' }, LOGIN))
    expect(a).toBe(b)
  })

  it('JSON is the same model in different syntax', () => {
    const portable = testToPortable({ name: 'T', baseURL: 'https://x.test' }, LOGIN)
    const fromJson = parsePortableTest(toPortableJson(portable), 'test.json')
    const fromYamlDoc = parsePortableTest(toYaml(portable), 'test.yaml')
    expect(fromJson.steps).toEqual(fromYamlDoc.steps)
  })
})

// =====================================================================
// § values that lie
// Each of these is a value YAML will hand back as the WRONG TYPE unless it
// was quoted on the way out. They are not hypothetical: "yes" is a real
// answer to type into a form, and "3.0" is a real price.
// =====================================================================
describe('§ values that lie', () => {
  const nasty: Array<[string, string]> = [
    ['a YAML boolean word', 'yes'],
    ['another one', 'no'],
    ['the word null', 'null'],
    ['a number with a trailing zero', '3.0'],
    ['a leading zero', '007'],
    ['a value starting with a colon', ':not a key'],
    ['a value containing a colon and space', 'time: 10:30 sharp'],
    ['a hash that is not a comment', 'item #4'],
    ['a leading dash', '-5'],
    ['a value with an apostrophe', "it's a test"],
    ['a value with quotes', 'he said "hi"'],
    ['a Windows path', 'C:\\Users\\qa\\file.txt'],
    ['braces', '{{username}}'],
    ['leading whitespace', '  padded'],
    ['an empty string', '']
  ]

  for (const [title, value] of nasty) {
    it(`survives ${title}`, () => {
      const { steps: back } = roundTrip(
        { name: 'T' },
        steps({ type: 'type', label: 'Field', value, selector: "locator('#f')" })
      )
      expect(back[0].value === undefined ? '' : back[0].value).toBe(value)
    })
  }

  it('keeps a multi-line value line for line', () => {
    const body = '{\n  "item": "backpack",\n  "qty": 2\n}'
    const { steps: back } = roundTrip(
      { name: 'T' },
      steps({ type: 'api', url: 'https://api.test/orders', apiMethod: 'POST', apiBody: body })
    )
    expect(back[0].apiBody).toBe(body)
  })

  it('a comment character inside a quoted value is not a comment', () => {
    const doc = parseYaml("name: 'a # b'\nother: plain # trailing comment\n") as Record<
      string,
      unknown
    >
    expect(doc.name).toBe('a # b')
    expect(doc.other).toBe('plain')
  })
})

// =====================================================================
// § the ladder
// The difference between a file that parses and a file that RUNS.
// =====================================================================
describe('§ the ladder', () => {
  it('builds a ladder from a hand-written selector', () => {
    // Nobody writes a ranked candidate list by hand. Replay resolves through
    // one — so importing has to build it, or this step finds nothing.
    const { steps: back, warnings } = parsePortableTest(
      [
        'name: Hand written',
        'steps:',
        '  - do: click',
        '    target: Login',
        "    selector: getByTestId('login-button')"
      ].join('\n')
    )
    expect(warnings).toEqual([])
    const cands = back[0].candidates as Record<string, unknown>[]
    expect(cands).toHaveLength(1)
    expect(cands[0].kind).toBe('testId')
    // Both attribute spellings, because the file never said which one the app
    // uses and guessing wrong finds nothing.
    expect(String(cands[0].css)).toContain('[data-test="login-button"]')
    expect(String(cands[0].css)).toContain('[data-testid="login-button"]')
  })

  it('keeps a real ladder rather than replacing it with a guess', () => {
    // A ladder recorded from a real page is far better than anything derivable
    // from one locator string — it has the fallbacks.
    const { steps: back } = roundTrip({ name: 'T' }, LOGIN)
    const cands = back[1].candidates as Record<string, unknown>[]
    expect(cands).toHaveLength(1)
    expect(cands[0].score).toBe(95)
  })

  for (const [locator, kind] of [
    ["locator('#pay')", 'css'],
    ["getByTestId('pay')", 'testId'],
    ["getByRole('button', { name: 'Pay now' })", 'role'],
    ["getByRole('heading')", 'role'],
    ["getByText('Continue')", 'text'],
    ["getByPlaceholder('Search')", 'placeholder'],
    ["getByLabel('Password')", 'role']
  ] as const) {
    it(`understands ${locator}`, () => {
      expect(candidateFromLocator(locator)?.kind).toBe(kind)
    })
  }

  it('carries nth through a .nth() suffix', () => {
    const c = candidateFromLocator("getByText('Go').nth(1)")!
    expect(c.kind).toBe('text')
    expect(c.nth).toBe(1)
    expect(candidateFromLocator("getByText('Go').first()")!.nth).toBe(0)
  })

  it('WARNS instead of guessing when it cannot read the selector', () => {
    // The critical refusal. Inventing a selector here is how a test goes green
    // against the wrong element, which is worse than not importing at all.
    const { warnings, steps: back } = parsePortableTest(
      [
        'name: T',
        'steps:',
        '  - do: click',
        '    target: Pay',
        "    selector: page.$$('weird')"
      ].join('\n')
    )
    expect(back[0].candidates).toBeUndefined()
    expect(warnings.join(' ')).toContain('could not work out')
  })

  it('warns when an action step names no element at all', () => {
    const { warnings } = parsePortableTest(
      ['name: T', 'steps:', '  - do: click', '    target: Pay'].join('\n')
    )
    expect(warnings.join(' ')).toContain('needs a selector')
  })

  it('rebuilds BOTH ends of a drag', () => {
    const { steps: back, warnings } = parsePortableTest(
      [
        'name: Board',
        'steps:',
        '  - do: drag',
        '    target: Card',
        '    dragKind: html5',
        "    selector: getByText('Card')",
        "    targetSelector: getByTestId('done')",
        '    targetLabel: Done'
      ].join('\n')
    )
    expect(warnings).toEqual([])
    expect((back[0].candidates as unknown[]).length).toBe(1)
    expect((back[0].targetCandidates as unknown[]).length).toBe(1)
  })
})

// =====================================================================
// § bad files
// A hand-edited file is going to be wrong sometimes. "Something went wrong"
// is not a usable answer when the file is four hundred lines long.
// =====================================================================
describe('§ bad files', () => {
  it('names the line a syntax error is on', () => {
    expect(() => parseYaml('name: T\nsteps:\n  - do: click\n  this is not a pair\n')).toThrow(
      /Line 4/
    )
  })

  it('refuses tabs, which indent differently in every editor', () => {
    expect(() => parseYaml('name: T\nsteps:\n\t- do: click\n')).toThrow(/tabs/)
  })

  it('says so when there are no steps', () => {
    expect(() => parsePortableTest('name: Empty\n')).toThrow(/no "steps:" list/)
  })

  it('says so when a step has no type', () => {
    expect(() => parsePortableTest('name: T\nsteps:\n  - target: Login\n')).toThrow(/"do:"/)
  })

  it('reports invalid JSON as invalid JSON', () => {
    expect(() => parsePortableTest('{ "name": "T", ', 'x.json')).toThrow(/isn't valid JSON/)
  })

  it('accepts a file from a NEWER format version, with a warning', () => {
    // Refusing outright would strand a file written by a newer build, for no
    // proven reason — the steps are very likely still readable.
    const { warnings, steps: back } = parsePortableTest(
      ['version: 99', 'name: T', 'steps:', '  - do: back'].join('\n')
    )
    expect(back).toHaveLength(1)
    expect(warnings.join(' ')).toContain('version 99')
  })
})

describe('§ what does not travel', () => {
  it('drops this machine’s facts about the run', () => {
    // Same reasoning as the bundle's "what travels" list: a self-heal record is
    // a fact about YOUR run, and carrying it into someone else's checkout
    // states something nobody has established.
    const p = stepToPortable({
      type: 'click',
      label: 'Pay',
      selector: "locator('#pay')",
      id: 41,
      healedByAi: { at: '2026-09-21', signals: ['role'], score: 80 }
    })
    expect(p.id).toBeUndefined()
    expect(p.healedByAi).toBeUndefined()
    expect(p.selector).toBe("locator('#pay')")
  })

  it('reads as one step per block, with the type first', () => {
    // The readability claim, asserted rather than assumed: this is the reason
    // the format exists, so it is worth a test.
    const yaml = toYaml(testToPortable({ name: 'T' }, LOGIN))
    expect(yaml).toContain('  - do: navigate')
    expect(yaml).toContain('    target: Username')
    expect(yaml.split('\n').filter((l) => l.startsWith('  - do:'))).toHaveLength(LOGIN.length)
  })
})

// =====================================================================
// § a REAL selector ladder
//
// Everything above this point used hand-made candidates, and hand-made
// candidates are tidy: `[data-test="username"]` starts with `[`, so the
// leading-character quoting rule already covered it. A ladder the recorder
// actually produced is not tidy —
//
//     css: input[name="user-name"]
//     locator: getByRole('textbox', { name: 'Username' })
//
// — and the first of those went out UNQUOTED inside an inline map, where `[`
// is structural. The file this module wrote could not be read back by this
// module: "Line 19: nested inline collections are not supported" on a real
// SauceDemo login export (Surbhi, Round 6).
//
// These are the exact candidates from that export. The round trip is the one
// property this format exists to have, so the fixture has to be real.
// =====================================================================
describe('§ a real selector ladder', () => {
  const REAL_LADDER = [
    {
      kind: 'testId',
      score: 95,
      locator: "getByTestId('username')",
      css: '[data-test="username"], [data-testid="username"]',
      testIdAttr: 'data-test'
    },
    { kind: 'id', score: 90, locator: "locator('#user-name')", css: '#user-name' },
    {
      kind: 'role',
      score: 80,
      locator: "getByRole('textbox', { name: 'Username' })",
      css: null,
      role: 'textbox',
      name: 'Username'
    },
    {
      kind: 'name',
      score: 70,
      locator: 'locator(\'input[name="user-name"]\')',
      css: 'input[name="user-name"]'
    },
    {
      kind: 'placeholder',
      score: 65,
      locator: "getByPlaceholder('Username')",
      css: '[placeholder="Username"]'
    },
    { kind: 'css', score: 15, locator: "locator('input')", css: 'input' }
  ]

  const REAL_STEP = {
    type: 'type',
    label: 'Username',
    value: 'standard_user',
    windowId: 0,
    selector: "getByTestId('username')",
    candidates: REAL_LADDER
  }

  it('survives the round trip, candidate for candidate', () => {
    const { steps: back, warnings } = roundTrip({ name: 'SauceDemo login' }, [REAL_STEP])
    expect(warnings).toEqual([])
    expect(back[0].candidates).toEqual(REAL_LADDER)
  })

  it('quotes a css value containing brackets', () => {
    // The specific break. `input[name="user-name"]` begins with a letter, so
    // the leading-character rule lets it out bare — and inside `{ … }` the `[`
    // is then read as a nested collection.
    const yaml = toYaml(testToPortable({ name: 'T' }, [REAL_STEP]))
    const line = yaml.split('\n').find((l) => l.includes('kind: name'))!
    // Assert on the CSS FIELD specifically. A looser toContain() passed for the
    // wrong reason: the locator value on the same line is
    // locator('input[name="user-name"]'), whose own syntax already contains
    // that quoted substring — so the check matched even with the fix disabled.
    expect(line).toContain(`css: 'input[name="user-name"]'`)
  })

  it('keeps a locator whose own quotes are doubled', () => {
    // getByRole('textbox', { name: 'Username' }) carries single quotes AND
    // braces. Quoting doubles the inner quotes; the parser has to undouble
    // them and not mistake the braces for structure.
    const { steps: back } = roundTrip({ name: 'T' }, [REAL_STEP])
    const cands = back[0].candidates as Record<string, unknown>[]
    const role = cands.find((c) => c.kind === 'role')!
    expect(role.locator).toBe("getByRole('textbox', { name: 'Username' })")
  })

  it('a null css survives as null, not as the string "null"', () => {
    const { steps: back } = roundTrip({ name: 'T' }, [REAL_STEP])
    const cands = back[0].candidates as Record<string, unknown>[]
    expect(cands.find((c) => c.kind === 'role')!.css).toBe(null)
  })

  it('reads a file written by an OLDER build, with the brackets unquoted', () => {
    // Her export was already on disk when the quoting bug was fixed, so the
    // emitter fix alone would not have made it readable. A format that cannot
    // read its own older output is not a round trip — and a hand-written file
    // will carry unquoted brackets too, because a person writing a CSS
    // selector has no reason to think the quoting matters.
    const olderStyle = [
      'name: Login',
      'steps:',
      '  - do: click',
      '    target: Username',
      "    selector: getByTestId('username')",
      '    candidates:',
      // Exactly as the old emitter wrote it: css unquoted, brackets and all.
      `      - { kind: name, score: 70, locator: locator('input[name="user-name"]'), css: input[name="user-name"] }`
    ].join('\n')
    const { steps: back, warnings } = parsePortableTest(olderStyle)
    expect(warnings).toEqual([])
    const cands = back[0].candidates as Record<string, unknown>[]
    expect(cands).toHaveLength(1)
    expect(cands[0].css).toBe('input[name="user-name"]')
  })

  it('a whole recorded login round-trips', () => {
    // Several steps, each with its own full ladder — the shape of the file
    // that actually failed.
    const flow = [
      { type: 'navigate', url: 'https://www.saucedemo.com/' },
      REAL_STEP,
      { ...REAL_STEP, label: 'Password', secret: true, value: undefined },
      {
        type: 'click',
        label: 'Login',
        selector: "getByTestId('login-button')",
        candidates: [
          {
            kind: 'testId',
            score: 95,
            locator: "getByTestId('login-button')",
            css: '[data-test="login-button"]'
          },
          {
            kind: 'css',
            score: 20,
            locator: 'locator(\'input[type="submit"]\')',
            css: 'input[type="submit"]'
          }
        ]
      }
    ]
    const { steps: back, warnings } = roundTrip({ name: 'SauceDemo login' }, flow)
    expect(warnings).toEqual([])
    expect(back).toHaveLength(4)
    expect(back[3].candidates).toHaveLength(2)
  })
})
