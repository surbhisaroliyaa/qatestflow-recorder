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
    __qaflow?: {
      setActive: (v: boolean) => void
      setPicking: (v: boolean) => void
      findByLabel: (
        label: string,
        role?: string,
        text?: string,
        rect?: { x: number; y: number; w: number; h: number } | null,
        action?: string
      ) => unknown
    }
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
  // While RECORDING we show the REAL dialog so you answer it yourself (type the
  // prompt, pick Ok/Cancel) and record your actual answer. The "never block"
  // rule only matters on REPLAY (unattended), where we auto-answer instead.
  window.alert = function (message?: unknown): void {
    const msg = String(message == null ? '' : message)
    if (recording) {
      origAlert.call(window, msg)
      postToHost('recorder:dialog', { kind: 'alert', message: msg })
      return
    }
    if (consumePending('alert') || gg.__qaflowReplaying) return
    origAlert.call(window, msg)
  }
  window.confirm = function (message?: unknown): boolean {
    const msg = String(message == null ? '' : message)
    if (recording) {
      const ok = origConfirm.call(window, msg)
      postToHost('recorder:dialog', { kind: 'confirm', message: msg, accept: ok })
      return ok
    }
    const pend = consumePending('confirm')
    if (pend) return pend.accept !== false
    if (gg.__qaflowReplaying) return true
    return origConfirm.call(window, msg)
  }
  // Day 16(+): Electron's embedded view has NO native prompt() box, so a page's
  // prompt() shows nothing to type into. While RECORDING we draw our OWN in-page
  // prompt so you type the answer on screen and it's recorded live — no editing
  // the step afterward. Caveat: prompt() must return its value SYNCHRONOUSLY, but
  // reading what you type is async — so the PAGE proceeds with the default; the
  // value you type is what gets recorded and replayed.
  let promptModalOpen = false
  const showPromptModal = (message: string, initial: string): void => {
    if (promptModalOpen) return
    promptModalOpen = true
    const overlay = document.createElement('div')
    overlay.setAttribute('data-qaflow-ui', 'prompt')
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.35);' +
      'display:flex;align-items:flex-start;justify-content:center;padding-top:15vh;' +
      'font-family:system-ui,Segoe UI,Arial,sans-serif;'
    const box = document.createElement('div')
    box.setAttribute('data-qaflow-ui', 'prompt')
    box.style.cssText =
      'background:#fff;color:#111;min-width:340px;max-width:80vw;border-radius:8px;' +
      'box-shadow:0 10px 40px rgba(0,0,0,0.35);padding:16px 18px;'
    const label = document.createElement('div')
    label.textContent = message || 'Prompt'
    label.style.cssText = 'font-size:14px;margin-bottom:10px;white-space:pre-wrap;'
    const input = document.createElement('input')
    input.type = 'text'
    input.value = initial
    input.setAttribute('data-qaflow-ui', 'prompt')
    input.style.cssText =
      'width:100%;box-sizing:border-box;padding:8px 10px;font-size:14px;' +
      'border:1px solid #bbb;border-radius:5px;outline:none;'
    const rowEl = document.createElement('div')
    rowEl.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px;'
    const cancelBtn = document.createElement('button')
    cancelBtn.textContent = 'Cancel'
    cancelBtn.setAttribute('data-qaflow-ui', 'prompt')
    cancelBtn.style.cssText =
      'padding:6px 14px;font-size:13px;border:1px solid #bbb;background:#f4f4f4;' +
      'border-radius:5px;cursor:pointer;'
    const okBtn = document.createElement('button')
    okBtn.textContent = 'OK'
    okBtn.setAttribute('data-qaflow-ui', 'prompt')
    okBtn.style.cssText =
      'padding:6px 14px;font-size:13px;border:1px solid #2563eb;background:#2563eb;' +
      'color:#fff;border-radius:5px;cursor:pointer;'
    rowEl.appendChild(cancelBtn)
    rowEl.appendChild(okBtn)
    box.appendChild(label)
    box.appendChild(input)
    box.appendChild(rowEl)
    overlay.appendChild(box)
    document.documentElement.appendChild(overlay)
    input.focus()
    input.select()

    const finish = (accepted: boolean): void => {
      // Record what you typed on OK; on Cancel record the page's default (which
      // is what the page actually received synchronously). main reads `value`.
      const recorded = accepted ? input.value : initial
      promptModalOpen = false
      overlay.remove()
      postToHost('recorder:dialog', {
        kind: 'prompt',
        message,
        value: recorded,
        accept: accepted
      })
    }
    okBtn.addEventListener('click', () => finish(true))
    cancelBtn.addEventListener('click', () => finish(false))
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        finish(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(false)
      }
    })
  }

  window.prompt = function (message?: unknown, def?: unknown): string | null {
    const msg = String(message == null ? '' : message)
    const fallback = def == null ? '' : String(def)
    if (recording && !gg.__qaflowReplaying) {
      // Show our own prompt so you can type the answer on screen; it's recorded
      // when you submit. The page proceeds now with the default (we can't block
      // for async input) — your typed value is what's recorded and replayed.
      showPromptModal(msg, fallback)
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
    },
    // Day 18 (self-heal): main calls this on a replay failure to AUTO-find the
    // element a broken step meant — by its recorded human label. Returns the
    // best visible match's facts (same shape a manual pick produces) or null.
    findByLabel: (
      label: string,
      role?: string,
      text?: string,
      rect?: { x: number; y: number; w: number; h: number } | null,
      action?: string
    ): unknown => findElementByLabel(label, role, text, rect, action)
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
    const el = first instanceof Element ? first : (event.target as Element | null)
    // Day 16(+): ignore events that land inside our OWN injected UI (the in-page
    // prompt modal below). Its input/buttons must never be recorded as page
    // clicks/typing. Returning null here makes every handler bail safely.
    if (el && typeof el.closest === 'function' && el.closest('[data-qaflow-ui]')) return null
    return el
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

  // === Parent-anchored fallback ====================================
  // For an element with no hook of its own, locate it via the nearest STABLE
  // ancestor (a human-named id, a test id, or an ARIA landmark) + this element's
  // tag/type/position. MIRROR WARNING: the index is counted with deepQueryAll,
  // the SAME traversal replay's findByCandidate uses — so `.nth` can't drift.
  const isGeneratedId = (id: string): boolean =>
    /\d{4,}/.test(id) || /[a-f0-9]{8,}/i.test(id) || id.indexOf(':') !== -1
  const LANDMARK_ROLES = ['navigation', 'main', 'form', 'search', 'banner', 'contentinfo', 'region']

  // Ancestor selector(s) for the nearest stable ancestor. Returns a LIST because
  // a test id spans two conventions ([data-test] / [data-testid]); id/landmark
  // are a single entry. null = no stable ancestor within reach (keep the honest
  // refusal rather than ship a global `body input` guess).
  function anchorSelectorsFor(el: Element): string[] | null {
    let node = el.parentElement
    let depth = 0
    let landmark: string | null = null // nearest ARIA landmark — a weaker fallback
    while (node && depth < 6 && node !== document.body && node !== document.documentElement) {
      const id = node.getAttribute('id')
      if (id && !isGeneratedId(id) && /^[A-Za-z][\w-]*$/.test(id)) return ['#' + id]
      const testId = node.getAttribute('data-test') || node.getAttribute('data-testid')
      if (testId) {
        return ['[data-test="' + attrEsc(testId) + '"]', '[data-testid="' + attrEsc(testId) + '"]']
      }
      if (!landmark) {
        const tag = node.tagName.toLowerCase()
        const role = node.getAttribute('role')
        const ariaLabel = node.getAttribute('aria-label')
        if (tag === 'form' || tag === 'nav' || tag === 'main') landmark = tag
        else if (tag === 'section' && ariaLabel)
          landmark = 'section[aria-label="' + attrEsc(ariaLabel) + '"]'
        else if (role && LANDMARK_ROLES.indexOf(role) !== -1)
          landmark = '[role="' + attrEsc(role) + '"]'
      }
      node = node.parentElement
      depth++
    }
    return landmark ? [landmark] : null
  }

  function collectAnchor(el: Element, facts: ElementFacts): void {
    const anchors = anchorSelectorsFor(el)
    if (!anchors) return
    const tag = el.tagName.toLowerCase()
    const type = el instanceof HTMLInputElement ? el.type : ''
    const descendant = tag + (type ? '[type="' + attrEsc(type) + '"]' : '')
    // Distribute the descendant across EVERY ancestor branch — otherwise a
    // comma-list ancestor ([data-test], [data-testid]) would leave the first
    // branch matching the ancestor itself, not the descendant.
    const scoped = anchors.map((a) => a + ' ' + descendant).join(', ')
    const list = deepQueryAll(scoped, document)
    const index = list.indexOf(el)
    if (index < 0 || list.length === 0) return
    facts.anchor = { css: scoped, count: list.length, index }
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
    // Parent-anchored fallback — only when the element has no strong hook of its
    // own (a cheap attribute gate, not the full ladder, so we skip the ancestor
    // walk + count for the common case). The engine ranks it above bare-tag.
    if (!facts.testId && !facts.id && !facts.name && !facts.placeholder) collectAnchor(el, facts)
    return facts
  }

  // === Day 18: self-heal finder ====================================
  // The visible "name" of an element the way a human reads it — used to match a
  // broken step's recorded label back to an element on the (changed) page.
  function accessibleNameOf(el: Element): string {
    const aria = el.getAttribute('aria-label')
    if (aria) return aria
    if (el instanceof HTMLInputElement) {
      if ((el.type === 'submit' || el.type === 'button' || el.type === 'reset') && el.value) {
        return el.value
      }
      if (el.placeholder) return el.placeholder
      if (el.id) {
        const escaped =
          (window as { CSS?: { escape?: (s: string) => string } }).CSS &&
          window.CSS.escape
            ? window.CSS.escape(el.id)
            : el.id
        const lab = document.querySelector('label[for="' + escaped + '"]')
        if (lab && lab.textContent) return lab.textContent
      }
    }
    if (el instanceof HTMLImageElement && el.alt) return el.alt
    const ph = el.getAttribute('placeholder')
    if (ph) return ph
    const heading = el.querySelector && el.querySelector('h1, h2, h3, h4, h5, h6')
    const text = (((heading && heading.textContent) || el.textContent) || '').trim()
    if (text && text.length <= 80) return text
    const title = el.getAttribute('title')
    if (title) return title
    return ''
  }

  // F4 (self-heal 2.0): find the VISIBLE elements a broken step might have meant,
  // scored by MULTIPLE signals — accessible NAME (the backbone) plus, when the
  // caller has them from the green baseline, the same ROLE, the recorded visible
  // TEXT, and the recorded POSITION on the page. Returns the top few candidates
  // WITH their live rects + a per-signal breakdown, so the host can add a fifth
  // signal (a pixel crop compare) and decide whether the winner is confident +
  // unambiguous enough to auto-heal. `wantRect` is normalised 0–1 of the viewport
  // (center used); null when no baseline position was captured.
  //
  // `action` is the step's action ('type' / 'select' / 'click' / …). It gates the
  // candidate set to elements that can actually DO that action — you can't type
  // into a <div> of help text — so static text that merely MENTIONS the field's
  // name (e.g. SauceDemo's "Accepted usernames are:" box) never competes with the
  // real input. Without it, such text scores as a near-tie and the ambiguity guard
  // wrongly declines a heal that should be obvious.
  function findElementByLabel(
    rawLabel: string,
    role?: string,
    wantText?: string,
    wantRect?: { x: number; y: number; w: number; h: number } | null,
    action?: string
  ): unknown {
    const norm = (s: string): string =>
      (s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
    const want = norm(rawLabel)
    if (!want) return null
    const wantTokens = want.split(' ').filter(Boolean)
    const wantTextN = norm(wantText || '')
    const vw = window.innerWidth || 1
    const vh = window.innerHeight || 1
    const wantCx = wantRect ? wantRect.x + wantRect.w / 2 : null
    const wantCy = wantRect ? wantRect.y + wantRect.h / 2 : null
    // Can this element perform the step's action? A `type` needs a fillable field
    // (text-like input / textarea / contenteditable); a `select` needs a <select>.
    // Other actions (click/hover/assert) don't restrict — almost anything is a
    // valid click/assert target.
    const NON_FILLABLE_INPUT = ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image']
    const canDoAction = (el: Element): boolean => {
      if (action === 'type') {
        const tag = el.tagName
        if (tag === 'TEXTAREA') return true
        if (tag === 'INPUT') {
          const t = (el.getAttribute('type') || 'text').toLowerCase()
          return NON_FILLABLE_INPUT.indexOf(t) < 0
        }
        return (el as HTMLElement).isContentEditable === true
      }
      if (action === 'select') return el.tagName === 'SELECT'
      return true
    }
    const nodes = Array.prototype.slice.call(
      document.querySelectorAll('a,button,input,select,textarea,label,img,[role],[data-test],[data-testid]')
    ) as Element[]
    const scored: {
      el: Element
      r: DOMRect
      combined: number
      nameScore: number
      roleMatch: boolean
      textMatch: boolean
      hasPos: boolean
      posScore: number
    }[] = []
    for (const el of nodes) {
      if (!canDoAction(el)) continue
      const r = el.getBoundingClientRect()
      if (!r.width && !r.height) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue
      const name = norm(accessibleNameOf(el))
      // NAME score: exact > contains > token-overlap (the original heuristic).
      let nameScore = 0
      if (name) {
        if (name === want) nameScore = 100
        else if (name.indexOf(want) >= 0 || want.indexOf(name) >= 0) nameScore = 70
        else {
          const nameTokens = new Set(name.split(' ').filter(Boolean))
          const shared = wantTokens.filter((t) => nameTokens.has(t)).length
          if (shared) nameScore = Math.round((shared / wantTokens.length) * 55)
        }
      }
      // TEXT signal: the recorded visible text still shows on this element.
      let textMatch = false
      if (wantTextN) {
        const t = norm(el.textContent || '')
        if (t && (t === wantTextN || t.indexOf(wantTextN) >= 0 || wantTextN.indexOf(t) >= 0)) {
          textMatch = true
        }
      }
      // Need SOME textual anchor — name or the recorded text — to be in the race.
      if (!nameScore && !textMatch) continue
      const roleMatch = !!(role && roleFor(el) === role)
      // POSITION signal: how close this element sits to where the recorded one
      // was (normalised centers). +1 right on top → 0 about a third of the
      // viewport away → clamped at -1 far off. Only when a baseline rect exists.
      let posScore = 0
      const hasPos = wantCx != null
      if (hasPos) {
        const cx = (r.left + r.width / 2) / vw
        const cy = (r.top + r.height / 2) / vh
        const dist = Math.sqrt((cx - (wantCx as number)) ** 2 + (cy - (wantCy as number)) ** 2)
        // Floored gently (-0.5): a moved element shouldn't be buried — layout
        // shifts are common exactly WHEN selectors break — but position still
        // strongly separates duplicates (span ≈ 30 pts) so the right one of six
        // look-alikes wins.
        posScore = Math.max(-0.5, 1 - dist / 0.35)
      }
      let combined = nameScore
      if (roleMatch) combined += 10
      if (textMatch) combined += 15
      if (hasPos) combined += Math.round(posScore * 20)
      if (combined < 50) continue // too weak on every signal to be a real match
      scored.push({ el, r, combined, nameScore, roleMatch, textMatch, hasPos, posScore })
    }
    if (!scored.length) return null
    scored.sort((a, b) => b.combined - a.combined)
    const matches = scored.slice(0, 5).map((s) => {
      const input = s.el instanceof HTMLInputElement ? s.el : null
      return {
        facts: collectFacts(s.el),
        rect: { x: s.r.left, y: s.r.top, w: s.r.width, h: s.r.height },
        vw,
        vh,
        score: s.combined,
        nameScore: s.nameScore,
        roleMatch: s.roleMatch,
        textMatch: s.textMatch,
        hasPos: s.hasPos,
        posScore: s.posScore,
        text: (s.el.textContent || '').trim().slice(0, 100) || undefined,
        inputValue: input ? input.value : undefined,
        disabled: 'disabled' in s.el ? !!(s.el as { disabled?: boolean }).disabled : undefined,
        checked:
          input && (input.type === 'checkbox' || input.type === 'radio') ? input.checked : undefined
      }
    })
    return { matches }
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
      // Day 16: a click on a file input only opens the native OS file picker.
      // The file you pick is captured separately as an `upload` step (preload →
      // CDP setFileInputFiles), so recording this click is pointless — and on
      // replay it would pop that "Open" dialog endlessly instead of uploading.
      if (tag === 'input' && (el as HTMLInputElement).type === 'file') return
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
