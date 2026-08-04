// =====================================================================
// "SAVE FROM RESPONSE" LINE VALIDATION (F24.1)
// Shared by main (which parses the spec at run time) and the renderer (which
// warns while you're still typing). One meaning, one implementation — the
// codebase has been bitten more than once by the same rule living in two places
// and only one of them getting the fix.
//
// WHY THIS EXISTS: the API editor stacks two identical-looking textareas —
// "Response checks" (`path op value`) and "Save from response" (`name = path`).
// A check typed into the save box (`id not-empty`) was silently DROPPED by the
// parser: no '=', so it was skipped without a word. The step went green, the
// export emitted nothing, and every layer looked correct while the assertion
// never existed. Silence is the bug; this module is what breaks it.
// =====================================================================

/** Operators the "Response checks" box understands (mirrors apiChecks.ts). */
const CHECK_OPS = new Set([
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
])

export interface BadSaveLine {
  line: string
  /** Names a check operator — almost certainly meant for the box above. */
  looksLikeCheck: boolean
}

/**
 * Lines that are NOT valid `name = path`, so a caller can report them.
 * Blank lines and `#` comments are ignored, as the parser ignores them.
 */
export function invalidSaveLines(text?: string): BadSaveLine[] {
  if (!text) return []
  const bad: BadSaveLine[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    const name = eq > 0 ? line.slice(0, eq).trim() : ''
    const path = eq > 0 ? line.slice(eq + 1).trim() : ''
    if (name && path) continue // valid
    bad.push({
      line,
      looksLikeCheck: line.split(/\s+/).some((w) => CHECK_OPS.has(w.toLowerCase()))
    })
  }
  return bad
}

/** The message to show for those lines — names the likely mix-up when it can. */
export function saveSpecWarning(text?: string): string {
  const bad = invalidSaveLines(text)
  if (!bad.length) return ''
  const quoted = bad.map((b) => `“${b.line}”`).join(', ')
  const plural = bad.length === 1 ? 'This line is' : 'These lines are'
  if (bad.some((b) => b.looksLikeCheck)) {
    return `${plural} ignored: ${quoted}. That looks like a response CHECK — it belongs in the “Response checks” box above. This box saves a value for later, as name = path (e.g. orderId = id).`
  }
  return `${plural} ignored: ${quoted}. This box needs name = path — e.g. orderId = id.`
}
