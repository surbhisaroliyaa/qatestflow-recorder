// =====================================================================
// CROSS-BROWSER REPLAY (F17)
// Our embedded browser is Electron's WebContentsView — Chromium only. There is
// no way to render a page in WebKit or Firefox INSIDE the app. So to genuinely
// run a test across engines, we shell out to REAL Playwright: export the current
// test to a temporary spec, write a Playwright config with one project per
// selected browser, and run `playwright test` as a child process. We parse its
// JSON report and hand per-browser pass/fail back to the UI.
//
// This needs @playwright/test (+ the browser binaries) installed in the project
// — a one-time `npm i -D @playwright/test && npx playwright install`. We detect
// its absence and report it cleanly instead of failing obscurely. In a PACKAGED
// build there's no project node_modules, so this is a dev-time capability (which
// is where the recorder is used).
// =====================================================================

import { app } from 'electron'
import { spawn } from 'child_process'
import { mkdir, writeFile, rm, copyFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'

export type BrowserName = 'chromium' | 'firefox' | 'webkit'

// One browser's outcome for the run.
export interface BrowserResult {
  browser: BrowserName
  ok: boolean
  failingTest?: string // the spec title that failed
  error?: string // first error message (trimmed)
}

export interface CrossBrowserResult {
  installed: boolean // was @playwright/test resolvable?
  ran: boolean // did the test process actually run?
  results: BrowserResult[]
  message?: string // install hint / spawn error / missing-browser hint
}

// The project directory that owns node_modules/@playwright/test. In dev this is
// the repo root (process.cwd()); app.getAppPath() is the fallback.
function projectRoot(): string | null {
  for (const dir of [process.cwd(), app.getAppPath()]) {
    if (dir && existsSync(join(dir, 'node_modules', '@playwright', 'test'))) return dir
  }
  return null
}

// Playwright's CLI entry (run via the Electron binary in Node mode). Both the
// scoped test runner and the base package ship a cli.js; prefer the runner's.
function playwrightCli(root: string): string | null {
  for (const rel of [
    ['node_modules', '@playwright', 'test', 'cli.js'],
    ['node_modules', 'playwright', 'cli.js'],
    ['node_modules', 'playwright-core', 'cli.js']
  ]) {
    const p = join(root, ...rel)
    if (existsSync(p)) return p
  }
  return null
}

// Is Playwright available to run at all?
export function checkPlaywright(): { installed: boolean; root: string | null } {
  const root = projectRoot()
  return { installed: !!(root && playwrightCli(root)), root }
}

// The temp Playwright config for a run: one project per requested browser, all
// headless, pointed at our temp spec. Kept minimal — the spec carries its own
// test.use({ baseURL }).
function runConfig(browsers: BrowserName[], specDir: string, storageStatePath?: string): string {
  const DEVICE: Record<BrowserName, string> = {
    chromium: 'Desktop Chrome',
    firefox: 'Desktop Firefox',
    webkit: 'Desktop Safari'
  }
  const projects = browsers
    .map(
      (b) => `    { name: '${b}', use: { ...devices['${DEVICE[b]}'] } }`
    )
    .join(',\n')
  // F32: a session-dependent test starts already logged in — point storageState at
  // the copied session file by ABSOLUTE path so there's no relative-resolution
  // ambiguity. Config-level use is overridden by any test.use in the spec, but the
  // monitor spec carries none, so this wins.
  const useProps = ['headless: true']
  if (storageStatePath) useProps.push(`storageState: ${JSON.stringify(storageStatePath)}`)
  return `import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: ${JSON.stringify(specDir)},
  fullyParallel: true,
  reporter: 'null',
  use: { ${useProps.join(', ')} },
  projects: [
${projects}
  ]
})
`
}

// =====================================================================
// F39 — PARALLEL SUITE RUN
//
// Run All replays each test one at a time in the embedded browser
// (`await runOnce(...)` in a for-loop). That is not a bug — there is exactly
// ONE WebContentsView, so two tests genuinely cannot drive it at once. In-app
// parallelism isn't a matter of adding workers; it's architecturally impossible.
//
// The headless path CAN parallelize, because it shells out to real Playwright,
// which has its own scheduler. So instead of N separate child processes, we
// write EVERY selected test as its own spec file into one temp directory and
// let a single Playwright run schedule them across `workers`. Playwright
// parallelizes across files by default, so this is its native mode.
//
// == The honesty problem this creates ==
//
// A headless run executes the EXPORTED spec, not the in-app replay engine. The
// two are not equivalent: self-heal, the recovery pause, and AI (`nl`) checks
// exist only in the app. An `nl` check exports as a COMMENT — so a test whose
// only real assertion is an AI check would run headlessly, assert nothing, and
// come back GREEN. That is a false pass, which is the single worst outcome for
// a tool whose identity is "a green run can be trusted".
//
// So `headlessBlockers()` (renderer) finds those tests up front and the caller
// runs them the normal sequential way instead. Nothing is skipped; the report
// says which test went down which path.
// =====================================================================

export interface ParallelSpec {
  /** Stable id (the test's fileName) so results map back to the right test. */
  id: string
  name: string
  code: string
  /** A saved session to copy in, if this test starts logged in. */
  sessionPath?: string
}

export interface ParallelTestResult {
  id: string
  ok: boolean
  error?: string
}

export interface ParallelRunResult {
  installed: boolean
  ran: boolean
  results: ParallelTestResult[]
  message?: string
}

/** A filename-safe token for one spec, unique per test. */
function specSlug(id: string, index: number): string {
  const base = id
    .replace(/\.json$/i, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
  // The index keeps two tests with the same slug in different suites apart.
  return `${index}-${base || 'test'}`
}

/**
 * Run many tests at once through real Playwright.
 *
 * One process, N workers, one spec file per test. Playwright owns the
 * scheduling — we only map its JSON report back onto our test ids.
 */
export async function runSuiteParallel(
  specs: ParallelSpec[],
  workers: number,
  envVars: Record<string, string> = {}
): Promise<ParallelRunResult> {
  const { installed, root } = checkPlaywright()
  if (!installed || !root) {
    return {
      installed: false,
      ran: false,
      results: [],
      message:
        'Playwright isn’t installed in this project. Run once:  npm i -D @playwright/test && npx playwright install'
    }
  }
  if (!specs.length) return { installed: true, ran: true, results: [] }
  const cli = playwrightCli(root)!
  const workDir = join(root, '.qaflow-parallel')
  const specDir = join(workDir, 'specs')
  // spec file base name → our test id, so the report maps back.
  const idBySlug = new Map<string, string>()
  try {
    await rm(workDir, { recursive: true, force: true })
    await mkdir(specDir, { recursive: true })
    await mkdir(join(workDir, 'sessions'), { recursive: true })
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]
      const slug = specSlug(spec.id, i)
      idBySlug.set(slug, spec.id)
      let code = spec.code
      if (spec.sessionPath) {
        // Each test carries its OWN session, so storageState can't live in the
        // shared config the way the single-test runner does it — it's injected
        // into this spec's own test.use instead.
        const dst = join(workDir, 'sessions', `${slug}.json`)
        try {
          await copyFile(spec.sessionPath, dst)
          code = `${code}\ntest.use({ storageState: ${JSON.stringify(dst)} })\n`
        } catch {
          // missing session — run without it; the test fails honestly, exactly
          // as it would in the app if the session file were gone.
        }
      }
      await writeFile(join(specDir, `${slug}.spec.ts`), code, 'utf-8')
    }
    await writeFile(
      join(workDir, 'playwright.config.ts'),
      `import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: ${JSON.stringify(specDir)},
  fullyParallel: true,
  workers: ${Math.max(1, Math.floor(workers))},
  // A suite run reports every result; one red test must not stop the rest.
  maxFailures: 0,
  reporter: 'null',
  use: { headless: true },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
})
`,
      'utf-8'
    )

    const json = await new Promise<string>((resolve, reject) => {
      let out = ''
      let err = ''
      const child = spawn(
        process.execPath,
        [cli, 'test', '--config', join(workDir, 'playwright.config.ts'), '--reporter=json'],
        { cwd: root, env: { ...process.env, ...envVars, ELECTRON_RUN_AS_NODE: '1' } }
      )
      // Scaled to the suite: a big fleet legitimately takes longer than one
      // test, but it must still be bounded so a hung run can't wedge the app.
      const timeoutMs = Math.min(30 * 60_000, 120_000 + specs.length * 60_000)
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`Parallel run timed out after ${Math.round(timeoutMs / 60000)} minutes`))
      }, timeoutMs)
      child.stdout.on('data', (d) => (out += d.toString()))
      child.stderr.on('data', (d) => (err += d.toString()))
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      child.on('close', () => {
        clearTimeout(timer)
        if (out.trim().startsWith('{')) resolve(out)
        else reject(new Error(err.trim() || out.trim() || 'Playwright produced no report'))
      })
    })

    // Walk the report and attribute each spec FILE back to its test id.
    const report = JSON.parse(json) as { suites?: unknown[] }
    const byId = new Map<string, ParallelTestResult>()
    const walk = (suite: {
      file?: string
      specs?: unknown[]
      suites?: unknown[]
      title?: string
    }): void => {
      for (const specRaw of suite.specs ?? []) {
        const s = specRaw as { title?: string; tests?: unknown[] }
        const file = (suite.file || suite.title || '').replace(/\\/g, '/')
        const slug = (file.split('/').pop() || '').replace(/\.spec\.ts$/, '')
        const id = idBySlug.get(slug)
        if (!id) continue
        for (const testRaw of s.tests ?? []) {
          const t = testRaw as { results?: { status?: string; error?: { message?: string } }[] }
          const results = t.results ?? []
          const ok = results.length > 0 && results.every((r) => r.status === 'passed')
          const firstErr = results.find((r) => r.error?.message)?.error?.message
          const prev = byId.get(id)
          // A data-driven test is several `test()` blocks in one file — the file
          // is green only if every one of them passed.
          byId.set(id, {
            id,
            ok: (prev?.ok ?? true) && ok,
            error:
              prev?.error ??
              (firstErr ? stripAnsi(firstErr).replace(/\s+/g, ' ').slice(0, 300) : undefined)
          })
        }
      }
      for (const inner of suite.suites ?? []) walk(inner as never)
    }
    for (const s of report.suites ?? []) walk(s as never)

    // A spec that produced no result at all didn't run (compile error, crash) —
    // report it as failed rather than silently dropping it from the suite.
    const results: ParallelTestResult[] = specs.map(
      (s) =>
        byId.get(s.id) ?? {
          id: s.id,
          ok: false,
          error: 'No result — the generated spec did not run (it may not compile headlessly).'
        }
    )
    return { installed: true, ran: true, results }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    const needsInstall = /Executable doesn.t exist|playwright install/i.test(m)
    return {
      installed: true,
      ran: false,
      results: [],
      message: needsInstall
        ? 'Browser binaries aren’t installed. Run once:  npx playwright install'
        : `Parallel run failed: ${m.slice(0, 300)}`
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

// Remove ANSI colour escapes (ESC "[" … "m") from Playwright's error text: the
// raw escapes rendered as literal "[31m…" in the results modal AND ate into the
// 300-char budget, hiding the useful part of the message. The ESC is required in
// the pattern, so a literal "[0m" inside a real error message is never eaten.
const ESC = String.fromCharCode(27)
const ANSI_RE = new RegExp(ESC + '\\[[0-9;]*m', 'g')
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

// Walk the Playwright JSON report and collect every test with its project name.
// The tree is suites → (nested suites) → specs → tests; tests carry projectName
// and a results[] with a status. A project "passes" when all its tests passed.
function collectTests(
  report: unknown
): { project: string; title: string; ok: boolean; error?: string }[] {
  const out: { project: string; title: string; ok: boolean; error?: string }[] = []
  const r = report as { suites?: unknown[] }
  const walkSuite = (suite: {
    specs?: unknown[]
    suites?: unknown[]
    title?: string
  }): void => {
    for (const specRaw of suite.specs ?? []) {
      const spec = specRaw as { title?: string; tests?: unknown[] }
      for (const testRaw of spec.tests ?? []) {
        const test = testRaw as {
          projectName?: string
          results?: { status?: string; error?: { message?: string } }[]
        }
        const results = test.results ?? []
        const ok = results.length > 0 && results.every((res) => res.status === 'passed')
        const firstErr = results.find((res) => res.error?.message)?.error?.message
        out.push({
          project: test.projectName || 'unknown',
          title: spec.title || 'test',
          ok,
          // Playwright colourises its messages; the raw ANSI escapes rendered as
          // literal "[31m…" in the UI AND ate into the 300-char budget, hiding
          // the useful part (the call log, e.g. "waiting for getByTestId(…)").
          error: firstErr ? stripAnsi(firstErr).replace(/\s+/g, ' ').slice(0, 300) : undefined
        })
      }
    }
    for (const inner of suite.suites ?? []) walkSuite(inner as never)
  }
  for (const s of r.suites ?? []) walkSuite(s as never)
  return out
}

// Run the given spec across the selected browsers. `specCode` is the exported
// Playwright test source (self-contained — no fixtures/sessions/HAR in v1).
export async function runCrossBrowser(
  specCode: string,
  browsers: BrowserName[],
  // F25 bridge: the active environment's variables (+ BASE_URL) so a spec that
  // reads process.env.USERNAME / process.env.BASE_URL runs against it here too.
  envVars: Record<string, string> = {},
  // F32: a saved session to start the run already logged in. `srcPath` is copied
  // into the run dir and its absolute path is fed to the config's storageState.
  session?: { name: string; srcPath: string }
): Promise<CrossBrowserResult> {
  const { installed, root } = checkPlaywright()
  if (!installed || !root) {
    return {
      installed: false,
      ran: false,
      results: [],
      message:
        'Playwright isn’t installed in this project. Run once:  npm i -D @playwright/test && npx playwright install'
    }
  }
  const cli = playwrightCli(root)!
  // A dedicated temp dir INSIDE the project so @playwright/test resolves, and
  // the run can’t collide with the user’s own tests.
  const workDir = join(root, '.qaflow-xbrowser')
  const specDir = join(workDir, 'specs')
  try {
    await rm(workDir, { recursive: true, force: true })
    await mkdir(specDir, { recursive: true })
    await writeFile(join(specDir, 'crossbrowser.spec.ts'), specCode, 'utf-8')
    // F32: copy the saved session in and pass its ABSOLUTE path to storageState so
    // a "starts logged in" test isn't kicked back to the login page (→ timeout).
    let storageStatePath: string | undefined
    if (session) {
      const dst = join(workDir, 'sessions', session.name)
      await mkdir(join(workDir, 'sessions'), { recursive: true })
      try {
        await copyFile(session.srcPath, dst)
        storageStatePath = dst
      } catch {
        // session file missing — run without it (test will fail honestly, as it
        // would in the app if the session were gone)
      }
    }
    await writeFile(
      join(workDir, 'playwright.config.ts'),
      runConfig(browsers, specDir, storageStatePath),
      'utf-8'
    )

    const json = await new Promise<string>((resolve, reject) => {
      let out = ''
      let err = ''
      // Run the Playwright CLI through the Electron binary in Node mode.
      const child = spawn(
        process.execPath,
        [cli, 'test', '--config', join(workDir, 'playwright.config.ts'), '--reporter=json'],
        {
          cwd: root,
          env: { ...process.env, ...envVars, ELECTRON_RUN_AS_NODE: '1' }
        }
      )
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('Cross-browser run timed out after 180s'))
      }, 180000)
      child.stdout.on('data', (d) => (out += d.toString()))
      child.stderr.on('data', (d) => (err += d.toString()))
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      child.on('close', () => {
        clearTimeout(timer)
        // Playwright exits non-zero when tests fail — that's expected; we still
        // have the JSON report. Reject only when there's no parseable JSON.
        if (out.trim().startsWith('{')) resolve(out)
        else reject(new Error(err.trim() || out.trim() || 'Playwright produced no report'))
      })
    })

    const report = JSON.parse(json)
    const tests = collectTests(report)
    // A browser whose binary isn’t installed makes Playwright error before any
    // test runs — surface that as a clear hint.
    const results: BrowserResult[] = browsers.map((b) => {
      const forBrowser = tests.filter((t) => t.project === b)
      if (forBrowser.length === 0) {
        return { browser: b, ok: false, error: 'no result (browser binary may be missing)' }
      }
      const failed = forBrowser.find((t) => !t.ok)
      return {
        browser: b,
        ok: !failed,
        failingTest: failed?.title,
        error: failed?.error
      }
    })
    const anyMissing = results.some((r) => r.error?.includes('browser binary'))
    return {
      installed: true,
      ran: true,
      results,
      message: anyMissing
        ? 'Some browsers reported no result — install them once:  npx playwright install'
        : undefined
    }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    // The classic "browser is not installed" runtime error → actionable hint.
    const needsInstall = /Executable doesn.t exist|playwright install/i.test(m)
    return {
      installed: true,
      ran: false,
      results: [],
      message: needsInstall
        ? 'Browser binaries aren’t installed. Run once:  npx playwright install'
        : `Cross-browser run failed: ${m.slice(0, 300)}`
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
