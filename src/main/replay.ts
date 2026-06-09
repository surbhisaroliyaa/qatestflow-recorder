// =====================================================================
// REPLAY ENGINE (script builder)
// We replay steps INSIDE our embedded browser, which has no Playwright
// driving it. So for each step we inject a small piece of JavaScript that
// finds the element by a CSS selector and performs the action.
//
// Each recorded step carries a ranked candidate ladder (Day 4); we pick the
// most stable candidate that has a usable CSS selector.
// =====================================================================

export interface ReplayStep {
  type: string
  url?: string
  value?: string
  secret?: boolean
  selector?: string
  candidates?: Array<{ score: number; css: string | null }>
}

// Choose the best (highest-score) candidate that can be expressed as CSS.
// Role-/text-based candidates have css = null and can't be used here.
export function pickCss(step: ReplayStep): string | null {
  if (!step.candidates) return null
  const usable = step.candidates
    .filter((c) => typeof c.css === 'string' && c.css.length > 0)
    .sort((a, b) => b.score - a.score)
  return usable.length ? (usable[0].css as string) : null
}

// Smart wait: poll up to 8s for the element to be not just present, but
// actually ACTIONABLE — visible (has layout) and not disabled. An element can
// exist in the DOM while still hidden or disabled mid-page-load, and clicking
// it then would fail; this mirrors how real automation waits.
function findPrelude(css: string): string {
  return `
    const sel = ${JSON.stringify(css)};
    const deadline = Date.now() + 8000;
    const isVisible = (n) => !!(n && (n.offsetWidth || n.offsetHeight || n.getClientRects().length));
    let el = null, everFound = false;
    while (Date.now() < deadline) {
      const cand = document.querySelector(sel);
      if (cand) everFound = true;
      if (cand && isVisible(cand) && !cand.disabled) { el = cand; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!el) return {
      ok: false,
      error: (everFound
        ? 'Element found but never became visible/enabled: '
        : 'Element not found (may have changed or not be on this page): ') + sel
    };
    el.scrollIntoView({ block: 'center' });`
}

// Build the full injectable script (an async IIFE returning {ok, error?}).
export function buildActionScript(step: ReplayStep, css: string): string {
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

    default:
      action = `return { ok: false, error: 'Unsupported step type: ' + ${JSON.stringify(step.type)} };`
  }

  return `(async () => {${findPrelude(css)}${action}\n})()`
}
