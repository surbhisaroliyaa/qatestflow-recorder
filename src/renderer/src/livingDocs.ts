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

// The step types that VERIFY something (vs perform an action) — they populate
// the "Checks" section, which is the part a reviewer cares about most.
const CHECK_TYPES = new Set(['assert', 'snapshot', 'a11y', 'perf'])

export interface DocMeta {
  suite?: string
  baseURL?: string
  storageState?: string
  viewport?: { width: number; height: number }
  dataRows?: Record<string, string>[]
}

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
  if (meta.viewport) {
    out.push(`Runs at a ${meta.viewport.width}×${meta.viewport.height} viewport (device emulation).`)
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

// Split a flow into its actions and its checks (both as human sentences).
function partition(flat: RecorderStep[]): { actions: RecorderStep[]; checks: RecorderStep[] } {
  const steps = flat.filter((s) => !s.disabled)
  return {
    actions: steps.filter((s) => !CHECK_TYPES.has(s.type)),
    checks: steps.filter((s) => CHECK_TYPES.has(s.type))
  }
}

// One test → a markdown document. `flat` should be the FLATTENED steps (linked
// blocks already expanded) so the doc describes what actually runs.
export function generateTestDoc(name: string, flat: RecorderStep[], meta: DocMeta = {}): string {
  const { actions, checks } = partition(flat)
  const host = hostOf(meta.baseURL || flat.find((s) => s.type === 'navigate')?.url)
  const lines: string[] = []
  lines.push(`# ${name || 'Recorded test'}`)
  lines.push('')
  lines.push(
    `**What it does:** a ${actions.length}-step flow${host ? ` on ${host}` : ''} that verifies ` +
      `${checks.length} outcome${checks.length === 1 ? '' : 's'}.`
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
  if (checks.length === 0) {
    lines.push(
      '- ⚠ **No checks** — this test performs actions but verifies nothing. A green run here ' +
        'only proves the steps ran, not that the app behaved correctly. Consider adding an assertion.'
    )
  } else {
    checks.forEach((s) => lines.push(`- ${stepText(s)}`))
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
  for (const [suite, tests] of bySuite) {
    lines.push(`## ${suite}`)
    lines.push('')
    for (const t of tests) {
      const { actions, checks } = partition(t.flat)
      if (checks.length === 0) noCheckTotal++
      lines.push(
        `- **${t.name}** — ${actions.length} actions, ${checks.length} checks` +
          (checks.length === 0 ? ' ⚠ _(verifies nothing)_' : '')
      )
    }
    lines.push('')
  }
  if (noCheckTotal > 0) {
    lines.push(
      `> ⚠ ${noCheckTotal} test${noCheckTotal === 1 ? ' has' : 's have'} no checks — passing but verifying nothing.`
    )
    lines.push('')
  }
  return lines.join('\n')
}
