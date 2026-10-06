import { analyzeControlFlow, type ControlFlowStep } from '../../shared/controlFlow'

// =====================================================================
// ▶ RUN THIS STEP / ▶ RUN FROM HERE  (PRD FR-15 — "step" execution)
// =====================================================================
// Re-running a whole 40-step flow to find out whether step 31 now works is the
// slowest possible debugging loop. These two row actions run a SLICE of the
// test against the page that is already open, through the exact same replay
// engine as ▶ Replay — this module only decides WHICH slice.
//
// It works on the EXPANDED run plan (buildRunPlan: linked blocks flattened)
// and its expanded→display map, because that is what the engine executes. A
// block row therefore runs every step inside the block, and the returned map
// keeps progress marks landing on the rows you can see.
//
// Pure on purpose: the rules for what a slice may start or stop on are the
// part most likely to be wrong, and they are testable without a browser.
// =====================================================================

export type StepRunMode = 'one' | 'toEnd'

export type StepRunPlan =
  | { ok: true; start: number; end: number; map: number[] }
  | { ok: false; reason: string }

const CLOSERS = new Set(['else', 'endIf', 'endRepeat'])

/**
 * Pick the expanded-plan slice [start, end] (inclusive) for a row action.
 *
 * @param flat    the expanded run plan (what the engine will execute)
 * @param map     expanded index → display row, from buildRunPlan
 * @param row     the display row the action was pressed on
 * @param mode    'one' = only this row; 'toEnd' = this row to the end of the test
 */
export function planStepRun(
  flat: ControlFlowStep[],
  map: number[],
  row: number,
  mode: StepRunMode
): StepRunPlan {
  const start = map.indexOf(row)
  if (start < 0) {
    // A disabled block, or a block whose file is gone, expands to nothing —
    // there is nothing to run, and saying so beats a run that "passes" empty.
    return { ok: false, reason: 'This row has no steps to run (is it turned off, or empty?).' }
  }
  if (flat[start].disabled) {
    return { ok: false, reason: 'This step is turned off — turn it back on to run it.' }
  }
  if (CLOSERS.has(flat[start].type)) {
    // A closing marker on its own means nothing: "end of loop" with no loop.
    // Guessing which block the user meant would silently run the wrong steps.
    return {
      ok: false,
      reason: 'An “otherwise” / “end” marker can’t run on its own — run its “if” or “repeat” row.'
    }
  }

  let end = start
  if (mode === 'toEnd') {
    end = flat.length - 1
  } else {
    // Every expanded step that came from this row (a block row = the whole block).
    while (end + 1 < flat.length && map[end + 1] === row) end++
    // An if / repeat row runs its whole block — the marker alone would be
    // refused by the engine as "never closed", and its body is what it means.
    const cf = analyzeControlFlow(flat)
    const span = cf.spans.get(start)
    if (span && span.end > end) end = span.end
  }

  // Starting INSIDE a loop or if-block leaves the slice with a closing marker
  // and no opener. The engine refuses unbalanced structure up front (it would
  // otherwise be guessing), so refuse here with a message that says what to do.
  const slice = flat.slice(start, end + 1)
  const cf = analyzeControlFlow(slice)
  if (cf.errors.length) {
    return {
      ok: false,
      reason:
        'This step is inside a loop or if-block, so the run would start half-way through it — run from the “repeat” / “if” row instead.'
    }
  }
  return { ok: true, start, end, map: map.slice(start, end + 1) }
}
