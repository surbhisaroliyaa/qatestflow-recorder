import type { SuiteRunState } from './suiteTypes'
import { CATEGORY_LABELS, CATEGORY_WHY } from './uiLabels'
import { collidesWithOsEnv } from '../../shared/osEnvNames'

// =====================================================================
// The paste-ready markdown for a suite run. Pure: everything it needs is passed
// in, so it can be tested without a running app -- which matters because this is
// the artefact people paste into a ticket and act on.
// =====================================================================

export const generateSuiteReport = (
  suiteRun: SuiteRunState | null,
): string => {
  if (!suiteRun) return ''
  const r = suiteRun.results
  const passed = r.filter((x) => x.status === 'passed').length
  const failed = r.length - passed
  const healed = r.reduce((s, x) => s + (x.healed ?? 0), 0)
  const byCat = new Map<string, number>()
  for (const x of r) {
    if (x.status === 'failed') {
      const c = x.category ?? 'unknown'
      byCat.set(c, (byCat.get(c) ?? 0) + 1)
    }
  }
  const lines: string[] = [
    `# Suite run — ${suiteRun.suite}`,
    '',
    `**${passed}/${r.length} passed · ${failed} failed${healed ? ` · ${healed} selector${healed > 1 ? 's' : ''} auto-healed` : ''}**`,
    ''
  ]
  if (byCat.size) {
    lines.push('## Failures by type', '')
    for (const [c, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) {
      // The reason travels WITH the count. Pasted into a ticket or a PR, this
      // report is read by someone who can't hover a chip to find out why an
      // "app bug" was called an app bug.
      const why = CATEGORY_WHY[c as FailureCategory]
      lines.push(`- **${CATEGORY_LABELS[c as FailureCategory] ?? c}: ${n}**${why ? ` — ${why}` : ''}`)
    }
    lines.push('')
  }
  // F25: unresolved {{env:…}} — in the pasted report too, since that's what
  // reaches a ticket. Without it the reader sees only the downstream failure.
  {
    const byVar = new Map<string, string[]>()
    for (const r of suiteRun.results) {
      for (const v of r.unresolvedEnv ?? []) {
        byVar.set(v, [...(byVar.get(v) ?? []), r.name])
      }
    }
    if (byVar.size) {
      lines.push('## ⚠ Environment variables with no value', '')
      lines.push(
        `Each was replaced with an empty string, so a failure below may be about the environment rather than the test.`,
        ''
      )
      for (const [v, tests] of byVar) {
        lines.push(
          `- \`{{env:${v}}}\` — ${tests.length} test${tests.length === 1 ? '' : 's'}: ${tests.join(', ')}` +
            (collidesWithOsEnv(v)
              ? ' _(never read from the OS, which defines this name too)_'
              : '')
        )
      }
      lines.push('')
    }
  }
  if (suiteRun.healables?.length) {
    lines.push('## Healable failures (review before accepting)', '')
    for (const hf of suiteRun.healables) {
      lines.push(
        `- ${hf.name} → suggests "${hf.healable.label}" (${hf.healable.signals.join(' + ')} · ${hf.healable.score}/100)`
      )
    }
    lines.push('')
  }
  lines.push('## Tests', '')
  // Two tests can share a display name in different sections (Daily/… and
  // E2E/… both hold a "saucedemo.com flow"). Listing the bare name made one
  // pass and one fail read as the SAME test reported twice with contradictory
  // results — the report looked broken when it was being accurate. Only the
  // ambiguous ones get the section, so the common case stays uncluttered.
  const nameCounts = new Map<string, number>()
  for (const x of r) nameCounts.set(x.name, (nameCounts.get(x.name) ?? 0) + 1)
  const sectionOf = (fileName: string): string =>
    fileName.includes('/') ? fileName.slice(0, fileName.lastIndexOf('/')) : ''
  for (const x of r) {
    const icon = x.status === 'passed' ? '✓' : '✗'
    const tags = [
      x.healed ? `🤖 ${x.healed} healed` : '',
      x.status === 'failed' && x.category ? (CATEGORY_LABELS[x.category] ?? x.category) : ''
    ]
      .filter(Boolean)
      .join(' · ')
    const section =
      (nameCounts.get(x.name) ?? 0) > 1 ? sectionOf(x.fileName) : ''
    lines.push(
      `- ${icon} **${x.name}**${section ? ` \`(${section})\`` : ''}${tags ? ` — ${tags}` : ''}` +
        (x.status === 'failed' && x.error ? `\n  - ${x.error}` : '')
    )
  }
  return lines.join('\n')
}
