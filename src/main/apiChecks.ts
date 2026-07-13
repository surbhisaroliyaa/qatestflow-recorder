// =====================================================================
// API RESPONSE CHECKS (F24.2)
//
// The hole this closes: an API step's only body assertion was "contains this
// substring" — which is precisely the dead-assertion disease F6 was built to
// catch, reinvented in API form:
//
//   body contains "id"       PASSES on { "id": null, "status": "FAILED" }
//   body contains "success"  PASSES on { "error": "no success for you" }
//
// A substring match cannot tell you a field is PRESENT, or NON-EMPTY, or EQUAL
// to something — it only tells you those characters appear somewhere in the
// text. So this module adds real checks, in a one-line-per-check syntax:
//
//   id           not-empty
//   status       equals CONFIRMED
//   items        count-gt 0
//   total        gt 100
//   header:content-type  contains application/json
//
// Plus a CONTRACT check (schema): capture the SHAPE of a known-good response,
// then assert later responses still match it. That is the one thing that catches
// a backend quietly renaming `total` to `amount` — no value assertion ever will,
// because the field simply isn't there any more.
//
// Pure: everything here takes plain data and returns plain data.
// =====================================================================

export interface CheckLine {
  path: string // 'status', 'data.items.0.sku', or 'header:content-type'
  op: string
  expected: string
}

export interface CheckFailure {
  line: string // the check as written, so the error names it verbatim
  reason: string
}

const HEADER_PREFIX = 'header:'

// The operators, and what each one MEANS. Deliberately small — a QA should be
// able to read the whole list once and remember it.
export const CHECK_OPS = [
  'equals',
  'not-equals',
  'contains',
  'not-contains',
  'exists',
  'not-empty',
  'empty',
  'gt',
  'lt',
  'count-eq',
  'count-gt',
  'count-lt',
  'is-number',
  'is-string',
  'is-boolean',
  'is-array'
] as const

// "status equals CONFIRMED" → { path, op, expected }. Blank lines and lines
// starting with # are ignored, so a check block can carry comments.
export function parseChecks(text?: string): CheckLine[] {
  if (!text) return []
  const out: CheckLine[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    // path, then op, then (optionally) the rest as the expected value.
    const m = /^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(line)
    if (!m) continue
    out.push({ path: m[1], op: m[2].toLowerCase(), expected: (m[3] ?? '').trim() })
  }
  return out
}

// Walk a dot path into a parsed body. Numeric segments index arrays.
// Returns the sentinel MISSING (not undefined) so we can tell "the field is
// absent" apart from "the field is present and holds null".
const MISSING = Symbol('missing')
export function readPath(body: unknown, path: string): unknown {
  let cur: unknown = body
  for (const seg of path.split('.')) {
    const key = seg.trim()
    if (!key) continue
    if (cur == null) return MISSING
    if (Array.isArray(cur)) {
      const idx = Number(key)
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return MISSING
      cur = cur[idx]
    } else if (typeof cur === 'object') {
      const obj = cur as Record<string, unknown>
      if (!(key in obj)) return MISSING
      cur = obj[key]
    } else {
      return MISSING
    }
  }
  return cur
}

const show = (v: unknown): string => {
  if (v === MISSING) return '(absent)'
  if (v === null) return 'null'
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80)
  return String(v)
}

// Run one check. Returns null when it passes, or WHY it failed.
function runCheck(
  check: CheckLine,
  body: unknown,
  headers: Record<string, string>
): string | null {
  const { path, op, expected } = check

  // header:content-type contains application/json
  if (path.toLowerCase().startsWith(HEADER_PREFIX)) {
    const name = path.slice(HEADER_PREFIX.length).toLowerCase()
    const actual = headers[name]
    if (actual === undefined) {
      return op === 'not-exists' ? null : `the response has no "${name}" header`
    }
    switch (op) {
      case 'exists':
        return null
      case 'equals':
        return actual.toLowerCase() === expected.toLowerCase()
          ? null
          : `header "${name}" is "${actual}", expected "${expected}"`
      case 'contains':
        return actual.toLowerCase().includes(expected.toLowerCase())
          ? null
          : `header "${name}" is "${actual}", which does not contain "${expected}"`
      default:
        return `unknown operator "${op}" for a header check`
    }
  }

  const value = readPath(body, path)
  const absent = value === MISSING

  switch (op) {
    case 'exists':
      return absent ? `"${path}" is not in the response` : null

    case 'not-empty':
      // The check that would have caught {"id": null}: present, AND actually a value.
      if (absent) return `"${path}" is not in the response`
      if (value === null || value === '') return `"${path}" is ${show(value)} — expected a value`
      if (Array.isArray(value) && value.length === 0) return `"${path}" is an empty array`
      return null

    case 'empty':
      if (absent || value === null || value === '') return null
      if (Array.isArray(value) && value.length === 0) return null
      return `"${path}" is ${show(value)} — expected it to be empty`

    case 'equals':
      if (absent) return `"${path}" is not in the response (expected "${expected}")`
      return String(value) === expected
        ? null
        : `"${path}" is ${show(value)}, expected "${expected}"`

    case 'not-equals':
      if (absent) return null
      return String(value) !== expected ? null : `"${path}" is "${expected}" — expected it not to be`

    case 'contains':
      if (absent) return `"${path}" is not in the response`
      return String(value).includes(expected)
        ? null
        : `"${path}" is ${show(value)}, which does not contain "${expected}"`

    case 'not-contains':
      if (absent) return null
      return !String(value).includes(expected)
        ? null
        : `"${path}" is ${show(value)}, which contains "${expected}"`

    case 'gt':
    case 'lt': {
      if (absent) return `"${path}" is not in the response`
      const n = Number(value)
      const target = Number(expected)
      if (!Number.isFinite(n)) return `"${path}" is ${show(value)}, which is not a number`
      if (!Number.isFinite(target)) return `"${expected}" is not a number`
      if (op === 'gt') return n > target ? null : `"${path}" is ${n}, expected greater than ${target}`
      return n < target ? null : `"${path}" is ${n}, expected less than ${target}`
    }

    case 'count-eq':
    case 'count-gt':
    case 'count-lt': {
      if (absent) return `"${path}" is not in the response`
      if (!Array.isArray(value)) return `"${path}" is ${show(value)}, which is not an array`
      const n = value.length
      const target = Number(expected)
      if (!Number.isFinite(target)) return `"${expected}" is not a number`
      if (op === 'count-eq') return n === target ? null : `"${path}" has ${n} items, expected ${target}`
      if (op === 'count-gt') {
        return n > target ? null : `"${path}" has ${n} items, expected more than ${target}`
      }
      return n < target ? null : `"${path}" has ${n} items, expected fewer than ${target}`
    }

    case 'is-number':
    case 'is-string':
    case 'is-boolean':
    case 'is-array': {
      if (absent) return `"${path}" is not in the response`
      const want = op.slice(3)
      const actual = Array.isArray(value) ? 'array' : typeof value
      return actual === want ? null : `"${path}" is a ${actual}, expected a ${want}`
    }

    default:
      return `unknown check "${op}" — try one of: ${CHECK_OPS.join(', ')}`
  }
}

// Run every check against a response. Returns the failures (empty = all passed).
// A non-JSON body fails any body check honestly rather than silently passing.
export function runChecks(
  text: string | undefined,
  bodyText: string,
  headers: Record<string, string>
): CheckFailure[] {
  const checks = parseChecks(text)
  if (!checks.length) return []

  const needsBody = checks.some((c) => !c.path.toLowerCase().startsWith(HEADER_PREFIX))
  let body: unknown
  if (needsBody) {
    try {
      body = JSON.parse(bodyText)
    } catch {
      return checks
        .filter((c) => !c.path.toLowerCase().startsWith(HEADER_PREFIX))
        .map((c) => ({
          line: `${c.path} ${c.op} ${c.expected}`.trim(),
          reason: "the response isn't JSON, so its fields can't be checked"
        }))
    }
  }

  const out: CheckFailure[] = []
  for (const c of checks) {
    const reason = runCheck(c, body, headers)
    if (reason) out.push({ line: `${c.path} ${c.op} ${c.expected}`.trim(), reason })
  }
  return out
}

// === CONTRACT (schema) ==============================================
// The SHAPE of a response: every field's dot path → its JSON type. Captured from
// a known-good response, then asserted against later ones.
//
// This is the check no value assertion can replace. When a backend renames
// `total` to `amount`, every "contains"/"equals" check on `total` still passes
// or fails for the WRONG reason — the field just isn't there. The contract says
// so in one line.

export type Contract = Record<string, string> // 'data.total' → 'number'

const typeOf = (v: unknown): string => {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

// Flatten a body into path → type. Arrays are recorded as `array`, and their
// FIRST element is walked (so `items.sku` is contracted, not `items.0.sku` and
// `items.1.sku` — a list of 3 things and a list of 300 have the same shape).
export function inferContract(body: unknown, prefix = '', out: Contract = {}): Contract {
  const t = typeOf(body)
  if (prefix) out[prefix] = t
  if (t === 'object') {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      inferContract(v, prefix ? `${prefix}.${k}` : k, out)
    }
  } else if (t === 'array') {
    const arr = body as unknown[]
    if (arr.length) inferContract(arr[0], prefix ? `${prefix}[]` : '[]', out)
  }
  return out
}

// Compare a response against a captured contract. Reports fields that VANISHED
// or CHANGED TYPE. Extra fields are NOT a failure — an API adding a field is
// backwards-compatible and breaking a test for it would train people to ignore
// contract failures, which defeats the point.
export function checkContract(body: unknown, contract: Contract): CheckFailure[] {
  const now = inferContract(body)
  const out: CheckFailure[] = []
  for (const [path, wantType] of Object.entries(contract)) {
    const actual = now[path]
    if (actual === undefined) {
      out.push({
        line: `contract: ${path}`,
        reason: `the field "${path}" is GONE from the response (it was a ${wantType})`
      })
    } else if (actual !== wantType && !(wantType === 'null' || actual === 'null')) {
      // null ⇄ a real type is a value change, not a shape change — an optional
      // field being null in one response and filled in another is normal.
      out.push({
        line: `contract: ${path}`,
        reason: `the field "${path}" is now a ${actual} — it was a ${wantType}`
      })
    }
  }
  return out
}
