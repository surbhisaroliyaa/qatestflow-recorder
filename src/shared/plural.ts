// One place that knows "1 step" / "2 steps" (audit finding QF-011).
//
// The audit caught a one-step run reporting "All 1 steps passed". Counts were
// formatted inline all over the app, each call site deciding (or forgetting)
// singular vs plural on its own. Anything that shows a count to a person goes
// through here.

/** "1 step", "3 steps", "1 entry", "2 entries". */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`
}
