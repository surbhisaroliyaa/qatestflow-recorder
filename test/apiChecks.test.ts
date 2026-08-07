import { describe, it, expect } from 'vitest'
import ts from 'typescript'
import {
  CHECK_OPS,
  checkContract,
  inferContract,
  parseChecks,
  readPath,
  runChecks
} from '../src/main/apiChecks'
import { API_CHECK_HELPER } from '../src/renderer/src/playwrightExport'

// =====================================================================
// F24.2 — the API response check engine.
//
// It exists because "body contains" proves nothing: `{"status": null}`
// contains the word "status". These are real field assertions, and they
// are the difference between an API test and a request that returned 200.
//
// The engine is written TWICE — once here for in-app replay, once as a
// helper pasted into the exported spec — and the exported copy says
// "mirrors the in-app engine exactly". That sentence is a promise between
// two copies of the same rules, and an unverified one is precisely how a
// test goes green in the app and red in CI. The last section runs both
// against the same cases.
// =====================================================================

const H: Record<string, string> = { 'content-type': 'application/json' }
const run = (text: string, body: unknown, headers = H): ReturnType<typeof runChecks> =>
  runChecks(text, JSON.stringify(body), headers)
const passes = (text: string, body: unknown, headers = H): boolean =>
  run(text, body, headers).length === 0

describe('reading a check line', () => {
  it('parses path, operator and expected value', () => {
    expect(parseChecks('status equals CONFIRMED')).toEqual([
      { path: 'status', op: 'equals', expected: 'CONFIRMED' }
    ])
  })

  it('keeps the whole rest of the line as the expected value', () => {
    expect(parseChecks('message equals Order was placed')[0].expected).toBe('Order was placed')
  })

  it('allows operators that need no value', () => {
    expect(parseChecks('id exists')[0]).toMatchObject({ path: 'id', op: 'exists', expected: '' })
  })

  it('ignores blank lines and # comments, so a block can be annotated', () => {
    expect(parseChecks('\n# the order id\nid exists\n\n')).toHaveLength(1)
  })

  it('KEEPS an unparseable line instead of dropping it', () => {
    // Dropping it is how you get a dead assertion: the user writes `id`,
    // forgetting the operator, sees no complaint, and reads the green as
    // "id was checked". It wasn't.
    const parsed = parseChecks('id')
    expect(parsed).toHaveLength(1)
    expect(parsed[0].invalid).toBeTruthy()
  })

  it('reports that unparseable line as a FAILURE at run time', () => {
    const fails = run('id', { id: 7 })
    expect(fails).toHaveLength(1)
    expect(fails[0].reason).toMatch(/check|operator/i)
  })

  it('rejects an operator it does not know, rather than guessing', () => {
    expect(run('status isnt CONFIRMED', { status: 'CONFIRMED' }).length).toBe(1)
  })
})

describe('finding the field', () => {
  it('walks a dot path', () => {
    expect(readPath({ data: { total: 42 } }, 'data.total')).toBe(42)
  })

  it('indexes into arrays', () => {
    expect(readPath({ items: [{ sku: 'A' }, { sku: 'B' }] }, 'items.1.sku')).toBe('B')
  })

  it('distinguishes "absent" from "present but null"', () => {
    // The whole point of the engine: null is a VALUE, and a check that treats
    // it as absence passes on a broken response.
    expect(passes('total not-empty', { total: null })).toBe(false)
    expect(passes('total exists', { total: null })).toBe(true)
    expect(passes('missing exists', { total: 1 })).toBe(false)
  })
})

describe('the operators', () => {
  const cases: Array<[string, unknown, boolean]> = [
    ['status equals CONFIRMED', { status: 'CONFIRMED' }, true],
    ['status equals SHIPPED', { status: 'CONFIRMED' }, false],
    ['status not-equals SHIPPED', { status: 'CONFIRMED' }, true],
    ['status contains CONF', { status: 'CONFIRMED' }, true],
    ['status not-contains SHIP', { status: 'CONFIRMED' }, true],
    ['id exists', { id: 1 }, true],
    ['id not-exists', { other: 1 }, true],
    ['name not-empty', { name: 'x' }, true],
    ['name not-empty', { name: '' }, false],
    ['name empty', { name: '' }, true],
    ['total gt 10', { total: 42 }, true],
    ['total gt 100', { total: 42 }, false],
    ['total lt 100', { total: 42 }, true],
    ['items count-eq 2', { items: [1, 2] }, true],
    ['items count-gt 1', { items: [1, 2] }, true],
    ['items count-lt 5', { items: [1, 2] }, true],
    ['total is-number', { total: 42 }, true],
    ['total is-number', { total: '42' }, false],
    ['name is-string', { name: 'x' }, true],
    ['ok is-boolean', { ok: false }, true],
    ['items is-array', { items: [] }, true]
  ]

  for (const [line, body, ok] of cases) {
    it(`${line} on ${JSON.stringify(body)} → ${ok ? 'pass' : 'fail'}`, () => {
      expect(passes(line, body)).toBe(ok)
    })
  }

  it('every documented operator is actually implemented', () => {
    // CHECK_OPS is what the UI offers. An operator offered but not handled
    // would fail every check that used it, with a confusing reason.
    for (const op of CHECK_OPS) {
      const fails = run(`field ${op} 1`, { field: 1 })
      for (const f of fails) expect(f.reason, op).not.toMatch(/unknown check/i)
    }
  })

  it('refuses to compare a non-number numerically instead of coercing', () => {
    // Number(null) is 0 and Number('') is 0 — coercion would make
    // "total gt -1" pass on a response with no total at all.
    expect(passes('total gt -1', { total: null })).toBe(false)
    expect(passes('total gt -1', { total: '' })).toBe(false)
    expect(passes('total gt -1', { total: true })).toBe(false)
  })

  it('a count check on something that is not an array fails as such', () => {
    const fails = run('items count-eq 2', { items: 'two' })
    expect(fails[0].reason).toMatch(/not an array/i)
  })

  it('a not-equals / not-contains on an ABSENT field fails rather than passes', () => {
    // "the field is not X" is trivially true when there is no field, which
    // would hide a response that lost the field entirely.
    expect(passes('status not-equals SHIPPED', {})).toBe(false)
    expect(passes('status not-contains SHIP', {})).toBe(false)
  })
})

describe('header checks', () => {
  it('matches a header case-insensitively', () => {
    expect(passes('header:Content-Type contains json', {})).toBe(true)
  })

  it('fails when the header is absent, and says so', () => {
    const fails = run('header:x-request-id exists', {})
    expect(fails[0].reason).toMatch(/no "x-request-id" header/i)
  })

  it('not-exists passes for an absent header', () => {
    expect(passes('header:x-debug not-exists', {})).toBe(true)
  })

  it('does not need a parseable body — headers are checked on their own', () => {
    expect(runChecks('header:content-type contains json', 'not json at all', H)).toEqual([])
  })
})

describe('failure messages name what was actually there', () => {
  it('quotes the real value, not just the expectation', () => {
    const [f] = run('status equals SHIPPED', { status: 'CONFIRMED' })
    expect(f.reason).toContain('CONFIRMED')
    expect(f.line).toContain('status equals SHIPPED')
  })

  it('reports EVERY failing check, not just the first', () => {
    // You fix them in one pass instead of re-running to find the next.
    expect(run('status equals X\ntotal gt 100\nid exists', { status: 'Y', total: 1 })).toHaveLength(
      3
    )
  })

  it('says the body was unreadable rather than blaming the fields', () => {
    const fails = runChecks('status equals X', '<html>502 Bad Gateway</html>', H)
    expect(fails.length).toBeGreaterThan(0)
    expect(JSON.stringify(fails)).toMatch(/json|parse|body/i)
  })
})

describe('the response contract', () => {
  it('captures the SHAPE, not the values', () => {
    const c = inferContract({ id: 1, name: 'x', ok: true, items: [], nested: { a: 1 } })
    expect(c['id']).toBe('number')
    expect(c['name']).toBe('string')
    expect(c['ok']).toBe('boolean')
    expect(c['items']).toBe('array')
    expect(c['nested.a']).toBe('number')
  })

  it('passes when the shape holds even though the values changed', () => {
    const c = inferContract({ id: 1, name: 'x' })
    expect(checkContract({ id: 999, name: 'totally different' }, c)).toEqual([])
  })

  it('catches a field that changed type — the classic breaking API change', () => {
    const c = inferContract({ id: 1 })
    expect(checkContract({ id: '1' }, c).length).toBe(1)
  })

  it('catches a field that disappeared', () => {
    const c = inferContract({ id: 1, name: 'x' })
    expect(checkContract({ id: 1 }, c).length).toBe(1)
  })
})

// =====================================================================
// § the mirror
// The exported spec carries its own copy of this engine, and claims to
// judge a check "exactly" as the app does. Run both over the same matrix.
// A disagreement here is the in-app-green / CI-red bug in its purest form.
// =====================================================================
describe('the exported copy agrees with the in-app engine', () => {
  // The helper is TypeScript (it is pasted into a .ts spec), so strip the types
  // before evaluating it. `expect` is stubbed — only __why is under test, and it
  // is pure: it returns the REASON a check failed, or null when it passed.
  const exporterWhy = ((): ((
    body: unknown,
    headers: Record<string, string>,
    path: string,
    op: string,
    expected: string
  ) => string | null) => {
    const js = ts.transpileModule(`${API_CHECK_HELPER}\nreturn __why`, {
      compilerOptions: { target: ts.ScriptTarget.ES2020 }
    }).outputText
    return new Function('expect', js)(() => ({ toEqual: () => {} }))
  })()

  const BODY = {
    status: 'CONFIRMED',
    total: 42,
    name: '',
    nothing: null,
    ok: false,
    items: [{ sku: 'A' }, { sku: 'B' }],
    nested: { deep: 'value' }
  }

  const matrix: Array<[string, string, string]> = [
    ['status', 'equals', 'CONFIRMED'],
    ['status', 'equals', 'SHIPPED'],
    ['status', 'not-equals', 'SHIPPED'],
    ['status', 'contains', 'CONF'],
    ['status', 'not-contains', 'SHIP'],
    ['missing', 'contains', 'x'],
    ['missing', 'not-contains', 'x'],
    ['missing', 'not-equals', 'x'],
    ['total', 'gt', '10'],
    ['total', 'gt', '100'],
    ['total', 'lt', '100'],
    ['nothing', 'gt', '0'],
    ['name', 'gt', '0'],
    ['ok', 'gt', '0'],
    ['id', 'exists', ''],
    ['status', 'exists', ''],
    ['nothing', 'exists', ''],
    ['missing', 'not-exists', ''],
    ['status', 'not-exists', ''],
    ['name', 'not-empty', ''],
    ['name', 'empty', ''],
    ['nothing', 'not-empty', ''],
    ['items', 'count-eq', '2'],
    ['items', 'count-gt', '5'],
    ['items', 'count-lt', '5'],
    ['status', 'count-eq', '2'],
    ['total', 'is-number', ''],
    ['status', 'is-number', ''],
    ['status', 'is-string', ''],
    ['ok', 'is-boolean', ''],
    ['items', 'is-array', ''],
    ['nothing', 'is-string', ''],
    ['items.1.sku', 'equals', 'B'],
    ['nested.deep', 'equals', 'value'],
    ['header:content-type', 'contains', 'json'],
    ['header:content-type', 'equals', 'application/json'],
    ['header:x-missing', 'exists', ''],
    ['header:x-missing', 'not-exists', '']
  ]

  for (const [path, op, expectedValue] of matrix) {
    const line = `${path} ${op} ${expectedValue}`.trim()
    it(`agrees on: ${line}`, () => {
      const inAppPassed = passes(line, BODY)
      const exportedPassed = exporterWhy(BODY, H, path, op, expectedValue) === null
      expect(exportedPassed, `in-app=${inAppPassed} exported=${exportedPassed}`).toBe(inAppPassed)
    })
  }

  it('both refuse a line with no operator', () => {
    expect(passes('id', BODY)).toBe(false)
    expect(exporterWhy(BODY, H, 'id', '', '')).not.toBeNull()
  })

  it('both refuse an operator neither knows', () => {
    expect(passes('status isnt X', BODY)).toBe(false)
    expect(exporterWhy(BODY, H, 'status', 'isnt', 'X')).not.toBeNull()
  })
})
