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
