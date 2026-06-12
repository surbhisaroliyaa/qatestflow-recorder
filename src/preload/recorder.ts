import { ipcRenderer } from 'electron'
// Type-only import (erased at build time) so the facts we send and the facts
// the selector engine receives can never drift apart.
import type { DupInfo, ElementFacts } from '../main/selector'

// =====================================================================
// THE OBSERVER
// Injected INTO every web page the embedded browser loads. When recording
// is ON, it reports each click / typed field back to the app via IPC.
//
// IMPORTANT: the observer is deliberately DUMB. It does NOT decide how to
// locate an element — it just reports the raw FACTS it can see. The
// selector engine in the main process turns those facts into a ranked
// selector ladder (see src/main/selector.ts). Keeping the page-injected
// code minimal is intentional: the brains live in our controlled code.
// =====================================================================

let recording = false

// Timestamp (ms) until which the next click should be ignored. Pressing Enter
// in a form makes the browser auto-fire a click on the submit button (implicit
// form submission); we record the Enter as a `press` step, so we suppress that
// synthesized click to avoid recording the same gesture twice.
let suppressClickUntil = 0

// The app flips this on/off when the user presses the Record button.
ipcRenderer.on('recorder:set-active', (_event, active: boolean): void => {
  recording = active
})

// === Day 9: ELEMENT PICKER ==========================================
// Pick mode turns the next click into pure POINTING: we highlight what's
// under the cursor, and on click we stop the event dead (capture phase, so
// the page never reacts and no click step is recorded) and just report the
// element's facts. Used for assertions today; reused by Recovery on Day 12.

let picking = false

// One reusable highlight box, drawn over whatever the cursor is on.
let highlightBox: HTMLDivElement | null = null

function moveHighlight(el: Element): void {
  if (!highlightBox) {
    highlightBox = document.createElement('div')
    highlightBox.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;' +
      'border:2px solid #58a6ff;background:rgba(88,166,255,0.15);border-radius:2px;'
    document.documentElement.appendChild(highlightBox)
  }
  const r = el.getBoundingClientRect()
  highlightBox.style.left = `${r.left - 2}px`
  highlightBox.style.top = `${r.top - 2}px`
  highlightBox.style.width = `${r.width}px`
  highlightBox.style.height = `${r.height}px`
}

function clearHighlight(): void {
  highlightBox?.remove()
  highlightBox = null
}

ipcRenderer.on('recorder:set-picking', (_event, active: boolean): void => {
  picking = active
  if (!picking) clearHighlight()
})

document.addEventListener(
  'mouseover',
  (event) => {
    if (!picking) return
    const target = event.target as Element | null
    if (target) moveHighlight(meaningfulTarget(target))
  },
  true
)

document.addEventListener(
  'keydown',
  (event) => {
    if (!picking || event.key !== 'Escape') return
    event.preventDefault()
    event.stopImmediatePropagation()
    picking = false
    clearHighlight()
    ipcRenderer.send('recorder:pick-cancel')
  },
  true
)

// Map an <input type> to its ARIA role so the engine can offer a role locator.
function inputRole(type: string): string | undefined {
  switch (type) {
    case 'submit':
    case 'button':
    case 'reset':
    case 'image':
      return 'button'
    case 'checkbox':
      return 'checkbox'
    case 'radio':
      return 'radio'
    case 'text':
    case 'email':
    case 'password':
    case 'search':
    case 'tel':
    case 'url':
    case 'number':
      return 'textbox'
    default:
      return undefined
  }
}

// The element's ARIA role: explicit role="" wins, else implied by the tag.
function roleFor(el: Element): string | undefined {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit
  switch (el.tagName.toLowerCase()) {
    case 'a':
      return el.hasAttribute('href') ? 'link' : undefined
    case 'button':
      return 'button'
    case 'select':
      return 'combobox'
    case 'textarea':
      return 'textbox'
    case 'input':
      return inputRole((el as HTMLInputElement).type)
    case 'img':
      // Images are found BY THEIR ALT TEXT via getByRole('img', { name }) —
      // alt is invisible on the page, so it must NOT become a text selector.
      return 'img'
    default:
      return undefined
  }
}

// === Day 10(b): duplicate counting ===================================
// A selector that matches FIVE elements silently acts on the first one — a
// false pass waiting to happen. So while we're still standing on the live page
// (a click may navigate away a millisecond later!), we count, for each
// strategy, how many elements match and which one ours is. The selector
// engine turns "count > 1" into an explicit .nth(index).
//
// MIRROR WARNING: the byRole / byText counting here MUST stay in sync with how
// replay RESOLVES those candidates (resolverHelpers in src/main/replay.ts).
// If capture counts a different list than replay walks, .nth(i) points at the
// wrong element. Change one → change both.

const norm = (s: string | null | undefined): string => (s || '').replace(/\s+/g, ' ').trim()

// Same role → CSS approximation table as replay's resolver.
const ROLE_SELECTORS: Record<string, string> = {
  button: 'button, [role=button], input[type=submit], input[type=button], input[type=reset]',
  link: 'a[href], [role=link]',
  textbox:
    'input:not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]), textarea, [role=textbox], [contenteditable=""], [contenteditable=true]',
  combobox: 'select, [role=combobox]',
  checkbox: 'input[type=checkbox], [role=checkbox]',
  radio: 'input[type=radio], [role=radio]',
  img: 'img, [role=img]'
}

// Mirror of replay's accName(): roughly what a user would call the element.
function accNameOf(el: Element): string {
  const aria = el.getAttribute('aria-label')
  if (aria) return norm(aria)
  if (el instanceof HTMLInputElement && /^(submit|button|reset)$/i.test(el.type) && el.value) {
    return norm(el.value)
  }
  if (el instanceof HTMLImageElement && el.alt) return norm(el.alt)
  const innerImg = el.querySelector('img[alt]') as HTMLImageElement | null
  if (innerImg && innerImg.alt) return norm(innerImg.alt)
  const text = norm(el.textContent)
  if (text) return text
  const title = el.getAttribute('title')
  return title ? norm(title) : ''
}

function queryAll(selector: string): Element[] {
  try {
    return Array.from(document.querySelectorAll(selector))
  } catch {
    return [] // malformed selector — no info is better than wrong info
  }
}

// All elements a role+name candidate matches, in DOM order — exact-name
// matches win; only if there are none do we fall back to "name contains".
function roleMatches(role: string, name: string): Element[] {
  const nodes = queryAll(ROLE_SELECTORS[role] || `[role=${role}]`)
  const want = norm(name)
  if (!want) return nodes
  const exact = nodes.filter((n) => accNameOf(n) === want)
  if (exact.length) return exact
  return nodes.filter((n) => accNameOf(n).includes(want))
}

// All elements a visible-text candidate matches: same trimmed text, keeping
// only the INNERMOST of nested matches (an <a> and the <span> inside it both
// "contain" the text — the span is the specific one).
function textMatches(text: string): Element[] {
  const want = norm(text)
  if (!want) return []
  const nodes = queryAll(
    // Must cover every tag capture can take text from — collectFacts prefers
    // inner headings up to h6, so h5/h6 MUST be searchable here too.
    'a, button, [role=button], [role=link], label, span, li, p, td, th, h1, h2, h3, h4, h5, h6, div'
  )
  const matches = nodes.filter((n) => norm(n.textContent) === want)
  return matches.filter((m) => !matches.some((other) => other !== m && m.contains(other)))
}

// Escape a value for use inside [attr="..."] in a CSS selector.
function attrEsc(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// Count duplicates for every strategy the facts support. Only strategies with
// MORE than one match are reported — absence means "unique".
function collectDup(el: Element, facts: ElementFacts): void {
  const dup: NonNullable<ElementFacts['dup']> = {}
  const note = (
    key: keyof NonNullable<ElementFacts['dup']>,
    list: Element[],
    index: number
  ): void => {
    if (list.length > 1 && index >= 0) dup[key] = { count: list.length, index } satisfies DupInfo
  }

  if (facts.testId) {
    const list = queryAll(
      `[data-test="${attrEsc(facts.testId)}"], [data-testid="${attrEsc(facts.testId)}"]`
    )
    note('testId', list, list.indexOf(el))
  }
  if (facts.id) {
    // ids SHOULD be unique — but real sites duplicate them all the time.
    const list = queryAll(`[id="${attrEsc(facts.id)}"]`)
    note('id', list, list.indexOf(el))
  }
  if (facts.name) {
    const list = queryAll(`${facts.tag}[name="${attrEsc(facts.name)}"]`)
    note('name', list, list.indexOf(el))
  }
  if (facts.placeholder) {
    const list = queryAll(`[placeholder="${attrEsc(facts.placeholder)}"]`)
    note('placeholder', list, list.indexOf(el))
  }
  // The ROLE candidate is built from the engine's accessibleName(facts)
  // priority — mirror that exact value here, or we'd count a different list
  // than the candidate will match.
  const name = facts.ariaLabel || facts.inputValue || facts.imgAlt || facts.text || facts.title
  if (facts.role && name) {
    const list = roleMatches(facts.role, name)
    note('role', list, list.indexOf(el))
  }
  // The TEXT candidate is built strictly from facts.text (words actually on
  // the page) — count with the same value.
  if (facts.text) {
    const list = textMatches(facts.text)
    // The innermost text match may be a child of the element we recorded
    // (the <span> inside our <button>) — count containment as "ours".
    note(
      'text',
      list,
      list.findIndex((m) => m === el || el.contains(m) || m.contains(el))
    )
  }

  if (Object.keys(dup).length) facts.dup = dup
}

// Gather the raw facts the selector engine needs. All optional but `tag`.
function collectFacts(el: Element): ElementFacts {
  const facts: ElementFacts = { tag: el.tagName.toLowerCase() }

  const testId = el.getAttribute('data-test') || el.getAttribute('data-testid')
  if (testId) facts.testId = testId
  if (el.id) facts.id = el.id

  const name = el.getAttribute('name')
  if (name) facts.name = name

  const role = roleFor(el)
  if (role) facts.role = role

  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel) facts.ariaLabel = ariaLabel.trim()

  const title = el.getAttribute('title')
  if (title) facts.title = title.trim()

  const placeholder = el.getAttribute('placeholder')
  if (placeholder) facts.placeholder = placeholder

  if (el instanceof HTMLInputElement) {
    facts.type = el.type
    if ((el.type === 'submit' || el.type === 'button' || el.type === 'reset') && el.value) {
      facts.inputValue = el.value
    }
  }

  // A <select>'s textContent is just ALL its options glued together
  // ("Name (A to Z)Name (Z to A)Price…") — useless as a name/label. Skip it
  // and let the selector engine fall back to testId / name / aria instead.
  if (el.tagName.toLowerCase() !== 'select') {
    // Prefer a heading INSIDE the element if there is one: a search-result link
    // wraps an <h3> title plus a long URL + description, so the whole link's
    // text is too long to use — but the <h3> alone is a clean, usable name.
    const heading = el.querySelector('h1, h2, h3, h4, h5, h6')
    const text = ((heading && heading.textContent) || el.textContent || '')
      .trim()
      .replace(/\s+/g, ' ')
    if (text && text.length <= 100) facts.text = text
  }

  // An image's alt text — covers clicking a product/cart image.
  if (el instanceof HTMLImageElement && el.alt) {
    facts.imgAlt = el.alt.trim()
  } else {
    const img = el.querySelector('img[alt]') as HTMLImageElement | null
    if (img && img.alt) facts.imgAlt = img.alt.trim()
  }

  // Day 10(b): count duplicates NOW, while the page still exists.
  collectDup(el, facts)

  return facts
}

// You often click the text/icon INSIDE a button — climb up to the real target.
function meaningfulTarget(start: Element): Element {
  return start.closest('a, button, input, select, textarea, [role="button"], [data-test]') || start
}

// === Day 10(d): smart hover detection ================================
// Naive recorders either spam a step for every mouse twitch or ignore hover
// entirely (and then replay fails on hover-menus). We do neither: hover is
// only interesting when something you CLICK was revealed by it — so we check
// exactly once, at click time.
//
// The trick: you can't ask CSS "would this be visible if nothing were
// hovered?" — but a CLONE has no :hover state. We clone the element's page
// branch into a hidden off-screen box, walk down to the same element in the
// clone, and read its computed styles there. Hidden in the clone + visible
// live = hover-revealed. The hover TRIGGER is the deepest ancestor that is
// still visible in the clone (the card you point at, not the hidden caption).
//
// Limitation (accepted): JS-driven menus that toggle a class on hover keep
// that class in the clone, so they look "always visible" and we record no
// hover — Phase-2 hardening territory. Pure CSS :hover reveals (the common
// case) are caught.
function findHoverTrigger(el: Element): Element | null {
  // The branch to clone: el's ancestor that sits directly under <body>. Cloning
  // high keeps descendant CSS rules (".figure .figcaption {…}") applying to
  // the clone; cloning just the element would rip it out of selector context.
  let top: Element = el
  while (top.parentElement && top.parentElement !== document.body) top = top.parentElement
  if (!top.parentElement || top === el) return null

  // Child-index path from `top` down to `el`, so we can walk the same path in
  // the clone.
  const path: number[] = []
  for (let n: Element = el; n !== top; ) {
    const parent = n.parentElement
    if (!parent) return null
    path.unshift(Array.prototype.indexOf.call(parent.children, n))
    n = parent
  }

  const box = document.createElement('div')
  box.style.cssText =
    'position:fixed;left:-99999px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;'
  box.appendChild(top.cloneNode(true))
  document.body.appendChild(box)
  try {
    const cloneTop = box.firstElementChild
    if (!cloneTop) return null

    // The chain of clone nodes from cloneTop (depth 0) down to el's twin.
    const chain: Element[] = [cloneTop]
    let node: Element = cloneTop
    for (const idx of path) {
      const child = node.children[idx]
      if (!child) return null // clone diverged — give up quietly
      chain.push(child)
      node = child
    }

    const hiddenByStyle = (n: Element): boolean => {
      const cs = getComputedStyle(n)
      return cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0
    }

    // Walk DOWN the chain: the last depth where everything is still visible.
    let lastVisible = -1
    for (let depth = 0; depth < chain.length; depth++) {
      if (hiddenByStyle(chain[depth])) break
      lastVisible = depth
    }
    if (lastVisible === chain.length - 1) return null // visible without hover — normal click
    if (lastVisible < 0) return null // whole branch hidden without hover — can't pick a trigger

    // Map the deepest visible depth back to the LIVE tree.
    let live: Element = top
    for (let depth = 0; depth < lastVisible; depth++) {
      live = live.children[path[depth]]
    }
    return live === document.body || live === el ? null : live
  } finally {
    box.remove()
  }
}

// --- Capture CLICKS ---
document.addEventListener(
  'click',
  (event) => {
    // Pick mode: this click is pure POINTING. Stop it before the page (or our
    // own recording below) can react, and report the element instead.
    if (picking) {
      event.preventDefault()
      event.stopImmediatePropagation()
      const pickTarget = event.target as Element | null
      if (!pickTarget) return
      const el = meaningfulTarget(pickTarget)
      picking = false
      clearHighlight()
      const field = el as HTMLInputElement
      // `checked` exists on EVERY input (false on a text box, meaninglessly) —
      // only report it where checking makes sense, so the assertion UI can use
      // its absence to hide the checked/unchecked kinds.
      const isCheckable =
        el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')
      ipcRenderer.send('recorder:picked', {
        facts: collectFacts(el),
        // Live state, so the assertion UI can prefill sensible expectations:
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        inputValue: typeof field.value === 'string' ? field.value : undefined,
        disabled: !!field.disabled,
        checked: isCheckable ? field.checked : undefined
      })
      return
    }
    if (!recording) return
    // Skip the implicit-submission click that follows an Enter we just recorded.
    if (Date.now() < suppressClickUntil) {
      suppressClickUntil = 0
      return
    }
    const target = event.target as Element | null
    if (!target) return
    const el = meaningfulTarget(target)
    // A dropdown fires both a click (to open) and a change (to pick). The
    // 'change' listener below captures the real action, so skip the click.
    const tag = el.tagName.toLowerCase()
    if (tag === 'select' || tag === 'option') return
    // Day 10(d): if this element is only visible BECAUSE something is hovered
    // right now, record that hover first — replay (and the exported Playwright
    // test) must hover the trigger before the click can possibly work.
    try {
      const trigger = findHoverTrigger(el)
      if (trigger) {
        ipcRenderer.send('recorder:event', { type: 'hover', facts: collectFacts(trigger) })
      }
    } catch {
      // hover detection is best-effort — never let it break click recording
    }
    ipcRenderer.send('recorder:event', { type: 'click', facts: collectFacts(el) })
  },
  true // "capture phase" — we see the event on the way down, before the page reacts
)

// --- Capture TYPING / SELECTING ---
// 'change' fires once per field (when you leave it), so we get ONE clean step
// per field instead of one per keystroke.
document.addEventListener(
  'change',
  (event) => {
    if (!recording) return
    const el = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null
    if (!el) return
    const tag = el.tagName.toLowerCase()

    // A dropdown is its own action: you PICK an option (record its visible
    // TEXT, e.g. "Price (low to high)"), you don't type a value ("lohi").
    if (tag === 'select') {
      const select = el as HTMLSelectElement
      const chosen = select.options[select.selectedIndex]
      ipcRenderer.send('recorder:event', {
        type: 'select',
        facts: collectFacts(select),
        value: (chosen && chosen.text.trim()) || select.value
      })
      return
    }

    if (tag !== 'input' && tag !== 'textarea') return
    const field = el as HTMLInputElement

    // If this change is the trailing one fired by an Enter we already handled
    // below, skip it — we recorded the value from the keydown to keep order
    // (fill → press), so recording it again here would duplicate the step.
    if (enterHandled.has(field)) {
      enterHandled.delete(field)
      return
    }

    // Mark passwords as secret. We keep the real value (so replay can log in),
    // but it stays in memory only — shown masked on screen and exported as an
    // env var, never written to disk. (QA secrets hygiene.)
    ipcRenderer.send('recorder:event', {
      type: 'type',
      facts: collectFacts(field),
      value: field.value,
      secret: field.type === 'password'
    })
  },
  true
)

// --- Capture ENTER-to-submit (keyboard) ---
// Many real sites submit a search with the Enter key, not a button click
// (Google, most search bars). 'change' alone can't see that. We watch for Enter
// in single-line text fields and record it as a `press` step.
//
// Single-line text-like inputs where Enter means "submit" — NOT textareas
// (Enter = newline there) nor buttons/checkboxes (Enter = a click).
const SUBMITTING_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'tel',
  'url',
  'number',
  'password'
])

// Fields whose value we already recorded from an Enter keydown, so the 'change'
// listener above can skip the duplicate trailing change.
const enterHandled = new WeakSet<EventTarget>()

document.addEventListener(
  'keydown',
  (event) => {
    if (!recording) return
    // Plain Enter only — Shift+Enter is a newline, not a submit.
    if (event.key !== 'Enter' || event.shiftKey) return

    const el = event.target as (HTMLInputElement & HTMLTextAreaElement) | null
    if (!el) return
    const tag = el.tagName.toLowerCase()
    if (tag !== 'input' && tag !== 'textarea') return

    // Which fields treat Enter as "submit" (so it's worth recording)?
    //  - single-line text inputs (search bars, login fields), AND
    //  - search-style boxes — IMPORTANT: Google's search box is a
    //    <textarea role="combobox">, where Enter submits instead of inserting a
    //    newline. A plain multiline textarea (a comment box) is left alone.
    const role = (el.getAttribute('role') || '').toLowerCase()
    const hint = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('name') || ''} ${
      el.getAttribute('placeholder') || ''
    }`.toLowerCase()
    const isSubmitInput = tag === 'input' && SUBMITTING_INPUT_TYPES.has(el.type)
    const isSearchBox =
      role === 'combobox' || role === 'searchbox' || (tag === 'textarea' && hint.includes('search'))
    if (!isSubmitInput && !isSearchBox) return

    // Order matters: a user FILLS the field, THEN presses Enter. The field's own
    // 'change' fires AFTER this keydown, so we record the value here first (and
    // suppress that trailing change), then record the Enter press.
    if (el.value) {
      enterHandled.add(el)
      ipcRenderer.send('recorder:event', {
        type: 'type',
        facts: collectFacts(el),
        value: el.value,
        secret: el.type === 'password'
      })
    }
    ipcRenderer.send('recorder:event', { type: 'press', facts: collectFacts(el), key: 'Enter' })

    // If this field is in a form WITH a submit button, the browser is about to
    // auto-click that button (implicit submission). We've already recorded the
    // Enter press, so suppress the click that's coming next.
    const form = el.form || (el.closest && el.closest('form'))
    if (
      form &&
      form.querySelector(
        'button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]'
      )
    ) {
      suppressClickUntil = Date.now() + 500
    }
  },
  true
)
