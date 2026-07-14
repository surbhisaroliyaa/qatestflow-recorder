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
  // A line we could not parse. It is kept (not dropped) and reported as a
  // FAILURE — a check the user believes they wrote must never silently not run.
  invalid?: string
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
  'not-exists',
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
//
// A line we cannot parse is NOT dropped. Dropping it is how you get a dead
// assertion: the user writes `id` (forgetting the operator), sees no complaint,
// and reads the resulting green as "id was checked". It wasn't. It is kept as an
// `invalid` line and reported as a failure, so a check that cannot run says so.
export function parseChecks(text?: string): CheckLine[] {
  if (!text) return []
  const out: CheckLine[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    // path, then op, then (optionally) the rest as the expected value.
    const m = /^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(line)
    if (!m) {
      out.push({
        path: line,
        op: '',
        expected: '',
        invalid: `"${line}" isn't a check — write it as: <field> <operator> [value]  (e.g. "id not-empty" or "status equals CONFIRMED")`
      })
      continue
    }
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

// "a number" / "an object" — the error messages read like sentences, so they
// need the right article. (They used to all say "a", hence "it was a object".)
//
// `null` takes NO article: it's a bare value, not a countable type, so "is null"
// is right and "is a null" is not. It's the only type name that reads this way.
const article = (t: string): string =>
  t === 'null' ? t : /^[aeiou]/i.test(t) ? `an ${t}` : `a ${t}`

// Run one check. Returns null when it passes, or WHY it failed.
function runCheck(
  check: CheckLine,
  body: unknown,
  headers: Record<string, string>
): string | null {
  const { path, op, expected } = check

  // A line that didn't parse — report it instead of quietly not running it.
  if (check.invalid) return check.invalid

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
      // The header IS present. This used to fall through to `default:` and report
      // a bogus "unknown operator" — so the one case not-exists exists to catch
      // was the one case it couldn't report.
      case 'not-exists':
        return `header "${name}" IS present ("${actual}") — expected it to be absent`
      case 'equals':
        return actual.toLowerCase() === expected.toLowerCase()
          ? null
          : `header "${name}" is "${actual}", expected "${expected}"`
      case 'contains':
        return actual.toLowerCase().includes(expected.toLowerCase())
          ? null
          : `header "${name}" is "${actual}", which does not contain "${expected}"`
      default:
        return `unknown operator "${op}" for a header check — try one of: exists, not-exists, equals, contains`
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

    // Asserting "this field is not X" against a field that ISN'T THERE used to
    // pass. That makes a typo'd path (`nmae not-equals Bob`) a guaranteed green —
    // the exact dead assertion this module exists to kill. A negative check still
    // has to be checking something. Use `not-exists` to assert a field is absent.
    case 'not-equals':
      if (absent) {
        return `"${path}" is not in the response — a not-equals check can't pass on a field that isn't there (did you mean "${path} not-exists", or misspell the field?)`
      }
      return String(value) !== expected ? null : `"${path}" is "${expected}" — expected it not to be`

    case 'contains':
      if (absent) return `"${path}" is not in the response`
      return String(value).includes(expected)
        ? null
        : `"${path}" is ${show(value)}, which does not contain "${expected}"`

    case 'not-contains':
      if (absent) {
        return `"${path}" is not in the response — a not-contains check can't pass on a field that isn't there (did you mean "${path} not-exists", or misspell the field?)`
      }
      return !String(value).includes(expected)
        ? null
        : `"${path}" is ${show(value)}, which contains "${expected}"`

    // The one way to assert a field is GONE — e.g. "password not-exists" on a
    // user response. There was no way to say this before.
    case 'not-exists':
      return absent ? null : `"${path}" IS in the response (${show(value)}) — expected it to be absent`

    case 'gt':
    case 'lt': {
      if (absent) return `"${path}" is not in the response`
      // Number() is far too generous to lean on: Number(null), Number([]),
      // Number(false) and Number('') are all 0 — and 0 is finite, so it sails
      // past an isFinite guard. That made `total gt -1` PASS on {"total": null}.
      // Reject the non-numeric TYPES up front; a numeric string ("100") is still
      // fine, because plenty of real APIs send numbers that way.
      if (value === null || typeof value === 'boolean' || typeof value === 'object' || value === '') {
        return `"${path}" is ${show(value)}, which is not a number`
      }
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
      // typeof null is "object", which would report the useless "is an object,
      // expected a number". Name null as null — it's the likeliest culprit.
      const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
      return actual === want
        ? null
        : `"${path}" is ${article(actual)}, expected ${article(want)}`
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

  const isHeader = (c: CheckLine): boolean =>
    !c.invalid && c.path.toLowerCase().startsWith(HEADER_PREFIX)

  const needsBody = checks.some((c) => !isHeader(c))
  let body: unknown
  let bodyUnparseable = false
  if (needsBody) {
    try {
      body = JSON.parse(bodyText)
    } catch {
      // The body isn't JSON — but that only kills the BODY checks. The header
      // checks still have headers to look at, and used to be silently thrown away
      // with an early return, so a mixed block lost its header assertions.
      bodyUnparseable = true
    }
  }

  const out: CheckFailure[] = []
  for (const c of checks) {
    const line = c.invalid ? c.path : `${c.path} ${c.op} ${c.expected}`.trim()
    if (bodyUnparseable && !isHeader(c) && !c.invalid) {
      out.push({ line, reason: "the response isn't JSON, so its fields can't be checked" })
      continue
    }
    const reason = runCheck(c, body, headers)
    if (reason) out.push({ line, reason })
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

  // An array that is PRESENT but EMPTY contributes no element paths (inferContract
  // only walks arr[0]). Without this, a contract captured from `{items:[{sku}]}`
  // reports `items[].sku` as GONE the first time the list comes back empty — and
  // an empty list is a perfectly normal response, not a broken contract.
  // We can't verify element shape with no elements; we can only decline to lie
  // about it.
  const emptyArrays = new Set<string>()
  for (const [p, t] of Object.entries(now)) {
    if (t === 'array' && !Object.keys(now).some((k) => k.startsWith(`${p}[]`))) emptyArrays.add(p)
  }
  const insideEmptyArray = (path: string): boolean =>
    [...emptyArrays].some((p) => path.startsWith(`${p}[]`))

  const out: CheckFailure[] = []
  for (const [path, wantType] of Object.entries(contract)) {
    const actual = now[path]
    if (actual === undefined) {
      if (insideEmptyArray(path)) continue
      out.push({
        line: `contract: ${path}`,
        reason: `the field "${path}" is GONE from the response (it was ${article(wantType)})`
      })
    } else if (actual !== wantType && !(wantType === 'null' || actual === 'null')) {
      // null ⇄ a real type is a value change, not a shape change — an optional
      // field being null in one response and filled in another is normal.
      out.push({
        line: `contract: ${path}`,
        reason: `the field "${path}" is now ${article(actual)} — it was ${article(wantType)}`
      })
    }
  }
  return out
}
