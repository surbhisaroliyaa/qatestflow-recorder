// =====================================================================
// REPLAY ENGINE (script builder)
// We replay steps INSIDE our embedded browser, which has no Playwright
// driving it. So for each step we inject a small piece of JavaScript that
// finds the element and performs the action.
//
// Day 10 upgrade — replay no longer follows ONLY CSS selectors. Each step
// carries a ranked candidate ladder (Day 4): testId/id/name/placeholder have a
// CSS form, but the strongest human-friendly ones (role + accessible name,
// visible text) do NOT. So the injected finder now resolves those semantically
// too — the same idea as Playwright's getByRole / getByText. This is what makes
// replay survive REAL sites that have no test-ids (e.g. the-internet's menu),
// instead of falling back to a dumb "first <a> on the page".
// =====================================================================

export interface ReplayCandidate {
  kind?: string
  score: number
  css: string | null
  role?: string
  name?: string
  text?: string
  nth?: number // Day 10(b): which of several matches is ours (0-based)
  pinned?: boolean // Day 10(c): hand-picked by the user — try this one FIRST
}

export interface ReplayStep {
  type: string
  // The human-readable name of the target element. Replay locates by the
  // candidate ladder, not this — but F4 self-heal re-finds a broken element by
  // its recorded label, so it's declared here (steps have always carried it).
  label?: string
  url?: string
  value?: string
  key?: string // for `press` steps — the key pressed (e.g. 'Enter')
  dialogKind?: string // Day 16: 'alert' | 'confirm' | 'prompt' for `dialog` steps
  assertKind?: string // for `assert` steps — which check to make (Day 9)
  attrName?: string // for `attribute` asserts — which attribute to check (Day 11)
  secret?: boolean
  disabled?: boolean // turned off in the editor — skipped during replay
  // F26 (conditional): this step MAY be absent (an optional cookie banner /
  // popup). Replay uses a shorter find timeout for it, and a failure is treated
  // as a skip (not a test failure) — see the run loop in index.ts.
  optional?: boolean
  baselineId?: string // Day 19: a `snapshot` step's baseline image id
  selector?: string
  candidates?: ReplayCandidate[]
  // Day 15: when set, the element lives inside an <iframe>. The action script
  // is unchanged (it's all document-relative) — main just runs it in the
  // matching frame's document instead of the top page. See FrameRef.
  frame?: { url: string; name?: string }[]
  // Day 17 (multiple windows): recording-local tab this step runs in (0 = the
  // starting tab). Replay switches to this tab before running the step.
  windowId?: number
  // Day 17: set on the click/press that OPENS a new tab — the ordinal it opens.
  // Replay arms a wait-for-popup before the action and binds the new tab to it.
  opensWindow?: number
  // F4 (self-heal 2.0): stamped when main auto-heals this step's broken selector
  // mid-run. Carried on the in-memory step so the trace/report can mark it.
  healedByAi?: { at: string; signals: string[]; score: number }
}

// === The in-page resolver ===========================================
// Injected as the first part of every action script. Defines findByCandidate(),
// which knows how to locate an element by CSS *or* by ARIA role + accessible
// name *or* by visible text — covering candidates that have no CSS form.
function resolverHelpers(): string {
  return `
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const isVisible = (n) => !!(n && (n.offsetWidth || n.offsetHeight || n.getClientRects().length));

    // Shadow-piercing querySelectorAll (Day 15.5): all matches in this root, in
    // DOM order, then (recursively) matches inside every OPEN shadow root. On a
    // page with no shadow DOM this returns exactly what a plain querySelectorAll
    // would, so existing behaviour is unchanged.
    // MIRROR WARNING: identical to deepQueryAll in src/main/observerSource.ts —
    // capture-time dup counting and replay finding MUST traverse in the SAME
    // order or a recorded .nth(i) lands on the wrong element.
    const deepQueryAll = (sel, root) => {
      root = root || document;
      let out;
      try { out = Array.prototype.slice.call(root.querySelectorAll(sel)); }
      catch (e) { return []; }
      const hosts = root.querySelectorAll('*');
      for (let i = 0; i < hosts.length; i++) {
        const sr = hosts[i].shadowRoot;
        if (sr) { const inner = deepQueryAll(sel, sr); for (let j = 0; j < inner.length; j++) out.push(inner[j]); }
      }
      return out;
    };

    // Approximate the elements that carry each ARIA role (explicit role="" or
    // the role implied by the tag), mirroring how getByRole searches.
    const ROLE_SELECTORS = {
      button: 'button, [role=button], input[type=submit], input[type=button], input[type=reset]',
      link: 'a[href], [role=link]',
      textbox: 'input:not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]), textarea, [role=textbox], [contenteditable=""], [contenteditable=true]',
      combobox: 'select, [role=combobox]',
      checkbox: 'input[type=checkbox], [role=checkbox]',
      radio: 'input[type=radio], [role=radio]',
      img: 'img, [role=img]'
    };

    // The element's "accessible name" — roughly what a user would call it.
    const accName = (el) => {
      if (!el) return '';
      const aria = el.getAttribute && el.getAttribute('aria-label');
      if (aria) return norm(aria);
      const tag = el.tagName;
      if (tag === 'INPUT' && /^(submit|button|reset)$/i.test(el.type) && el.value) return norm(el.value);
      if (tag === 'IMG' && el.alt) return norm(el.alt);
      const innerImg = el.querySelector && el.querySelector('img[alt]');
      if (innerImg && innerImg.alt) return norm(innerImg.alt);
      const text = norm(el.textContent);
      if (text) return text;
      const title = el.getAttribute && el.getAttribute('title');
      return title ? norm(title) : '';
    };

    // MIRROR WARNING (Day 10b): byRole/byText must walk the SAME match lists
    // that capture-time duplicate counting walks (collectDup in
    // src/main/observerSource.ts) — otherwise a recorded .nth(i) lands on the
    // wrong element. Change one → change both. (Day 15.5: both now pierce
    // shadow DOM via deepQueryAll — keep that identical on both sides too.)

    // All elements matching role + accessible name, in DOM order: exact-name
    // matches win; only if there are none, fall back to "name contains".
    const byRoleAll = (role, name) => {
      const sel = ROLE_SELECTORS[role] || ('[role=' + role + ']');
      const nodes = deepQueryAll(sel, document);
      const want = norm(name);
      if (!want) return nodes;
      const exact = nodes.filter((n) => accName(n) === want);
      if (exact.length) return exact;
      return nodes.filter((n) => accName(n).includes(want));
    };

    // All elements whose trimmed visible text equals the target, keeping only
    // the INNERMOST of nested matches (the <span> inside the <a>, not both),
    // in DOM order.
    const byTextAll = (text) => {
      const want = norm(text);
      if (!want) return [];
      const nodes = deepQueryAll(
        'a, button, [role=button], [role=link], label, span, li, p, td, th, h1, h2, h3, h4, h5, h6, div',
        document
      );
      const matches = nodes.filter((n) => norm(n.textContent) === want);
      return matches.filter((m) => !matches.some((o) => o !== m && m.contains(o)));
    };

    // Resolve ONE candidate to an element (or null). When capture counted
    // duplicates, c.nth says which of the matches is ours.
    const findByCandidate = (c) => {
      const at = c.nth || 0;
      try {
        if (c.css) return deepQueryAll(c.css, document)[at] || null;
        if (c.kind === 'role' && c.role) return byRoleAll(c.role, c.name)[at] || null;
        if (c.kind === 'text' && c.text) return byTextAll(c.text)[at] || null;
      } catch (e) { /* malformed selector — treat as no match */ }
      return null;
    };`
}

// Smart wait + ladder search: poll up to 8s, and on each tick try the
// candidates strongest-first, returning the first one that resolves to a
// visible, enabled (actionable) element. Mirrors how real automation waits AND
// how it falls back across locator strategies.
//
// allowHidden (hover steps only): a hover TRIGGER may only be findable through
// a child that is itself hover-hidden (e.g. the caption text inside a card) —
// you'd need the hover to find the hover. So after a short grace period we
// accept a hidden match too; the hover action then climbs to its nearest
// VISIBLE ancestor and points the mouse there, like a human would.
// The candidate ladder, ready to search: resolver helpers + the sorted,
// bare-tag-filtered `cands` list. Shared by the element finder below AND the
// checks that judge the ladder differently (hidden / count, Day 11).
function ladderPrelude(candidates: ReplayCandidate[]): string {
  return (
    resolverHelpers() +
    `
    const raw = ${JSON.stringify(candidates ?? [])};
    // Drop the bare-tag last resort (css 'a' / 'div' / 'button' on its own): it
    // matches the FIRST such element on the page, almost never the recorded one.
    // Failing honestly beats acting on the wrong element and reporting success.
    const isBareTag = (c) => !!(c.css && /^[a-zA-Z][a-zA-Z0-9]*$/.test(c.css.trim()));
    // Hand-picked (pinned) candidate first, then strongest score (Day 10c).
    const cands = raw.filter((c) => !isBareTag(c)).sort(
      (a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || ((b.score || 0) - (a.score || 0))
    );
    if (raw.length && !cands.length) {
      return { ok: false, error: 'No reliable selector for this element (no stable id / role / text was captured) — skipped to avoid acting on the wrong thing' };
    }`
  )
}

function findPrelude(candidates: ReplayCandidate[], allowHidden = false, timeoutMs = 8000): string {
  return (
    ladderPrelude(candidates) +
    `
    const ALLOW_HIDDEN = ${allowHidden ? 'true' : 'false'};
    const deadline = Date.now() + ${timeoutMs};
    let el = null, everFound = false, hidden = null, hiddenAt = 0;
    while (Date.now() < deadline) {
      for (const c of cands) {
        const cand = findByCandidate(c);
        if (cand) {
          everFound = true;
          if (!hidden) { hidden = cand; hiddenAt = Date.now(); }
          if (isVisible(cand) && !cand.disabled) { el = cand; break; }
        }
      }
      if (el) break;
      // Hover triggers: prefer a visible match, but settle for a hidden one
      // after 600ms instead of burning the whole 8s wait.
      if (ALLOW_HIDDEN && hidden && Date.now() - hiddenAt > 600) { el = hidden; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!el) {
      // Three distinct failures, kept distinct because F26 (optional steps)
      // must tell "the user couldn't reach this" apart from "the app is
      // broken":
      //   not found        — never in the DOM        → absent
      //   never visible    — in the DOM, display:none / zero-size → absent
      //   stayed disabled  — visible on screen, but not interactive → A BUG
      // An optional step skips on the first two and FAILS on the third: a
      // visible-but-disabled control is something the user can see and can't
      // use, and silently skipping it would hide a real defect.
      //
      // Visibility is tested FIRST: an element that is both hidden and
      // disabled counts as hidden, because the user can't reach it either way.
      let error;
      if (!everFound) {
        error = 'Element not found (may have changed or not be on this page)';
      } else if (hidden && !isVisible(hidden)) {
        error = 'Element found but never became visible';
      } else {
        error = 'Element found but stayed disabled';
      }
      return { ok: false, error };
    }
    el.scrollIntoView({ block: 'center' });`
  )
}

// Build the full injectable script (an async IIFE returning {ok, error?}).
export function buildActionScript(step: ReplayStep): string {
  // PAGE-level checks (Day 11) have NO element — they read location.href /
  // document.title directly, so they skip the whole find-the-element prelude.
  // Same polling idea as element checks: pages settle asynchronously.
  if (
    step.type === 'assert' &&
    (step.assertKind === 'url-contains' || step.assertKind === 'title')
  ) {
    const want = JSON.stringify(step.value ?? '')
    const isUrl = step.assertKind === 'url-contains'
    const read = isUrl
      ? `({ pass: location.href.includes(want), actual: location.href })`
      : `({ pass: document.title.replace(/\\s+/g, ' ').trim() === want, actual: document.title })`
    const wants = isUrl ? `'URL to contain "'` : `'page title to be "'`
    return `(async () => {
      const want = ${want};
      const read = () => ${read};
      const deadline = Date.now() + 3000;
      let last = read();
      while (!last.pass && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
        last = read();
      }
      if (last.pass) return { ok: true };
      return { ok: false, error: 'Expected ' + ${wants} + want + '" — actual: "' + String(last.actual).slice(0, 120) + '"' };
    })()`
  }

  // HIDDEN check (Day 11): inverted logic, so it can't share the normal
  // finder — that one WAITS for the element to become visible, which is the
  // exact opposite of what we're asserting. Pass = no candidate resolves to a
  // visible element; "not in the DOM at all" counts as hidden too (same
  // semantics as Playwright's toBeHidden()).
  if (step.type === 'assert' && step.assertKind === 'hidden') {
    return `(async () => {${ladderPrelude(step.candidates ?? [])}
      const read = () => {
        for (const c of cands) {
          const el = findByCandidate(c);
          if (el && isVisible(el)) return false;
        }
        return true;
      };
      const deadline = Date.now() + 3000;
      let pass = read();
      while (!pass && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
        pass = read();
      }
      if (pass) return { ok: true };
      return { ok: false, error: 'Expected element to be hidden — it is still visible' };
    })()`
  }

  // COUNT check (Day 11): a GROUP check, not a single-element one. Count ALL
  // matches of the strongest candidate, ignoring its .nth — nth answers
  // "which one is ours", but here the group size IS the assertion.
  if (step.type === 'assert' && step.assertKind === 'count') {
    const want = Math.max(0, parseInt(step.value ?? '0', 10) || 0)
    return `(async () => {${ladderPrelude(step.candidates ?? [])}
      const want = ${want};
      const countAll = (c) => {
        try {
          if (c.css) return document.querySelectorAll(c.css).length;
          if (c.kind === 'role' && c.role) return byRoleAll(c.role, c.name).length;
          if (c.kind === 'text' && c.text) return byTextAll(c.text).length;
        } catch (e) { /* malformed selector — count as zero */ }
        return 0;
      };
      const read = () => (cands.length ? countAll(cands[0]) : 0);
      const deadline = Date.now() + 3000;
      let actual = read();
      while (actual !== want && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
        actual = read();
      }
      if (actual === want) return { ok: true };
      return { ok: false, error: 'Expected ' + want + ' matching element(s) — actual: ' + actual };
    })()`
  }

  let action: string

  switch (step.type) {
    case 'click':
      // Day 16(+): submitting a form that contains a file input requires a
      // TRUSTED user gesture — Chromium silently blocks a synthetic el.click()
      // there (a guard against pages exfiltrating files without real user
      // action). So when this click is a submit control inside a file-upload
      // form, hand its center coordinates back and let main dispatch a real
      // CDP mouse click (like Playwright). Every other click stays on the
      // robust, coordinate-free el.click().
      // Day 16(+): a submit control inside a FILE-UPLOAD form won't actually
      // submit via a synthetic el.click() here (the file input changes how the
      // click resolves) — so submit the form itself with requestSubmit(), which
      // behaves as if this button was pressed (validation + submit event), with
      // form.submit() as a last-resort fallback. Every other click stays on the
      // normal, robust el.click().
      action = `
        const submitLike = (el.tagName === 'BUTTON' && el.type !== 'button' && el.type !== 'reset')
          || (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'image'));
        if (submitLike && el.form && el.form.querySelector('input[type=file]')) {
          if (el.form.requestSubmit) { el.form.requestSubmit(el); } else { el.form.submit(); }
          return { ok: true };
        }
        el.click();
        return { ok: true };`
      break

    case 'type': {
      const v = JSON.stringify(step.value ?? '')
      // Use the native value setter so frameworks like React notice the change.
      action = `
        el.focus();
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const d = Object.getOwnPropertyDescriptor(proto, 'value');
        if (d && d.set) { d.set.call(el, ${v}); } else { el.value = ${v}; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };`
      break
    }

    case 'select': {
      const v = JSON.stringify(step.value ?? '')
      // We recorded the option's VISIBLE text, so match by text then set value.
      action = `
        const opt = Array.from(el.options).find((o) => o.text.trim() === ${v});
        if (!opt) return { ok: false, error: 'Option not found: ' + ${v} };
        el.value = opt.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };`
      break
    }

    case 'hover': {
      // A synthetic mouseover event CANNOT switch on CSS :hover — only real
      // input can. So the page script just locates the trigger and returns its
      // center; main then sends a REAL mouseMove via webContents.sendInputEvent,
      // which sets :hover exactly like a human moving the mouse.
      // If the ladder resolved a hover-HIDDEN child (allowHidden above), climb
      // to the nearest visible ancestor — that's the surface a human points at.
      action = `
        let target = el;
        while (target && !isVisible(target)) target = target.parentElement;
        if (!target) return { ok: false, error: 'Hover target has no visible ancestor to point at' };
        target.scrollIntoView({ block: 'center' });
        const r = target.getBoundingClientRect();
        return { ok: true, hoverAt: { x: r.left + r.width / 2, y: r.top + r.height / 2 } };`
      break
    }

    case 'assert': {
      // A check, not an action. Conditions are POLLED for up to 3s (pages
      // settle asynchronously — same reason Playwright's expect() retries),
      // and a failure reports expected vs ACTUAL — the evidence a human (or
      // Day 13's AI translator) needs to understand what went wrong.
      const want = JSON.stringify(step.value ?? '')
      const kind = JSON.stringify(step.assertKind ?? 'visible')
      const attr = JSON.stringify(step.attrName ?? '')
      action = `
        const want = ${want};
        const kind = ${kind};
        const attr = ${attr};
        const read = () => {
          if (kind === 'visible') return { pass: isVisible(el), actual: isVisible(el) ? 'visible' : 'hidden' };
          if (kind === 'enabled') return { pass: !el.disabled, actual: el.disabled ? 'disabled' : 'enabled' };
          if (kind === 'disabled') return { pass: !!el.disabled, actual: el.disabled ? 'disabled' : 'enabled' };
          if (kind === 'checked') return { pass: !!el.checked, actual: el.checked ? 'checked' : 'unchecked' };
          if (kind === 'unchecked') return { pass: !el.checked, actual: el.checked ? 'checked' : 'unchecked' };
          if (kind === 'focused') return { pass: document.activeElement === el, actual: document.activeElement === el ? 'focused' : 'not focused' };
          if (kind === 'editable') {
            const tag = el.tagName;
            // "Editable" only means something for elements a user can type in.
            if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && !el.isContentEditable) {
              return { pass: false, actual: 'not an editable element type (' + tag.toLowerCase() + ')' };
            }
            const pass = !el.disabled && !el.readOnly;
            return { pass, actual: el.disabled ? 'disabled' : el.readOnly ? 'readonly' : 'editable' };
          }
          if (kind === 'empty') {
            // A field is empty when its VALUE is empty; anything else when it
            // has no visible text (same idea as Playwright's toBeEmpty()).
            const tag = el.tagName;
            const v = (tag === 'INPUT' || tag === 'TEXTAREA') ? String(el.value || '') : norm(el.textContent);
            return { pass: v === '', actual: v === '' ? 'empty' : v };
          }
          if (kind === 'attribute') {
            const a = el.getAttribute(attr);
            return { pass: a === want, actual: a === null ? '(attribute missing)' : a };
          }
          if (kind === 'class') {
            return { pass: el.classList.contains(want), actual: el.className || '(no classes)' };
          }
          if (kind === 'value') { const v = el.value !== undefined ? String(el.value) : ''; return { pass: v === want, actual: v }; }
          const t = norm(el.textContent);
          if (kind === 'text-contains') return { pass: t.includes(want), actual: t };
          return { pass: t === want, actual: t }; // text-equals
        };
        const checkUntil = Date.now() + 3000;
        let last = read();
        while (!last.pass && Date.now() < checkUntil) {
          await new Promise((r) => setTimeout(r, 150));
          last = read();
        }
        if (last.pass) return { ok: true };
        const wants = {
          'visible': 'be visible',
          'enabled': 'be enabled',
          'disabled': 'be disabled',
          'checked': 'be checked',
          'unchecked': 'be unchecked',
          'focused': 'be focused',
          'editable': 'be editable',
          'empty': 'be empty',
          'attribute': 'have attribute ' + attr + ' = "' + want + '"',
          'class': 'have class "' + want + '"',
          'value': 'have value "' + want + '"',
          'text-equals': 'have text "' + want + '"',
          'text-contains': 'contain text "' + want + '"'
        }[kind] || kind;
        return { ok: false, error: 'Expected element to ' + wants + ' — actual: "' + String(last.actual).slice(0, 120) + '"' };`
      break
    }

    case 'press': {
      const k = JSON.stringify(step.key ?? 'Enter')
      // We can't drive the real keyboard, so we (1) dispatch synthetic key
      // events — these fire the site's OWN keydown handlers (covers JS-driven
      // search boxes) — and (2) for Enter, also call form.requestSubmit(),
      // because a *synthetic* keydown does NOT trigger native form submission.
      action = `
        el.focus();
        const opts = { key: ${k}, code: ${k}, keyCode: 13, which: 13, bubbles: true };
        el.dispatchEvent(new KeyboardEvent('keydown', opts));
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
        if (${k} === 'Enter') {
          const form = el.form || (el.closest && el.closest('form'));
          if (form) {
            try { form.requestSubmit ? form.requestSubmit() : form.submit(); } catch (e) {}
          }
        }
        return { ok: true };`
      break
    }

    default:
      action = `return { ok: false, error: 'Unsupported step type: ' + ${JSON.stringify(step.type)} };`
  }

  // Hover triggers AND assertion targets may legitimately be hidden/disabled
  // right now (you must be able to FIND a hidden element to report "it's
  // hidden") — so both resolve tolerantly; the action itself judges the state.
  const tolerant = step.type === 'hover' || step.type === 'assert'
  // F26: an optional step's element may simply not be there — don't burn the
  // full 8s wait on it; 2.5s is plenty to confirm presence, then it skips.
  const findTimeout = step.optional ? 2500 : 8000
  return `(async () => {${findPrelude(step.candidates ?? [], tolerant, findTimeout)}${action}\n})()`
}

// === F4 (self-heal 2.0): locate a step's element for fingerprinting =====
// During a GREEN run we snapshot each element's POSITION (rect) + a pixel crop
// so a later failure can heal by "where it was" + "what it looked like", not
// just its name. This finds the step's element by the SAME candidate ladder
// replay uses and returns its viewport rect + the viewport size (so main can
// normalise the rect and clip a screenshot to it). Short poll: the page may
// still be settling as we go into the step. null rect = couldn't locate it.
export function buildLocateRectScript(step: ReplayStep): string {
  return `(async () => {${ladderPrelude(step.candidates ?? [])}
    const deadline = Date.now() + 1500;
    let el = null;
    while (Date.now() < deadline) {
      for (const c of cands) {
        const cand = findByCandidate(c);
        if (cand && isVisible(cand)) { el = cand; break; }
      }
      if (el) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!el) return { rect: null, vw: window.innerWidth, vh: window.innerHeight };
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    return {
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      vw: window.innerWidth,
      vh: window.innerHeight
    };
  })()`
}

// === Failure screenshot annotation (Day 12.9, Surbhi's idea) =========
// Drawn onto the page just before the failure screenshot is captured and
// erased right after — the markings exist only inside the PNG, the live page
// (which the Day 12 recovery pause shows) stays clean. Two layers:
//  1. A red BANNER with the error text — every failure screenshot explains
//     itself, even when there's no element to point at (not-found, page-level
//     checks, navigate failures).
//  2. A red OUTLINE around the culprit element, when the step's ladder can
//     still resolve one (assert mismatches / wrong-state failures — the
//     element exists, its state is just wrong). Scrolled into view first:
//     capturePage photographs only the viewport.
export function buildFailureMarkScript(step: ReplayStep, error: string): string {
  const text = JSON.stringify('✗ ' + error.replace(/\s+/g, ' ').slice(0, 140))
  const banner = `
    if (document.body) {
      const banner = document.createElement('div');
      banner.id = '__qaflow_fail_banner';
      banner.textContent = ${text};
      banner.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;' +
        'top:10px;left:50%;transform:translateX(-50%);max-width:85%;padding:8px 14px;' +
        'background:#b2423e;color:#fff;border-radius:6px;' +
        'font:600 13px/1.4 -apple-system,"Segoe UI",Roboto,sans-serif;' +
        'box-shadow:0 2px 12px rgba(0,0,0,0.5);';
      document.body.appendChild(banner);
    }`
  // No candidates = nothing to outline (navigate / wait / page-level checks).
  // NOTE: banner comes FIRST — ladderPrelude can return early ("no reliable
  // selector"), and the banner must already be on the page by then.
  const outline = step.candidates?.length
    ? `${ladderPrelude(step.candidates)}
    let el = null;
    for (const c of cands) { el = findByCandidate(c); if (el) break; }
    if (el && document.body) {
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const box = document.createElement('div');
      box.id = '__qaflow_fail_box';
      box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;' +
        'left:' + (r.left - 4) + 'px;top:' + (r.top - 4) + 'px;' +
        'width:' + (r.width + 8) + 'px;height:' + (r.height + 8) + 'px;' +
        'border:3px solid #e0524d;border-radius:4px;' +
        'box-shadow:0 0 0 3px rgba(224,82,77,0.35),0 0 18px rgba(224,82,77,0.6);';
      document.body.appendChild(box);
    }`
    : ''
  return `(() => { try {${banner}${outline}
    } catch (e) { /* decoration only — never block the screenshot */ }
    return { ok: true };
  })()`
}

// Erase the markings after capture so the live page stays clean.
export function removeFailureMarkScript(): string {
  return `(() => {
    for (const id of ['__qaflow_fail_banner', '__qaflow_fail_box']) {
      const n = document.getElementById(id);
      if (n) n.remove();
    }
    return { ok: true };
  })()`
}
