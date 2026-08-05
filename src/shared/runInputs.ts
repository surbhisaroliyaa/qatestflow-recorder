// =====================================================================
// RUN INPUTS — the decisions every kind of run has to make, in one place
//
// WHY THIS EXISTS
//
// A test can be run seven ways: in-app replay, one data row, all data rows, a
// suite, a parallel batch, a scheduled monitor, a cross-browser check. Each one
// assembled its own inputs inline, which meant every safety rule had to be
// written out seven times — and the seventh was reliably the one that got
// missed. Two examples from the same week:
//
//   · the scheduler guard covered `suiteRun` and not the other three batch kinds
//   · env resolution covered four run paths and not the monitor, so a deleted
//     environment surfaced as "Expected pattern /inventory.html" instead of
//     "SAUCE_PW has no value"
//
// Same shape both times. You cannot fix that by being more careful; you fix it
// by having one place to be careful in.
//
// This module is the PURE half — no Electron, no IPC, no async. It takes steps
// and saved-test data and returns what a run needs. The thin async wrapper that
// fetches env values and secrets lives in the renderer and calls into here, so
// the rules themselves stay unit-testable.
// =====================================================================

/** The subset of a step this module reads. Structural, like ControlFlowStep —
 *  src/shared must not depend on the renderer's ambient RecorderStep. */
export interface RunInputStep {
  type: string
  value?: string
  disabled?: boolean
  secretRef?: string
}

/**
 * Every secret reference the run will need resolved, deduped, in order.
 *
 * Since F40 a password lives in userData and the step carries only an opaque
 * ref. A path that forgets to collect these types an empty string into the
 * login — which is what made all three cross-browser engines time out
 * identically, looking like an engine problem rather than a missing value.
 */
export function runSecretRefs(steps: RunInputStep[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const s of steps) {
    const ref = s.secretRef
    if (typeof ref !== 'string' || !ref || seen.has(ref)) continue
    seen.add(ref)
    out.push(ref)
  }
  return out
}

/**
 * Absolute source paths of every file an upload step needs, deduped.
 *
 * One step can carry several paths, newline-separated. Uploads never travelled
 * into a parallel run — the runner copied the session but not these — so every
 * upload test died on `ENOENT …/fixtures/<name>`, which the triage desk then
 * read as a stale selector.
 */
export function runFixturePaths(steps: RunInputStep[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const s of steps) {
    if (s.type !== 'upload' || s.disabled || !s.value) continue
    for (const p of s.value.split('\n')) {
      const path = p.trim()
      if (!path || seen.has(path)) continue
      seen.add(path)
      out.push(path)
    }
  }
  return out
}

/**
 * The data block for the spec generator, or undefined for a plain test.
 *
 * BOTH halves are required. Columns with no rows cannot be filled, and rows
 * with no columns have nothing to fill — either way the generator must emit an
 * ordinary test rather than a parameterized one that substitutes nothing.
 *
 * Handing this over is not optional bookkeeping: a data-driven test generated
 * WITHOUT it keeps its `{{username}}` tokens as literal text and types them
 * into the form.
 */
export function runData(
  columns: string[],
  rows: Record<string, string>[] | undefined
): { columns: string[]; rows: Record<string, string>[] } | undefined {
  if (!columns.length) return undefined
  if (!rows || !rows.length) return undefined
  return { columns, rows }
}

/**
 * Which of the environment variables this run needs still has no value.
 *
 * THE SUBTLETY THAT ALREADY CAUGHT ME ONCE: the resolver reports a missing name
 * in `unresolved` AND puts an empty string in `values` for it. A caller that
 * tests `values[name] !== undefined` therefore concludes the variable is
 * present, copies '' in, and the guard silently never fires — which is exactly
 * the failure the guard exists to catch, an empty value passing itself off as a
 * real one. Emptiness is the test, not definedness.
 *
 * `provided` is anything already supplied out of band (a monitor's pinned
 * environment, say) and always wins: the resolver only knows the ACTIVE
 * environment plus the process.
 */
export function missingEnvNames(
  needed: string[],
  resolved: { values: Record<string, string>; unresolved: string[] },
  provided: Record<string, string> = {}
): string[] {
  const unresolved = new Set(resolved.unresolved)
  return needed.filter((n) => unresolved.has(n) && !provided[n] && !resolved.values[n])
}

/**
 * Merge resolved values into the out-of-band ones without letting an empty
 * string overwrite a real value, or count as one. Same rule as above.
 */
export function mergeEnvValues(
  provided: Record<string, string>,
  values: Record<string, string>
): Record<string, string> {
  const out = { ...provided }
  for (const [k, v] of Object.entries(values)) {
    if (!out[k] && v) out[k] = v
  }
  return out
}

/**
 * The sentence shown when a run refuses to start for want of a variable.
 *
 * Recorded as a SETUP error, not a test failure — "your configuration is
 * incomplete" and "the site is broken" are different problems and must not
 * share a verdict. `pinnedButMissing` says the environment itself is gone,
 * which is the more useful thing to be told when it is true.
 */
export function missingEnvMessage(
  missing: string[],
  opts: {
    /** The environment it was pinned to has been deleted — the more useful thing
     *  to say when true, because it explains why NOTHING was applied. */
    pinnedButMissing?: boolean
    /** Where this particular caller expects the user to fix it. Passed in rather
     *  than appended by the caller: two sentences each telling you to pick an
     *  environment reads like a stutter. */
    fixHint?: string
  } = {}
): string {
  const names = missing.map((n) => `{{env:${n}}}`).join(', ')
  const plural = missing.length === 1 ? '' : 's'
  const hint = opts.fixHint ?? 'Add the value to the environment this run uses, or pick a different one.'
  const why = opts.pinnedButMissing
    ? `This run is pinned to an environment that no longer exists, so none of its variables were applied. ${hint}`
    : hint
  return `${missing.length} environment variable${plural} had no value: ${names}. ${why}`
}
