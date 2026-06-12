// =====================================================================
// FAILURE TRANSLATOR (Day 13)
// Turns a replay failure's raw evidence into a plain-English diagnosis
// with a VERDICT: was this an app bug, a test bug (stale selector /
// stale expectation), a timing problem, or an environment problem?
// That's the question every red test forces a human to answer — this
// module automates the first pass at it.
//
// Two interchangeable backends behind one function (explainFailure):
//   1. `claude -p` — the Claude Code CLI run headlessly. Uses the
//      machine's existing Claude subscription login; there is NO API
//      key anywhere in this app, so it can never produce a bill.
//   2. Rule-based — our own classifier over the error strings the
//      replay engine itself produces. Always available, fully offline.
// The AI path is tried first; ANY problem (CLI missing, logged out,
// timeout, unparseable answer) falls back silently to the rules.
// =====================================================================

import { spawn } from 'child_process'

// Everything we know about a failure, gathered at the moment it happened.
// Assembled by the renderer (it owns the step list + human step text);
// console/network lines come from main's replay-time capture.
export interface FailureEvidence {
  testName?: string
  pageUrl: string
  pageTitle: string
  stepIndex: number // 0-based index of the failing step
  stepText: string // the human sentence, e.g. 'Click "Add to cart"'
  stepType: string
  selector?: string
  error: string
  consoleErrors: string[] // "[step 3] Uncaught TypeError: …"
  networkErrors: string[] // "[step 3] HTTP 500 on https://…/api/items"
  screenshotPath?: string
  allSteps: string[] // every step as a numbered sentence (repro context)
}

export type FailureVerdict = 'app-bug' | 'test-bug' | 'timing' | 'environment' | 'unknown'

export interface FailureAnalysis {
  source: 'ai' | 'rules' // which backend produced this
  verdict: FailureVerdict
  explanation: string
  suggestion: string
}

// === The rule-based backend =========================================
// We wrote every error message the replay engine can produce, so we can
// classify them reliably — and sharpen the verdict with the console /
// network evidence (a "not found" WITH server 500s reads very
// differently from a "not found" on a healthy page).

const firstLine = (lines: string[]): string => (lines[0] ?? '').slice(0, 160)

// Network lines are tagged [site] / [third-party] at capture (main/index.ts).
// Third-party failures (analytics, crash reporters) happen constantly on
// healthy real-world pages, so only SAME-SITE errors count as evidence that
// the application is broken; third-party lines are reported but not weighed.
const isThirdParty = (l: string): boolean => l.includes('[third-party]')

// Same-site lines first (the ones that can implicate the app), order kept
// within each group — used by the prompt AND the UI so the capped "first N"
// can never be all junk.
export const siteFirst = (lines: string[]): string[] =>
  [...lines].sort((a, b) => Number(isThirdParty(a)) - Number(isThirdParty(b)))

export function ruleBasedExplain(ev: FailureEvidence): FailureAnalysis {
  const err = ev.error || ''
  const siteNetErrors = ev.networkErrors.filter((l) => !isThirdParty(l))
  const thirdPartyCount = ev.networkErrors.length - siteNetErrors.length
  const serverErrors = siteNetErrors.filter((l) => /HTTP 5\d\d/.test(l))
  const clientErrors = siteNetErrors.filter((l) => /HTTP 4\d\d/.test(l))
  const requestFailures = siteNetErrors.filter((l) => !/HTTP \d\d\d/.test(l))
  const hasJsErrors = ev.consoleErrors.length > 0

  // Evidence sentences appended to whichever explanation wins below.
  const notes: string[] = []
  if (serverErrors.length) {
    notes.push(
      `The server returned ${serverErrors.length} error response(s) — e.g. ${firstLine(serverErrors)} — which points at the application's backend.`
    )
  }
  if (clientErrors.length) {
    notes.push(
      `There were also ${clientErrors.length} HTTP 4xx response(s) (${firstLine(clientErrors)}).`
    )
  }
  if (requestFailures.length) {
    notes.push(`Some requests never completed at all (${firstLine(requestFailures)}).`)
  }
  if (hasJsErrors) {
    notes.push(
      `The page logged ${ev.consoleErrors.length} JavaScript error(s) — e.g. ${firstLine(ev.consoleErrors)} — so the page's own code may be broken.`
    )
  }
  if (thirdPartyCount) {
    notes.push(
      `(${thirdPartyCount} third-party request error(s) — analytics/telemetry from other domains — were also captured; these are common on healthy pages and were not counted as evidence.)`
    )
  }

  const finish = (
    verdict: FailureVerdict,
    explanation: string,
    suggestion: string
  ): FailureAnalysis => ({
    source: 'rules',
    verdict,
    explanation: [explanation, ...notes].join(' '),
    suggestion
  })

  // Couldn't reach the site at all — nothing about the app or test ran.
  if (
    /ERR_(NAME_NOT_RESOLVED|CONNECTION_REFUSED|CONNECTION_TIMED_OUT|TIMED_OUT|INTERNET_DISCONNECTED|CERT_|ADDRESS_UNREACHABLE)/.test(
      err
    )
  ) {
    return finish(
      'environment',
      `The browser could not load the page at all (${err}). Neither the test nor the application got a chance to run — this is a network / environment problem, not a product or test defect.`,
      'Check the URL, your internet connection, and whether the site is up, then run again.'
    )
  }

  // The element never appeared. Stale selector (test bug) — unless the
  // page is visibly broken underneath, in which case the element is
  // probably missing BECAUSE the app failed to render it.
  if (err.includes('Element not found')) {
    if (serverErrors.length || hasJsErrors) {
      return finish(
        'app-bug',
        `The step "${ev.stepText}" could not find its element — and the page shows signs of being genuinely broken, so the element is likely missing because the application failed to render it, not because the selector went stale.`,
        'Treat this as an application defect: generate the bug report and attach the screenshot and logs.'
      )
    }
    return finish(
      'test-bug',
      `The step "${ev.stepText}" could not find its element (selector: ${ev.selector ?? 'n/a'}), and the page otherwise looks healthy (no console or network errors). Most likely the page changed — the recorded selector no longer matches anything.`,
      'Use Re-pick during an interactive replay (or the selector ladder) to point the step at the right element, then save the healed test.'
    )
  }

  // Found, but never actionable — classic slow-page territory.
  if (err.includes('never became visible/enabled')) {
    if (hasJsErrors || serverErrors.length) {
      return finish(
        'app-bug',
        `The element for "${ev.stepText}" exists but never became visible/enabled — and the page logged real errors, so it may be stuck mid-load because something in the application broke.`,
        'Check the console/network evidence in the bug report; if the page is stuck, that is an application defect.'
      )
    }
    return finish(
      'timing',
      `The element for "${ev.stepText}" was found but stayed hidden or disabled past the wait limit. On a healthy page that usually means the page is simply slower than the test — an animation, a spinner, or a delayed fetch.`,
      'Retry the run; if it fails the same way, insert a wait step (or a visible-check) before this step to give the page time.'
    )
  }

  // Our own honest refusal — an authoring gap, not a product problem.
  if (err.includes('No reliable selector')) {
    return finish(
      'test-bug',
      `The recorded element has no stable hooks (no id, role, or text), so replay refuses to guess — acting on the wrong element would be worse than failing. The test step needs a better target, the application did nothing wrong.`,
      'Re-record or re-pick a more specific element (a label, button, or a container with an id).'
    )
  }

  // An assertion compared expected vs actual and lost.
  if (err.startsWith('Expected ')) {
    return finish(
      'app-bug',
      `A check failed: ${err}. The element was found fine — its STATE is what differs from what was recorded as correct. Unless the expected value itself is outdated test data, the application is showing the wrong thing.`,
      'If the expectation is still correct, report this as an application bug; if the app legitimately changed, edit the expected value in the step.'
    )
  }

  // The dropdown no longer offers the recorded option.
  if (err.includes('Option not found')) {
    return finish(
      serverErrors.length || hasJsErrors ? 'app-bug' : 'unknown',
      `The dropdown for "${ev.stepText}" no longer contains the recorded option (${err}). Either the application's option list changed (app side) or the recorded choice is outdated test data (test side).`,
      'Open the page, look at the dropdown: if the option should exist, file the bug; if it was renamed, edit the step value.'
    )
  }

  return finish(
    'unknown',
    `The step "${ev.stepText}" failed with: ${err}.`,
    'Check the screenshot and the console/network evidence to narrow it down.'
  )
}

// === The Claude CLI backend =========================================
// Runs `claude -p` (headless one-shot mode of the Claude Code CLI the
// developer already has installed + logged into). The prompt goes in via
// stdin (no shell-quoting traps), the analysis comes back on stdout.

const CLAUDE_TIMEOUT_MS = 90_000

function buildPrompt(ev: FailureEvidence): string {
  const lines: string[] = [
    'You are a senior QA engineer triaging an automated UI test failure. Be concrete and brief.',
    '',
    `Test: ${ev.testName || '(unsaved recording)'}`,
    `Page at failure: ${ev.pageUrl} — "${ev.pageTitle}"`,
    '',
    'Recorded steps:',
    ...ev.allSteps.map(
      (s, i) => `  ${i + 1}. ${s}${i === ev.stepIndex ? '   <-- FAILED HERE' : ''}`
    ),
    '',
    `Failing step: ${ev.stepText} (type: ${ev.stepType}${ev.selector ? `, selector: ${ev.selector}` : ''})`,
    `Error: ${ev.error}`,
    '',
    ev.consoleErrors.length
      ? `Console errors during the run:\n${ev.consoleErrors
          .slice(0, 10)
          .map((l) => `  ${l.slice(0, 200)}`)
          .join('\n')}`
      : 'Console errors during the run: none',
    ev.networkErrors.length
      ? // Same-site lines first so the 10-line cap can't crowd out the ones
        // that matter; tags tell the model whose server each failure was.
        `Network problems during the run ([site] = the site under test, [third-party] = analytics/other domains, often harmless noise):\n${siteFirst(
          ev.networkErrors
        )
          .slice(0, 10)
          .map((l) => `  ${l.slice(0, 200)}`)
          .join('\n')}`
      : 'Network problems during the run: none',
    ''
  ]
  if (ev.screenshotPath) {
    lines.push(
      `An annotated screenshot of the page at the moment of failure is saved at: ${ev.screenshotPath}`,
      'Use the Read tool to look at it before answering.',
      ''
    )
  }
  lines.push(
    'Decide what kind of failure this is:',
    '  app-bug      = the application under test is misbehaving',
    '  test-bug     = the test is stale (selector or expected value no longer matches a healthy app)',
    '  timing       = the app is fine but slower than the test (waits needed)',
    '  environment  = network/site unreachable, nothing meaningful ran',
    '',
    'Answer in EXACTLY this format (no markdown, no preamble):',
    'VERDICT: <app-bug|test-bug|timing|environment|unknown>',
    'EXPLANATION: <2-4 plain sentences a manual tester would understand, citing the evidence>',
    'SUGGESTION: <one sentence: the next action to take>'
  )
  return lines.join('\n')
}

function parseAiAnswer(text: string): FailureAnalysis | null {
  const verdictMatch = /VERDICT:\s*(app-bug|test-bug|timing|environment|unknown)/i.exec(text)
  const explanationMatch = /EXPLANATION:\s*([\s\S]*?)(?=\nSUGGESTION:|$)/i.exec(text)
  const suggestionMatch = /SUGGESTION:\s*([\s\S]*)$/i.exec(text)
  if (!verdictMatch || !explanationMatch) return null
  return {
    source: 'ai',
    verdict: verdictMatch[1].toLowerCase() as FailureVerdict,
    explanation: explanationMatch[1].trim(),
    suggestion: (suggestionMatch?.[1] ?? '').trim()
  }
}

// Resolves to null on ANY problem — the caller falls back to the rules.
function aiExplain(ev: FailureEvidence, cwd: string): Promise<FailureAnalysis | null> {
  return new Promise((resolve) => {
    // COST SAFETY: even if an Anthropic API key exists in the machine's
    // environment, never let the CLI see it — with no key, `claude` can
    // only use the local subscription login, which is a flat fee.
    const env = { ...process.env }
    delete env.ANTHROPIC_API_KEY

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(
        'claude',
        // -p = print-and-exit (headless). Read-only tool access so it can
        // open the screenshot; max-turns bounds a runaway session.
        ['-p', '--output-format', 'text', '--allowedTools', 'Read', '--max-turns', '8'],
        // shell:true lets Windows resolve claude.cmd from PATH.
        { cwd, env, shell: process.platform === 'win32', windowsHide: true }
      )
    } catch {
      resolve(null)
      return
    }

    let out = ''
    let settled = false
    const settle = (value: FailureAnalysis | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // already gone
      }
      settle(null)
    }, CLAUDE_TIMEOUT_MS)

    child.on('error', () => settle(null)) // CLI not installed / not runnable
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.on('close', (code) => {
      if (code !== 0 || !out.trim()) {
        settle(null)
        return
      }
      settle(parseAiAnswer(out))
    })

    try {
      child.stdin?.write(buildPrompt(ev))
      child.stdin?.end()
    } catch {
      settle(null)
    }
  })
}

// === The front door ==================================================
// Try the AI; fall back to the rules on any failure. The renderer shows
// `source` so the user always knows which brain answered.
export async function explainFailure(ev: FailureEvidence, cwd: string): Promise<FailureAnalysis> {
  const ai = await aiExplain(ev, cwd).catch(() => null)
  return ai ?? ruleBasedExplain(ev)
}
