// =====================================================================
// F8 — "WHAT CHANGED SINCE LAST GREEN RUN"
// When a step fails, we compare the page NOW against a snapshot from the
// last run where this test passed, and report what's different — so a human
// can tell "the app changed" (text/element moved or renamed) from "same page,
// flaky/timing". Pure logic: main captures the snapshots + stores the green
// baseline; this just diffs two snapshots.
//
// A "page-level" diff by design (v1): visible TEXT lines + a list of notable
// ELEMENTS and their attributes — the actionable stuff — not a pixel or full
// DOM-tree diff.
// =====================================================================

export interface PageSnapshot {
  url: string
  lines: string[] // visible text, one entry per innerText line (trimmed, non-empty)
  elements: Array<Record<string, string>> // notable els: {tag, id?, role?, text?, href?, ...}
}

export interface ElementChange {
  desc: string // human description of the element ("<button> \"Checkout\"")
  changes: string[] // ["id: \"submit\" → \"submit-btn\"", "text: \"Login\" → \"Log in\""]
}

export interface DomDiff {
  hasChanges: boolean
  baselineAt?: string // when the green baseline was captured
  urlChanged?: { from: string; to: string }
  textRemoved: string[] // was on the page when green, gone now
  textAdded: string[] // on the page now, wasn't when green
  elementsRemoved: string[] // element descriptions present when green, gone now
  elementsAdded: string[] // present now, weren't when green
  elementsChanged: ElementChange[] // same element, different attributes/text
}

// A stable-ish identity for matching an element across the two snapshots:
// prefer id / data-test, else tag + its most identifying attribute.
function elKey(e: Record<string, string>): string {
  if (e.id) return `#${e.id}`
  if (e['data-test']) return `dt:${e['data-test']}`
  if (e['data-testid']) return `dt:${e['data-testid']}`
  const tag = e.tag || 'el'
  const label = e['aria-label'] || e.name || e.href || e.text || e.placeholder || ''
  return `${tag}|${label}`
}

function elDesc(e: Record<string, string>): string {
  const tag = e.tag || 'el'
  const id = e.id ? ` #${e.id}` : ''
  const dt = e['data-test'] || e['data-testid']
  const dtStr = dt ? ` [data-test=${dt}]` : ''
  const txt = e.text ? ` "${e.text.slice(0, 40)}"` : ''
  return `<${tag}${id}${dtStr}>${txt}`
}

// The attribute keys worth comparing when the SAME element differs.
const COMPARE_ATTRS = [
  'id',
  'role',
  'aria-label',
  'name',
  'type',
  'placeholder',
  'href',
  'value',
  'title',
  'text',
  'data-test',
  'data-testid'
]

function attrChanges(before: Record<string, string>, after: Record<string, string>): string[] {
  const out: string[] = []
  for (const k of COMPARE_ATTRS) {
    const a = before[k]
    const b = after[k]
    if (a === b) continue
    if (a && b) out.push(`${k}: "${a.slice(0, 50)}" → "${b.slice(0, 50)}"`)
    else if (a && !b) out.push(`${k} removed (was "${a.slice(0, 50)}")`)
    else if (!a && b) out.push(`${k} added ("${b.slice(0, 50)}")`)
  }
  return out
}

const CAP = 25 // never flood the panel — cap each list

export function diffSnapshots(green: PageSnapshot, now: PageSnapshot, baselineAt?: string): DomDiff {
  const greenLines = new Set(green.lines)
  const nowLines = new Set(now.lines)
  const textRemoved = green.lines.filter((l) => !nowLines.has(l)).slice(0, CAP)
  const textAdded = now.lines.filter((l) => !greenLines.has(l)).slice(0, CAP)

  const greenByKey = new Map<string, Record<string, string>>()
  for (const e of green.elements) if (!greenByKey.has(elKey(e))) greenByKey.set(elKey(e), e)
  const nowByKey = new Map<string, Record<string, string>>()
  for (const e of now.elements) if (!nowByKey.has(elKey(e))) nowByKey.set(elKey(e), e)

  const removedEls: Record<string, string>[] = []
  const addedEls: Record<string, string>[] = []
  const elementsChanged: ElementChange[] = []

  // Pass 1 — match by primary key (id / data-test / tag+label).
  for (const [k, e] of greenByKey) {
    const match = nowByKey.get(k)
    if (!match) removedEls.push(e)
    else {
      const changes = attrChanges(e, match)
      if (changes.length) elementsChanged.push({ desc: elDesc(match), changes })
    }
  }
  for (const [k, e] of nowByKey) if (!greenByKey.has(k)) addedEls.push(e)

  // Pass 2 — reconcile a RENAMED element (the common break: an id/data-test was
  // renamed but it's the same element). It shows up as one removed + one added;
  // re-pair them when they share a strong identity signal (exact visible text, or
  // exact aria-label / name / href) so it reads as a CHANGE ("id: a → b"), not a
  // disappear + appear. Requires an exact signal to avoid false pairings.
  const sameElement = (a: Record<string, string>, b: Record<string, string>): boolean => {
    if (a.tag !== b.tag) return false
    for (const k of ['text', 'aria-label', 'name', 'href']) {
      if (a[k] && b[k] && a[k] === b[k]) return true
    }
    return false
  }
  const addedUsed = new Set<number>()
  const elementsRemoved: string[] = []
  for (const r of removedEls) {
    let pair = -1
    for (let i = 0; i < addedEls.length; i++) {
      if (!addedUsed.has(i) && sameElement(r, addedEls[i])) {
        pair = i
        break
      }
    }
    if (pair >= 0) {
      addedUsed.add(pair)
      const changes = attrChanges(r, addedEls[pair])
      if (changes.length) elementsChanged.push({ desc: elDesc(addedEls[pair]), changes })
    } else {
      elementsRemoved.push(elDesc(r))
    }
  }
  const elementsAdded: string[] = addedEls
    .filter((_, i) => !addedUsed.has(i))
    .map((e) => elDesc(e))

  const urlChanged = green.url !== now.url ? { from: green.url, to: now.url } : undefined

  const hasChanges =
    !!urlChanged ||
    textRemoved.length > 0 ||
    textAdded.length > 0 ||
    elementsRemoved.length > 0 ||
    elementsAdded.length > 0 ||
    elementsChanged.length > 0

  return {
    hasChanges,
    baselineAt,
    urlChanged,
    textRemoved,
    textAdded,
    elementsRemoved: elementsRemoved.slice(0, CAP),
    elementsAdded: elementsAdded.slice(0, CAP),
    elementsChanged: elementsChanged.slice(0, CAP)
  }
}
