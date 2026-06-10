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
}

export interface ReplayStep {
  type: string
  url?: string
  value?: string
  key?: string // for `press` steps — the key pressed (e.g. 'Enter')
  secret?: boolean
  disabled?: boolean // turned off in the editor — skipped during replay
  selector?: string
  candidates?: ReplayCandidate[]
}

// === The in-page resolver ===========================================
// Injected as the first part of every action script. Defines findByCandidate(),
// which knows how to locate an element by CSS *or* by ARIA role + accessible
// name *or* by visible text — covering candidates that have no CSS form.
function resolverHelpers(): string {
  return `
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const isVisible = (n) => !!(n && (n.offsetWidth || n.offsetHeight || n.getClientRects().length));

    // Approximate the elements that carry each ARIA role (explicit role="" or
    // the role implied by the tag), mirroring how getByRole searches.
    const ROLE_SELECTORS = {
      button: 'button, [role=button], input[type=submit], input[type=button], input[type=reset]',
      link: 'a[href], [role=link]',
      textbox: 'input:not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]), textarea, [role=textbox], [contenteditable=""], [contenteditable=true]',
      combobox: 'select, [role=combobox]',
      checkbox: 'input[type=checkbox], [role=checkbox]',
      radio: 'input[type=radio], [role=radio]'
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

    // Find by ARIA role + accessible name: exact name first, then "contains".
    const byRole = (role, name) => {
      const sel = ROLE_SELECTORS[role] || ('[role=' + role + ']');
      let nodes;
      try { nodes = Array.from(document.querySelectorAll(sel)); } catch (e) { return null; }
      const want = norm(name);
      if (!want) return nodes[0] || null;
      return nodes.find((n) => accName(n) === want)
        || nodes.find((n) => accName(n).includes(want))
        || null;
    };

    // Find by visible text — pick the MOST SPECIFIC element whose own trimmed
    // text equals the target (fewest element descendants), so we click the link
    // itself, not the giant container that happens to contain the text.
    const byText = (text) => {
      const want = norm(text);
      if (!want) return null;
      let nodes;
      try {
        nodes = Array.from(document.querySelectorAll(
          'a, button, [role=button], [role=link], label, span, li, p, td, th, h1, h2, h3, h4, div'
        ));
      } catch (e) { return null; }
      const matches = nodes.filter((n) => norm(n.textContent) === want);
      matches.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
      return matches[0] || null;
    };

    // Resolve ONE candidate to an element (or null).
    const findByCandidate = (c) => {
      try {
        if (c.css) return document.querySelector(c.css);
        if (c.kind === 'role' && c.role) return byRole(c.role, c.name);
        if (c.kind === 'text' && c.text) return byText(c.text);
      } catch (e) { /* malformed selector — treat as no match */ }
      return null;
    };`
}

// Smart wait + ladder search: poll up to 8s, and on each tick try the
// candidates strongest-first, returning the first one that resolves to a
// visible, enabled (actionable) element. Mirrors how real automation waits AND
// how it falls back across locator strategies.
function findPrelude(candidates: ReplayCandidate[]): string {
  return (
    resolverHelpers() +
    `
    const raw = ${JSON.stringify(candidates ?? [])};
    // Drop the bare-tag last resort (css 'a' / 'div' / 'button' on its own): it
    // matches the FIRST such element on the page, almost never the recorded one.
    // Failing honestly beats clicking the wrong element and reporting success.
    const isBareTag = (c) => !!(c.css && /^[a-zA-Z][a-zA-Z0-9]*$/.test(c.css.trim()));
    const cands = raw.filter((c) => !isBareTag(c)).sort((a, b) => (b.score || 0) - (a.score || 0));
    if (raw.length && !cands.length) {
      return { ok: false, error: 'No reliable selector for this element (no stable id / role / text was captured) — skipped to avoid clicking the wrong thing' };
    }
    const deadline = Date.now() + 8000;
    let el = null, everFound = false;
    while (Date.now() < deadline) {
      for (const c of cands) {
        const cand = findByCandidate(c);
        if (cand) {
          everFound = true;
          if (isVisible(cand) && !cand.disabled) { el = cand; break; }
        }
      }
      if (el) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!el) return {
      ok: false,
      error: everFound
        ? 'Element found but never became visible/enabled'
        : 'Element not found (may have changed or not be on this page)'
    };
    el.scrollIntoView({ block: 'center' });`
  )
}

// Build the full injectable script (an async IIFE returning {ok, error?}).
export function buildActionScript(step: ReplayStep): string {
  let action: string

  switch (step.type) {
    case 'click':
      action = `el.click(); return { ok: true };`
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

  return `(async () => {${findPrelude(step.candidates ?? [])}${action}\n})()`
}
