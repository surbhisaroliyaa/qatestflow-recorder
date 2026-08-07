import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'

// ── QATestFlow: API response checks (mirrors the in-app engine exactly) ──
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
  t === 'null' ? t : /^[aeiou]/i.test(t) ? `an ${t}` : `a ${t}`
function __why(body: unknown, headers: Record<string, string>, path: string, op: string, expected: string): string | null {
  if (!op) return `"${path}" isn't a check — write it as: <field> <operator> [value]`
  if (path.toLowerCase().startsWith('header:')) {
    const name = path.slice(7).toLowerCase()
    const actual = headers[name]
    if (actual === undefined) return op === 'not-exists' ? null : `the response has no "${name}" header`
    if (op === 'exists') return null
    if (op === 'not-exists') return `header "${name}" IS present ("${actual}") — expected it to be absent`
    if (op === 'equals') {
      return actual.toLowerCase() === expected.toLowerCase() ? null : `header "${name}" is "${actual}", expected "${expected}"`
    }
    if (op === 'contains') {
      return actual.toLowerCase().includes(expected.toLowerCase()) ? null : `header "${name}" is "${actual}", which does not contain "${expected}"`
    }
    return `unknown operator "${op}" for a header check`
  }
  const value = __readField(body, path)
  const absent = value === __MISSING
  switch (op) {
    case 'exists':
      return absent ? `"${path}" is not in the response` : null
    case 'not-exists':
      return absent ? null : `"${path}" IS in the response (${__show(value)}) — expected it to be absent`
    case 'not-empty':
      if (absent) return `"${path}" is not in the response`
      if (value === null || value === '') return `"${path}" is ${__show(value)} — expected a value`
      if (Array.isArray(value) && value.length === 0) return `"${path}" is an empty array`
      return null
    case 'empty':
      if (absent || value === null || value === '') return null
      if (Array.isArray(value) && value.length === 0) return null
      return `"${path}" is ${__show(value)} — expected it to be empty`
    case 'equals':
      if (absent) return `"${path}" is not in the response (expected "${expected}")`
      return String(value) === expected ? null : `"${path}" is ${__show(value)}, expected "${expected}"`
    case 'not-equals':
      if (absent) return `"${path}" is not in the response — a not-equals check can't pass on a field that isn't there`
      return String(value) !== expected ? null : `"${path}" is "${expected}" — expected it not to be`
    case 'contains':
      if (absent) return `"${path}" is not in the response`
      return String(value).includes(expected) ? null : `"${path}" is ${__show(value)}, which does not contain "${expected}"`
    case 'not-contains':
      if (absent) return `"${path}" is not in the response — a not-contains check can't pass on a field that isn't there`
      return !String(value).includes(expected) ? null : `"${path}" is ${__show(value)}, which contains "${expected}"`
    case 'gt':
    case 'lt': {
      if (absent) return `"${path}" is not in the response`
      if (value === null || typeof value === 'boolean' || typeof value === 'object' || value === '') {
        return `"${path}" is ${__show(value)}, which is not a number`
      }
      const n = Number(value)
      const target = Number(expected)
      if (!Number.isFinite(n)) return `"${path}" is ${__show(value)}, which is not a number`
      if (!Number.isFinite(target)) return `"${expected}" is not a number`
      if (op === 'gt') return n > target ? null : `"${path}" is ${n}, expected greater than ${target}`
      return n < target ? null : `"${path}" is ${n}, expected less than ${target}`
    }
    case 'count-eq':
    case 'count-gt':
    case 'count-lt': {
      if (absent) return `"${path}" is not in the response`
      if (!Array.isArray(value)) return `"${path}" is ${__show(value)}, which is not an array`
      const n = value.length
      const target = Number(expected)
      if (!Number.isFinite(target)) return `"${expected}" is not a number`
      if (op === 'count-eq') return n === target ? null : `"${path}" has ${n} items, expected ${target}`
      if (op === 'count-gt') return n > target ? null : `"${path}" has ${n} items, expected more than ${target}`
      return n < target ? null : `"${path}" has ${n} items, expected fewer than ${target}`
    }
    case 'is-number':
    case 'is-string':
    case 'is-boolean':
    case 'is-array': {
      if (absent) return `"${path}" is not in the response`
      const want = op.slice(3)
      const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
      return actual === want ? null : `"${path}" is ${__article(actual)}, expected ${__article(want)}`
    }
    default:
      return `unknown check "${op}"`
  }
}
// Reports EVERY failing check at once, not just the first — you fix them in one pass.
function __expectChecks(body: unknown, headers: Record<string, string>, list: [string, string, string][]): void {
  const failures = list
    .map(([p, op, exp]) => {
      const why = __why(body, headers, p, op, exp)
      return why ? `${[p, op, exp].filter(Boolean).join(' ')} — ${why}` : null
    })
    .filter(Boolean)
  expect(failures, 'API response checks').toEqual([])
}

test("Orders", async ({ page, request }) => {
  // Fresh every run, so a re-run never collides with the data the last one left behind.
  const runUuid = randomUUID()
  // Values lifted out of API responses (the server invents them).
  const saved: Record<string, string> = {}

  try {
    // Go to https://shop.test/
    await page.goto("https://shop.test/")

    // API POST https://api.shop.test/orders/{{uuid}} → expect 201
    {
      const t0 = Date.now()
      const res = await request.post(`https://api.shop.test/orders/${runUuid}`, { headers: { "Content-Type": "application/json" }, data: "{\"item\":\"backpack\"}" })
      expect(res.status(), 'status').toBe(201)
      expect(Date.now() - t0, 'response time').toBeLessThanOrEqual(800)
      const body = await res.json()
      __expectChecks(body, res.headers(), [
        ["status", "equals", "CONFIRMED"]
      ])
      saved.orderId = String(body.id)
    }

    // Check Order id contains "{{saved:orderId}}"
    await expect(page.locator("[data-test=\"order-id\"], [data-testid=\"order-id\"]")).toContainText(saved.orderId)
  } finally {
    // 🧹 Teardown — runs even if the test failed above, so the data this
    // test created is never left behind in the environment.
    // API DELETE https://api.shop.test/orders/{{saved:orderId}} → expect 204,404
    {
      const res = await request.delete(`https://api.shop.test/orders/${saved.orderId}`)
      expect([204, 404], 'status is one of 204,404').toContain(res.status())
    }
  }
})
