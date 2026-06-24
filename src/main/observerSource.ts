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

  // === Day 16: native dialog capture (alert / confirm / prompt) ========
  // window.alert/confirm/prompt normally pop a BLOCKING native OS dialog that no
  // recorder or replay can get past. Intercept them in the page:
  //  - RECORDING  → record a `dialog` step (kind + message) and auto-respond so
  //    the take never stalls (confirm→accept, prompt→its default);
  //  - REPLAY     → answer with what main pre-armed for the next dialog
  //    (__qaflowNextDialog), or a safe default while replaying so nothing blocks;
  //  - otherwise (just browsing) → fall through to the real native dialog.
  const gg = g as typeof g & {
    __qaflowReplaying?: boolean
    __qaflowNextDialog?: { kind: string; accept?: boolean; text?: string } | null
  }
  const origAlert = window.alert
  const origConfirm = window.confirm
  const origPrompt = window.prompt
  const consumePending = (kind: string): { accept?: boolean; text?: string } | null => {
    const p = gg.__qaflowNextDialog
    if (p && p.kind === kind) {
      gg.__qaflowNextDialog = null
      return p
    }
    return null
  }
  window.alert = function (message?: unknown): void {
    const msg = String(message == null ? '' : message)
    if (recording) {
      postToHost('recorder:dialog', { kind: 'alert', message: msg })
      return
    }
    if (consumePending('alert') || gg.__qaflowReplaying) return
    origAlert.call(window, msg)
  }
  window.confirm = function (message?: unknown): boolean {
    const msg = String(message == null ? '' : message)
    if (recording) {
      postToHost('recorder:dialog', { kind: 'confirm', message: msg })
      return true
    }
    const pend = consumePending('confirm')
    if (pend) return pend.accept !== false
    if (gg.__qaflowReplaying) return true
    return origConfirm.call(window, msg)
  }
  window.prompt = function (message?: unknown, def?: unknown): string | null {
    const msg = String(message == null ? '' : message)
    const fallback = def == null ? '' : String(def)
    if (recording) {
      postToHost('recorder:dialog', { kind: 'prompt', message: msg, value: fallback })
      return fallback
    }
    const pend = consumePending('prompt')
    if (pend) return pend.accept === false ? null : pend.text ?? ''
    if (gg.__qaflowReplaying) return fallback
    return origPrompt.call(window, msg, def as string | undefined)
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
      const target = realTarget(event)
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

  // Shadow-piercing querySelectorAll (Day 15.5): all matches in this root, in
  // DOM order, then (recursively) matches inside every OPEN shadow root. On a
  // page with no shadow DOM this returns exactly what a plain querySelectorAll
  // would, so existing capture/dup behaviour is unchanged.
  // MIRROR WARNING: identical traversal to deepQueryAll in src/main/replay.ts's
  // resolverHelpers — capture-time dup counting and replay finding must walk in
  // the SAME order or a recorded .nth(i) lands on the wrong element.
  function deepQueryAll(selector: string, root: Document | ShadowRoot): Element[] {
    let out: Element[]
    try {
      out = Array.from(root.querySelectorAll(selector))
    } catch {
      return []
    }
    const hosts = root.querySelectorAll('*')
    for (const host of Array.from(hosts)) {
      const sr = host.shadowRoot
      if (sr) out.push(...deepQueryAll(selector, sr))
    }
    return out
  }

  function queryAll(selector: string): Element[] {
    return deepQueryAll(selector, document)
  }

  // The real element under an event. event.target RETARGETS to the shadow host
  // when the true target is inside an open shadow root; composedPath()[0] is the
  // actual element. Falls back to event.target for plain (non-shadow) events.
  // (Closed shadow roots are out of scope — composedPath can't pierce them.)
  function realTarget(event: Event): Element | null {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : []
    const first = path[0]
    if (first instanceof Element) return first
    return event.target as Element | null
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
        const pickTarget = realTarget(event)
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
      const target = realTarget(event)
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
  const onChange = (event: Event): void => {
    if (!recording) return
    const el = realTarget(event) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null
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

    // Day 16: file inputs are handled by the relay preload (only it can resolve
    // the real disk path, via webUtils — the page world can't). Don't record a
    // bogus 'type' step carrying the browser's fake "C:\fakepath\…" value.
    if (field.type === 'file') return

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
  }
  document.addEventListener('change', onChange, true)

  // Day 15.5: 'change' is composed:false — unlike click/keydown/mouseover it
  // does NOT cross an open shadow boundary, so the document listener above never
  // sees typing/selecting INSIDE a shadow root. Attach the SAME handler to every
  // open shadow root, present and future (each change then fires exactly one
  // listener — the innermost root's). Closed roots are out of scope.
  const armedRoots = new WeakSet<ShadowRoot>()
  const armRoot = (root: ShadowRoot): void => {
    if (armedRoots.has(root)) return
    armedRoots.add(root)
    root.addEventListener('change', onChange, true)
  }
  const scanShadowRoots = (root: Document | ShadowRoot | Element): void => {
    for (const host of Array.from(root.querySelectorAll('*'))) {
      const sr = host.shadowRoot
      if (sr) {
        armRoot(sr)
        scanShadowRoots(sr)
      }
    }
  }
  scanShadowRoots(document)
  // A shadow root created by UPGRADING an existing element (the common case for
  // custom elements) adds no DOM nodes, so the MutationObserver below can't see
  // it, and the one-time scan above may run before the page's scripts create
  // it. Every open root is born via attachShadow, so hook that to arm roots the
  // instant they appear, whatever the timing. (Patched once; open roots only —
  // closed roots are out of scope and we can't reach their contents anyway.)
  try {
    const proto = Element.prototype as unknown as {
      attachShadow: (init: ShadowRootInit) => ShadowRoot
      __qaflowPatched?: boolean
    }
    if (!proto.__qaflowPatched) {
      const original = proto.attachShadow
      proto.attachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
        const root = original.call(this, init)
        if (init && init.mode === 'open') armRoot(root)
        return root
      }
      proto.__qaflowPatched = true
    }
  } catch {
    // attachShadow not patchable — the scan + MutationObserver still cover roots
    // that already exist or arrive as inserted, already-upgraded subtrees
  }
  try {
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of Array.from(m.addedNodes)) {
          if (!(node instanceof Element)) continue
          if (node.shadowRoot) {
            armRoot(node.shadowRoot)
            scanShadowRoots(node.shadowRoot)
          }
          scanShadowRoots(node)
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true })
  } catch {
    // no documentElement / MutationObserver unavailable — the install-time scan
    // still covers every shadow root that existed when we were injected
  }

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

      const el = realTarget(event) as (HTMLInputElement & HTMLTextAreaElement) | null
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
