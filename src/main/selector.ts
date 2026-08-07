// =====================================================================
// THE SELECTOR ENGINE
// The observer (preload) only REPORTS raw facts about a clicked/typed
// element — it doesn't decide how to find that element again. That
// decision lives here, in our own controlled code, so we can grow it
// (Day 10 adds the replay fallback ladder + a stability UI).
//
// Given the facts, we build a RANKED list of candidate selectors:
// most-stable first. The top one becomes the step's primary selector;
// the rest are kept as fallbacks for later.
// =====================================================================

// Day 10(b): how many elements on the page matched one locating strategy, and
// which one OURS was (0-based, in DOM order). Counted by the observer AT
// CAPTURE TIME, inside the page — a click can navigate away, so by the time
// these facts reach us there may be no page left to count.
export interface DupInfo {
  count: number
  index: number
}

// The raw facts the observer gathers about an element. Everything optional
// except the tag — real pages are messy and most attributes are absent.
export interface ElementFacts {
  tag: string
  testId?: string // data-test / data-testid — put there FOR testing
  // WHICH attribute held the test id. Needed by the export: Playwright's
  // getByTestId() reads a single configurable attribute (default data-testid).
  testIdAttr?: 'data-test' | 'data-testid'
  id?: string
  name?: string
  role?: string // aria role (explicit, or implied by the tag/type)
  type?: string // input type
  ariaLabel?: string
  title?: string
  placeholder?: string
  text?: string // trimmed visible text
  imgAlt?: string // alt of the element's own / inner image
  inputValue?: string // value of an <input type=submit|button>
  // Per-strategy duplicate info — only present when a strategy matched MORE
  // than one element (absence means "unique", the happy path).
  dup?: Partial<Record<'testId' | 'id' | 'role' | 'name' | 'placeholder' | 'text', DupInfo>>
  // Parent-anchored fallback: when the element has NO hook of its own, the
  // observer scopes a selector to the nearest STABLE ancestor (non-generated
  // id / test id / ARIA landmark) plus this element's position among matches.
  // Computed IN-PAGE (like `dup`) because a click can navigate away first, and
  // its `index` is counted with the SAME deepQueryAll replay uses.
  anchor?: { css: string; count: number; index: number }
}

// How we found the element + how stable that strategy is (0–100).
export interface SelectorCandidate {
  kind: 'testId' | 'id' | 'role' | 'name' | 'placeholder' | 'text' | 'css' | 'anchored'
  score: number
  locator: string // a Playwright-style expression (used by Day 5 export)
  css: string | null // a CSS selector when expressible (used by Day 6 replay)
  // Semantic info for replay to find role/text candidates IN the page — these
  // have no CSS form, so Day 10 replay resolves them by ARIA role + accessible
  // name, or by visible text, the same way Playwright's getByRole/getByText do.
  role?: string // for kind 'role' — the ARIA role
  name?: string // for kind 'role' — the accessible name
  text?: string // for kind 'text' — the visible text
  // for kind 'testId' — the attribute the id came from, so the export can emit
  // `testIdAttribute` (absent on tests recorded before this was captured).
  testIdAttr?: 'data-test' | 'data-testid'
  // Day 10(b): when this strategy matched several elements, which one is ours.
  // A selector that silently matches 5 things is a lie — .nth() makes the
  // ambiguity explicit (and costs score: position is fragile).
  nth?: number
  // Day 10(c): the user hand-picked this candidate in the ladder UI — replay
  // tries it FIRST, regardless of score, and export uses its locator.
  pinned?: boolean
}

export interface BuiltSelector {
  primary: string // top candidate's locator, for convenience
  candidates: SelectorCandidate[] // ranked best-first
}

// Single quotes inside a Playwright string arg must be escaped.
function esc(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

// An id is only useful if a HUMAN gave it a stable name. Auto-generated ids
// (long digit runs, framework hashes, ":r1:") are noise — score them low.
function looksGenerated(id: string): boolean {
  return /\d{4,}/.test(id) || /[a-f0-9]{8,}/i.test(id) || id.includes(':')
}

// `#id` works as a CSS selector only for simple ids; otherwise use [id="..."].
function idToCss(id: string): string {
  return /^[A-Za-z][\w-]*$/.test(id) ? `#${id}` : `[id="${esc(id)}"]`
}

// The "accessible name" — what a user would call this element, used for
// role-/text-based locators.
function accessibleName(f: ElementFacts): string | undefined {
  return f.ariaLabel || f.inputValue || f.imgAlt || f.text || f.title
}

// Day 10(b): if the observer counted MORE than one match for this candidate's
// strategy, make the ambiguity explicit. `.nth(i)` says "the i-th of several"
// out loud (Playwright has the same API), and the score drops 30 points —
// position is fragile: add one row above ours and the selector breaks. A
// duplicated testId (95) now scores below a UNIQUE role locator (80), so the
// ladder naturally prefers strategies that pinpoint exactly one element.
function disambiguate(c: SelectorCandidate, dup?: DupInfo): SelectorCandidate {
  if (!dup || dup.count <= 1 || dup.index < 0) return c
  return {
    ...c,
    nth: dup.index,
    locator: `${c.locator}.nth(${dup.index})`,
    score: Math.max(20, c.score - 30)
  }
}

// === The ladder: turn facts into ranked candidates ===
export function buildSelectors(facts: ElementFacts): BuiltSelector {
  const candidates: SelectorCandidate[] = []
  const name = accessibleName(facts)
  const isField = facts.tag === 'input' || facts.tag === 'select' || facts.tag === 'textarea'
  const dup = facts.dup ?? {}

  // 1. test id — the gold standard, added FOR testing, never restyled away.
  //
  // …unless a machine wrote it. A test id is only a promise of stability when a
  // HUMAN chose the name; React/MUI/Angular emit `data-testid="row-8f3a91cc"`
  // and file lists emit `data-testid="1786087311623_report.txt"`, which change on
  // the next render or the next upload. Those were scoring 95 — above every hook
  // that actually survives — so the recorded test broke for a reason that had
  // nothing to do with the app under test.
  //
  // Same judgement, same function as the `id` rung below (which has demoted
  // generated names since Day 10); it just was never applied here. 45 puts it
  // under role (80), name (70) and text (50) so any real hook wins, while
  // staying above a generated id (40) — a test id was at least placed on purpose.
  if (facts.testId) {
    candidates.push(
      disambiguate(
        {
          kind: 'testId',
          score: looksGenerated(facts.testId) ? 45 : 95,
          locator: `getByTestId('${esc(facts.testId)}')`,
          // Match BOTH conventions — the element may carry data-test OR
          // data-testid (we read either as the test id), and getByTestId in
          // export defaults to data-testid. Mirrors collectDup's both-attr count.
          css: `[data-test="${esc(facts.testId)}"], [data-testid="${esc(facts.testId)}"]`,
          // Which one it actually was — the export declares it via
          // `testIdAttribute` so getByTestId resolves in real Playwright.
          testIdAttr: facts.testIdAttr
        },
        dup.testId
      )
    )
  }

  // 2. id — stable & unique if a human named it; weak if auto-generated.
  if (facts.id) {
    candidates.push(
      disambiguate(
        {
          kind: 'id',
          score: looksGenerated(facts.id) ? 40 : 90,
          locator: `locator('${idToCss(facts.id)}')`,
          css: idToCss(facts.id)
        },
        dup.id
      )
    )
  }

  // 3. role + accessible name — how a USER finds it; survives restyling.
  if (facts.role && name) {
    candidates.push(
      disambiguate(
        {
          kind: 'role',
          score: 80,
          locator: `getByRole('${facts.role}', { name: '${esc(name)}' })`,
          css: null, // not expressible as plain CSS — replay resolves it semantically
          role: facts.role,
          name
        },
        dup.role
      )
    )
  }

  // 4. name attribute — stable for form fields.
  if (facts.name) {
    candidates.push(
      disambiguate(
        {
          kind: 'name',
          score: 70,
          locator: `locator('${facts.tag}[name="${esc(facts.name)}"]')`,
          css: `${facts.tag}[name="${esc(facts.name)}"]`
        },
        dup.name
      )
    )
  }

  // 5. placeholder — decent for inputs, but breaks if copy changes.
  if (facts.placeholder) {
    candidates.push(
      disambiguate(
        {
          kind: 'placeholder',
          score: 65,
          locator: `getByPlaceholder('${esc(facts.placeholder)}')`,
          css: `[placeholder="${esc(facts.placeholder)}"]`
        },
        dup.placeholder
      )
    )
  }

  // 6. visible text — readable, but fragile (copy edits, i18n). Not for fields.
  // STRICTLY facts.text (words actually written on the page) — never alt/aria
  // names: getByText searches text content, so a selector built from an
  // invisible alt ("User Avatar") would be a promise replay can never keep.
  //
  // The cap matches what the observer actually CAPTURES (observerSource.ts:585
  // keeps text up to 100). It used to be 40, which quietly decided what you were
  // allowed to assert on: an element with no id/role/name has text as its only
  // hook, so anything longer than 40 characters got no candidate but the bare tag
  // and the UI refused the check as unreplayable. Ordinary page furniture blew
  // past 40 — "Example of a new window page for Automation Testing Practice" is
  // 59 — so headings, banners, confirmations and validation messages were
  // uncheckable for no reason the tester could see.
  //
  // Widening it only ADDS a fallback where there was none: text scores 50, below
  // id (90), role (80) and name (70), so it still never displaces a better hook.
  if (facts.text && !isField && facts.text.length <= 100) {
    candidates.push(
      disambiguate(
        {
          kind: 'text',
          score: 50,
          locator: `getByText('${esc(facts.text)}')`,
          css: null, // replay resolves this by matching visible text
          text: facts.text
        },
        dup.text
      )
    )
  }

  // 6.5 Parent-anchored — the element has no hook of its OWN, but a stable
  // ANCESTOR does: scope to that ancestor + this element's tag/position. Ranks
  // above the bare-tag last resort, below every real own-hook (so a genuine
  // id/role/name/placeholder/text always wins and this only becomes primary for
  // a truly hookless element). A UNIQUE scoped match is fairly safe; one that
  // needs `.nth` is positional (more fragile → lower score).
  if (facts.anchor) {
    const a = facts.anchor
    const many = a.count > 1
    candidates.push({
      kind: 'anchored',
      score: many ? 45 : 55,
      locator: many ? `locator('${esc(a.css)}').nth(${a.index})` : `locator('${esc(a.css)}')`,
      css: a.css,
      nth: many ? a.index : undefined
    })
  }

  // 7. tag — last resort. Almost certainly not unique, so very low score.
  candidates.push({
    kind: 'css',
    score: 15,
    locator: `locator('${facts.tag}')`,
    css: facts.tag
  })

  candidates.sort((a, b) => b.score - a.score)
  return { primary: candidates[0].locator, candidates }
}

// === The human label — a short sentence-ready name for the step list ===
function humanize(slug: string): string {
  return slug.replace(/[-_]+/g, ' ').trim()
}

export function labelFrom(facts: ElementFacts): string {
  if (facts.ariaLabel) return facts.ariaLabel
  if (facts.title) return facts.title
  if (facts.inputValue) return facts.inputValue
  if (facts.imgAlt) return facts.imgAlt
  // visible text, but ignore bare numbers (e.g. a cart badge "1")
  if (facts.text && !/^\d+$/.test(facts.text)) {
    return facts.text.length <= 40 ? facts.text : `${facts.text.slice(0, 40)}…`
  }
  if (facts.placeholder) return facts.placeholder
  const slug = facts.testId || facts.name || facts.id
  if (slug) return humanize(slug)
  return facts.tag
}
