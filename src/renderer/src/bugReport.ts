// =====================================================================
// AUTO BUG REPORT (Day 13)
// Turns a failure's evidence bundle (+ the translator's analysis, when
// one was run) into a ready-to-paste markdown bug report. Pure
// formatting — every fact in the report was already captured elsewhere:
// the steps ARE the reproduction recipe, the assertion error IS the
// expected-vs-actual, the screenshot/console/network ARE the evidence.
// =====================================================================

const VERDICT_TITLES: Record<FailureVerdict, string> = {
  'app-bug': 'Application bug (the product is misbehaving)',
  'test-bug': 'Test maintenance needed (the app looks healthy; the test is stale)',
  timing: 'Timing / flakiness (the app is slower than the test)',
  environment: 'Environment problem (the site could not be reached)',
  unknown: 'Unclassified — needs human triage'
}

// "Expected element to have text "Products" — actual: "Productz"" splits
// cleanly into the Expected / Actual rows every bug template wants.
function expectedVsActual(error: string): { expected: string; actual: string } {
  const m = /^Expected (.*?) — actual: (.*)$/s.exec(error)
  if (m) return { expected: m[1].trim(), actual: m[2].trim() }
  return {
    expected: 'The step completes successfully',
    actual: error
  }
}

export function generateBugReport(ev: FailureEvidence, analysis: FailureAnalysis | null): string {
  const now = new Date()
  const lines: string[] = []

  // Whole-test report when several steps failed (Continue mode) — every failure
  // in one document, not one report per step. `fails` is the list we walk.
  const multi = !!(ev.failures && ev.failures.length > 1)
  const fails = multi
    ? ev.failures!
    : [
        {
          index: ev.stepIndex,
          stepText: ev.stepText,
          error: ev.error,
          selector: ev.selector,
          screenshotPath: ev.screenshotPath
        }
      ]
  const failingIdx = new Set(fails.map((f) => f.index))

  lines.push(
    multi
      ? `# ${ev.testName ? `[${ev.testName}] ` : ''}${fails.length} steps fail (steps ${fails
          .map((f) => f.index + 1)
          .join(', ')})`
      : `# ${ev.testName ? `[${ev.testName}] ` : ''}Step ${ev.stepIndex + 1} fails: ${ev.stepText}`,
    '',
    `**Found by:** QATestFlow Recorder (automated replay)`,
    `**Date:** ${now.toLocaleString()}`,
    `**Page:** ${ev.pageUrl}${ev.pageTitle ? ` — "${ev.pageTitle}"` : ''}`,
    ''
  )

  if (analysis) {
    lines.push(
      '## Triage',
      '',
      `**Verdict:** ${VERDICT_TITLES[analysis.verdict] ?? analysis.verdict} _(${
        analysis.source === 'ai' ? 'analyzed by Claude' : 'rule-based analysis'
      })_`,
      '',
      analysis.explanation,
      ''
    )
    if (analysis.suggestion) lines.push(`**Suggested next action:** ${analysis.suggestion}`, '')
  }

  lines.push('## Steps to reproduce', '')
  ev.allSteps.forEach((s, i) => {
    lines.push(`${i + 1}. ${s}${failingIdx.has(i) ? '   ← **fails here**' : ''}`)
  })
  lines.push('')

  // Per-failure detail — one block each (a single failure renders one block, so
  // the layout is uniform whether one step or several failed).
  lines.push(multi ? `## Failures (${fails.length})` : '## Expected vs actual', '')
  fails.forEach((f) => {
    const { expected, actual } = expectedVsActual(f.error)
    if (multi) lines.push(`### Step ${f.index + 1}: ${f.stepText}`, '')
    lines.push(`**Expected:** ${expected}`, `**Actual:** ${actual}`, '')
    lines.push(`**Error:** \`${f.error}\``)
    if (f.selector) lines.push(`**Selector:** \`${f.selector}\``)
    if (f.screenshotPath)
      lines.push(`**Screenshot:** \`${f.screenshotPath}\` (annotated at the moment of failure)`)
    lines.push('')
  })

  lines.push('## Evidence during the run', '')

  if (ev.consoleErrors.length) {
    lines.push('**Console errors during the run:**', '', '```')
    for (const line of ev.consoleErrors.slice(0, 15)) lines.push(line)
    if (ev.consoleErrors.length > 15) lines.push(`… and ${ev.consoleErrors.length - 15} more`)
    lines.push('```', '')
  }
  if (ev.networkErrors.length) {
    lines.push('**Network problems during the run:**', '', '```')
    for (const line of ev.networkErrors.slice(0, 15)) lines.push(line)
    if (ev.networkErrors.length > 15) lines.push(`… and ${ev.networkErrors.length - 15} more`)
    lines.push('```', '')
  }
  if (!ev.consoleErrors.length && !ev.networkErrors.length) {
    lines.push('_No console or network errors were observed during the run._', '')
  }

  return lines.join('\n')
}

// A filesystem-safe default file name for the save dialog.
export function bugReportFileName(ev: FailureEvidence): string {
  const base = (ev.testName || 'bug-report')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const stamp = new Date().toISOString().slice(0, 10)
  return `${base || 'bug-report'}-step${ev.stepIndex + 1}-${stamp}.md`
}
