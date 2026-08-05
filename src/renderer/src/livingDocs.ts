// =====================================================================
// LIVING DOCS (F31)
// A test's step model is already a precise description of a flow — this turns it
// into a plain-English document a PM or dev can read without opening code: what
// the test DOES (the actions, numbered) and what it VERIFIES (the checks), plus
// its preconditions (session / environment / viewport / data). "Living" because
// it's regenerated from the current steps every time — it can't drift from the
// test the way a hand-written doc does.
//
// Pure generator. It reuses the SAME per-step phrasing the app shows everywhere
// (`stepText`), so the doc reads exactly like the step list, and splits steps
// into actions vs checks so the "what it verifies" story stands on its own.
// =====================================================================

import { stepText } from './playwrightExport'
import { envVarNames } from './dataDriven'
import { findWeakAssertions, type WeakAssertion } from './deadAssertions'
import { resolveDevice, deviceSummary } from './devices'

// The step types that VERIFY something (vs perform an action) — they populate
// the "Checks" section, which is the part a reviewer cares about most.
const CHECK_TYPES = new Set(['assert', 'snapshot', 'a11y', 'perf'])

export interface DocMeta {
  suite?: string
  baseURL?: string
  storageState?: string
  viewport?: { width: number; height: number }
  deviceId?: string // F36
  tags?: string[] // F38
  dataRows?: Record<string, string>[]
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

function hostOf(url?: string): string {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// The human-readable preconditions from the test's metadata + steps.
function preconditions(steps: RecorderStep[], meta: DocMeta): string[] {
  const out: string[] = []
  const firstNav = steps.find((s) => s.type === 'navigate' && s.url)
  const base = meta.baseURL || firstNav?.url
  if (base) out.push(`Base URL: ${base}`)
  if (meta.storageState) {
    out.push(`Starts already logged in (session "${meta.storageState}") — the login steps are skipped.`)
  }
  // F38: what this test is FOR, as opposed to where it files.
  if (meta.tags && meta.tags.length) {
    out.push(`Tagged ${meta.tags.join(' ')}.`)
  }
  // F36: name the DEVICE when there is one — "runs on an iPhone 13" tells a
  // reader far more than "runs at 390×664", and it's the difference between a
  // real mobile test and a narrow desktop window.
  const device = resolveDevice(meta.deviceId, meta.viewport)
  if (device) {
    out.push(
      device.userAgent
        ? `Runs as ${device.label} — ${deviceSummary(device)}.`
        : `Runs at a ${device.viewport.width}×${device.viewport.height} viewport (size only — the page still sees a desktop browser).`
    )
  }
  if (meta.dataRows && meta.dataRows.length) {
    out.push(`Data-driven: runs once per row of a data table (${meta.dataRows.length} rows).`)
  }
  const envs = envVarNames(steps, meta.dataRows ?? [])
  if (envs.length) {
    out.push(`Uses environment variables (per environment): ${envs.join(', ')}.`)
  }
  return out
}

// A check plus F6's verdict on whether it can actually fail.
export interface DocCheck {
  step: RecorderStep
  weak?: WeakAssertion
}

// Split a flow into its actions and its checks. Each check carries F6's
// dead/weak verdict, so the doc can say not just "there is a check here" but
// "this check can never fail" — counting a dead assertion as coverage is the
// exact lie F6 exists to catch (see deadAssertions.ts header).
//
// findWeakAssertions indexes into the array it's given, so it must run on the
// FULL flat array — resolving its indices against the disabled-filtered list
// would silently point at the wrong steps.
function partition(flat: RecorderStep[]): { actions: RecorderStep[]; checks: DocCheck[] } {
  const weakByIndex = new Map(findWeakAssertions(flat).map((w) => [w.index, w]))
  const actions: RecorderStep[] = []
  const checks: DocCheck[] = []
  flat.forEach((s, i) => {
    if (s.disabled) return
    if (CHECK_TYPES.has(s.type)) checks.push({ step: s, weak: weakByIndex.get(i) })
    else actions.push(s)
  })
  return { actions, checks }
}

// A dead check always passes, so it proves nothing and is not counted as
// coverage. A weak check is low-value but can still fail — it counts.
const isDead = (c: DocCheck): boolean => c.weak?.severity === 'dead'
const realChecks = (checks: DocCheck[]): DocCheck[] => checks.filter((c) => !isDead(c))

// One check → its markdown bullet, struck through and explained when dead.
function checkLine(c: DocCheck): string {
  const text = stepText(c.step)
  if (!c.weak) return `- ${text}`
  if (c.weak.severity === 'dead') return `- ⚠ ~~${text}~~ — dead: ${c.weak.reason}`
  return `- ${text} — ⚠ weak: ${c.weak.reason}`
}

// One test → a markdown document. `flat` should be the FLATTENED steps (linked
// blocks already expanded) so the doc describes what actually runs.
//
// NOT WIRED TO A BUTTON. The per-test "📖 Docs" surface was removed: for a
// single test the bug report already prints the steps as its repro recipe, so
// this mostly duplicated it. Kept because it's the only surface that describes
// a test WITHOUT needing a run (a report needs a failure to exist at all) —
// wire it up if a per-test spec is ever wanted again. The suite doc below is
// the live surface and shares this file's partition/dead-check logic.
export function generateTestDoc(name: string, flat: RecorderStep[], meta: DocMeta = {}): string {
  const { actions, checks } = partition(flat)
  const host = hostOf(meta.baseURL || flat.find((s) => s.type === 'navigate')?.url)
  const lines: string[] = []
  lines.push(`# ${name || 'Recorded test'}`)
  lines.push('')
  const real = realChecks(checks)
  const dead = checks.length - real.length
  lines.push(
    `**What it does:** a ${actions.length}-step flow${host ? ` on ${host}` : ''} that verifies ` +
      `${plural(real.length, 'outcome')}.` +
      (dead > 0
        ? ` _(${plural(dead, real.length > 0 ? 'further check' : 'check')} always ${dead === 1 ? 'passes' : 'pass'} — see below.)_`
        : '')
  )
  lines.push('')

  const pre = preconditions(flat.filter((s) => !s.disabled), meta)
  if (pre.length) {
    lines.push('**Preconditions**')
    lines.push('')
    for (const p of pre) lines.push(`- ${p}`)
    lines.push('')
  }

  lines.push('## Steps')
  lines.push('')
  if (actions.length === 0) lines.push('_(no actions)_')
  actions.forEach((s, i) => {
    const opt = s.optional ? ' _(optional — skipped if not present)_' : ''
    lines.push(`${i + 1}. ${stepText(s)}${opt}`)
  })
  lines.push('')

  lines.push('## Checks (what it verifies)')
  lines.push('')
  if (real.length === 0) {
    lines.push(
      `- ⚠ **No checks that can fail** — this test performs actions but verifies nothing. ${
        dead > 0
          ? `It has ${plural(dead, 'check')}, but ${dead === 1 ? 'it always passes' : 'they all always pass'} regardless of how the app behaves. `
          : ''
      }A green run here only proves the steps ran, not that the app behaved correctly. Consider adding an assertion.`
    )
    checks.forEach((c) => lines.push(checkLine(c)))
  } else {
    checks.forEach((c) => lines.push(checkLine(c)))
  }
  lines.push('')

  return lines.join('\n')
}

// Many tests → one coverage document (grouped by suite). Ready for the F31
// suite-level surface; wire a "Suite docs" button to it when wanted. Each entry
// carries the test's flattened steps + metadata.
export function generateSuiteDoc(
  entries: { name: string; suite: string; flat: RecorderStep[]; meta: DocMeta }[]
): string {
  const lines: string[] = []
  lines.push('# Test coverage')
  lines.push('')
  lines.push(`${entries.length} test${entries.length === 1 ? '' : 's'} documented — a living map of what QA covers.`)
  lines.push('')
  const bySuite = new Map<string, typeof entries>()
  for (const e of entries) {
    const key = e.suite || 'Ungrouped'
    if (!bySuite.has(key)) bySuite.set(key, [])
    bySuite.get(key)!.push(e)
  }
  let noCheckTotal = 0
  let fixtureNoCheckTotal = 0
  let deadTestTotal = 0
  let orphanTotal = 0 // F27: tests that create data but have no teardown to remove it
  for (const [suite, tests] of bySuite) {
    lines.push(`## ${suite}`)
    lines.push('')
    for (const t of tests) {
      const { actions, checks } = partition(t.flat)
      const real = realChecks(checks)
      const dead = checks.length - real.length
      // A test tagged @fixture exists to prove a MECHANISM works — that a loop
      // loops, that a device UA is applied, that a parallel batch runs. It has no
      // checks by design, and counting it alongside a real test that forgot to
      // assert anything is what made the warning untrustworthy: "34 tests verify
      // nothing" was roughly half deliberate, so the number got ignored — and a
      // warning you have learned to ignore hides the genuine cases inside it.
      const isFixture = (t.meta.tags ?? []).some((x) => /^@?fixture$/i.test(x.trim()))
      if (real.length === 0) {
        if (isFixture) fixtureNoCheckTotal++
        else noCheckTotal++
      }
      if (dead > 0) deadTestTotal++
      // F27: what this test creates, and whether anything cleans it up.
      const created = t.flat
        .filter((s) => !s.disabled && s.createsData)
        .map((s) => s.createsData as string)
      // `&& s.type === 'api'` matters: BOTH the runner (index.ts, the
      // run-early-ended teardown sweep) and the exporter (playwrightExport.ts)
      // honour teardown on API steps ONLY. This check did not, so marking a UI
      // step as teardown made the doc report "cleaned up ✓" for cleanup that
      // never runs — a false all-clear, which is worse than the warning it
      // replaced. The doc must describe what the engine actually does.
      const hasTeardown = t.flat.some((s) => !s.disabled && s.teardown && s.type === 'api')
      const orphan = created.length > 0 && !hasTeardown
      if (orphan) orphanTotal++
      // F36/F38: the DEVICE this runs as and the tags it carries belong on the
      // per-test line. They used to be written into preconditions() — which
      // only generateTestDoc calls, and that has had no UI entry point since
      // the per-test 📖 button was dropped, so they never appeared anywhere.
      const device = resolveDevice(t.meta.deviceId, t.meta.viewport)
      const deviceNote = device
        ? device.userAgent
          ? ` 📱 _(${device.label})_`
          : ` 🖥 _(${device.viewport.width}×${device.viewport.height}, size only)_`
        : ''
      const tagNote = t.meta.tags?.length ? ` ${t.meta.tags.join(' ')}` : ''
      lines.push(
        `- **${t.name}**${deviceNote}${tagNote} — ${plural(actions.length, 'action')}, ${plural(real.length, 'check')}` +
          (dead > 0 ? ` _(${dead} dead)_` : '') +
          (real.length === 0
            ? isFixture
              ? ' 🔧 _(mechanics fixture — no checks by design)_'
              : ' ⚠ _(verifies nothing)_'
            : '') +
          (created.length
            ? ` 🗃️ _(creates ${created.join(', ')}${orphan ? ' — ⚠ no teardown!' : ' — cleaned up ✓'})_`
            : '')
      )
      // The counts alone can't answer "is this outcome covered?" — listing each
      // check under its test turns the index into a coverage map you can scan.
      for (const c of checks) lines.push(`    ${checkLine(c)}`)
    }
    lines.push('')
  }
  if (noCheckTotal > 0) {
    lines.push(
      `> ⚠ ${noCheckTotal} test${noCheckTotal === 1 ? ' has' : 's have'} no checks that can fail — passing but verifying nothing.` +
        (fixtureNoCheckTotal > 0
          ? ` (${fixtureNoCheckTotal} more ${fixtureNoCheckTotal === 1 ? 'is a' : 'are'} deliberate 🔧 mechanics fixture${fixtureNoCheckTotal === 1 ? '' : 's'}, not counted here.)`
          : '')
    )
    lines.push('')
  }
  if (deadTestTotal > 0) {
    lines.push(
      `> ⚠ ${deadTestTotal} test${deadTestTotal === 1 ? ' has' : 's have'} dead checks that always pass regardless of the app.`
    )
    lines.push('')
  }
  if (orphanTotal > 0) {
    lines.push(
      // The VERBS have to agree with the count too — "1 test create data but have
      // no teardown" was pluralising the noun and leaving the verbs plural.
      `> 🗃️ ${orphanTotal} test${orphanTotal === 1 ? '' : 's'} ${orphanTotal === 1 ? 'creates' : 'create'} data but ${orphanTotal === 1 ? 'has' : 'have'} **no teardown** to remove it — orphaned records will pile up in the environment.`
    )
    lines.push('')
  }
  return lines.join('\n')
}
