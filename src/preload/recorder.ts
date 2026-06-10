import { ipcRenderer } from 'electron'

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
    default:
      return undefined
  }
}

// Gather the raw facts the selector engine needs. All optional but `tag`.
function collectFacts(el: Element): Record<string, string> {
  const facts: Record<string, string> = { tag: el.tagName.toLowerCase() }

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

  return facts
}

// You often click the text/icon INSIDE a button — climb up to the real target.
function meaningfulTarget(start: Element): Element {
  return (
    start.closest('a, button, input, select, textarea, [role="button"], [data-test]') || start
  )
}

// --- Capture CLICKS ---
document.addEventListener(
  'click',
  (event) => {
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
      form.querySelector('button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]')
    ) {
      suppressClickUntil = Date.now() + 500
    }
  },
  true
)
