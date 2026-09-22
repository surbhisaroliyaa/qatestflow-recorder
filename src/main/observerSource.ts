// =====================================================================
// THE OBSERVER — the code that watches a page while you record
// =====================================================================
// QF-002, completed 2026-09-18. This used to be injected into each frame's
// PAGE world and posted its events up to the top window with postMessage,
// guarded by a per-recording nonce. A page watching a live recording could
// read that nonce off the very messages it guarded and imitate the recorder.
//
// Now it runs in each frame's ISOLATED world: the recorder preload
// (src/preload/recorder.ts) loads into every frame (nodeIntegrationInSubFrames)
// and calls createObserver() there. The page cannot see this code, its state,
// or its transport — `send` is ipcRenderer, which only exists in this world —
// and main learns WHICH frame spoke from Electron (event.senderFrame), not
// from anything the page could write. No nonce is needed any more.
//
// Two things still have to live in the PAGE world, and are kept tiny:
//   · dialogShimProgram() — overriding window.alert/confirm/prompt only works
//     in the world the page calls them from. It tells this observer about a
//     dialog through a DOM event ("qaflow-dialog"). A page can dispatch that
//     event too — but a page decides which dialogs it shows anyway, so all it
//     could do is describe a dialog it could equally have opened.
//   · nothing else. (The old attachShadow patch is replaced by arming shadow
//     roots from `focusin`, which the isolated world can see.)
//
// Script-written iframes (about:blank + document.write — rich-text editors,
// many widgets) get no preload of their own, so the frame that CONTAINS one
// adopts it: createObserver() is called again with the child's window and
// document, and reports the child's frame path in `frame`. See adoptChildren.
//
// SELF-CONTAINED ON PURPOSE: createObserver references nothing outside
// itself, so the DOM tests can stringify it and run it in a plain page with a
// fake `send`. Inside, `window`, `document` and the DOM classes are rebound to
// the frame being observed — the body below reads like ordinary page code,
// but works on an adopted child's realm too.
//
// IMPORTANT: the selector/dup logic here MIRRORS the replay resolver in
// src/main/replay.ts and the selector engine in src/main/selector.ts — change
// one, change the others (see the MIRROR WARNINGs below).

import type { DupInfo, ElementFacts } from './selector'

/** A frame path element — the same shape main uses for FrameRef. */
export interface ObserverFrameStep {
  url: string
  name: string
}

export interface ObserverOptions {
  /** How events reach main. In the app: ipcRenderer.send. In tests: a fake. */
  send: (channel: string, payload: Record<string, unknown>) => void
  /** This document's frame path RELATIVE to the preload that owns it: null for
   *  the preload's own frame, or e.g. [{url:'about:blank', name:'editor'}] for
   *  an adopted script-written child. Main prepends the sender frame's path. */
  frame?: ObserverFrameStep[] | null
  recording?: boolean
  picking?: boolean
}

export interface ObserverHandle {
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

/**
 * The PAGE-world half: native dialog capture. Injected by main into every
 * frame with executeJavaScript, and self-contained for the same reason.
 *
 * window.alert/confirm/prompt normally pop a BLOCKING native dialog that no
 * recorder or replay can get past:
 *  - RECORDING  → the real dialog shows so you answer it yourself; your answer
 *    is reported to the observer as a `dialog` step;
 *  - REPLAY     → answer with what main pre-armed for the next dialog
 *    (__qaflowNextDialog), or a safe default so an unattended run never blocks;
 *  - otherwise (just browsing) → the real native dialog.
 * "Recording" is read from an attribute the observer sets on <html>.
 */
export function dialogShimProgram(): void {
  const g = window as unknown as {
    __qaflowShim?: boolean
    __qaflowReplaying?: boolean
    __qaflowNextDialog?: { kind: string; accept?: boolean; text?: string } | null
  }
  if (g.__qaflowShim) return
  g.__qaflowShim = true

  const recording = (): boolean =>
    document.documentElement?.getAttribute('data-qaflow-recording') === '1'
  const report = (payload: Record<string, unknown>): void => {
    try {
      document.dispatchEvent(new CustomEvent('qaflow-dialog', { detail: JSON.stringify(payload) }))
    } catch {
      // no document to talk through — nothing to record
    }
  }
  const origAlert = window.alert
  const origConfirm = window.confirm
  const origPrompt = window.prompt
  const consumePending = (kind: string): { accept?: boolean; text?: string } | null => {
    const p = g.__qaflowNextDialog
    if (p && p.kind === kind) {
      g.__qaflowNextDialog = null
      return p
    }
    return null
  }
  window.alert = function (message?: unknown): void {
    const msg = String(message == null ? '' : message)
    if (recording()) {
      origAlert.call(window, msg)
      report({ kind: 'alert', message: msg })
      return
    }
    if (consumePending('alert') || g.__qaflowReplaying) return
    origAlert.call(window, msg)
  }
  window.confirm = function (message?: unknown): boolean {
    const msg = String(message == null ? '' : message)
    if (recording()) {
      const ok = origConfirm.call(window, msg)
      report({ kind: 'confirm', message: msg, accept: ok })
      return ok
    }
    const pend = consumePending('confirm')
    if (pend) return pend.accept !== false
    if (g.__qaflowReplaying) return true
    return origConfirm.call(window, msg)
  }
  // Day 16(+): Electron's embedded view has NO native prompt() box, so a page's
  // prompt() shows nothing to type into. While RECORDING we draw our OWN in-page
  // prompt so you type the answer on screen and it's recorded live. Caveat:
  // prompt() must return SYNCHRONOUSLY, but reading what you type is async — so
  // the PAGE proceeds with the default; the value you type is what gets recorded
  // and replayed.
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
      report({ kind: 'prompt', message, value: recorded, accept: accepted })
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
    if (recording() && !g.__qaflowReplaying) {
      showPromptModal(msg, fallback)
      return fallback
    }
    const pend = consumePending('prompt')
    if (pend) return pend.accept === false ? null : (pend.text ?? '')
    if (g.__qaflowReplaying) return fallback
    return origPrompt.call(window, msg, def as string | undefined)
  }
}

/**
 * Install the observer on one document. Returns the handle the preload uses to
 * switch recording / picking and to run a self-heal lookup.
 *
 * Idempotent per document: a second call returns the first call's handle, so
 * listeners are never registered twice.
 */
export function createObserver(
  win: Window & typeof globalThis,
  doc: Document,
  opts: ObserverOptions
): ObserverHandle {
  // Per-document guard, kept on a WeakMap that lives in THIS world — the page
  // can't see it, clear it, or fake it.
  const registry = ((
    createObserver as unknown as { registry?: WeakMap<Document, ObserverHandle> }
  ).registry ??= new WeakMap())
  const existing = registry.get(doc)
  if (existing) return existing

  // Rebind the page globals to the frame being observed, so the body below —
  // written as ordinary page code — works on an ADOPTED child's realm as well
  // as on the preload's own frame. (instanceof must use the child realm's
  // classes: a child's <input> is not an instance of the parent's
  // HTMLInputElement.)
  const window = win
  const document = doc
  const Element = win.Element
  const HTMLInputElement = win.HTMLInputElement
  const HTMLImageElement = win.HTMLImageElement
  const MutationObserver = win.MutationObserver
  const getComputedStyle = (el: Element): CSSStyleDeclaration => win.getComputedStyle(el)

  const FRAME = opts.frame ?? null
  let recording = !!opts.recording
  let picking = !!opts.picking
  const postToHost = (channel: string, payload: Record<string, unknown>): void => {
    try {
      opts.send(channel, payload)
    } catch {
      // transport gone (frame tearing down) — nothing to do
    }
  }
  // The page-world dialog shim reads this to know whether to record.
  const markRecording = (): void => {
    try {
      document.documentElement?.setAttribute('data-qaflow-recording', recording ? '1' : '0')
    } catch {
      // no <html> yet — set again on the next toggle
    }
  }
  markRecording()

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

  const handle: ObserverHandle = {
    setActive: (v: boolean): void => {
      recording = v
      markRecording()
    },
    setPicking: (v: boolean): void => {
      picking = v
      if (!picking) clearHighlight()
    },
    // Day 18 (self-heal): main asks for this on a replay failure to AUTO-find
    // the element a broken step meant — by its recorded human label. Returns
    // the best visible match's facts (same shape a manual pick produces) or null.
    findByLabel: (
      label: string,
      role?: string,
      text?: string,
      rect?: { x: number; y: number; w: number; h: number } | null,
      action?: string
    ): unknown => findElementByLabel(label, role, text, rect, action)
  }
  registry.set(doc, handle)

  // A dialog reported by the page-world shim (see dialogShimProgram).
  document.addEventListener('qaflow-dialog', (event) => {
    if (!recording) return
    let d: Record<string, unknown>
    try {
      d = JSON.parse(String((event as CustomEvent).detail))
    } catch {
      return
    }
    if (!d || typeof d !== 'object') return
    postToHost('recorder:dialog', d)
  })

  // Timestamp until which the next click is ignored (implicit form submission
  // fires a synthetic click after an Enter we already recorded as `press`).
  let suppressClickUntil = 0
  // Phase 4: an element that was just DRAGGED, and until when.
  //
  // Dragging a form control changes its value, and the browser fires `change`
  // — which the change listener below would record as a second step. A slider
  // came out as a drag PLUS `Type "3.5" into input`, and the exported spec
  // then called .fill() on an input[type=range], which Playwright rejects
  // outright with "Malformed value" (Surbhi, Round 4).
  //
  // That is QF-001's shape exactly: green in the app, red in CI. The click
  // after a drag was already suppressed for the same reason; the change was
  // simply missed.
  let draggedEl: Element | null = null
  let suppressChangeUntil = 0

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
      // QF-002: only a real key press may cancel picking (see `click` below).
      if (!event.isTrusted) return
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

    // Remember WHICH attribute carried the test id. Both conventions exist, and
    // real Playwright's getByTestId() reads only ONE of them (data-testid by
    // default) — so the export must declare the attribute it actually saw, or
    // the exported locator matches nothing. Mirrors the `||` preference below.
    const dataTest = el.getAttribute('data-test')
    const dataTestId = el.getAttribute('data-testid')
    const testId = dataTest || dataTestId
    if (testId) {
      facts.testId = testId
      facts.testIdAttr = dataTest ? 'data-test' : 'data-testid'
    }
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

    // The control's <label> — `labels` covers both label[for=id] and a wrapping
    // <label>, so no id lookup (and no CSS escaping) is needed. Read from a copy
    // with the controls removed: `<label>Country <select>…</select></label>`
    // would otherwise be named "Country" plus the text of every option.
    const labelled = el as HTMLInputElement
    if (labelled.labels && labelled.labels.length) {
      const copy = labelled.labels[0].cloneNode(true) as HTMLElement
      copy.querySelectorAll('input, select, textarea, button').forEach((c) => c.remove())
      const lt = (copy.textContent || '').trim().replace(/\s+/g, ' ')
      if (lt && lt.length <= 100) facts.labelText = lt
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
          (window as { CSS?: { escape?: (s: string) => string } }).CSS && window.CSS.escape
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
    const text = ((heading && heading.textContent) || el.textContent || '').trim()
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
      document.querySelectorAll(
        'a,button,input,select,textarea,label,img,[role],[data-test],[data-testid]'
      )
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

  // QF-001: is this a tickable control? Checkbox and radio are the two input
  // types whose interaction is a STATE CHANGE, not a value entry — they need
  // the canonical `check` step rather than `click` + `type`.
  // (Deliberately a plain boolean, not an `el is HTMLInputElement` predicate:
  // as a type guard it would narrow the ELSE branch of the change listener —
  // where the field is already known to be an input — down to `never`.)
  const isCheckable = (el: Element | null): boolean =>
    !!el && el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')

  // QF-001: the control a click on this element would toggle, if any. Covers
  // `<label for=x>`, the wrapping `<label><input>text</label>` form, and a click
  // on any descendant of either (the span inside a styled checkbox, say).
  const labelledControl = (el: Element): HTMLInputElement | null => {
    const label = el.closest('label')
    if (!label) return null
    const control = (label as HTMLLabelElement).control
    return isCheckable(control) ? (control as HTMLInputElement) : null
  }

  // --- Capture CLICKS ---
  //
  // QF-002 — ONLY REAL INPUT IS RECORDED. The browser sets `isTrusted` on
  // events produced by the user's actual mouse and keyboard, and page script
  // cannot set it: `button.click()` or `dispatchEvent(new MouseEvent(...))`
  // arrive with isTrusted === false. Before this, the tested page could forge a
  // step just by calling .click() — no nonce needed, since this listener
  // recorded every click it saw. (Found by tools/e2e-smoke.mjs.) The same rule
  // is applied to `change` and the Enter key below.
  document.addEventListener(
    'click',
    (event) => {
      if (!event.isTrusted) return
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
      // QF-001: a checkbox/radio is recorded ONCE, by the change listener below,
      // as a canonical `check` step carrying the resulting ticked state. Record
      // nothing here or the tick lands twice (a click AND a bogus type "on").
      // The label counts too: clicking a <label> toggles its control, so a
      // label click would otherwise sneak the duplicate straight back in —
      // covers both `for=` labels and the wrapping <label><input>…</label> form.
      if (isCheckable(el) || isCheckable(labelledControl(el))) return
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
    // QF-002: a change the PAGE dispatched is not something the user did.
    if (!event.isTrusted) return
    if (!recording) return
    // Phase 4: the value changed BECAUSE it was just dragged. The drag step
    // already records that, and a second value-setting step would both
    // duplicate it and (for a range input) fail to run at all.
    if (Date.now() < suppressChangeUntil && realTarget(event) === draggedEl) {
      return
    }
    const el = realTarget(event) as
      | HTMLInputElement
      | HTMLSelectElement
      | HTMLTextAreaElement
      | null
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

    // QF-001: a checkbox/radio reports `field.value` as the HTML default "on",
    // which says nothing about whether it ended up ticked. Record the STATE.
    // `change` is the right listener for this: it fires for a mouse click, a
    // label click, and the keyboard Space toggle alike, and it fires only when
    // the state actually moved — so a page that preventDefaults the click
    // (leaving the box untouched) correctly records nothing.
    if (isCheckable(field)) {
      postToHost('recorder:event', {
        type: 'check',
        facts: collectFacts(field),
        value: String(field.checked),
        frame: FRAME
      })
      return
    }

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
  // it. This used to be solved by patching Element.prototype.attachShadow — but
  // a patch made in THIS isolated world never runs when the page calls it.
  //
  // What the isolated world CAN see is `focusin`, which is composed (crosses
  // shadow boundaries) and fires before any typing: a user has to focus a field
  // before its `change` can fire. So every shadow root on the focused element's
  // path is armed at that moment — whenever that root was created.
  document.addEventListener(
    'focusin',
    (event) => {
      for (const node of event.composedPath()) {
        const root = node as ShadowRoot
        if (root && root.nodeType === 11 && (root as { host?: unknown }).host) armRoot(root)
      }
    },
    true
  )
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
      if (!event.isTrusted) return // QF-002: real key presses only
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

  // === Phase 4: capture SCROLLING ====================================
  //
  // `isTrusted` cannot be the gate here, the way it is for every other
  // listener. A scroll event is dispatched BY THE BROWSER whether a human
  // turned the wheel or the page called window.scrollTo() — both arrive
  // trusted, so the flag says nothing about who scrolled.
  //
  // The gate is therefore the GESTURE that caused it: a wheel, a touch, a drag
  // of the scrollbar, or a scrolling key, each of which IS isTrusted-checkable.
  // A scroll with no such gesture just before it was the page moving itself,
  // and the page moving itself is not a step the user performed. That also
  // kills the noise that would otherwise arrive from every smooth-scroll
  // animation, banner reveal and scroll-restoration on the site under test.
  const SCROLL_KEYS = new Set([
    'PageDown',
    'PageUp',
    'Home',
    'End',
    'ArrowDown',
    'ArrowUp',
    ' ',
    'Spacebar'
  ])
  let lastGestureAt = 0
  // How long the page must be BOTH gesture-free and scroll-free before the
  // scroll is treated as finished.
  //
  // This was 350ms and it was far too short. A person reading a long page
  // pauses longer than that between wheel notches constantly, so every notch
  // settled, the timer fired, and a single gesture became seventeen steps
  // (Surbhi, Round 2a). The timer is also restarted by the GESTURE events
  // below, not only by scroll events — continuous wheeling keeps resetting it
  // even in the gaps where the page has momentarily stopped moving, which is
  // exactly the case the old version got wrong.
  const SCROLL_SETTLE_MS = 800
  let scrollTimer: ReturnType<typeof setTimeout> | null = null
  let lastRecordedY = -1
  // The page height when the last scroll step was recorded. Growth since then
  // means this scroll LOADED something — see loadedMore in recordRest.
  let lastRecordedHeight = 0

  // Is a pointer being HELD right now? This is the scrollbar-drag case, and it
  // is deliberately not the same thing as "a pointer was pressed recently".
  //
  // pointerdown used to mark a gesture for the next 1200ms like the wheel does,
  // which quietly broke the whole rule: a CLICK is a pointerdown, so every
  // click opened a window in which any scroll the page performed counted as the
  // user's. Clicking a link and letting the new page jump to the top recorded a
  // "Scroll to the top of the page" step nobody did (Surbhi, Round 2b Part 2) —
  // and since navigation-after-a-click is the most common way a page scrolls
  // itself, that covered most of what this rule exists to reject.
  //
  // A scrollbar drag scrolls WHILE THE BUTTON IS DOWN; a click's navigation
  // scroll happens after the release. So the window is exactly the hold.
  let pointerHeld = false
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (event.isTrusted) pointerHeld = true
    },
    { capture: true, passive: true }
  )
  for (const name of ['pointerup', 'pointercancel']) {
    document.addEventListener(
      name,
      () => {
        pointerHeld = false
      },
      { capture: true, passive: true }
    )
  }

  const markGesture = (event: Event): void => {
    if (!event.isTrusted) return
    if (event.type === 'keydown' && !SCROLL_KEYS.has((event as KeyboardEvent).key)) return
    lastGestureAt = Date.now()
    // Still gesturing, so the scroll is not over — push the deadline back.
    if (scrollTimer) {
      clearTimeout(scrollTimer)
      scrollTimer = setTimeout(recordRest, SCROLL_SETTLE_MS)
    }
  }
  // pointerdown is NOT in this list — see pointerHeld above.
  for (const name of ['wheel', 'touchmove', 'keydown']) {
    document.addEventListener(name, markGesture, { capture: true, passive: true })
  }

  /**
   * The anchor for a recorded scroll: something identifiable near the middle of
   * where the user landed. Preferred over the raw pixel offset because a
   * selector survives a different viewport — "scroll to the Reviews heading"
   * means the same thing on a phone, "scroll to 1200px" does not.
   *
   * But ONLY when the anchor is a real landmark. On a page whose content sits
   * in one tall `<div id="content">`, climbing to "the nearest thing with an
   * id" finds that container from every scroll position — so every step got the
   * same label AND, far worse, the same meaning: "scroll to the top of the
   * content", which is nowhere near where the user actually was. Seventeen
   * steps that all replayed to the same wrong place (Surbhi, Round 2a).
   *
   * So a candidate has to earn it: it must be no taller than the viewport (a
   * container you cannot see the whole of is not a place), and its top must
   * actually be near the resting viewport. Anything else falls back to the
   * pixel offset, which is weaker but at least true.
   */
  // What makes an element a LANDMARK rather than merely a thing that is there,
  // strongest first. The tiers matter: a test id beats a heading, a heading
  // beats a link or a button, and a bare list row is the last resort — the same
  // order the selector engine ranks candidates in, so the anchor a scroll
  // records is one it can also build a durable selector for.
  const ANCHOR_TIERS = [
    '[data-test], [data-testid], [id]',
    'h1, h2, h3, h4, h5, h6, [role="heading"]',
    'a[href], button, [aria-label]',
    'li, tr, article, section'
  ]

  function anchorAtRest(): Element | null {
    const viewportH = window.innerHeight
    const midY = Math.round(viewportH / 2)
    for (const x of [0.5, 0.25, 0.75]) {
      const hit = document.elementFromPoint(Math.round(window.innerWidth * x), midY)
      if (!hit || hit === document.body || hit === document.documentElement) continue

      // Collect the ancestors worth considering: from the element under the
      // midpoint outwards, stopping once a candidate grows taller than the
      // viewport (past that we would be naming a container, not a place).
      const chain: Element[] = []
      let textFallback: Element | null = null
      let node: Element | null = hit
      while (node && node !== document.body && node !== document.documentElement) {
        const rect = node.getBoundingClientRect()
        if (rect.height > viewportH) break
        // Near the resting viewport, not merely somewhere on the page.
        if (rect.height > 0 && rect.top > -viewportH && rect.top < viewportH * 1.5) {
          chain.push(node)
          if (!textFallback && (node.textContent || '').trim().length > 0) textFallback = node
        }
        node = node.parentElement
      }

      // Now look for a landmark, strongest kind first — and look INSIDE each
      // ancestor as well as at it.
      //
      // Looking inside is the part that took two attempts. On SauceDemo the
      // item name (data-test="inventory-item-name") is a SIBLING of the price,
      // not an ancestor of it, so climbing alone never reaches it: it goes
      // price bar → item container → body, finds nothing identified, and
      // settles for the price. That produced `getByText('$49.99Add to cart')` —
      // a scroll step anchored to a PRICE, which breaks the moment the price
      // changes (Surbhi, Round 2c).
      //
      // Asking each ancestor "does anything identified live in here" finds the
      // item name from the item container, which is how a person would name
      // that place: "the Fleece Jacket item", not "the div with the price in it".
      // Is this element on screen at the resting position? A container can hold
      // plenty that is scrolled out of sight or hidden.
      const onScreen = (el: Element): boolean => {
        const r = el.getBoundingClientRect()
        return r.height > 0 && r.top > -viewportH && r.top < viewportH * 1.5
      }

      // Every tier match, self first then descendants, innermost ancestor out.
      const tierMatches = (tier: string): Element[] => {
        const out: Element[] = []
        for (const candidate of chain) {
          if (candidate.matches(tier) && onScreen(candidate)) out.push(candidate)
          for (const inner of Array.prototype.slice.call(candidate.querySelectorAll(tier))) {
            if (onScreen(inner as Element)) out.push(inner as Element)
          }
        }
        return out
      }

      // A landmark has to be recognisable to a PERSON. SauceDemo gives its
      // prices a data-test too, so the price and the item name sit in the same
      // tier — and the price won simply by being nearer the cursor, giving
      // "Scroll to $15.99" (Surbhi, Round 2c). The selector was stable, but the
      // step read like nonsense and would move to a different item the moment
      // prices changed order.
      //
      // "Readable" deliberately means "not purely a number", not "English":
      // anything outside digits, currency and numeric punctuation counts, so a
      // label in any script qualifies while a price, a quantity or a date does
      // not.
      const readable = (el: Element): boolean =>
        /[^\d\s.,:/$€£¥%+\-()]/.test((el.textContent || '').trim())

      let anyMatch: Element | null = null
      for (const tier of ANCHOR_TIERS) {
        const matches = tierMatches(tier)
        if (!anyMatch && matches.length) anyMatch = matches[0]
        const named = matches.find(readable)
        if (named) return named
      }
      // Nothing readable anywhere — an identified element still beats a bare
      // run of text, so take the strongest match we saw.
      if (anyMatch) return anyMatch
      if (textFallback) return textFallback
    }
    return null
  }

  /** Called once the scroll has settled — see SCROLL_SETTLE_MS. */
  function recordRest(): void {
    scrollTimer = null
    if (!recording) return
    const y = Math.round(window.scrollY || window.pageYOffset || 0)
    // Landed where we already are (a wheel nudge against the end of the page,
    // or a bounce) — nothing happened worth a step.
    if (Math.abs(y - lastRecordedY) < 40) return
    const height = document.documentElement.scrollHeight || 0
    const maxY = Math.max(0, height - window.innerHeight)
    // Did this scroll make the page GROW? That is the difference between the
    // two things a run of scrolls can mean, and it is a fact rather than a
    // guess about timing:
    //
    //   · reading down a static page — nothing loads, so the intermediate
    //     positions do not matter and the steps merge into one;
    //   · an infinite-scroll list — each scroll fetches the next page, so each
    //     one is a real step and merging them would replay one load where the
    //     user did three.
    //
    // Half a viewport is the bar. A shifting ad or a lazily-sized image moves
    // the page by tens of pixels; a page of new content moves it by hundreds.
    const grew = lastRecordedHeight > 0 && height - lastRecordedHeight > window.innerHeight / 2
    const loadedMore = grew || undefined
    // WHICH WAY. Reading down a page — the case the merging exists for — is
    // always one direction; a reversal is unambiguously a new action, because
    // you went somewhere and then came back. Without this, scrolling down and
    // then back up merged into a single step and the trip down vanished
    // (Surbhi, Round 2b Part 1).
    const scrollDir: 'up' | 'down' = y >= lastRecordedY ? 'down' : 'up'
    lastRecordedY = y
    lastRecordedHeight = height
    // At the very top or bottom, say so: those two are the intent ("load the
    // next page", "back to the start"), and they hold at any window size.
    if (y <= 4) {
      postToHost('recorder:event', {
        type: 'scroll',
        scrollKind: 'top',
        loadedMore,
        scrollDir,
        frame: FRAME
      })
      return
    }
    if (maxY > 0 && y >= maxY - 4) {
      postToHost('recorder:event', {
        type: 'scroll',
        scrollKind: 'bottom',
        loadedMore,
        scrollDir,
        frame: FRAME
      })
      return
    }
    const anchor = anchorAtRest()
    if (anchor) {
      postToHost('recorder:event', {
        type: 'scroll',
        scrollKind: 'element',
        facts: collectFacts(anchor),
        loadedMore,
        scrollDir,
        frame: FRAME
      })
      return
    }
    postToHost('recorder:event', {
      type: 'scroll',
      scrollKind: 'position',
      value: String(y),
      loadedMore,
      scrollDir,
      frame: FRAME
    })
  }

  const onScroll = (): void => {
    if (!recording || picking) return
    // Not a human scroll — the page scrolled itself. See the note above.
    // A held pointer counts for as long as it is held (a scrollbar drag); a
    // wheel, touch or key counts for a short window after it.
    if (!pointerHeld && Date.now() - lastGestureAt > 1200) return
    if (scrollTimer) clearTimeout(scrollTimer)
    scrollTimer = setTimeout(recordRest, SCROLL_SETTLE_MS)
  }
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })

  // === Phase 4: capture DRAGGING =====================================
  //
  // Two unrelated gestures wear the same name, and a recorder that only knows
  // one of them silently misses half the drags on the web:
  //
  //   · HTML5 drag and drop — draggable="true", dragstart/dragover/drop. The
  //     browser runs the gesture; the page only handles the events.
  //   · a pointer drag — sliders, react-dnd, sortable.js. No dragstart ever
  //     fires; the library is watching pointerdown/move/up itself.
  //
  // Both are captured here, and the step records WHICH one happened, because
  // replay and export have to reproduce the matching one to work at all.

  // --- HTML5 ---
  let dragSource: Element | null = null
  document.addEventListener(
    'dragstart',
    (event) => {
      if (!event.isTrusted || !recording) return
      const el = realTarget(event)
      dragSource = el ? meaningfulTarget(el) : null
    },
    true
  )
  document.addEventListener(
    'drop',
    (event) => {
      if (!event.isTrusted || !recording) return
      const target = realTarget(event)
      if (!dragSource || !target) return
      const dropOn = meaningfulTarget(target)
      postToHost('recorder:event', {
        type: 'drag',
        dragKind: 'html5',
        facts: collectFacts(dragSource),
        targetFacts: collectFacts(dropOn),
        frame: FRAME
      })
      dragSource = null
    },
    true
  )
  // A drag the user abandoned (dropped on nothing) must not leave the source
  // armed — the next unrelated drop would otherwise pair with it.
  document.addEventListener(
    'dragend',
    () => {
      dragSource = null
    },
    true
  )

  // --- pointer drag ---
  // Held down, moved a real distance, released. The distance threshold is what
  // separates a drag from a click with a shaky hand; below it the normal click
  // listener records a click, as it should.
  const DRAG_MIN_PX = 12
  let pressAt: { x: number; y: number; el: Element; frac?: string } | null = null
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!event.isTrusted || !recording || picking) return
      const el = realTarget(event)
      if (!el) return
      const pressEl = meaningfulTarget(el)
      // Where inside the element the press landed, as a fraction of its box.
      // See RecorderStep.dragFrom — this is what makes a slider replay from the
      // knob rather than from the middle of the track.
      const box = pressEl.getBoundingClientRect()
      const frac =
        box.width > 0 && box.height > 0
          ? `${((event.clientX - box.left) / box.width).toFixed(3)},${(
              (event.clientY - box.top) /
              box.height
            ).toFixed(3)}`
          : undefined
      pressAt = { x: event.clientX, y: event.clientY, el: pressEl, frac }
    },
    true
  )
  document.addEventListener(
    'pointerup',
    (event) => {
      if (!event.isTrusted || !recording || picking) return
      const start = pressAt
      pressAt = null
      if (!start) return
      const dx = Math.round(event.clientX - start.x)
      const dy = Math.round(event.clientY - start.y)
      if (Math.abs(dx) < DRAG_MIN_PX && Math.abs(dy) < DRAG_MIN_PX) return
      // An HTML5 drag also produces pointer events; it has already been recorded
      // by the drop listener above, so don't record it twice.
      if (dragSource) return
      const upTarget = realTarget(event)
      const dropOn = upTarget ? meaningfulTarget(upTarget) : null
      // The click this gesture is about to fire is part of the drag, not a
      // separate action — the same suppression the Enter-to-submit path uses.
      suppressClickUntil = Date.now() + 500
      // And the VALUE CHANGE it caused is part of the drag too. Without this a
      // slider records the drag plus a value-setting step, and the exported
      // spec calls .fill() on an input[type=range] — which Playwright refuses.
      // See draggedEl.
      draggedEl = start.el
      suppressChangeUntil = Date.now() + 700
      if (dropOn && dropOn !== start.el) {
        postToHost('recorder:event', {
          type: 'drag',
          dragKind: 'mouse',
          facts: collectFacts(start.el),
          targetFacts: collectFacts(dropOn),
          frame: FRAME
        })
        return
      }
      // Released over the element it started on: a slider or a knob. The
      // DISTANCE is the whole content of the step.
      postToHost('recorder:event', {
        type: 'drag',
        dragKind: 'mouse',
        facts: collectFacts(start.el),
        value: `${dx},${dy}`,
        dragFrom: start.frac,
        frame: FRAME
      })
    },
    true
  )

  return handle
}
