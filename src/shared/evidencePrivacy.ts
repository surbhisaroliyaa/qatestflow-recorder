// =====================================================================
// EVIDENCE PRIVACY  (Phase 4, audit gap: "evidence-privacy UX")
// =====================================================================
// THE PROBLEM
//
// This app's best idea is that every run leaves evidence: a screenshot per
// step, the page's HTML, the console, the network, a video. That evidence is
// exactly what makes a failure explicable — and it is also a perfect copy of
// whatever was on the screen at the time.
//
// On a staging environment seeded with real data, that is real customers'
// names, emails, order numbers and card fragments, written to disk in a folder
// the user shares, attaches to bug reports and commits. The tester never chose
// that; it is just what "capture everything" means. And it is the single
// reason a security-conscious team cannot adopt a tool like this.
//
// == What this module does, and where ==
//
// One POLICY, applied everywhere evidence is written, rather than a setting
// per artifact:
//   · redact()          — text: the DOM capture, console lines, network lines,
//                         step descriptions, bug reports
//   · maskSelectors     — regions painted over in captured screenshots
//   · captureDom: false — the biggest carrier of all, turned off wholesale
//
// == Why patterns AND selectors, rather than one of them ==
//
// They fail in opposite directions, so neither is sufficient alone. A selector
// is precise but only covers what you knew to name — the customer name in the
// header, not the same name in a toast that appeared during the run. A pattern
// catches the shape of a thing wherever it appears, but cannot know that
// "Priya Sharma" is a name. Together they cover most of it; separately each
// leaves an obvious hole.
//
// == What this is NOT ==
//
// It is not a guarantee, and this module should never be described as one. A
// screenshot is pixels: text baked into an image that no selector covers stays
// readable. The honest claim is "materially less leakage, under your control",
// and the UI says exactly that rather than implying the evidence is now safe
// to publish.
// =====================================================================

export interface PrivacySettings {
  /** Apply the built-in patterns below (emails, card-like numbers, tokens). */
  builtins: boolean
  /** User regexes, one per line. Anything that doesn't compile is ignored
   *  rather than throwing — a typo in a settings box must not break capture. */
  patterns: string
  /** CSS selectors whose regions are painted over in captured screenshots,
   *  one per line or comma-separated. The same syntax F15's per-snapshot
   *  `maskSelectors` uses, deliberately — one idea, one vocabulary. */
  maskSelectors: string
  /** Capture the page's HTML into the trace at all. The single biggest PII
   *  carrier in the whole evidence set, because it is the literal data. */
  captureDom: boolean
}

export const DEFAULT_PRIVACY: PrivacySettings = {
  // Off by default. This is a deliberate choice, not an oversight: redaction
  // that surprises you is worse than none, because a tester who doesn't know
  // it is on will read "[redacted]" in a failure and chase a bug that isn't
  // there. It is opt-in, and the UI says what it will do before it does it.
  builtins: false,
  patterns: '',
  maskSelectors: '',
  captureDom: true
}

/** What a redacted span is replaced with. Fixed-width and obviously
 *  artificial, so nobody reads it as a value the app produced. */
export const REDACTED = '[redacted]'

/**
 * The built-in patterns.
 *
 * Chosen to be things with an unmistakable SHAPE — where matching is a
 * judgement about syntax, not about meaning. A pattern for "names" would be a
 * pattern for "words", and would turn every failure message into noise.
 *
 * Order matters: the longest, most specific shapes run first, so a JWT is
 * redacted as a JWT rather than being partially eaten by the digit rule.
 */
export const BUILTIN_PATTERNS: { name: string; re: RegExp }[] = [
  // A bearer token / JWT: three base64url segments separated by dots.
  { name: 'token', re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g },
  // `Authorization: Bearer …` and friends, including the header name, because
  // the value alone is not always shaped distinctively.
  { name: 'auth-header', re: /\b(authorization|api[-_]?key|x-api-key)\s*[:=]\s*\S+/gi },
  // An email address. Deliberately loose on the local part — real addresses
  // contain plus-tags, dots and apostrophes.
  { name: 'email', re: /\b[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // A payment-card-like run of 13–19 digits, allowing spaces or hyphens in the
  // usual grouping. Not a Luhn check: this is about not writing the number
  // down, and a number that fails Luhn is still a number someone typed.
  { name: 'card', re: /\b(?:\d[ -]?){13,19}\b/g }
]

/** Compile the user's own patterns, dropping any that don't parse. */
export function userPatterns(settings: PrivacySettings): RegExp[] {
  const out: RegExp[] = []
  for (const line of (settings.patterns ?? '').split('\n')) {
    const src = line.trim()
    if (!src) continue
    try {
      out.push(new RegExp(src, 'g'))
    } catch {
      // A half-typed regex in a settings box is the normal state of a settings
      // box. Ignoring it keeps capture working; the UI flags it separately.
    }
  }
  return out
}

/** Is this a usable regex? Used by the settings UI to flag a typo AS a typo,
 *  rather than silently doing nothing and leaving the user believing they are
 *  covered — which is the dangerous failure for a privacy feature. */
export function isValidPattern(source: string): boolean {
  try {
    new RegExp(source)
    return true
  } catch {
    return false
  }
}

/**
 * Redact one piece of text.
 *
 * Returns the input unchanged when nothing is configured, so the no-policy
 * path costs a boolean check — this runs over every console line of every step
 * of every run.
 */
export function redact(text: string, settings: PrivacySettings): string {
  if (!text) return text
  const patterns = [
    ...(settings.builtins ? BUILTIN_PATTERNS.map((p) => p.re) : []),
    ...userPatterns(settings)
  ]
  if (!patterns.length) return text
  let out = text
  for (const re of patterns) {
    // A fresh RegExp per use: a /g regex carries lastIndex, and a shared one
    // would skip matches on every other call. This bug does not fail loudly —
    // it just silently leaves some of the data in, which for a privacy feature
    // is the worst possible way to be wrong.
    out = out.replace(new RegExp(re.source, re.flags), REDACTED)
  }
  return out
}

/** Redact a list, dropping nothing — a redacted line is still a line, and the
 *  count of console errors is itself evidence. */
export function redactAll(lines: string[], settings: PrivacySettings): string[] {
  if (!lines?.length) return lines ?? []
  return lines.map((l) => redact(l, settings))
}

/** Is any part of the policy actually doing something? Drives the "evidence is
 *  being redacted" indicator, which has to be visible during a run — a tester
 *  reading `[redacted]` in a failure needs to know why it's there. */
export function privacyActive(settings: PrivacySettings): boolean {
  return (
    settings.builtins ||
    userPatterns(settings).length > 0 ||
    selectorList(settings.maskSelectors).length > 0 ||
    !settings.captureDom
  )
}

/** Split a mask-selector field into selectors. Accepts newline- or
 *  comma-separated input, like F15's per-step masks. */
export function selectorList(raw: string): string[] {
  return (raw ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * A one-line, plain description of what this policy will do — shown before it
 * is switched on, because a privacy feature that surprises you is worse than
 * no privacy feature at all.
 */
export function describePrivacy(settings: PrivacySettings): string {
  const parts: string[] = []
  // WHERE each kind of setting actually reaches. This used to be one hardcoded
  // tail — "from screenshots, page HTML, console and network" — printed
  // whatever was switched on. With only text patterns set it claimed to be
  // redacting SCREENSHOTS, which text patterns cannot touch: a screenshot is
  // pixels, and the only thing that covers it is a mask selector.
  //
  // Surbhi read that sentence, checked a screenshot, found her username in it
  // and asked what the point of the feature was. That is the correct response
  // to a privacy summary that overstates its reach, and it is a worse failure
  // than the gap itself: a claim you trust stops you checking.
  const surfaces = new Set<string>()
  if (settings.builtins) {
    parts.push('emails, card numbers and tokens')
  }
  const extra = userPatterns(settings).length
  if (extra) parts.push(`${extra} pattern${extra === 1 ? '' : 's'} of your own`)
  // Text redaction rewrites text. It never reaches an image.
  if (settings.builtins || extra) {
    surfaces.add('page HTML')
    surfaces.add('console')
    surfaces.add('network')
    // Round 8: the step titles are listed because they are the surface the
    // summary is read NEXT TO. Leaving them out of the sentence while they
    // were also left out of the redaction is what made a working policy look
    // like it had done nothing at all.
    surfaces.add('step titles')
  }
  const sels = selectorList(settings.maskSelectors).length
  if (sels) {
    parts.push(`${sels} screen region${sels === 1 ? '' : 's'}`)
    surfaces.add('screenshots')
  }
  if (!settings.captureDom) {
    parts.push('no page HTML saved at all')
    // Not a surface something is redacted "from" — the file stops existing.
    surfaces.delete('page HTML')
  }
  if (!parts.length) return 'Evidence is captured in full — nothing is redacted.'
  const where = [...surfaces]
  const list =
    where.length > 1 ? `${where.slice(0, -1).join(', ')} and ${where[where.length - 1]}` : where[0]
  return where.length
    ? `Redacting ${parts.join(', ')} from ${list}.`
    : `Redacting ${parts.join(', ')}.`
}
