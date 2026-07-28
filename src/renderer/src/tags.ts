// =====================================================================
// F38 — TAGS (@smoke / @regression / @checkout)
//
// == Why this is not the same thing as a suite ==
//
// A test lives in exactly ONE suite (the folder it's saved in — E2E, Daily).
// A test can carry MANY tags. That's the entire difference, and it's the reason
// both exist rather than one replacing the other:
//
//   suite  answers "where does this test live?"      → one answer, a filing system
//   tags   answer  "what is this test FOR?"          → many answers, cross-cutting
//
// The login test belongs in E2E. It's also @smoke (run it on every commit),
// @auth (the area it covers), and @critical (block a release if it fails). No
// folder structure can express that without duplicating the test, which is how
// suites quietly rot into "E2E-smoke", "E2E-smoke-critical" and so on.
//
// The payoff is selection: "run everything tagged @smoke" is a 90-second
// pre-merge check across a 500-test library, without maintaining a second list
// of which tests those are.
// =====================================================================

/** Tags we suggest in the editor. Not a fixed set — any tag can be typed. */
export const SUGGESTED_TAGS = [
  '@smoke',
  '@regression',
  '@critical',
  '@slow',
  '@flaky-watch',
  '@auth',
  '@checkout'
]

/**
 * Clean one tag into its canonical form.
 *
 * Always leading-@, lowercase, no spaces. Playwright's own tag convention is
 * `@name`, and `--grep @smoke` is a plain substring match — so "@Smoke" and
 * "@smoke" would be two different tags to the filter while looking identical to
 * a human. Normalising on the way IN means that can never happen.
 *
 * Returns '' for anything that isn't a usable tag, so callers can filter it out.
 */
export function normalizeTag(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9@\-_]+/g, '-') // spaces/punctuation → hyphen
    .replace(/^-+|-+$/g, '')
    .replace(/^@+/, '') // collapse any number of leading @
    .replace(/-+/g, '-')
  if (!cleaned) return ''
  return `@${cleaned}`.slice(0, 40)
}

/** Parse a free-text field ("@smoke, @auth  @critical") into clean tags. */
export function parseTags(input: string): string[] {
  const out: string[] = []
  for (const part of input.split(/[\s,]+/)) {
    const tag = normalizeTag(part)
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out
}

/** Every distinct tag across the library, most-used first then alphabetical —
 *  so the filter bar leads with the tags actually worth clicking. */
export function allTags(tests: { tags?: string[] }[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const t of tests) {
    for (const tag of t.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

/**
 * Does this test match the selected tags?
 *
 * Multi-select is AND, not OR. "@smoke + @checkout" means "the smoke tests for
 * checkout" — a narrowing filter, which is what every other filter in this
 * library does (search AND status AND category). An OR would widen the set as
 * you click more, which reads as broken.
 */
export function matchesTags(test: { tags?: string[] }, selected: Set<string>): boolean {
  if (selected.size === 0) return true
  const own = test.tags ?? []
  for (const want of selected) if (!own.includes(want)) return false
  return true
}
