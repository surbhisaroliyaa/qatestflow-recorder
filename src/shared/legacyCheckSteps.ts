// =====================================================================
// MIGRATING TESTS RECORDED BEFORE THE CHECKBOX FIX  (audit finding QF-001)
// =====================================================================
// Until the fix, ticking a checkbox or picking a radio recorded TWO steps:
//
//     click   → the control
//     type    → the control, value "on"
//
// "on" is the HTML default `value` of a checkbox. It is not the ticked state
// and never was; the recorder simply read `field.value` the way it does for a
// text box. The exported spec therefore emitted `.fill('on')`, which Playwright
// rejects outright — so every test saved before the fix still exports broken,
// no matter how green it looks in the app.
//
// This collapses that pair back into the canonical `check` step, once, as a
// saved test is read from disk.
//
// ── THE LIMIT, STATED PLAINLY ───────────────────────────────────────────
// The old recording cannot tell us which way the box was moved. `field.value`
// is "on" whether the user ticked it OR unticked it — the direction was never
// stored. So a migrated step assumes a TICK, which is right for the common case
// (accepting terms, opting in) and wrong for a recording that unticked a box
// that started ticked.
//
// That is still strictly better than what it replaces: a step that cannot run
// at all becomes a step that runs, and a wrong-direction one fails loudly and
// visibly in the step list, where it can be flipped in one click. But it is a
// repair, not a recovery, and it should not be described as one.
// =====================================================================

/** The subset of a step this module reads. Structural, like RunInputStep —
 *  src/shared must not depend on the renderer's ambient RecorderStep. */
export interface LegacyStep {
  type: string
  value?: string
  label?: string
  selector?: string
  windowId?: number
  [key: string]: unknown
}

/** The HTML default value of a checkbox — the fingerprint of the old bug. */
const CHECKBOX_DEFAULT_VALUE = 'on'

/** Do these two steps address the same element in the same place? */
function sameTarget(a: LegacyStep, b: LegacyStep): boolean {
  return (
    a.selector === b.selector &&
    a.label === b.label &&
    (a.windowId ?? 0) === (b.windowId ?? 0) &&
    JSON.stringify(a.frame ?? null) === JSON.stringify(b.frame ?? null)
  )
}

/**
 * Is this the legacy "typed the word on" step?
 *
 * The value must match EXACTLY. A checkbox is the only control that produces
 * it by accident; a text field would have to have been filled with the literal
 * two letters "on", which is the one false positive this rule can have. It is
 * accepted knowingly: the alternative is leaving every pre-fix checkbox test
 * exporting code that cannot run.
 */
function isLegacyCheckboxType(step: LegacyStep): boolean {
  return (
    step.type === 'type' &&
    step.value === CHECKBOX_DEFAULT_VALUE &&
    // A password field never carries a literal value, so it can never be this.
    !step.secret
  )
}

export interface MigrationResult {
  steps: LegacyStep[]
  /** How many legacy pairs/singles were rewritten. 0 = the test was untouched. */
  migrated: number
}

/**
 * Rewrite pre-fix checkbox recordings into canonical `check` steps.
 *
 * Two shapes, because the old code produced both:
 *
 *   click + type "on"   — a mouse click on the box or its label
 *   type "on" alone     — a keyboard Space toggle, which fired `change` with
 *                         no click for the click listener to see
 *
 * Returns a NEW array; the input is not modified. Safe to run repeatedly — a
 * `check` step has no `type` step to match, so a second pass is a no-op.
 */
export function migrateLegacyCheckSteps(steps: LegacyStep[]): MigrationResult {
  const out: LegacyStep[] = []
  let migrated = 0

  for (const step of steps) {
    if (!isLegacyCheckboxType(step)) {
      out.push(step)
      continue
    }

    // Drop the click that belongs to this tick — it is the same interaction
    // counted twice, and replaying it would toggle the box back off.
    const prev = out[out.length - 1]
    if (prev && prev.type === 'click' && sameTarget(prev, step)) out.pop()

    const { secret: _secret, ...rest } = step
    out.push({ ...rest, type: 'check', value: 'true' })
    migrated++
  }

  return { steps: out, migrated }
}
