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

// The raw facts the observer gathers about an element. Everything optional
// except the tag — real pages are messy and most attributes are absent.
export interface ElementFacts {
  tag: string
  testId?: string // data-test / data-testid — put there FOR testing
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
}

// How we found the element + how stable that strategy is (0–100).
export interface SelectorCandidate {
  kind: 'testId' | 'id' | 'role' | 'name' | 'placeholder' | 'text' | 'css'
  score: number
  locator: string // a Playwright-style expression (used by Day 5 export)
  css: string | null // a CSS selector when expressible (used by Day 6 replay)
  // Semantic info for replay to find role/text candidates IN the page — these
  // have no CSS form, so Day 10 replay resolves them by ARIA role + accessible
  // name, or by visible text, the same way Playwright's getByRole/getByText do.
  role?: string // for kind 'role' — the ARIA role
  name?: string // for kind 'role' — the accessible name
  text?: string // for kind 'text' — the visible text
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

// === The ladder: turn facts into ranked candidates ===
export function buildSelectors(facts: ElementFacts): BuiltSelector {
  const candidates: SelectorCandidate[] = []
  const name = accessibleName(facts)
  const isField = facts.tag === 'input' || facts.tag === 'select' || facts.tag === 'textarea'

  // 1. test id — the gold standard, added FOR testing, never restyled away.
  if (facts.testId) {
    candidates.push({
      kind: 'testId',
      score: 95,
      locator: `getByTestId('${esc(facts.testId)}')`,
      css: `[data-test="${esc(facts.testId)}"]`
    })
  }

  // 2. id — stable & unique if a human named it; weak if auto-generated.
  if (facts.id) {
    candidates.push({
      kind: 'id',
      score: looksGenerated(facts.id) ? 40 : 90,
      locator: `locator('${idToCss(facts.id)}')`,
      css: idToCss(facts.id)
    })
  }

  // 3. role + accessible name — how a USER finds it; survives restyling.
  if (facts.role && name) {
    candidates.push({
      kind: 'role',
      score: 80,
      locator: `getByRole('${facts.role}', { name: '${esc(name)}' })`,
      css: null, // not expressible as plain CSS — replay resolves it semantically
      role: facts.role,
      name
    })
  }

  // 4. name attribute — stable for form fields.
  if (facts.name) {
    candidates.push({
      kind: 'name',
      score: 70,
      locator: `locator('${facts.tag}[name="${esc(facts.name)}"]')`,
      css: `${facts.tag}[name="${esc(facts.name)}"]`
    })
  }

  // 5. placeholder — decent for inputs, but breaks if copy changes.
  if (facts.placeholder) {
    candidates.push({
      kind: 'placeholder',
      score: 65,
      locator: `getByPlaceholder('${esc(facts.placeholder)}')`,
      css: `[placeholder="${esc(facts.placeholder)}"]`
    })
  }

  // 6. visible text — readable, but fragile (copy edits, i18n). Not for fields.
  if (name && !isField && name.length <= 40) {
    candidates.push({
      kind: 'text',
      score: 50,
      locator: `getByText('${esc(name)}')`,
      css: null, // replay resolves this by matching visible text
      text: name
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
