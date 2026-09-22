// =====================================================================
// PORTABLE TEST FORMAT — YAML / JSON round trip  (Phase 4, audit gap)
// =====================================================================
// WHAT THIS IS FOR
//
// A saved test already lives as JSON in a visible folder, and F40's bundle
// already puts that folder in git. So why another format?
//
// Because the saved JSON is a MACHINE format. Every step carries its full
// ranked selector ladder — five or six candidates, each with a score, a CSS
// form, a role, an accessible name. A twelve-step login is four hundred lines.
// You can commit it, but nobody can review it: a pull request that changes one
// button's name shows up as an unreadable wall, and nobody can WRITE one by
// hand at all.
//
// This module is the human-facing form of the same model:
//
//   - do: type
//     target: Username
//     value: standard_user
//     selector: getByTestId('username')
//
// One step, four lines, and a reviewer can see what changed. It round-trips:
// export a test, edit it in any text editor, import it back, and it runs.
//
// == Two things this deliberately does NOT do ==
//
// 1. It is not a replacement for the saved JSON. Run history, versions, trust
//    scores and baselines stay where they are — they are YOUR machine's facts,
//    not the test's (the same reasoning as the bundle's "what travels" list).
// 2. It does not invent selectors. A hand-written step that names no selector
//    cannot be resolved, and this module says so rather than guessing — a
//    guessed selector is how a test goes green against the wrong element.
//
// == The ladder, and why importing is not just parsing ==
//
// Replay resolves elements through `candidates`, the ranked ladder. Export
// writes `selector`, one locator expression. A HAND-WRITTEN step will have the
// selector (it is the readable part) and no ladder at all — so importing has to
// rebuild a ladder from the selector, or the step parses cleanly and then fails
// to find anything at replay. That is what `candidateFromLocator` does, for the
// locator forms people actually write.
//
// == Why a hand-rolled YAML subset, rather than a library ==
//
// The audit's QF-006 was two high-severity advisories arriving through a
// dependency, and CI now fails on `npm audit --audit-level=high`. A YAML parser
// is a notoriously large attack surface for what is, here, a fixed and tiny
// shape: block maps, block sequences, inline maps, quoted scalars, and block
// literals for multi-line values. That subset is written and tested here rather
// than pulled in, and anything outside it is REJECTED with a line number rather
// than half-understood.
// =====================================================================

/** The values the emitter and parser handle. Deliberately closed. */
type Scalar = string | number | boolean | null
type Value = Scalar | Value[] | { [k: string]: Value }

export const PORTABLE_VERSION = 1

/** A test in its portable form. `steps` are the step model, minus the fields
 *  that are this machine's business rather than the test's. */
export interface PortableTest {
  version: number
  name: string
  baseURL?: string
  tags?: string[]
  viewport?: { width: number; height: number }
  deviceId?: string
  storageState?: string
  har?: string
  dataRows?: Record<string, string>[]
  steps: Record<string, unknown>[]
}

// ── what a step looks like in the portable form ──────────────────────
// `do` is the step type and always comes first; `target` is the human label.
// The rest are the step's own fields, in a fixed order so a re-export of an
// unchanged test produces an identical file (a format whose output order
// wobbles makes every diff useless, which defeats the point).
const STEP_KEY_ORDER = [
  'do',
  'target',
  'url',
  'value',
  'key',
  'assertKind',
  'attrName',
  'waitKind',
  'dialogKind',
  'scrollKind',
  'dragKind',
  'dragFrom',
  'repeatKind',
  'condKind',
  'blockRef',
  'secret',
  'secretRef',
  'optional',
  'disabled',
  'teardown',
  'createsData',
  'windowId',
  'opensWindow',
  'frame',
  'selector',
  'targetSelector',
  'targetLabel',
  'maskSelectors',
  'freezeAnimations',
  'maxDiffPixels',
  'baselineId',
  'downloadPath',
  'apiMethod',
  'apiHeaders',
  'apiBody',
  'apiExpectStatus',
  'apiExpectBody',
  'apiSave',
  'apiChecks',
  'apiMaxMs',
  'apiTimeoutMs',
  'apiInjectCookies',
  'apiInjectStorage',
  'candidates',
  'targetCandidates'
] as const

// Fields that belong to THIS MACHINE'S run of the test, not to the test. They
// are dropped on export for the same reason the bundle drops run history:
// carrying them to someone else's checkout states a fact about their machine
// that nobody has established.
const DROPPED_ON_EXPORT = new Set(['id', 'healedByAi', 'revealValue'])

// ── the emitter ──────────────────────────────────────────────────────

/** Does this string need quoting to survive a round trip? Erring towards
 *  quoting is safe; erring away from it silently changes values ("yes" and
 *  "3.0" are the classic ones — YAML would hand them back as a boolean and a
 *  number, and a test would start typing `true` into a search box). */
function needsQuotes(s: string, inline = false): boolean {
  if (s === '') return true
  if (s !== s.trim()) return true
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true
  if (/:\s|\s#/.test(s)) return true
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return true
  // INSIDE `{ … }` far more is structural, and it does not have to be at the
  // start of the value to matter. A real selector ladder is full of this:
  //
  //     css: input[name="user-name"]
  //
  // begins with a letter, so the rules above let it out bare — and then the
  // `[` read as the start of a nested collection and the file this module
  // wrote could not be read back by this module (Surbhi, Round 6). The
  // fixtures missed it because hand-made ladders use tidy values like
  // `[data-test="x"]`, which the leading-character rule already quotes; REAL
  // ones do not.
  if (inline && /[[\]{},'"]/.test(s)) return true
  return false
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

function emitScalar(v: Scalar, inline = false): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  return needsQuotes(v, inline) ? quote(v) : v
}

/** An inline map — `{ kind: role, score: 92 }`. Used for a selector candidate,
 *  which is one conceptual thing and reads far better on one line than as six
 *  nested ones. */
function emitInline(o: Record<string, Value>): string {
  const parts = Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${emitScalar(v as Scalar, true)}`)
  return `{ ${parts.join(', ')} }`
}

function isPlainObject(v: unknown): v is Record<string, Value> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Every value in this object is a scalar — so it can go on one line. */
function allScalar(o: Record<string, Value>): boolean {
  return Object.values(o).every((v) => v === null || typeof v !== 'object')
}

// Which lists read better with one item per LINE rather than one per BLOCK.
// A selector candidate and a data row are each one small record, and a page of
// six-line blocks for them buries the steps. A STEP is never inlined, whatever
// its size — the step list is the thing a reviewer reads, and it has to look
// the same whether a step has three fields or nine.
const INLINE_ITEM_KEYS = new Set(['candidates', 'targetCandidates', 'dataRows'])

function emitValue(v: Value, indent: string, out: string[], inlineItems = false): void {
  if (Array.isArray(v)) {
    if (!v.length) {
      out[out.length - 1] += ' []'
      return
    }
    for (const item of v) {
      if (isPlainObject(item)) {
        if (inlineItems && allScalar(item)) {
          out.push(`${indent}- ${emitInline(item)}`)
        } else {
          const keys = Object.keys(item).filter((k) => item[k] !== undefined)
          out.push(`${indent}- ${keys[0]}:`)
          // Re-emit the first key properly, then the rest at the same level.
          out.pop()
          let first = true
          for (const k of keys) {
            const prefix = first ? `${indent}- ` : `${indent}  `
            first = false
            emitPair(k, item[k], prefix, `${indent}  `, out)
          }
        }
      } else {
        out.push(`${indent}- ${emitScalar(item as Scalar)}`)
      }
    }
    return
  }
  if (isPlainObject(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue
      emitPair(k, val, indent, indent, out)
    }
    return
  }
  out[out.length - 1] += ` ${emitScalar(v as Scalar)}`
}

function emitPair(key: string, v: Value, prefix: string, childIndent: string, out: string[]): void {
  const inlineItems = INLINE_ITEM_KEYS.has(key)
  // A multi-line string becomes a block literal. `|-` keeps the lines and drops
  // the trailing newline, which is what every multi-line field here means (an
  // upload's file list, an API body, a mask-selector list).
  if (typeof v === 'string' && v.includes('\n')) {
    out.push(`${prefix}${key}: |-`)
    for (const line of v.split('\n')) out.push(`${childIndent}  ${line}`)
    return
  }
  if (Array.isArray(v) || isPlainObject(v)) {
    if (isPlainObject(v) && allScalar(v)) {
      out.push(`${prefix}${key}: ${emitInline(v)}`)
      return
    }
    out.push(`${prefix}${key}:`)
    emitValue(v, `${childIndent}  `, out, inlineItems)
    return
  }
  out.push(`${prefix}${key}: ${emitScalar(v as Scalar)}`)
}

/** Render a portable test as YAML. */
export function toYaml(test: PortableTest): string {
  const out: string[] = []
  out.push('# QATestFlow portable test — edit freely, then import it back.')
  out.push('# `selector` is the contract: a step with no selector cannot be found.')
  out.push('')
  for (const [k, v] of Object.entries(test)) {
    if (v === undefined || k === 'steps') continue
    emitPair(k, v as Value, '', '', out)
  }
  out.push('steps:')
  emitValue(test.steps as unknown as Value, '  ', out)
  return out.join('\n') + '\n'
}

// ── the parser ───────────────────────────────────────────────────────

class YamlError extends Error {
  constructor(line: number, message: string) {
    super(`Line ${line}: ${message}`)
  }
}

/** Read one scalar. Kept deliberately narrow — see needsQuotes. */
function parseScalar(raw: string, line: number): Scalar {
  const s = raw.trim()
  if (s === '' || s === '~' || s === 'null') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new YamlError(line, 'unterminated quoted value')
    return s.slice(1, -1).replace(/''/g, "'")
  }
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new YamlError(line, 'unterminated quoted value')
    return s
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s)
  return s
}

/** Split an inline map/list body on commas that are not inside quotes. */
function splitInline(body: string, line: number): string[] {
  const parts: string[] = []
  let cur = ''
  let quoteCh = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (quoteCh) {
      cur += c
      if (c === quoteCh) {
        // '' inside a single-quoted scalar is an escaped quote, not the end.
        if (c === "'" && body[i + 1] === "'") {
          cur += "'"
          i++
        } else {
          quoteCh = ''
        }
      }
      continue
    }
    if (c === "'" || c === '"') {
      quoteCh = c
      cur += c
      continue
    }
    if (c === ',') {
      parts.push(cur)
      cur = ''
      continue
    }
    // A bracket or brace here is an ordinary CHARACTER, not structure.
    //
    // This used to throw. Nested inline collections are not supported, so the
    // reasoning went that a `[` could only be somebody attempting one — but a
    // selector is full of them (`css: input[name="user-name"]`), and a file
    // written by an older build, or written by hand, carries them unquoted.
    // Refusing made those files unreadable for no gain: with no nesting to be
    // confused with, there is nothing for a bracket to be ambiguous against.
    //
    // Commas and quotes still do their job above, and a value that genuinely
    // needs protecting gets quoted on the way out (see needsQuotes).
    cur += c
  }
  if (quoteCh) throw new YamlError(line, 'unterminated quoted value')
  if (cur.trim()) parts.push(cur)
  return parts
}

function parseInline(s: string, line: number): Value {
  const body = s.slice(1, -1).trim()
  if (s.startsWith('[')) {
    if (!body) return []
    return splitInline(body, line).map((p) => parseScalar(p, line))
  }
  if (!body) return {}
  const o: Record<string, Value> = {}
  for (const part of splitInline(body, line)) {
    const at = part.indexOf(':')
    if (at < 0) throw new YamlError(line, `expected "key: value" in { … }, got "${part.trim()}"`)
    o[part.slice(0, at).trim()] = parseScalar(part.slice(at + 1), line)
  }
  return o
}

interface Line {
  indent: number
  text: string
  n: number
}

/**
 * Remove a comment from one line.
 *
 * A `#` only starts a comment at the beginning of the line or after
 * whitespace, and never inside a quoted scalar — `value: 'item #4'` is a
 * value, not a truncated one. Done by scanning rather than by regex, because
 * the regex that looked right here silently left whole-line comments in place
 * and then reported them as syntax errors on line 1.
 */
function stripComment(raw: string): string {
  let quoteCh = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (quoteCh) {
      if (c === quoteCh) {
        if (c === "'" && raw[i + 1] === "'") i++
        else quoteCh = ''
      }
      continue
    }
    if (c === "'" || c === '"') {
      quoteCh = c
      continue
    }
    if (c === '#' && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i)
  }
  return raw
}

/** Strip comments and blank lines, and record each line's indent. Tabs are
 *  refused outright: they indent differently in every editor, so a file that
 *  mixes them parses one way here and reads another way to the person who
 *  wrote it. */
function readLines(src: string): Line[] {
  const out: Line[] = []
  src.split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1
    if (raw.includes('\t') && !raw.trim().startsWith('#')) {
      const beforeContent = raw.slice(0, raw.length - raw.trimStart().length)
      if (beforeContent.includes('\t')) throw new YamlError(n, 'tabs cannot be used to indent')
    }
    const withoutComment = stripComment(raw)
    if (!withoutComment.trim()) return
    out.push({ indent: raw.length - raw.trimStart().length, text: withoutComment.trim(), n })
  })
  return out
}

/** Parse a block at `indent` starting at lines[i]. Returns the value and the
 *  index of the first line that is no longer part of it. */
function parseBlock(lines: Line[], start: number, indent: number): [Value, number] {
  if (start >= lines.length) return [null, start]

  if (lines[start].text.startsWith('- ') || lines[start].text === '-') {
    const arr: Value[] = []
    let i = start
    while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('-')) {
      const rest = lines[i].text.replace(/^-\s*/, '')
      const childIndent = lines[i].indent + 2
      if (!rest) {
        const [v, next] = parseBlock(lines, i + 1, childIndent)
        arr.push(v)
        i = next
        continue
      }
      if (rest.startsWith('{') || rest.startsWith('[')) {
        arr.push(parseInline(rest, lines[i].n))
        i++
        continue
      }
      const at = rest.indexOf(':')
      if (at < 0) {
        arr.push(parseScalar(rest, lines[i].n))
        i++
        continue
      }
      // "- key: value" opens a map whose remaining keys are indented to where
      // that first key started.
      const mapIndent = lines[i].indent + 2
      const synthetic: Line[] = [{ indent: mapIndent, text: rest, n: lines[i].n }]
      let j = i + 1
      while (j < lines.length && lines[j].indent >= mapIndent && !lines[j].text.startsWith('- ')) {
        synthetic.push(lines[j])
        j++
      }
      // A nested list under one of those keys sits at the map's own indent.
      while (
        j < lines.length &&
        lines[j].indent > lines[i].indent &&
        lines[j].text.startsWith('-')
      ) {
        synthetic.push(lines[j])
        j++
      }
      const [v] = parseBlock(synthetic, 0, mapIndent)
      arr.push(v)
      i = j
    }
    return [arr, i]
  }

  const o: Record<string, Value> = {}
  let i = start
  while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
    const { text, n } = lines[i]
    const at = text.indexOf(':')
    if (at < 0) throw new YamlError(n, `expected "key: value", got "${text}"`)
    const key = text.slice(0, at).trim()
    const rest = text.slice(at + 1).trim()

    if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-') {
      const chunk: string[] = []
      let j = i + 1
      const bodyIndent = j < lines.length ? lines[j].indent : indent + 2
      while (j < lines.length && lines[j].indent >= bodyIndent && lines[j].indent > indent) {
        chunk.push(' '.repeat(lines[j].indent - bodyIndent) + lines[j].text)
        j++
      }
      o[key] = rest.startsWith('>') ? chunk.join(' ') : chunk.join('\n')
      i = j
      continue
    }
    if (rest.startsWith('{') || rest.startsWith('[')) {
      o[key] = parseInline(rest, n)
      i++
      continue
    }
    if (rest === '') {
      const [v, next] = parseBlock(
        lines,
        i + 1,
        i + 1 < lines.length ? lines[i + 1].indent : indent + 2
      )
      o[key] = v
      i = next
      continue
    }
    o[key] = parseScalar(rest, n)
    i++
  }
  return [o, i]
}

/** Parse the YAML subset this module emits. Throws with a LINE NUMBER — a
 *  hand-edited file is going to be wrong sometimes, and "something went wrong"
 *  is not a usable answer when the file is four hundred lines long. */
export function parseYaml(src: string): Value {
  const lines = readLines(src)
  if (!lines.length) return {}
  const [v, next] = parseBlock(lines, 0, lines[0].indent)
  // Anything the parse did not consume is a mistake in the file — most often a
  // line indented to a level that belongs to nothing. Dropping it silently is
  // the dangerous answer: the import would succeed, and a step the author
  // clearly meant to include would simply not be there.
  if (next < lines.length) {
    throw new YamlError(
      lines[next].n,
      `this line doesn't belong to anything above it — check its indentation ("${lines[next].text}")`
    )
  }
  return v
}

// ── the step model ↔ the portable form ───────────────────────────────

/**
 * Rebuild a selector candidate from a locator expression.
 *
 * Replay resolves through the ladder; export writes the locator. A hand-written
 * step has the locator and no ladder, so without this it would parse perfectly
 * and then find nothing at replay — the worst kind of failure, because the file
 * looks right.
 *
 * Only the forms a person actually writes are understood. Anything else returns
 * null and the import says so, rather than inventing a selector: a guess here
 * is how a test goes green against the wrong element.
 */
export function candidateFromLocator(locator: string): Record<string, unknown> | null {
  const l = locator.trim()
  const str = String.raw`(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")`
  const unescape = (s: string): string => s.replace(/\\(['"\\])/g, '$1')

  let m = new RegExp(`^locator\\(\\s*${str}\\s*\\)$`).exec(l)
  if (m) return { kind: 'css', score: 70, css: unescape(m[1] ?? m[2] ?? ''), locator: l }

  m = new RegExp(`^getByTestId\\(\\s*${str}\\s*\\)$`).exec(l)
  if (m) {
    const id = unescape(m[1] ?? m[2] ?? '')
    // Both attributes, because the file doesn't say which one the app uses and
    // guessing wrong finds nothing. The recorder stores testIdAttr; a human
    // writing this line by hand has no reason to know it exists.
    return {
      kind: 'testId',
      score: 95,
      css: `[data-test="${id}"], [data-testid="${id}"]`,
      locator: l
    }
  }

  m = new RegExp(`^getByRole\\(\\s*${str}\\s*(?:,\\s*\\{\\s*name:\\s*${str}\\s*\\}\\s*)?\\)$`).exec(
    l
  )
  if (m) {
    const role = unescape(m[1] ?? m[2] ?? '')
    const name = m[3] ?? m[4]
    return {
      kind: 'role',
      score: 85,
      css: null,
      role,
      ...(name === undefined ? {} : { name: unescape(name) }),
      locator: l
    }
  }

  m = new RegExp(`^getByText\\(\\s*${str}\\s*\\)$`).exec(l)
  if (m)
    return { kind: 'text', score: 60, css: null, text: unescape(m[1] ?? m[2] ?? ''), locator: l }

  m = new RegExp(`^getByPlaceholder\\(\\s*${str}\\s*\\)$`).exec(l)
  if (m) {
    const p = unescape(m[1] ?? m[2] ?? '')
    return { kind: 'placeholder', score: 75, css: `[placeholder="${p}"]`, locator: l }
  }

  m = new RegExp(`^getByLabel\\(\\s*${str}\\s*\\)$`).exec(l)
  if (m) {
    // A label names its control; ARIA's accessible-name computation is what
    // replay already uses for role candidates, so route it there rather than
    // inventing a CSS form that would only match aria-label and miss <label for>.
    return { kind: 'role', score: 80, css: null, name: unescape(m[1] ?? m[2] ?? ''), locator: l }
  }

  // A trailing .first() / .nth(n) on any of the above.
  m = /^(.*)\.(?:first\(\)|nth\(\s*(\d+)\s*\))$/.exec(l)
  if (m) {
    const inner = candidateFromLocator(m[1])
    if (inner) return { ...inner, nth: m[2] ? Number(m[2]) : 0, locator: l }
  }
  return null
}

/** The step model → the portable form. */
export function stepToPortable(step: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { do: step.type }
  if (step.label !== undefined && step.label !== '') out.target = step.label
  for (const key of STEP_KEY_ORDER) {
    if (key === 'do' || key === 'target') continue
    const v = step[key]
    if (v === undefined || v === null || v === '') continue
    if (DROPPED_ON_EXPORT.has(key)) continue
    out[key] = v
  }
  return out
}

/** The portable form → the step model. Returns the step plus any WARNINGS —
 *  things that parsed but will not work, which the importer shows rather than
 *  discovering at replay. */
export function stepFromPortable(
  p: Record<string, unknown>,
  index: number
): { step: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = []
  const type = p.do
  if (typeof type !== 'string' || !type) {
    throw new Error(`Step ${index + 1}: every step needs a "do:" naming its type`)
  }
  const step: Record<string, unknown> = { type }
  if (p.target !== undefined) step.label = p.target
  for (const key of STEP_KEY_ORDER) {
    if (key === 'do' || key === 'target') continue
    if (p[key] !== undefined) step[key] = p[key]
  }

  // The ladder. A file that still has one keeps it; a hand-written step gets one
  // built from its selector, which is the whole reason importing is more than
  // parsing. See candidateFromLocator.
  const rebuild = (
    sel: unknown,
    cands: unknown,
    into: 'candidates' | 'targetCandidates',
    what: string
  ): void => {
    if (Array.isArray(cands) && cands.length) return
    if (typeof sel !== 'string' || !sel) return
    const c = candidateFromLocator(sel)
    if (c) {
      step[into] = [c]
      return
    }
    warnings.push(
      `Step ${index + 1}: could not work out what "${sel}" points at, so ${what} has no ` +
        `resolvable selector. Supported forms: locator('#id'), getByTestId('…'), ` +
        `getByRole('button', { name: '…' }), getByText('…'), getByLabel('…'), getByPlaceholder('…').`
    )
  }

  const NEEDS_ELEMENT = new Set([
    'click',
    'type',
    'check',
    'select',
    'press',
    'hover',
    'drag',
    'upload',
    'assert'
  ])
  if (NEEDS_ELEMENT.has(type) && !step.selector && type !== 'assert') {
    warnings.push(`Step ${index + 1}: a "${type}" step needs a selector to find its element.`)
  }
  rebuild(step.selector, step.candidates, 'candidates', 'the element')
  if (type === 'drag') {
    rebuild(step.targetSelector, step.targetCandidates, 'targetCandidates', 'the drop target')
  }
  return { step, warnings }
}

/** A saved test → its portable form. */
export function testToPortable(
  test: Record<string, unknown>,
  steps: Record<string, unknown>[]
): PortableTest {
  const out: PortableTest = {
    version: PORTABLE_VERSION,
    name: String(test.name ?? 'Recorded flow'),
    steps: steps.map(stepToPortable)
  }
  if (test.baseURL) out.baseURL = String(test.baseURL)
  if (Array.isArray(test.tags) && test.tags.length) out.tags = test.tags as string[]
  if (test.viewport) out.viewport = test.viewport as { width: number; height: number }
  if (test.deviceId) out.deviceId = String(test.deviceId)
  if (test.storageState) out.storageState = String(test.storageState)
  if (test.har) out.har = String(test.har)
  if (Array.isArray(test.dataRows) && test.dataRows.length) {
    out.dataRows = test.dataRows as Record<string, string>[]
  }
  return out
}

export interface ImportResult {
  test: PortableTest
  steps: Record<string, unknown>[]
  warnings: string[]
}

/**
 * Read a portable test from YAML or JSON. The format is detected rather than
 * asked for: a file that starts with `{` is JSON, and anything else is tried as
 * YAML. Being wrong about that is harmless — both paths report a line number.
 */
export function parsePortableTest(source: string, fileName = ''): ImportResult {
  const looksJson = /^\s*[{[]/.test(source) || /\.json$/i.test(fileName)
  let doc: unknown
  if (looksJson) {
    try {
      doc = JSON.parse(source)
    } catch (e) {
      throw new Error(`This file isn't valid JSON — ${(e as Error).message}`)
    }
  } else {
    doc = parseYaml(source)
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('A test file must be a map with a "name:" and a "steps:" list.')
  }
  const d = doc as Record<string, unknown>
  if (!Array.isArray(d.steps)) {
    throw new Error('This file has no "steps:" list, so there is no test in it.')
  }
  const warnings: string[] = []
  const steps: Record<string, unknown>[] = []
  d.steps.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Step ${i + 1}: expected a step, got ${JSON.stringify(raw)}`)
    }
    const { step, warnings: w } = stepFromPortable(raw as Record<string, unknown>, i)
    steps.push(step)
    warnings.push(...w)
  })
  // A version from the future is a warning, not a refusal: the steps are very
  // likely still readable, and refusing outright would strand a file written by
  // a newer build for no proven reason.
  const version = typeof d.version === 'number' ? d.version : PORTABLE_VERSION
  if (version > PORTABLE_VERSION) {
    warnings.push(
      `This file says format version ${version}; this build understands ${PORTABLE_VERSION}. ` +
        `Anything it doesn't recognise has been kept as-is.`
    )
  }
  const test: PortableTest = {
    version,
    name: typeof d.name === 'string' && d.name.trim() ? d.name.trim() : 'Imported test',
    steps: d.steps as Record<string, unknown>[]
  }
  if (typeof d.baseURL === 'string') test.baseURL = d.baseURL
  if (Array.isArray(d.tags)) test.tags = d.tags.map(String)
  if (d.viewport && typeof d.viewport === 'object') {
    test.viewport = d.viewport as { width: number; height: number }
  }
  if (typeof d.deviceId === 'string') test.deviceId = d.deviceId
  if (typeof d.storageState === 'string') test.storageState = d.storageState
  if (typeof d.har === 'string') test.har = d.har
  if (Array.isArray(d.dataRows)) test.dataRows = d.dataRows as Record<string, string>[]
  return { test, steps, warnings }
}

/** The JSON form of the same portable shape — same model, different syntax,
 *  for anyone whose tooling reads JSON more comfortably than YAML. */
export function toPortableJson(test: PortableTest): string {
  return JSON.stringify(test, null, 2) + '\n'
}
