// =====================================================================
// F20 — EDGE-CASE VERDICTS AND REPORT
//
// Pulled out of App.tsx because none of it needs React: given a finished edge
// run it decides each variant's verdict, explains how that verdict was reached,
// and builds the paste-ready markdown. Pure in, pure out.
//
// That matters more here than for most of this file. These functions decide
// whether the app under test ACCEPTED a hostile input -- the most consequential
// claim this product makes -- and one of them once reported fourteen rejections
// as fourteen vulnerabilities, the exact opposite reading of the same evidence.
// Being testable without launching Electron is the point.
// =====================================================================

/** The shape buildEdgeReport needs from a finished run. Structural, so this
 *  module does not depend on the renderer's state types. */
export interface EdgeRunLike {
  hasAssertion: boolean
  successUrl?: string
  startUrl?: string
  results: {
    case: {
      baseline?: boolean
      fieldLabel: string
      edgeLabel: string
      value: string
      hint: string
    }
    ok: boolean
    finalUrl?: string
    verdict?: 'accepted' | 'rejected' | 'unknown'
  }[]
}

// F20 verdict for one variant.
// 'accepted' = the app took the hostile input and still reached success (a bug
// to investigate — worst for injection). 'rejected' = the app blocked it
// (good). 'unknown' = we cannot tell, and MUST NOT guess.
//
// ORIGINALLY this was just `ok ? accepted : rejected`, which is only meaningful
// when the test HAS a success check. Without one, `ok` means "the steps
// completed" — and typing garbage into a field and clicking Login always
// complete, whatever the app says next. So `ok` carried NO information, and
// SauceDemo rejecting all 14 hostile inputs was reported as 14 ACCEPTED, with
// the SQL injection flagged as a serious vulnerability. Manufacturing a
// security finding is the worst thing a QA tool can do.
//
// Three sources of truth, most authoritative first:
//   1. a success rule the user typed  — explicit beats inferred, always
//   2. the test's own ✓ check         — what they actually asserted
//   3. the BASELINE's final URL       — valid input lands on the post-login
//      page; a variant that ends elsewhere was rejected. No hand-written
//      assertion needed, which is the whole point: nobody adds one before
//      running edge cases for the first time.
// Only when none of the three can speak do we say 'unknown'.
export const normEdgeUrl = (u?: string): string => {
  if (!u) return ''
  try {
    const x = new URL(u)
    // origin + path only. Query/hash routinely carry per-run noise (tokens,
    // scroll anchors) that would make identical pages compare as different.
    return (x.origin + x.pathname).replace(/\/+$/, '').toLowerCase()
  } catch {
    return u.trim().replace(/\/+$/, '').toLowerCase()
  }
}
export type EdgeBasis = 'stored' | 'rule' | 'check' | 'url' | 'none'
export const edgeVerdict = (
  r: { ok: boolean; finalUrl?: string; verdict?: 'accepted' | 'rejected' | 'unknown' },
  ctx: {
    baselineOk: boolean
    hasAssertion: boolean
    successUrl: string
    startUrl: string
    baselineUrl: string
  }
): { verdict: 'accepted' | 'rejected' | 'unknown'; basis: EdgeBasis } => {
  // A re-opened SAVED run carries the verdict it was given the day it ran.
  // Reuse it: stored evidence must not change meaning later just because the
  // judging rules improved, and the context it was judged with (the success
  // rule, the start URL) isn't all persisted.
  if (r.verdict) return { verdict: r.verdict, basis: 'stored' }
  // Baseline broken → the valid input didn't even work, so nothing below means
  // anything.
  if (!ctx.baselineOk) return { verdict: 'unknown', basis: 'none' }

  // 1. An explicit rule the user typed.
  const rule = ctx.successUrl.trim().toLowerCase()
  if (rule) {
    if (!r.finalUrl) return { verdict: 'unknown', basis: 'none' }
    return {
      verdict: r.finalUrl.toLowerCase().includes(rule) ? 'accepted' : 'rejected',
      basis: 'rule'
    }
  }

  // 2. The test's own check.
  if (ctx.hasAssertion) return { verdict: r.ok ? 'accepted' : 'rejected', basis: 'check' }

  // 3. Inferred from the baseline. Usable ONLY if success visibly moves the
  //    page — on an app that stays put (a SPA swapping content in place) the
  //    baseline ends where it started, the signal can't discriminate, and
  //    saying so beats guessing.
  const base = normEdgeUrl(ctx.baselineUrl)
  const start = normEdgeUrl(ctx.startUrl)
  const mine = normEdgeUrl(r.finalUrl)
  if (base && start && base !== start && mine) {
    return { verdict: mine === base ? 'accepted' : 'rejected', basis: 'url' }
  }
  return { verdict: 'unknown', basis: 'none' }
}

// The context every verdict in a run shares. Derived once from the run itself,
// so the report, the markdown and the saved record can never disagree.
export const edgeCtxOf = (run: {
  hasAssertion: boolean
  successUrl?: string
  startUrl?: string
  results: { case: { baseline?: boolean }; ok: boolean; finalUrl?: string }[]
}): {
  baselineOk: boolean
  hasAssertion: boolean
  successUrl: string
  startUrl: string
  baselineUrl: string
} => {
  const baseline = run.results.find((r) => r.case.baseline)
  return {
    baselineOk: !!baseline?.ok,
    hasAssertion: run.hasAssertion,
    successUrl: run.successUrl ?? '',
    startUrl: run.startUrl ?? '',
    baselineUrl: baseline?.finalUrl ?? ''
  }
}

// How the verdicts in this run were reached — shown so a verdict is never a
// black box, and so an INFERRED one is visibly weaker than an asserted one.
export const edgeBasisNote = (ctx: { hasAssertion: boolean; successUrl: string; startUrl: string; baselineUrl: string; baselineOk: boolean }): string => {
  if (!ctx.baselineOk) return ''
  if (ctx.successUrl.trim()) return `Judged by your rule: success = URL contains “${ctx.successUrl.trim()}”.`
  if (ctx.hasAssertion) return 'Judged by the test’s own ✓ check.'
  const base = normEdgeUrl(ctx.baselineUrl)
  const start = normEdgeUrl(ctx.startUrl)
  if (base && start && base !== start) {
    return `Inferred: the valid-input baseline ended on ${ctx.baselineUrl} — a variant that ended elsewhere was rejected.`
  }
  return ''
}

// A ready-to-paste markdown summary of an edge-case run (Copy button).
export const buildEdgeReport = (edgeRun: EdgeRunLike | null, testName: string): string => {
  if (!edgeRun) return ''
  const baseline = edgeRun.results.find((r) => r.case.baseline)
  const baselineOk = !!baseline?.ok
  const variants = edgeRun.results.filter((r) => !r.case.baseline)
  const ctx = edgeCtxOf(edgeRun)
  const verdicts = variants.map((r) => edgeVerdict(r, ctx).verdict)
  const accepted = verdicts.filter((v) => v === 'accepted').length
  const rejected = verdicts.filter((v) => v === 'rejected').length
  const undetermined = verdicts.filter((v) => v === 'unknown').length
  const lines: string[] = []
  lines.push(`# Edge-case report${testName ? ` — ${testName}` : ''}`)
  lines.push('')
  lines.push(`- Variants run: ${variants.length}`)
  // Only claim accepted/rejected counts when they mean something. Printing
  // "0 rejected" beside "14 undetermined" reads as a finding; it isn't one.
  if (undetermined === variants.length) {
    lines.push(`- ? Undetermined: ${undetermined} — no verdict is possible for this run (see below).`)
  } else {
    lines.push(`- ⚠ Accepted (app took the bad input — review): ${accepted}`)
    lines.push(`- ✓ Rejected (handled): ${rejected}`)
    if (undetermined) lines.push(`- ? Undetermined: ${undetermined}`)
  }
  // How the verdicts were reached travels WITH them — an inferred verdict is
  // weaker than an asserted one and the reader has to be able to see which.
  const note = edgeBasisNote(ctx)
  if (note) lines.push(`- ${note}`)
  if (!baselineOk) lines.push(`- ⚠ Baseline (happy path) FAILED — fix the test first, then re-run; nothing here can be judged until the valid inputs pass.`)
  if (undetermined === variants.length && baselineOk)
    lines.push(`- ⚠ No success check in this test AND the valid-input baseline didn't move the page, so there is nothing to compare against. Add an assertion, or set a success rule in the 🧨 dialog, and re-run.`)
  lines.push('')
  for (const r of variants) {
    const v = edgeVerdict(r, ctx).verdict
    const mark =
      v === 'accepted'
        ? '⚠ ACCEPTED'
        : v === 'rejected'
          ? '✓ rejected'
          : baselineOk
            ? '? undetermined'
            : '· (baseline broken)'
    lines.push(`- ${mark} — **${r.case.fieldLabel}** = ${r.case.edgeLabel}: \`${r.case.value.slice(0, 60) || '(empty)'}\``)
    lines.push(`  - ${r.case.hint}`)
  }
  return lines.join('\n')
}
