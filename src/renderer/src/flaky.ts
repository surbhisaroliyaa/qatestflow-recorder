// =====================================================================
// FLAKY ANALYTICS (F2)
// Every replay is already saved to a test's run history (library.ts). This
// turns that history into a single trust verdict per test — the "mini CI
// dashboard" signal a QA reads at a glance:
//
//   stable       every recent run passed — trust it
//   flaky        results flip-flop pass↔fail — trust NEITHER result (the scary one)
//   newly-broken was passing, now failing and staying red — a fresh regression
//   failing      every recent run failed — consistently broken
//   new          only one run so far — not enough to judge
//
// The raw dots still show the full history; this is the one-word summary of
// "how much do I trust this test's result right now?".
// =====================================================================

export type FlakyTag = 'stable' | 'flaky' | 'newly-broken' | 'failing' | 'new' | 'untested'

// True flakiness shows up as TRANSIENT errors — timeouts, timing, network,
// "not visible yet" — that come and go on their own. A real bug shows up as an
// assertion/logic failure ("expected X, got Y"), which is NOT flaky even if the
// run history flip-flops (because a human broke → fixed → rebroke it). So we
// only call a test "flaky" when its failures actually look transient. No error
// text → treat as NOT transient (don't cry "flaky" without evidence).
const TRANSIENT_RE =
  /\btimeout\b|timed out|not visible|not attached|became detached|detached from|waiting for|net::|ERR_[A-Z]|ECONN|socket hang|navigation (failed|interrupted)|target closed|page crashed|temporar/i
function isTransientFailure(error?: string): boolean {
  return !!error && TRANSIENT_RE.test(error)
}

export interface FlakyVerdict {
  tag: FlakyTag
  label: string // short chip text
  title: string // hover explanation (counts + meaning)
}

// runs are newest-first (library.ts stores `[newest, …]`).
export function classifyRuns(runs: RunInfo[]): FlakyVerdict {
  const n = runs.length
  if (n === 0) return { tag: 'untested', label: 'not run', title: 'Never replayed yet.' }

  const passed = runs.filter((r) => r.status === 'passed').length
  const failed = n - passed
  const counts = `${n} run${n === 1 ? '' : 's'} · ${passed} passed, ${failed} failed`

  if (n === 1) {
    const ok = runs[0].status === 'passed'
    return {
      tag: 'new',
      label: ok ? 'new · ✓' : 'new · ✗',
      title: `Only one run so far (${ok ? 'passed' : 'failed'}) — not enough history to judge stability.`
    }
  }

  if (failed === 0) return { tag: 'stable', label: 'stable', title: `Stable — ${counts}.` }
  if (passed === 0)
    return { tag: 'failing', label: 'failing', title: `Consistently failing — ${counts}.` }

  // Mixed pass + fail. Count how many times the result flipped between runs,
  // and whether any failure actually looks transient (timing/network) — because
  // only THOSE make a test genuinely flaky. Assertion/real-bug failures don't.
  let transitions = 0
  for (let i = 0; i < n - 1; i++) if (runs[i].status !== runs[i + 1].status) transitions++
  const anyTransient = runs.some((r) => r.status === 'failed' && isTransientFailure(r.error))

  // Flip-flopping AND the failures look transient (timing) → genuinely flaky.
  if (transitions >= 2 && anyTransient) {
    return {
      tag: 'flaky',
      label: 'flaky',
      title: `Flaky — flips pass↔fail with transient (timing/network) failures, not a real bug (${counts}).`
    }
  }
  // Otherwise the failures have REAL causes (assertion/logic) — judge by the
  // current state: failing now = a real break to investigate; passing now =
  // it recovered and is trustworthy again.
  if (runs[0].status === 'failed') {
    return {
      tag: 'newly-broken',
      label: 'now failing',
      title: `Now failing — passed before, failing now. A real failure to investigate, not flakiness (${counts}).`
    }
  }
  return {
    tag: 'stable',
    label: 'stable',
    title: `Currently passing; earlier failures had real causes, now recovered (${counts}).`
  }
}
