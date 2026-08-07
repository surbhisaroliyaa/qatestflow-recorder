// =====================================================================
// F22 — TURNING AN AI DRAFT INTO STEPS
//
// `draftTestFromStory` asks the model to turn a user story into a list of
// intents. Everything AFTER that answer arrives is ordinary decision-making
// with no model, no network and no Electron in it — so it lives here, where
// it can be tested, instead of inside the IPC handler in index.ts.
//
// The interesting half is the URL. The model is asked for a bare path but
// routinely answers in prose ("Open the login page at /login"), and a step
// whose url is a SENTENCE cannot navigate — it fails at replay, long after
// the mistake was made, looking like the site is broken.
// =====================================================================

import type { DraftResult, DraftStep } from './translator'

function isHttpUrl(u: string): boolean {
  try {
    return /^https?:$/.test(new URL(u).protocol)
  } catch {
    return false
  }
}

/** Shorten a label for the step list — the full text stays in the step. */
export function trunc(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/**
 * Get a navigable URL out of what the model said, and say whether we GUESSED.
 *
 * `guessed` is the honest part: the story often never named a target at all, and
 * a guess presented as fact is a step that navigates somewhere plausible and
 * wrong. The caller marks those ⚠ for the tester to fill in.
 */
export function resolveDraftUrl(text: string, baseUrl?: string): { url: string; guessed: boolean } {
  const t = (text || '').trim()
  // 1. A full URL anywhere in the text wins (stop at whitespace or a ")").
  const urlInProse = t.match(/https?:\/\/[^\s)]+/i)
  if (urlInProse) {
    const found = urlInProse[0].replace(/[.,]+$/, '') // drop trailing punctuation
    if (isHttpUrl(found)) return { url: found, guessed: false }
  }
  // 2. A path: either the WHOLE string, or one embedded in prose. The whole
  //    string only counts when it contains no whitespace — "/login page shows
  //    the form" starts with "/" but is a SENTENCE, and taking it verbatim is
  //    how prose used to end up in the URL. Requiring a word boundary before
  //    the "/" also stops us grabbing the slash inside things like "and/or".
  const path =
    t.startsWith('/') && !/\s/.test(t) ? t : (t.match(/(?:^|\s)(\/[^\s)]+)/)?.[1] ?? '')
  if (baseUrl) {
    try {
      const base = new URL(baseUrl)
      if (path.length > 1) {
        const abs = base.origin + '/' + path.replace(/^\/+|[.,/]+$/g, '')
        if (isHttpUrl(abs)) return { url: abs, guessed: false }
      }
      // 3. A single bare word like "login" -> a path under the current origin;
      //    prose with no path at all -> the current site's root. Both are
      //    GUESSES: the story never actually named a target.
      const fallback =
        t && !t.includes(' ')
          ? base.origin + '/' + t.replace(/^\/+|\/+$/g, '')
          : base.origin + '/'
      if (isHttpUrl(fallback)) return { url: fallback, guessed: true }
    } catch {
      /* unusable base — fall through */
    }
  }
  // 4. No page open to resolve against. A bare path is still the best answer we
  //    have (the step editor can finish it). Prose is NOT — storing a sentence
  //    as a URL is the very thing this function exists to prevent, so leave it
  //    empty and let the flag tell the user to fill it in.
  return { url: path.length > 1 ? path : '', guessed: true }
}

/** One drafted intent as a recorder step. */
export function stepFromDraft(d: DraftStep, baseUrl?: string): {
  step: Record<string, unknown>
  guessed: boolean
} {
  if (d.kind === 'navigate') {
    const target = resolveDraftUrl(d.text, baseUrl)
    return {
      step: { type: 'navigate', url: target.url, label: `Go to ${trunc(d.text)}` },
      guessed: target.guessed
    }
  }
  if (d.kind === 'check') {
    // A claim in words has no deterministic matcher — it's judged by the model
    // at replay (F19), so it stays plain English rather than being invented into
    // a selector nobody verified.
    return {
      step: { type: 'assert', assertKind: 'nl', value: d.text, label: `Check: ${trunc(d.text)}` },
      guessed: false
    }
  }
  // action → a manual pause with the instruction, for the tester to ground.
  // The model never saw the page, so it cannot honestly produce a selector.
  return {
    step: { type: 'wait', waitKind: 'manual', value: d.text, label: `Do: ${trunc(d.text)}` },
    guessed: false
  }
}

/**
 * The whole draft as steps, plus which navigations were guesses.
 *
 * `guessed` is returned ALONGSIDE the steps rather than stamped onto them: it is
 * review-only state, and putting it on the step would let it be saved into the
 * test file and outlive the review it belongs to.
 */
export function stepsFromDraft(
  res: DraftResult,
  baseUrl?: string
): { steps: Record<string, unknown>[]; guessed: number[]; note: string } {
  const guessed: number[] = []
  const steps = res.steps.map((d, i) => {
    const out = stepFromDraft(d, baseUrl)
    if (out.guessed) guessed.push(i)
    return out.step
  })
  const notes = [res.note]
  if (guessed.length) {
    notes.push(
      `${guessed.length} “Go to” step${guessed.length === 1 ? '' : 's'} had no clear address in the story — marked ⚠ below. Set the URL before you replay.`
    )
  }
  return { steps, guessed, note: notes.filter(Boolean).join(' ') }
}
