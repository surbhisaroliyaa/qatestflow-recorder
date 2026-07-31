// =====================================================================
// F39 — WHICH TESTS ARE SAFE TO RUN HEADLESS (in parallel)?
//
// The parallel path runs the EXPORTED Playwright spec, not the in-app replay
// engine. Those are not the same thing, and the difference is dangerous in one
// specific direction: some steps that DO something in the app become a comment
// in the export. A test whose only real assertion is an AI (`nl`) check would
// run headlessly, verify nothing at all, and come back GREEN.
//
// That's a FALSE PASS. For a tool whose whole identity is "a green run can be
// trusted", a false pass is worse than no result — a red test gets looked at, a
// wrongly-green one gets shipped behind.
//
// So before running anything in parallel we ask each test: would you mean the
// same thing headlessly? Tests that answer no aren't dropped — the caller runs
// them the normal sequential way and the report says which path each took.
// =====================================================================

export interface HeadlessBlocker {
  /** Short reason, shown per test in the run report. */
  reason: string
  /** How many steps triggered it. */
  count: number
}

/**
 * Why this test must NOT go down the parallel/headless path.
 * Empty array = safe to run headless.
 */
export function headlessBlockers(steps: { type: string; assertKind?: string; waitKind?: string; disabled?: boolean }[]): HeadlessBlocker[] {
  const counts = new Map<string, number>()
  const bump = (reason: string): void => {
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }

  for (const s of steps) {
    if (s.disabled) continue
    // F19: an AI check exports as a comment — there is no deterministic
    // Playwright equivalent. Headless, it silently checks NOTHING.
    if (s.type === 'assert' && s.assertKind === 'nl') {
      bump('has an AI (plain-English) check, which doesn’t exist outside the app')
    }
    // F30: a manual gate exports as a commented-out page.pause(). Headless it
    // no-ops, so whatever the human was meant to do never happens — and the
    // steps after it act on a page that isn't in the expected state.
    if (s.type === 'wait' && s.waitKind === 'manual') {
      bump('waits for a human step (2FA / CAPTCHA), which can’t run unattended')
    }
    // F13: the exported a11y check needs @axe-core/playwright installed in the
    // project. If it isn't, the spec fails to compile — which would read as
    // "this test is broken" rather than "a dependency is missing".
    if (s.type === 'a11y') {
      bump('has an accessibility check, which needs @axe-core/playwright installed')
    }
    // Day 19 / F15: Playwright manages its OWN screenshot baselines, separate
    // from the app's. On a first headless run it CREATES them and passes — a
    // green that proves nothing was compared.
    if (s.type === 'snapshot') {
      bump('has a visual snapshot, which compares against Playwright’s own baseline, not the app’s')
    }
  }
  return [...counts.entries()].map(([reason, count]) => ({ reason, count }))
}

/** One-line summary for the report row. */
export function blockerSummary(blockers: HeadlessBlocker[]): string {
  if (!blockers.length) return ''
  return blockers.map((b) => (b.count > 1 ? `${b.reason} (×${b.count})` : b.reason)).join('; ')
}

/**
 * A sensible default worker count.
 *
 * Playwright's own default is half the cores. We match it and cap at 8: past
 * that, browsers contend for CPU and each test gets slower, which shows up as
 * TIMING flakiness — precisely the thing this app spends so much effort not
 * manufacturing (see F2's conservative flaky tagging).
 */
export function defaultWorkers(): number {
  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 4) : 4
  return Math.max(1, Math.min(8, Math.floor(cores / 2)))
}

/**
 * Triage a failure that came back from REAL Playwright, not the in-app engine.
 *
 * main/translator.ts classifies in-app replay errors, and its patterns match
 * our own wording ("Element not found", "Expected …"). Playwright says
 * different things — "Test timeout of 30000ms exceeded",
 * "expect(locator).toHaveText(expected) failed". Nothing matched, so every
 * headless failure landed in `unclassified`: 20 out of 20 in Surbhi's Test 12
 * batch. That made the breakdown useless on exactly the runs that predict CI.
 *
 * Deliberately coarser than the in-app rules. A headless run has no console or
 * network evidence to weigh, so the 'app-bug' verdict — which in-app depends on
 * the page having logged real errors — is NOT reachable here. Claiming it
 * without that evidence would be a guess dressed as a finding.
 */
export function headlessCategory(error: string | undefined): FailureCategory {
  const e = error ?? ''
  if (!e) return 'unknown'

  // Our own pre-pass refusing a malformed test — an authoring problem.
  if (/Test structure problem|is never closed/i.test(e)) return 'authoring'

  // The run never reached the site, or a fixture/HAR/file was missing.
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ENOENT|ERR_FILE_NOT_FOUND|net::/i.test(e)) {
    return 'environment'
  }

  // A value/state comparison that ran and lost — the element WAS found.
  // Checked before the timeout rule: Playwright reports a failed expect with a
  // timeout too, and the comparison is the more specific, more useful reading.
  if (/toHaveText|toHaveValue|toHaveURL|toContainText|toHaveTitle|toHaveCount|toHaveAttribute|toBe\b|toContain\b/.test(e)) {
    // …unless what it timed out on is the element never existing at all.
    if (/element\(s\) not found|resolved to 0 elements/i.test(e)) return 'stale-selector'
    return 'stale-data'
  }

  // Visible/enabled checks that never came true: the element resolved, so the
  // selector is fine — it's state or timing.
  if (/toBeVisible|toBeEnabled|toBeChecked|toBeEditable/.test(e)) {
    return /locator resolved to/i.test(e) ? 'stale-data' : 'stale-selector'
  }

  // A bare Playwright timeout with nothing else to go on. In-app this is the
  // "element never appeared" case, which is a stale selector far more often
  // than anything else — but say `timing` only when Playwright names a wait.
  if (/Test timeout of \d+ms exceeded/i.test(e)) return 'stale-selector'
  if (/Timeout .*exceeded|waiting for/i.test(e)) return 'timing'

  return 'unknown'
}
