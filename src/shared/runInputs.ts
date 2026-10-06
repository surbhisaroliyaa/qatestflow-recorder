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
// the rules themselves stay unit-testable. The two async helpers at the end
// (planRun, headlessRunEnv) take their disk and IPC access as arguments for the
// same reason: the app and the command line hand in different plumbing, and
// run the same rule.
// =====================================================================

import { secretCellEnv, withoutSecretKeys } from './secretCells'

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
  // A `secret:<ref>` name is a protected data-table cell, not an environment
  // variable — telling someone to add "{{env:secret:sec_91a…}}" to an
  // environment would send them looking for something that doesn't exist. It
  // goes missing when the encrypted store can't be read (another machine or
  // user account), and the fix is to type the value into the table again.
  const cells = missing.filter((n) => n.startsWith('secret:'))
  const envs = missing.filter((n) => !n.startsWith('secret:'))
  const parts: string[] = []
  if (envs.length) {
    const names = envs.map((n) => `{{env:${n}}}`).join(', ')
    const plural = envs.length === 1 ? '' : 's'
    const hint =
      opts.fixHint ?? 'Add the value to the environment this run uses, or pick a different one.'
    const why = opts.pinnedButMissing
      ? `This run is pinned to an environment that no longer exists, so none of its variables were applied. ${hint}`
      : hint
    parts.push(`${envs.length} environment variable${plural} had no value: ${names}. ${why}`)
  }
  if (cells.length) {
    const plural = cells.length === 1 ? '' : 's'
    parts.push(
      `${cells.length} protected data-table value${plural} could not be read on this machine. ` +
        'Type the value into the data table again and save.'
    )
  }
  return parts.join(' ')
}

/** The subset of a step the run plan reads. */
export interface PlanStep {
  type: string
  disabled?: boolean
  blockRef?: string
  createsData?: string
}

/**
 * The steps a run actually executes, and where each came from.
 *
 * A linked `block` step is replaced by the block's CURRENT steps, loaded fresh
 * (the "live" in live-link), nested blocks included; a disabled or dangling
 * block contributes nothing. `map[i]` is the row in `display` that flat step
 * `i` came from — every step inside a block points back at the block's row —
 * so a failure on flat step `i` is shown on the row the user can see.
 *
 * Shared because the command line has to run a test the way the app does. It
 * used to hand the saved steps straight to the exporter, which has no code for
 * a `block` step and silently dropped it: a test built on a "Login" block ran
 * from the CLI without logging in.
 *
 * A block MARKER can carry its own 🗃️ "creates data" flag. It is carried onto
 * the FIRST inner step — once, where a reader expects it — unless that step
 * has one of its own, which the block never overwrites.
 */
export async function planRun<T extends PlanStep>(
  display: T[],
  loadBlockSteps: (ref: string) => Promise<T[] | null | undefined>
): Promise<{ flat: T[]; map: number[] }> {
  const flat: T[] = []
  const map: number[] = []
  for (let i = 0; i < display.length; i++) {
    const s = display[i]
    if (s.type !== 'block') {
      flat.push(s)
      map.push(i)
      continue
    }
    if (s.disabled || !s.blockRef) continue
    const steps = await loadBlockSteps(s.blockRef)
    if (!steps) continue
    const inner = (await planRun(steps, loadBlockSteps)).flat
    if (s.createsData && inner.length && !inner[0].createsData) {
      inner[0] = { ...inner[0], createsData: s.createsData }
    }
    for (const st of inner) {
      flat.push(st)
      map.push(i)
    }
  }
  return { flat, map }
}

/** A step as the headless environment rule reads it. */
export interface EnvStep extends RunInputStep {
  secret?: boolean
}

/** Where a headless run's values come from. Handed in, so the rule below is
 *  the same code in the renderer (over IPC) and in main (directly), and can be
 *  tested with fakes. */
export interface EnvSources {
  /** `{{env:NAME}}` and `secret:<ref>` names → values, the env:get contract:
   *  a name with no value is in `unresolved` AND has '' in `values`. */
  resolveNames: (names: string[]) => Promise<{
    values: Record<string, string>
    unresolved: string[]
  }>
  /** Secret-store refs → stored values; a ref it cannot read is left out. */
  getSecrets: (refs: string[]) => Promise<Record<string, string>>
}

/**
 * The environment a HEADLESS run hands its generated spec — the rule the
 * in-app monitor used to write out inline, shared now so the command line (and
 * the scheduled "runs when closed" task, which IS the command line) fills a
 * password exactly the way the app does instead of refusing for want of one.
 *
 * Precedence, highest first:
 *   1. `provided` — the environment the run was pointed at (a monitor's pinned
 *      one). A value the user configured deliberately always wins; that is
 *      also how every other variable already resolves (env:get puts the
 *      environment before the process, and the child's env puts these values
 *      over the inherited ones).
 *   2. `external` — values already set outside the app (the command line
 *      passes the OS environment). Beats the store, so a pipeline can override
 *      a saved password with `set PASSWORD=…` without editing the test. The
 *      in-app monitor passes nothing here: it has no such input.
 *   3. the secret store — a secret step's ref for PASSWORD, a protected data
 *      cell's ref for PASSWORD_1…, then a pre-F40 literal left on a secret step
 *      (a test not yet migrated).
 *
 * `envNames` is envVarNames(flat, rows) — computed by the caller, because the
 * token rules live with the data-driven engine in the renderer.
 *
 * Nothing here logs a value or puts one anywhere but `env`, which goes to the
 * child process and nowhere else.
 */
export async function headlessRunEnv(
  flat: EnvStep[],
  rows: Record<string, string>[],
  envNames: string[],
  provided: Record<string, string>,
  sources: EnvSources,
  external: Record<string, string | undefined> = {}
): Promise<{ env: Record<string, string>; missing: string[] }> {
  const env: Record<string, string> = { ...provided }
  if (env.PASSWORD === undefined && !external.PASSWORD) {
    const refs = runSecretRefs(flat)
    if (refs.length) {
      const resolved = await sources.getSecrets(refs)
      const first = refs.map((r) => resolved[r]).find((v) => v)
      if (first) env.PASSWORD = first
    }
    if (env.PASSWORD === undefined) {
      const literal = flat.find(
        (s) => s.type === 'type' && s.secret && s.value && !s.value.includes('{{')
      )
      if (literal?.value) env.PASSWORD = literal.value
    }
  }
  if (!envNames.length) return { env, missing: [] }
  const resolved = await sources.resolveNames(envNames)
  // `env` goes in as `provided`, so a value already there wins.
  const values = mergeEnvValues(env, resolved.values)
  const missing = missingEnvNames(envNames, resolved, env)
  // Protected data cells become the PASSWORD_1… names the spec reads; the
  // `secret:<ref>` lookup keys stay out of the child's environment. A cell name
  // the outside already set is left to it — the same rule as PASSWORD above.
  const cells = secretCellEnv(rows, values)
  for (const name of Object.keys(cells)) if (external[name]) delete cells[name]
  Object.assign(env, withoutSecretKeys(values), cells)
  return { env, missing }
}
