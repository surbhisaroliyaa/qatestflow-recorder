// =====================================================================
// THE OBSERVER (page-world, injectable)
// =====================================================================
// This is the watcher that records clicks / typing on a page. Day 15
// rewrite: instead of shipping it as a PRELOAD (which Electron injects into
// sub-frames unreliably — iframes would randomly go uncaptured), main INJECTS
// this function into EVERY frame itself via WebFrameMain.executeJavaScript.
// That is reliable on any frame, any origin.
//
// Because it now runs in the page's own world (no Node, no ipcRenderer), it
// talks to the app a different way: it posts its events UP to the top window
// via window.top.postMessage, where a tiny preload relay (src/preload/
// recorder.ts) forwards them to main over IPC. Arming (record/pick on-off) and
// this frame's identity are handed in by main as globals set right before this
// runs (see injectObserver in src/main/index.ts):
//   window.__qaflowFrame       — this frame's FrameRef (or null for the top page)
//   window.__qaflowInitActive   — was recording already on when injected?
//   window.__qaflowInitPicking  — was pick mode already on?
//
// The function MUST stay fully self-contained (no module imports at runtime):
// it is stringified with .toString() and injected, so it can only reference
// what it defines inside itself plus the page globals above. Types are import-
// only and erased at compile time.
//
// IMPORTANT: the selector/dup logic here MIRRORS the replay resolver in
// src/main/replay.ts and the selector engine in src/main/selector.ts — change
// one, change the others (see the MIRROR WARNINGs below).

import type { DupInfo, ElementFacts } from './selector'

export function observerProgram(): void {
  // Guard: main may inject more than once (several load events fire per page).
  // Listeners must be registered exactly once per document.
  const g = window as unknown as {
    __qaflowInstalled?: boolean
    __qaflowFrame?: unknown
    __qaflowInitActive?: boolean
    __qaflowInitPicking?: boolean
    __qaflow?: { setActive: (v: boolean) => void; setPicking: (v: boolean) => void }
  }
  if (g.__qaflowInstalled) {
    // Re-injected by main to push a fresh record/pick state. Main re-injects
    // EVERY frame on a record/pick toggle, because that path reliably reaches
    // deeply-nested frames that a one-off setActive call can silently miss.
    // The listeners are already installed; just re-assert the armed state
    // (baked into the init globals for this run) and bail.
    if (g.__qaflow) {
      g.__qaflow.setActive(!!g.__qaflowInitActive)
      g.__qaflow.setPicking(!!g.__qaflowInitPicking)
    }
    return
  }
  g.__qaflowInstalled = true

  // Identity + initial state handed in by main just before this ran.
  const FRAME = g.__qaflowFrame ?? null
  let recording = !!g.__qaflowInitActive
  let picking = !!g.__qaflowInitPicking

  // Transport: bubble every event up to the TOP window. The top frame's
  // preload relay forwards it to main. Posting cross-origin to the top is
  // allowed (we only post, never read), so this works for nested/foreign frames.
  const postToHost = (channel: string, payload: Record<string, unknown>): void => {
    try {
      const top = window.top
      if (top) top.postMessage({ __qaflow: true, channel, payload }, '*')
    } catch {
      // detached frame or blocked — nothing we can do
    }
  }

  // === Day 9: ELEMENT PICKER state ===================================
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
    if (highlightBox) highlightBox.remove()
    highlightBox = null
  }

  // Arming hooks main calls via executeJavaScript when the user toggles
  // record / pick AFTER this frame was already injected.
  g.__qaflow = {
    setActive: (v: boolean): void => {
      recording = v
    },
    setPicking: (v: boolean): void => {
      picking = v
      if (!picking) clearHighlight()
    }
  }

  // Timestamp until which the next click is ignored (implicit form submission
  // fires a synthetic click after an Enter we already recorded as `press`).
  let suppressClickUntil = 0

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
      postToHost('recorder:pick-cancel', {})
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
        return 'img'
      default:
        return undefined
    }
  }

  // === Day 10(b): duplicate counting ================================
  // MIRROR WARNING: byRole / byText counting here MUST match how replay
  // RESOLVES those candidates (resolverHelpers in src/main/replay.ts).
  const norm = (s: string | null | undefined): string => (s || '').replace(/\s+/g, ' ').trim()

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
      return []
    }
  }

  function roleMatches(role: string, name: string): Element[] {
    const nodes = queryAll(ROLE_SELECTORS[role] || `[role=${role}]`)
    const want = norm(name)
    if (!want) return nodes
    const exact = nodes.filter((n) => accNameOf(n) === want)
    if (exact.length) return exact
    return nodes.filter((n) => accNameOf(n).includes(want))
  }

  function textMatches(text: string): Element[] {
    const want = norm(text)
    if (!want) return []
    const nodes = queryAll(
      'a, button, [role=button], [role=link], label, span, li, p, td, th, h1, h2, h3, h4, h5, h6, div'
    )
    const matches = nodes.filter((n) => norm(n.textContent) === want)
    return matches.filter((m) => !matches.some((other) => other !== m && m.contains(other)))
  }

  function attrEsc(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  }

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
    const name = facts.ariaLabel || facts.inputValue || facts.imgAlt || facts.text || facts.title
    if (facts.role && name) {
      const list = roleMatches(facts.role, name)
      note('role', list, list.indexOf(el))
    }
    if (facts.text) {
      const list = textMatches(facts.text)
      note(
        'text',
        list,
        list.findIndex((m) => m === el || el.contains(m) || m.contains(el))
      )
    }

    if (Object.keys(dup).length) facts.dup = dup
  }

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

    if (el.tagName.toLowerCase() !== 'select') {
      const heading = el.querySelector('h1, h2, h3, h4, h5, h6')
      const text = ((heading && heading.textContent) || el.textContent || '')
        .trim()
        .replace(/\s+/g, ' ')
      if (text && text.length <= 100) facts.text = text
    }

    if (el instanceof HTMLImageElement && el.alt) {
      facts.imgAlt = el.alt.trim()
    } else {
      const img = el.querySelector('img[alt]') as HTMLImageElement | null
      if (img && img.alt) facts.imgAlt = img.alt.trim()
    }

    collectDup(el, facts)
    return facts
  }

  function meaningfulTarget(start: Element): Element {
    return (
      start.closest('a, button, input, select, textarea, [role="button"], [data-test]') || start
    )
  }

  // === Day 10(d): smart hover detection =============================
  function findHoverTrigger(el: Element): Element | null {
    let top: Element = el
    while (top.parentElement && top.parentElement !== document.body) top = top.parentElement
    if (!top.parentElement || top === el) return null

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

      const chain: Element[] = [cloneTop]
      let node: Element = cloneTop
      for (const idx of path) {
        const child = node.children[idx]
        if (!child) return null
        chain.push(child)
        node = child
      }

      const hiddenByStyle = (n: Element): boolean => {
        const cs = getComputedStyle(n)
        return cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0
      }

      let lastVisible = -1
      for (let depth = 0; depth < chain.length; depth++) {
        if (hiddenByStyle(chain[depth])) break
        lastVisible = depth
      }
      if (lastVisible === chain.length - 1) return null
      if (lastVisible < 0) return null

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
      if (picking) {
        event.preventDefault()
        event.stopImmediatePropagation()
        const pickTarget = event.target as Element | null
        if (!pickTarget) return
        const el = meaningfulTarget(pickTarget)
        picking = false
        clearHighlight()
        const field = el as HTMLInputElement
        const isCheckable =
          el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')
        postToHost('recorder:picked', {
          facts: collectFacts(el),
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
          inputValue: typeof field.value === 'string' ? field.value : undefined,
          disabled: !!field.disabled,
          checked: isCheckable ? field.checked : undefined,
          frame: FRAME
        })
        return
      }
      if (!recording) return
      if (Date.now() < suppressClickUntil) {
        suppressClickUntil = 0
        return
      }
      const target = event.target as Element | null
      if (!target) return
      const el = meaningfulTarget(target)
      const tag = el.tagName.toLowerCase()
      if (tag === 'select' || tag === 'option') return
      try {
        const trigger = findHoverTrigger(el)
        if (trigger) {
          postToHost('recorder:event', {
            type: 'hover',
            facts: collectFacts(trigger),
            frame: FRAME
          })
        }
      } catch {
        // hover detection is best-effort
      }
      postToHost('recorder:event', { type: 'click', facts: collectFacts(el), frame: FRAME })
    },
    true
  )

  // --- Capture TYPING / SELECTING ---
  document.addEventListener(
    'change',
    (event) => {
      if (!recording) return
      const el = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null
      if (!el) return
      const tag = el.tagName.toLowerCase()

      if (tag === 'select') {
        const select = el as HTMLSelectElement
        const chosen = select.options[select.selectedIndex]
        postToHost('recorder:event', {
          type: 'select',
          facts: collectFacts(select),
          value: (chosen && chosen.text.trim()) || select.value,
          frame: FRAME
        })
        return
      }

      if (tag !== 'input' && tag !== 'textarea') return
      const field = el as HTMLInputElement

      if (enterHandled.has(field)) {
        enterHandled.delete(field)
        return
      }

      postToHost('recorder:event', {
        type: 'type',
        facts: collectFacts(field),
        value: field.value,
        secret: field.type === 'password',
        frame: FRAME
      })
    },
    true
  )

  // --- Capture ENTER-to-submit (keyboard) ---
  const SUBMITTING_INPUT_TYPES = new Set([
    'text',
    'search',
    'email',
    'tel',
    'url',
    'number',
    'password'
  ])

  const enterHandled = new WeakSet<EventTarget>()

  document.addEventListener(
    'keydown',
    (event) => {
      if (!recording) return
      if (event.key !== 'Enter' || event.shiftKey) return

      const el = event.target as (HTMLInputElement & HTMLTextAreaElement) | null
      if (!el) return
      const tag = el.tagName.toLowerCase()
      if (tag !== 'input' && tag !== 'textarea') return

      const role = (el.getAttribute('role') || '').toLowerCase()
      const hint = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('name') || ''} ${
        el.getAttribute('placeholder') || ''
      }`.toLowerCase()
      const isSubmitInput = tag === 'input' && SUBMITTING_INPUT_TYPES.has(el.type)
      const isSearchBox =
        role === 'combobox' ||
        role === 'searchbox' ||
        (tag === 'textarea' && hint.includes('search'))
      if (!isSubmitInput && !isSearchBox) return

      if (el.value) {
        enterHandled.add(el)
        postToHost('recorder:event', {
          type: 'type',
          facts: collectFacts(el),
          value: el.value,
          secret: el.type === 'password',
          frame: FRAME
        })
      }
      postToHost('recorder:event', {
        type: 'press',
        facts: collectFacts(el),
        key: 'Enter',
        frame: FRAME
      })

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
}
