// =====================================================================
// THE COMMAND LINE  (Phase 4, audit gap: "a general CLI")
// =====================================================================
// WHY THIS IS THE ONE THAT MATTERS
//
// Everything else this app does, it does on one person's desktop. A CLI is
// what lets the same tests run somewhere nobody is sitting: a pipeline, a
// nightly job, a pre-release gate. Without it the tool is a personal
// instrument; with it, it's part of a team's build.
//
// == It is the SAME executable ==
//
// This app is installed, not cloned. There is no `npm start`, no repo, no
// node_modules on the machine that runs it — so the CLI cannot be a separate
// script. It is the installed .exe with arguments:
//
//     "QATestFlow Recorder.exe" run --suite E2E --reporter junit --out r.xml
//
// When a command is present, main never opens a window: it runs the tests
// through the same headless Playwright path the parallel runner already uses,
// writes a report, and exits with a code a pipeline can read.
//
// == The Windows console caveat, stated rather than hidden ==
//
// A packaged Electron app on Windows is a GUI-subsystem binary, so its stdout
// is not attached to the terminal that launched it. Output still goes to a
// file via --out, and the exit code is still correct, but text printed to
// stdout may not appear in cmd.exe. That is a property of the platform, not a
// bug to be surprised by, so `--out` is the documented path and the help text
// says so.
//
// This module is deliberately all pure functions — parsing, selection,
// formatting. Everything that touches disk or spawns Playwright lives in
// index.ts, so every rule here is testable without an Electron app.
// =====================================================================

import type { RunSummary } from '../shared/postback'

export interface CliOptions {
  command: 'run' | 'list' | 'help'
  /** Only tests in this suite (folder). */
  suite?: string
  /** Only tests in this project (the folder above the suite). */
  project?: string
  /** Only tests carrying ALL of these tags. */
  tags: string[]
  /** Only tests whose name or path contains this, case-insensitively. */
  grep?: string
  /**
   * Exactly this one test, by its library-relative file path
   * (e.g. `E2E/login.json`, as `list` prints it). --grep is a substring match,
   * which is right for a person narrowing a list and wrong for anything that
   * must run ONE test: "Login" also matches "Login negative".
   */
  test?: string
  reporter: 'text' | 'json' | 'junit'
  /** Write the report here instead of (only) stdout. */
  out?: string
  workers: number
  /**
   * Record this run against a monitor's history (the monitor's id).
   *
   * Set only by the scheduled task the app creates for "🌙 runs when closed" —
   * it is not for people to type, which is why it is absent from --help. Without
   * it a monitor that ran all night with the app closed left no trace in the
   * app: its history and "last run" only ever showed in-app runs.
   */
  monitorId?: string
  /** Exit 0 even when tests failed — for a pipeline stage that only collects. */
  allowFailures: boolean
}

export const CLI_DEFAULTS: Pick<CliOptions, 'tags' | 'reporter' | 'workers' | 'allowFailures'> = {
  tags: [],
  reporter: 'text',
  workers: 4,
  allowFailures: false
}

/** A flag that takes a value, so `--suite E2E` and `--suite=E2E` both work. */
const VALUE_FLAGS = new Set([
  '--suite',
  '--project',
  '--tag',
  '--grep',
  '--test',
  '--reporter',
  '--out',
  '--workers',
  '--monitor'
])

export class CliError extends Error {}

/**
 * Read the command line.
 *
 * Returns null when there is no command — which is the normal case, because
 * this is the same binary the user double-clicks. Getting that wrong in either
 * direction is bad in a specific way: treat a normal launch as a command and
 * the app never opens; miss a real command and a pipeline silently opens a
 * window on a build agent and hangs forever.
 *
 * `argv` is the process argv with the executable (and, in dev, the script
 * path) already stripped by the caller — which is why that stripping is NOT
 * done here, where it could not be tested honestly.
 */
export function parseArgs(argv: string[]): CliOptions | null {
  const args = argv.filter((a) => a !== '--')
  if (!args.length) return null

  const first = args[0]
  // Electron and Chromium add their own switches (--inspect, --no-sandbox,
  // --remote-debugging-port, and on some systems a bare file path). A command
  // has to be the FIRST argument and a bare word, or we are not being asked to
  // run a command at all.
  if (first.startsWith('-')) {
    if (first === '--help' || first === '-h' || first === '--version' || first === '-v') {
      return { ...CLI_DEFAULTS, command: 'help' }
    }
    return null
  }
  if (first !== 'run' && first !== 'list' && first !== 'help') return null

  const opts: CliOptions = { ...CLI_DEFAULTS, command: first === 'help' ? 'help' : first, tags: [] }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('--')) continue

    let name = arg
    let value: string | undefined
    const eq = arg.indexOf('=')
    if (eq > 0) {
      name = arg.slice(0, eq)
      value = arg.slice(eq + 1)
    }

    if (name === '--help' || name === '-h') {
      opts.command = 'help'
      continue
    }
    if (name === '--allow-failures') {
      opts.allowFailures = true
      continue
    }
    if (!VALUE_FLAGS.has(name)) {
      // An unknown flag is an error, not something to ignore. A typo in a
      // pipeline — `--suit E2E` — would otherwise run the WHOLE library and
      // report success, which is the most expensive way for this to be wrong.
      throw new CliError(`Unknown option "${name}". Run with --help to see what is supported.`)
    }
    if (value === undefined) {
      value = args[++i]
      if (value === undefined || value.startsWith('--')) {
        throw new CliError(`Option "${name}" needs a value.`)
      }
    }

    switch (name) {
      case '--suite':
        opts.suite = value
        break
      case '--project':
        opts.project = value
        break
      case '--tag':
        // Repeatable, and ANDed: --tag @smoke --tag @checkout means both.
        opts.tags.push(value.startsWith('@') ? value : `@${value}`)
        break
      case '--grep':
        opts.grep = value
        break
      case '--test':
        opts.test = value
        break
      case '--reporter':
        if (value !== 'text' && value !== 'json' && value !== 'junit') {
          throw new CliError(`Unknown reporter "${value}". Use text, json or junit.`)
        }
        opts.reporter = value
        break
      case '--out':
        opts.out = value
        break
      case '--monitor':
        opts.monitorId = value
        break
      case '--workers': {
        const n = Number(value)
        if (!Number.isInteger(n) || n < 1 || n > 32) {
          throw new CliError(`--workers must be a whole number from 1 to 32 (got "${value}").`)
        }
        opts.workers = n
        break
      }
    }
  }
  return opts
}

/** One test, as the CLI needs to see it for selection. */
export interface SelectableTest {
  fileName: string
  name: string
  suite: string
  project: string
  tags?: string[]
}

/**
 * Which tests the options select.
 *
 * Filters are ANDed, and an absent filter matches everything. Tags are ANDed
 * with each other too — `--tag @smoke --tag @checkout` means tests that are
 * both, not either, because "run the smoke tests for checkout" is what people
 * mean and the union is almost never useful.
 */
export function selectTests(tests: SelectableTest[], opts: CliOptions): SelectableTest[] {
  const grep = opts.grep?.toLowerCase()
  const exact = opts.test ? samePath(opts.test) : undefined
  return tests.filter((t) => {
    if (exact !== undefined && samePath(t.fileName) !== exact) return false
    if (opts.suite && t.suite !== opts.suite) return false
    if (opts.project && t.project !== opts.project) return false
    if (opts.tags.length && !opts.tags.every((tag) => (t.tags ?? []).includes(tag))) return false
    if (grep && !`${t.name} ${t.fileName}`.toLowerCase().includes(grep)) return false
    return true
  })
}

/**
 * A library path in the one form two spellings of it can be compared in.
 * Windows users type `E2E\login.json`, `list` prints `E2E/login.json`, and the
 * file system does not care about case — so neither does this.
 */
function samePath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\/+/, '')
    .toLowerCase()
}

/**
 * The options a run for a MONITOR actually uses: exactly the monitor's own
 * test, and nothing else.
 *
 * Every other filter is dropped, on purpose. Scheduled tasks created before
 * this existed carry `--grep "<test name>" --monitor <id>`; the grep was a
 * substring match that also ran "Login negative" for a monitor on "Login". With
 * the file pinned exactly, keeping the grep could only ever HIDE the right test
 * — after a rename, the old name no longer matches and the task would run
 * nothing. So an old task keeps working, exactly, with no re-creation.
 */
export function monitorSelection(opts: CliOptions, fileName: string): CliOptions {
  return {
    ...opts,
    test: fileName,
    grep: undefined,
    suite: undefined,
    project: undefined,
    tags: []
  }
}

export interface CliTestResult {
  name: string
  fileName: string
  ok: boolean
  durationMs: number
  error?: string
  /**
   * The step the failure happened on, 1-based and numbered the way the editor
   * numbers the saved test — so "step 4" here is the fourth row the user sees.
   * Absent when the failure could not be traced to a step; see stepAtLine.
   */
  failedAtStep?: number
  /** A data-driven test: how many rows ran and how many failed. */
  rows?: { total: number; failed: number }
  /**
   * This test's postback, when one was attempted. Absent when postbacks are
   * off or the policy skipped this result. A failed delivery never changes the
   * exit code — the tests' outcome is the truth — but it is REPORTED, because a
   * postback nobody hears about failing is the exact problem it exists to solve.
   */
  postback?: { ok: boolean; error?: string }
}

export interface CliRunReport {
  total: number
  passed: number
  failed: number
  durationMs: number
  results: CliTestResult[]
}

export function summarize(results: CliTestResult[], durationMs: number): CliRunReport {
  const failed = results.filter((r) => !r.ok).length
  return {
    total: results.length,
    passed: results.length - failed,
    failed,
    durationMs,
    results
  }
}

/** XML-escape. Every one of these five has broken somebody's JUnit parser. */
function xml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * JUnit XML — the format every CI system already knows how to read.
 *
 * This is the whole reason to support it rather than inventing something: it
 * means Jenkins, GitLab CI and GitHub Actions display the results natively,
 * with no glue code from the user.
 *
 * Control characters are stripped from messages. They are legal in a JS string
 * and ILLEGAL in XML 1.0, and a single one makes the entire file unparseable —
 * so a test failing with an odd byte in its message would take the whole report
 * down with it, which reads to the user as "the run produced nothing".
 */
export function formatJunit(report: CliRunReport, suiteName = 'QATestFlow'): string {
  const clean = (s: string): string =>
    // Matching control characters is the POINT here: they are legal in a JS
    // string and illegal in XML 1.0, and one of them makes the whole report
    // unparseable. This is the one place that should contain this range.
    // eslint-disable-next-line no-control-regex
    xml(s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''))
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>']
  lines.push(
    `<testsuite name="${xml(suiteName)}" tests="${report.total}" failures="${report.failed}" time="${(report.durationMs / 1000).toFixed(3)}">`
  )
  for (const r of report.results) {
    const open = `  <testcase name="${clean(r.name)}" classname="${clean(r.fileName)}" time="${(r.durationMs / 1000).toFixed(3)}"`
    if (r.ok) {
      lines.push(`${open} />`)
    } else {
      lines.push(`${open}>`)
      // The step goes in the element's text, not the message attribute: CI
      // systems show the message as the headline and it should stay the error.
      const at = r.failedAtStep !== undefined ? `Failed at step ${r.failedAtStep}` : ''
      lines.push(`    <failure message="${clean(r.error ?? 'Test failed')}">${at}</failure>`)
      lines.push('  </testcase>')
    }
  }
  lines.push('</testsuite>')
  return lines.join('\n') + '\n'
}

export function formatJson(report: CliRunReport): string {
  return JSON.stringify(report, null, 2) + '\n'
}

/** Human-readable, for someone running it by hand. */
export function formatText(report: CliRunReport): string {
  const lines = report.results.map((r) => {
    let line = `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`
    if (r.rows) line += `  (${r.rows.total - r.rows.failed}/${r.rows.total} rows passed)`
    if (!r.ok) {
      const at = r.failedAtStep !== undefined ? `step ${r.failedAtStep}: ` : ''
      line += `\n      ${at}${r.error ?? ''}`
    }
    if (r.postback && !r.postback.ok) {
      line += `\n      postback not delivered: ${r.postback.error ?? 'no reason given'}`
    }
    return line
  })
  lines.push('')
  lines.push(
    `${report.passed} passed, ${report.failed} failed, ${report.total} total ` +
      `(${(report.durationMs / 1000).toFixed(1)}s)`
  )
  const pb = postbackProblem(report)
  if (pb) lines.push(pb)
  return lines.join('\n') + '\n'
}

/**
 * One line saying which postbacks did not arrive, or null when every attempted
 * one did. Shared by the text report and the monitor history, so the two can
 * never describe the same failure differently.
 */
export function postbackProblem(report: CliRunReport): string | null {
  const tried = report.results.filter((r) => r.postback)
  const lost = tried.filter((r) => !r.postback!.ok)
  if (!lost.length) return null
  return (
    `Postback not delivered for ${lost.length} of ${tried.length} ` +
    `test${tried.length === 1 ? '' : 's'} — e.g. ${lost[0].name}: ` +
    `${lost[0].postback!.error ?? 'no reason given'}`
  )
}

/**
 * The postback's view of one CLI result — the same fields the in-app run
 * sends, so a receiver cannot tell (and need not care) which path ran it.
 *
 * `failedAtStep` is set only when the failure was traced back to a recorded
 * step (see stepAtLine). When it was not, it stays unset rather than guessed —
 * a wrong number sends a receiver to the wrong step — and the payload still
 * carries the message on its own.
 */
export function cliRunSummary(
  r: CliTestResult,
  meta: { suite?: string; project?: string; tags?: string[]; stepCount: number }
): RunSummary {
  return {
    testName: r.name,
    ok: r.ok,
    total: meta.stepCount,
    failed: r.ok ? 0 : 1,
    durationMs: r.durationMs,
    failedAtStep: r.ok ? undefined : r.failedAtStep,
    error: r.ok ? undefined : r.error,
    suite: meta.suite || undefined,
    project: meta.project || undefined,
    tags: meta.tags?.length ? meta.tags : undefined,
    // One postback per TEST, rows folded in — the model the in-app data run
    // uses. Per-row postbacks gave a receiver N "runs" of the same test.
    rows: r.rows
  }
}

/**
 * Which recorded step a failure on `line` of a generated spec belongs to.
 *
 * The CLI generates its specs with `stepMarkers`, which puts a
 * `// qtf:step <n>` line above each step's code; the answer is the nearest
 * marker at or above the failing line. `planMap` then turns that index — into
 * the EXPANDED step list, where a linked block is already its inner steps —
 * into the row the editor shows, exactly as the app's toDisplayIdx does. Every
 * step inside a block therefore reports as the block's own row: the editor
 * shows the block as one row, so that is the number a person can find. Which
 * step inside the block failed is not recoverable from the number, the same
 * limit the in-app run has.
 *
 * Returns the 1-based step number, or undefined when the line is above the
 * first marker (the file's setup, a helper) or no line was reported — in which
 * case the failure is sent without a step rather than pinned on step 1.
 */
export function stepAtLine(
  code: string,
  line: number | undefined,
  planMap?: number[]
): number | undefined {
  if (line === undefined || !Number.isInteger(line) || line < 1) return undefined
  const lines = code.split(/\r?\n/)
  for (let n = Math.min(line, lines.length) - 1; n >= 0; n--) {
    const m = /^\s*\/\/ qtf:step (\d+)\s*$/.exec(lines[n])
    if (!m) continue
    const flatIdx = Number(m[1])
    const display = planMap ? planMap[flatIdx] : flatIdx
    return display === undefined ? undefined : display + 1
  }
  return undefined
}

export function formatReport(report: CliRunReport, reporter: CliOptions['reporter']): string {
  if (reporter === 'json') return formatJson(report)
  if (reporter === 'junit') return formatJunit(report)
  return formatText(report)
}

/**
 * The --out file for a run that could not happen at all (exit 2): no tests
 * matched, a needed value is missing, the runner would not start.
 *
 * It used to write nothing, and the reason went only to stdout — which, on
 * Windows, a packaged Electron app may never show (see the console caveat at
 * the top). A pipeline then had an exit code of 2 and no explanation anywhere.
 * So the reason goes into the file the pipeline already reads, in the format
 * it asked for: JUnit as an <error> (a CI system shows it red, WITH the
 * reason — not as a green "0 tests"), JSON with `notRun` and `reason`.
 */
export function formatRefusal(reason: string, reporter: CliOptions['reporter']): string {
  const text = reason.trim()
  if (reporter === 'json') {
    return (
      JSON.stringify(
        { notRun: true, reason: text, total: 0, passed: 0, failed: 0, durationMs: 0, results: [] },
        null,
        2
      ) + '\n'
    )
  }
  if (reporter === 'junit') {
    // eslint-disable-next-line no-control-regex
    const clean = (s: string): string => xml(s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''))
    const first = text.split('\n')[0]
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<testsuite name="QATestFlow" tests="1" failures="0" errors="1" time="0.000">',
      `  <testcase name="QATestFlow could not run" classname="QATestFlow" time="0.000">`,
      `    <error message="${clean(first)}">${clean(text)}</error>`,
      '  </testcase>',
      '</testsuite>',
      ''
    ].join('\n')
  }
  return `NOT RUN\n\n${text}\n`
}

/**
 * The process exit code.
 *
 * 0 = everything passed, 1 = something failed, 2 = the run could not happen at
 * all (nothing matched, Playwright missing). Two is separated from one on
 * purpose: "no tests matched your filter" passing as success is how a pipeline
 * ends up green while testing nothing, which is the exact failure this whole
 * app exists to prevent.
 */
export function exitCodeFor(report: CliRunReport, opts: CliOptions): number {
  if (report.total === 0) return 2
  if (report.failed === 0) return 0
  return opts.allowFailures ? 0 : 1
}

export const HELP_TEXT = `QATestFlow Recorder — command line

  <app> run [options]     Run saved tests and report the result
  <app> list [options]    List the tests that would run
  <app> help              This text

Selecting tests (all filters are ANDed; no filter means everything):
  --suite <name>          Only this suite (folder)
  --project <name>        Only this project (the folder above suites)
  --tag <@tag>            Only tests with this tag; repeat for AND
  --grep <text>           Only tests whose name or path contains this
  --test <file>           Exactly this test, by the path \`list\` prints

Running and reporting:
  --reporter <kind>       text (default), json, or junit
  --out <file>            Write the report to this file
  --workers <n>           How many tests to run at once (default 4, max 32)
  --allow-failures        Exit 0 even when tests fail

Exit codes:
  0  all selected tests passed
  1  at least one test failed
  2  nothing matched, or the run could not start

On Windows the app is a GUI program, so text printed to a terminal may not
appear there. Use --out to write the report to a file; the exit code is always
correct either way.
`

// =====================================================================
// Environment variables a spec depends on.
//
// The exporter never writes a password into a spec file — a secret step
// compiles to `process.env.PASSWORD ?? ''` and an `{{env:NAME}}` token to
// `process.env.NAME ?? ''`. That is the right call: a generated spec has to be
// safe to commit.
//
// The cost is that an unset variable does not fail. It fills the field with an
// empty string, the login quietly does not happen, and the NEXT step waits its
// whole timeout for an element that was never going to appear. The run then
// blames a step that was perfectly fine — a 30-second timeout pointing at the
// wrong line, with nothing anywhere saying "PASSWORD was empty".
//
// So the specs are read for what they actually reference, rather than the
// exporter's rule being re-derived here. Re-deriving it would be a second copy
// to keep in step, and this file has already been bitten by exactly that.
//
// `?? ''` is the marker of a reference with NO fallback. BASE_URL is emitted as
// `process.env.BASE_URL || "…"`, which does have one, so it is not matched.
// =====================================================================
const ENV_REF = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)\s*\?\?\s*''/g

export interface MissingEnv {
  name: string
  tests: string[]
}

export function missingEnvRefs(
  specs: { name: string; code: string }[],
  env: Record<string, string | undefined>,
  /** Per spec, by position: the values that spec alone will be run with (its
   *  stored password, say), layered over `env`. */
  perSpec: (Record<string, string | undefined> | undefined)[] = []
): MissingEnv[] {
  const byName = new Map<string, string[]>()
  for (const [n, spec] of specs.entries()) {
    const own = perSpec[n] ? { ...env, ...perSpec[n] } : env
    // A fresh lastIndex per spec: ENV_REF is a module-level /g regex, and a
    // shared one silently skips matches if it carries state between calls.
    ENV_REF.lastIndex = 0
    const seen = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = ENV_REF.exec(spec.code)) !== null) {
      const name = m[1]
      // An empty string counts as unset. That is the whole point: "" is what a
      // missing password looks like by the time it reaches the page.
      if (own[name]) continue
      if (seen.has(name)) continue
      seen.add(name)
      const list = byName.get(name) ?? []
      list.push(spec.name)
      byName.set(name, list)
    }
  }
  return [...byName.entries()].map(([name, tests]) => ({ name, tests }))
}

export function describeMissingEnv(missing: MissingEnv[]): string {
  const lines = missing.map((m) => {
    const n = m.tests.length
    return `  ${m.name.padEnd(14)} needed by ${n} test${n === 1 ? '' : 's'}, e.g. "${m.tests[0]}"`
  })
  return [
    `Cannot run: ${missing.length} environment variable${missing.length === 1 ? ' is' : 's are'} not set.`,
    '',
    ...lines,
    '',
    'A password is never written into a generated spec. It is taken from the',
    "test's saved password when this Windows account can read it; otherwise it",
    'has to come from the environment. Set the variable and run again.',
    'Nothing was run.',
    ''
  ].join('\n')
}

/**
 * Split tests into groups that can share ONE environment.
 *
 * A Playwright run hands every spec in it the same process environment, but
 * each test's environment is its own — above all its stored password. Two
 * tests whose PASSWORD differs cannot both be right in one run, so they go in
 * separate runs; tests that agree (nearly always all of them) share one. A
 * name only one side sets is not a conflict: a spec never reads a variable its
 * test did not put there.
 *
 * Greedy and order-preserving: each test joins the first group it agrees with.
 * The values are compared and never shown.
 */
export function envBatches(
  items: { id: string; env: Record<string, string> }[]
): { ids: string[]; env: Record<string, string> }[] {
  const batches: { ids: string[]; env: Record<string, string> }[] = []
  for (const item of items) {
    const fits = batches.find((b) =>
      Object.entries(item.env).every(([k, v]) => !(k in b.env) || b.env[k] === v)
    )
    if (fits) {
      fits.ids.push(item.id)
      Object.assign(fits.env, item.env)
    } else {
      batches.push({ ids: [item.id], env: { ...item.env } })
    }
  }
  return batches
}
