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
// One failed step in a whole-test analysis (Continue mode can fail several).
export interface FailureItem {
  index: number // 0-based index into allSteps
  stepText: string
  error: string
  selector?: string
  screenshotPath?: string
}

export interface FailureEvidence {
  testName?: string
  pageUrl: string
  pageTitle: string
  stepIndex: number // 0-based index of the (primary) failing step
  stepText: string // the human sentence, e.g. 'Click "Add to cart"'
  stepType: string
  selector?: string
  error: string
  consoleErrors: string[] // "[step 3] Uncaught TypeError: …"
  networkErrors: string[] // "[step 3] HTTP 500 on https://…/api/items"
  screenshotPath?: string
  allSteps: string[] // every step as a numbered sentence (repro context)
  // When a test failed at MORE THAN ONE step, all of them — so Explain and the
  // bug report cover the WHOLE test at once instead of step-by-step. The primary
  // fields above mirror failures[0] for the single-failure code paths.
  failures?: FailureItem[]
}

export type FailureVerdict = 'app-bug' | 'test-bug' | 'timing' | 'environment' | 'unknown'

// F9 (finer categories): the precise, triage-oriented sub-type — what to DO
// about it. `verdict` is the 4-bucket headline (drives the report band); this
// splits `test-bug` into the actions that differ, and flags the one case the
// tool genuinely can't disambiguate (a value mismatch = app bug OR stale test
// data). Deterministic from the error string, so it's cheap enough to compute
// on EVERY failure (the suite-wide breakdown relies on that).
//   stale-selector : element not found on a healthy page  → re-pick / self-heal
//   stale-data     : a value/option mismatch              → app bug OR edit the expected value
//   app-bug        : found-but-wrong-state, or missing element on a broken page
//   timing         : found but never actionable in time   → add a wait
//   environment    : site unreachable                     → check network/URL
//   authoring      : no reliable selector was recorded    → target a better element
//   unknown        : unclassified
export type FailureCategory =
  | 'stale-selector'
  | 'stale-data'
  | 'app-bug'
  | 'timing'
  | 'environment'
  | 'authoring'
  | 'unknown'

export interface FailureAnalysis {
  source: 'ai' | 'rules' // which backend produced this
  verdict: FailureVerdict
  explanation: string
  suggestion: string
  // F9: what the failure BLOCKED — how far the flow got and what never ran.
  // Deterministic (computed from step positions), so it's always present.
  impact?: string
  // F9 (finer categories): the precise triage sub-type (see FailureCategory).
  category?: FailureCategory
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

// Run-wide evidence sentences (console/network). Computed once and appended to
// the explanation — shared by every failed step, so listed a single time.
function buildNotes(ev: FailureEvidence): string[] {
  const siteNetErrors = ev.networkErrors.filter((l) => !isThirdParty(l))
  const thirdPartyCount = ev.networkErrors.length - siteNetErrors.length
  const serverErrors = siteNetErrors.filter((l) => /HTTP 5\d\d/.test(l))
  const clientErrors = siteNetErrors.filter((l) => /HTTP 4\d\d/.test(l))
  const requestFailures = siteNetErrors.filter((l) => !/HTTP \d\d\d/.test(l))
  const hasJsErrors = ev.consoleErrors.length > 0

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
  return notes
}

interface OneVerdict {
  verdict: FailureVerdict
  category: FailureCategory
  explanation: string
  suggestion: string
}

// Classify ONE failure by its error + the run's server/JS-error signals — WITHOUT
// the run-wide notes (the caller adds those once). This is the core rule engine;
// ruleBasedExplain wraps it for the single- and multi-failure cases.
function classifyOne(ev: FailureEvidence): OneVerdict {
  const err = ev.error || ''
  const siteNetErrors = ev.networkErrors.filter((l) => !isThirdParty(l))
  const serverErrors = siteNetErrors.filter((l) => /HTTP 5\d\d/.test(l))
  const hasJsErrors = ev.consoleErrors.length > 0

  const finish = (
    verdict: FailureVerdict,
    category: FailureCategory,
    explanation: string,
    suggestion: string
  ): OneVerdict => ({ verdict, category, explanation, suggestion })

  // Couldn't reach the site at all — nothing about the app or test ran.
  if (
    /ERR_(NAME_NOT_RESOLVED|CONNECTION_REFUSED|CONNECTION_TIMED_OUT|TIMED_OUT|INTERNET_DISCONNECTED|CERT_|ADDRESS_UNREACHABLE)/.test(
      err
    )
  ) {
    return finish(
      'environment',
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
        'app-bug',
        `The step "${ev.stepText}" could not find its element — and the page shows signs of being genuinely broken, so the element is likely missing because the application failed to render it, not because the selector went stale.`,
        'Treat this as an application defect: generate the bug report and attach the screenshot and logs.'
      )
    }
    return finish(
      'test-bug',
      'stale-selector',
      `The step "${ev.stepText}" could not find its element (selector: ${ev.selector ?? 'n/a'}), and the page otherwise looks healthy (no console or network errors). Most likely the page changed — the recorded selector no longer matches anything.`,
      'Use Re-pick during an interactive replay (or the selector ladder) to point the step at the right element, then save the healed test.'
    )
  }

  // Found, but never actionable — classic slow-page territory. replay.ts splits
  // this into two messages ("never became visible" / "stayed disabled") so an
  // optional step can skip the hidden case; both land here for triage.
  if (err.includes('never became visible') || err.includes('stayed disabled')) {
    if (hasJsErrors || serverErrors.length) {
      return finish(
        'app-bug',
        'app-bug',
        `The element for "${ev.stepText}" exists but never became visible/enabled — and the page logged real errors, so it may be stuck mid-load because something in the application broke.`,
        'Check the console/network evidence in the bug report; if the page is stuck, that is an application defect.'
      )
    }
    return finish(
      'timing',
      'timing',
      `The element for "${ev.stepText}" was found but stayed hidden or disabled past the wait limit. On a healthy page that usually means the page is simply slower than the test — an animation, a spinner, or a delayed fetch.`,
      'Retry the run; if it fails the same way, insert a wait step (or a visible-check) before this step to give the page time.'
    )
  }

  // Our own honest refusal — an authoring gap, not a product problem.
  if (err.includes('No reliable selector')) {
    return finish(
      'test-bug',
      'authoring',
      `The recorded element has no stable hooks (no id, role, or text), so replay refuses to guess — acting on the wrong element would be worse than failing. The test step needs a better target, the application did nothing wrong.`,
      'Re-record or re-pick a more specific element (a label, button, or a container with an id).'
    )
  }

  // An assertion compared expected vs actual and lost.
  if (err.startsWith('Expected ')) {
    return finish(
      'app-bug',
      'stale-data',
      `A check failed: ${err}. The element was found fine — its STATE is what differs from what was recorded as correct. Unless the expected value itself is outdated test data, the application is showing the wrong thing.`,
      'If the expectation is still correct, report this as an application bug; if the app legitimately changed, edit the expected value in the step.'
    )
  }

  // The dropdown no longer offers the recorded option.
  if (err.includes('Option not found')) {
    return finish(
      serverErrors.length || hasJsErrors ? 'app-bug' : 'unknown',
      'stale-data',
      `The dropdown for "${ev.stepText}" no longer contains the recorded option (${err}). Either the application's option list changed (app side) or the recorded choice is outdated test data (test side).`,
      'Open the page, look at the dropdown: if the option should exist, file the bug; if it was renamed, edit the step value.'
    )
  }

  return finish(
    'unknown',
    'unknown',
    `The step "${ev.stepText}" failed with: ${err}.`,
    'Check the screenshot and the console/network evidence to narrow it down.'
  )
}

// When a test fails at several steps, one headline verdict has to represent them
// all. Prefer the most product-implicating / actionable read: a real app-bug
// anywhere trumps a stale-test elsewhere, etc.
const VERDICT_PRIORITY: FailureVerdict[] = ['app-bug', 'environment', 'timing', 'test-bug', 'unknown']
function headlineVerdict(verdicts: FailureVerdict[]): FailureVerdict {
  for (const v of VERDICT_PRIORITY) if (verdicts.includes(v)) return v
  return 'unknown'
}

export function ruleBasedExplain(ev: FailureEvidence): FailureAnalysis {
  const notes = buildNotes(ev)

  // Whole-test analysis: classify EACH failed step, then combine into one verdict
  // + one explanation that walks through every failure. Run-wide notes once.
  if (ev.failures && ev.failures.length > 1) {
    const parts = ev.failures.map((f) => ({
      f,
      ...classifyOne({
        ...ev,
        stepIndex: f.index,
        stepText: f.stepText,
        error: f.error,
        selector: f.selector
      })
    }))
    const verdict = headlineVerdict(parts.map((p) => p.verdict))
    const headline = parts.find((p) => p.verdict === verdict) ?? parts[0]
    const explanation = [
      `This test failed at ${ev.failures.length} steps.`,
      ...parts.map(
        (p, i) => `(${i + 1}) Step ${p.f.index + 1} "${p.f.stepText}" — ${p.explanation}`
      ),
      ...notes
    ].join(' ')
    return {
      source: 'rules',
      verdict,
      category: headline.category,
      explanation,
      suggestion: headline.suggestion
    }
  }

  const one = classifyOne(ev)
  return {
    source: 'rules',
    verdict: one.verdict,
    category: one.category,
    explanation: [one.explanation, ...notes].join(' '),
    suggestion: one.suggestion
  }
}

// F9: the finer category for a failure, deterministic from the error — the
// headline failure's category when several failed. Cheap + offline, so it can be
// stamped on every failure (the suite-wide breakdown, Stage 2). Independent of
// which backend wrote the prose, so it's also attached to AI explanations.
export function categorizeFailure(ev: FailureEvidence): FailureCategory {
  if (ev.failures && ev.failures.length > 1) {
    const parts = ev.failures.map((f) =>
      classifyOne({ ...ev, stepIndex: f.index, stepText: f.stepText, error: f.error, selector: f.selector })
    )
    const v = headlineVerdict(parts.map((p) => p.verdict))
    return (parts.find((p) => p.verdict === v) ?? parts[0]).category
  }
  return classifyOne(ev).category
}

// === The Claude CLI backend =========================================
// Runs `claude -p` (headless one-shot mode of the Claude Code CLI the
// developer already has installed + logged into). The prompt goes in via
// stdin (no shell-quoting traps), the analysis comes back on stdout.

const CLAUDE_TIMEOUT_MS = 90_000

function buildPrompt(ev: FailureEvidence): string {
  const multi = !!(ev.failures && ev.failures.length > 1)
  const failedIdx = new Set(multi ? ev.failures!.map((f) => f.index) : [ev.stepIndex])
  const lines: string[] = [
    'You are a senior QA engineer triaging an automated UI test failure. Be concrete and brief.',
    '',
    `Test: ${ev.testName || '(unsaved recording)'}`,
    `Page at failure: ${ev.pageUrl} — "${ev.pageTitle}"`,
    '',
    'Recorded steps:',
    ...ev.allSteps.map((s, i) => `  ${i + 1}. ${s}${failedIdx.has(i) ? '   <-- FAILED HERE' : ''}`),
    ''
  ]
  if (multi) {
    lines.push(
      `This test failed at ${ev.failures!.length} steps. Analyze the WHOLE test and give ONE combined verdict + explanation that covers all of them:`,
      ...ev.failures!.map(
        (f, i) => `  (${i + 1}) Step ${f.index + 1}: ${f.stepText}${f.selector ? ` [selector: ${f.selector}]` : ''} — Error: ${f.error}`
      ),
      ''
    )
  } else {
    lines.push(
      `Failing step: ${ev.stepText} (type: ${ev.stepType}${ev.selector ? `, selector: ${ev.selector}` : ''})`,
      `Error: ${ev.error}`,
      ''
    )
  }
  lines.push(
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
  )
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

// Run one headless `claude -p` prompt; resolve to its stdout, or null on ANY
// problem (CLI missing, non-zero exit, timeout, empty output). Shared by the
// failure explainer and the F19 AI-assertion evaluator.
function runClaude(prompt: string, cwd: string, timeoutMs = CLAUDE_TIMEOUT_MS): Promise<string | null> {
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
    const settle = (value: string | null): void => {
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
    }, timeoutMs)

    child.on('error', () => settle(null)) // CLI not installed / not runnable
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.on('close', (code) => {
      settle(code === 0 && out.trim() ? out : null)
    })

    try {
      child.stdin?.write(prompt)
      child.stdin?.end()
    } catch {
      settle(null)
    }
  })
}

// Resolves to null on ANY problem — the caller falls back to the rules.
async function aiExplain(ev: FailureEvidence, cwd: string): Promise<FailureAnalysis | null> {
  const out = await runClaude(buildPrompt(ev), cwd)
  return out ? parseAiAnswer(out) : null
}

// === F9: impact line ================================================
// "Why it failed" (verdict/explanation) tells you the cause; this tells you the
// COST — how far the flow got and what never ran, so a PM/dev reads "how bad"
// at a glance. Deterministic from the step positions (no LLM needed), so it's
// attached to every analysis regardless of backend.
function computeImpact(ev: FailureEvidence): string {
  const total = ev.allSteps.length
  if (!total) return ''
  // Continue-mode: several steps failed but the run went the distance.
  if (ev.failures && ev.failures.length > 1) {
    return `${ev.failures.length} of ${total} steps failed — the test did not complete cleanly.`
  }
  const ran = Math.min(Math.max(ev.stepIndex + 1, 1), total) // 1-based steps reached
  const skipped = total - ran
  if (skipped <= 0) {
    return `Reached the final step (${ran} of ${total}) — the flow ran end-to-end, but its last check failed.`
  }
  const next = ev.allSteps
    .slice(ran, ran + 3)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const preview = next.length ? ` (${next.join('; ')}${skipped > 3 ? '; …' : ''})` : ''
  return `Blocked at step ${ran} of ${total} — the remaining ${skipped} step${
    skipped > 1 ? 's' : ''
  } never ran${preview}.`
}

// === The front door ==================================================
// Try the AI; fall back to the rules on any failure. The renderer shows
// `source` so the user always knows which brain answered.
export async function explainFailure(ev: FailureEvidence, cwd: string): Promise<FailureAnalysis> {
  const ai = await aiExplain(ev, cwd).catch(() => null)
  const analysis = ai ?? ruleBasedExplain(ev)
  const impact = computeImpact(ev)
  if (impact) analysis.impact = impact
  // F9: the finer category is deterministic from the error — attach it whichever
  // backend wrote the prose (the AI path returns only the 4-bucket verdict).
  analysis.category = categorizeFailure(ev)
  return analysis
}

// === F9 Stage 3: Deep RCA (whole-trace root-cause) ==================
// The normal Explain looks at the FAILING step + logs. Deep RCA is opt-in (a
// 🔬 button, one failure at a time) and hands the LLM the WHOLE run trace —
// every step's status, error, console/network, and SCREENSHOT — so it can find
// a root cause that started EARLIER than where the test reported the failure
// (a cascading failure). Costly (many screenshots), so never automatic.
// Shape mirrors buildPrompt/parseAiAnswer so the panel renders it identically.
export interface TraceStepLite {
  index: number
  text: string
  status: string
  durationMs?: number
  error?: string
  screenshotFile?: string
  consoleErrors: string[]
  networkErrors: string[]
}

function buildDeepPrompt(testName: string | undefined, steps: TraceStepLite[]): string {
  const lines: string[] = [
    'You are a senior QA engineer doing ROOT-CAUSE analysis on a failed UI test.',
    'You have the FULL step-by-step trace below — every step with its status, any',
    'error, its console/network problems, and a screenshot file you can open with',
    'the Read tool (the files are in your current directory).',
    '',
    'CRITICAL: the step the test reported as "error" is often only the SYMPTOM. The',
    'real cause can be an EARLIER step that silently went wrong (e.g. a login that',
    'looked ok but landed on the wrong page, a dismissed modal that never appeared).',
    'Walk the trace in order, LOOK at the screenshots around the failure, and find',
    'the earliest step where things actually went wrong.',
    '',
    `Test: ${testName || '(unsaved recording)'}`,
    '',
    'Trace:'
  ]
  for (const s of steps) {
    lines.push(
      `  Step ${s.index + 1} [${s.status}] ${s.text}${s.durationMs ? ` (${s.durationMs}ms)` : ''}`
    )
    if (s.error) lines.push(`     error: ${s.error}`)
    for (const c of s.consoleErrors.slice(0, 3)) lines.push(`     console: ${c.slice(0, 160)}`)
    for (const n of s.networkErrors.slice(0, 3)) lines.push(`     network: ${n.slice(0, 160)}`)
    if (s.screenshotFile) lines.push(`     screenshot: ${s.screenshotFile}`)
  }
  lines.push(
    '',
    'Open the screenshots around the failure before answering. Then respond in',
    'EXACTLY this format (no markdown, no preamble):',
    'VERDICT: <app-bug|test-bug|timing|environment|unknown>',
    'EXPLANATION: <2-4 sentences. State the EARLIEST step where it actually went',
    '  wrong (cite "step N") and how the later failure followed from it.>',
    'SUGGESTION: <one sentence: the next action to take>'
  )
  return lines.join('\n')
}

// Run Deep RCA. cwd MUST be the trace directory (so the model can Read the
// step screenshots by filename). Returns null on any problem — no rule fallback
// (cross-step visual reasoning is inherently the LLM's job); the caller shows a
// clear "needs Claude" message.
export async function deepRcaFailure(
  testName: string | undefined,
  steps: TraceStepLite[],
  traceCwd: string
): Promise<FailureAnalysis | null> {
  const out = await runClaude(buildDeepPrompt(testName, steps), traceCwd, 180_000).catch(() => null)
  const parsed = out ? parseAiAnswer(out) : null
  return parsed ? { ...parsed, source: 'ai' } : null
}

// === F19: AI (natural-language) assertion ============================
// A check written in plain English ("an order number is shown", "the date is
// today") that a fixed matcher can't express. At replay we hand the LLM the
// page's text + the claim and it judges PASS/FAIL. There is NO rule-based
// fallback — the check is inherently semantic — so if Claude can't run, the
// assertion FAILS loudly (never a silent green) with a clear reason.
export interface NlContext {
  url: string
  title: string
  text: string
  // Cheap DOM signal so text-only claims about images have evidence (innerText
  // has none — an <img> is not text).
  images?: { count: number; alts: string[] }
  // A bounded list of notable elements with their key attributes/roles — gives
  // the model evidence for attribute/role claims that aren't in the text or the
  // screenshot ("the submit button has aria-label X", "there's a link to /cart").
  elements?: Array<Record<string, string>>
  // A FULL-PAGE screenshot the LLM can actually LOOK at (via the Read tool) — the
  // only way to judge visual claims (images, layout, colours, icons), including
  // content below the fold.
  screenshotPath?: string
}
export interface NlVerdict {
  pass: boolean
  error: string // populated on FAIL (feeds the normal failure flow); '' on pass
}

function buildNlPrompt(claim: string, ctx: NlContext): string {
  const lines: string[] = [
    'You are a QA assertion evaluator. Decide whether a CLAIM about a web page is',
    'TRUE, judging ONLY from the page content provided (do not assume anything not',
    'shown). Be strict: if the page does not clearly satisfy the claim, it FAILS.',
    '',
    `CLAIM: "${claim}"`,
    '',
    `Page URL: ${ctx.url}`,
    `Page title: ${ctx.title}`
  ]
  if (ctx.images) {
    const alts = ctx.images.alts.length
      ? ` (sample alt text: ${ctx.images.alts.map((a) => `"${a}"`).join(', ')})`
      : ''
    lines.push(`Image elements on the page: ${ctx.images.count}${alts}`)
  }
  lines.push(
    'Visible page text (may be truncated; it contains NO information about images,',
    'layout, or colours — use the screenshot for those):',
    '"""',
    ctx.text.slice(0, 8000),
    '"""',
    ''
  )
  if (ctx.elements && ctx.elements.length) {
    lines.push(
      'Notable elements with their attributes/roles (for attribute/role/link claims):'
    )
    for (const el of ctx.elements.slice(0, 80)) {
      const attrs = Object.entries(el)
        .filter(([k]) => k !== 'tag' && k !== 'text')
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ')
      const txt = el.text ? ` — "${el.text}"` : ''
      lines.push(`  <${el.tag ?? 'el'}${attrs ? ' ' + attrs : ''}>${txt}`)
    }
    lines.push('')
  }
  if (ctx.screenshotPath) {
    lines.push(
      `A FULL-PAGE screenshot of the page is saved at: ${ctx.screenshotPath}`,
      'Use the Read tool to LOOK at it before deciding — it is the ONLY evidence for',
      'any visual claim (images present, layout, colours, icons), including content',
      'below the fold. Do not fail a visual claim for "no evidence" without looking',
      'at the screenshot first.',
      ''
    )
  }
  lines.push(
    'Answer in EXACTLY this format, no markdown, no preamble:',
    'RESULT: <PASS|FAIL>',
    'REASON: <one sentence citing what on the page makes it pass or fail>'
  )
  return lines.join('\n')
}

function parseNlAnswer(text: string): { pass: boolean; reason: string } | null {
  const m = /RESULT:\s*(PASS|FAIL)/i.exec(text)
  if (!m) return null
  const reason = /REASON:\s*([\s\S]*)$/i.exec(text)?.[1]?.trim() ?? ''
  return { pass: m[1].toUpperCase() === 'PASS', reason }
}

export async function evaluateNlAssertion(
  claim: string,
  ctx: NlContext,
  cwd: string
): Promise<NlVerdict> {
  const c = (claim || '').trim()
  if (!c) return { pass: false, error: 'AI check has no claim to verify — type what to check.' }
  const out = await runClaude(buildNlPrompt(c, ctx), cwd).catch(() => null)
  if (out == null) {
    return {
      pass: false,
      error: `AI check "${c}" could not run — Claude was unavailable. (This is an AI assertion; it needs the Claude CLI at replay time.)`
    }
  }
  const parsed = parseNlAnswer(out)
  if (!parsed) return { pass: false, error: `AI check "${c}" got an unreadable response from Claude.` }
  if (parsed.pass) return { pass: true, error: '' }
  return { pass: false, error: `AI check failed: "${c}" — ${parsed.reason || 'the page did not satisfy it.'}` }
}
