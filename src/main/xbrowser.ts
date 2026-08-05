// =====================================================================
// CROSS-BROWSER REPLAY (F17)
// Our embedded browser is Electron's WebContentsView — Chromium only. There is
// no way to render a page in WebKit or Firefox INSIDE the app. So to genuinely
// run a test across engines, we shell out to REAL Playwright: export the current
// test to a temporary spec, write a Playwright config with one project per
// selected browser, and run `playwright test` as a child process. We parse its
// JSON report and hand per-browser pass/fail back to the UI.
//
// This needs @playwright/test (the runner) AND the browser binaries. The two
// are shipped very differently, and the difference is the whole story here:
//
//   THE RUNNER travels with the app. `@playwright/test` is a real dependency
//   (not a devDependency) and electron-builder is told to asarUnpack it, so a
//   packaged install has a spawnable cli.js on disk. Before this, a packaged
//   build had no project node_modules at all and every headless / parallel /
//   cross-browser feature was dev-only — a teammate who installed the app
//   could record and replay, but never run a suite.
//
//   THE BROWSERS DO NOT. Chromium + Firefox + WebKit are ~400 MB that
//   Playwright downloads into a shared per-user cache (%LOCALAPPDATA%\
//   ms-playwright on Windows). No installer should carry that. So the app
//   detects their absence and offers to fetch them ON DEMAND, using the very
//   cli.js it now ships — see installBrowsers(). Telling the user to go run
//   `npx playwright install` is not an option for someone who installed a
//   .exe and has no repo and no npm.
// =====================================================================

import { app } from 'electron'
import { spawn } from 'child_process'
import { mkdir, writeFile, rm, copyFile, symlink } from 'fs/promises'
import { existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type BrowserName = 'chromium' | 'firefox' | 'webkit'

// One browser's outcome for the run.
export interface BrowserResult {
  browser: BrowserName
  ok: boolean
  total: number // tests this engine ran — a data-driven test contributes one PER ROW
  passed: number // …and how many of them passed
  failingTest?: string // the spec title that failed
  error?: string // first error message (trimmed)
}

export interface CrossBrowserResult {
  installed: boolean // was @playwright/test resolvable?
  ran: boolean // did the test process actually run?
  results: BrowserResult[]
  message?: string // install hint / spawn error / missing-browser hint
  /** The runner is fine, the engines just aren’t downloaded — offer the fix. */
  needsBrowsers?: boolean
}

// The directory that owns node_modules/@playwright/test.
//
// Dev: the repo root (process.cwd()).
// Packaged: resources/app.asar.unpacked. app.getAppPath() itself points INSIDE
// app.asar, and an archive path is not a real file — spawn() can't launch from
// it and Node can't resolve modules through it. The .unpacked sibling is the
// on-disk copy electron-builder writes for exactly this reason.
function playwrightRoot(): string | null {
  const candidates = app.isPackaged
    ? [
        `${app.getAppPath()}.unpacked`,
        join(process.resourcesPath, 'app.asar.unpacked'),
        app.getAppPath()
      ]
    : [process.cwd(), app.getAppPath()]
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, 'node_modules', '@playwright', 'test'))) return dir
  }
  return null
}

/**
 * A scratch directory for one run — spec files, a config, copied sessions.
 *
 * Dev keeps the historic behaviour: a dot-folder in the repo root. Every
 * generated spec does `import { test } from '@playwright/test'`, and Node
 * resolves that by walking UP from the spec's own folder — so sitting inside
 * the project is what makes it resolve.
 *
 * Packaged, that same folder would land in the INSTALL directory: wrong place
 * for run artefacts, and outright unwritable if the app went to Program Files.
 * So the work dir moves to userData and we plant a `node_modules` junction
 * pointing back at the app's real one, which restores the upward walk. A
 * junction is used rather than a symlink deliberately — Windows grants those
 * to ordinary users, whereas a true symlink needs admin or developer mode.
 */
async function makeWorkDir(root: string, name: string): Promise<string> {
  const dir = app.isPackaged ? join(app.getPath('userData'), name) : join(root, name)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  if (app.isPackaged) {
    await symlink(join(root, 'node_modules'), join(dir, 'node_modules'), 'junction')
  }
  return dir
}

// =====================================================================
// BROWSER BINARIES
// Shared per-user cache, NOT shipped in the installer (~400 MB).
// =====================================================================

/** Playwright's download cache, honouring its own override env var. */
function browsersDir(): string {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (override && override !== '0') return override
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || homedir(), 'ms-playwright')
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright')
  return join(homedir(), '.cache', 'ms-playwright')
}

/**
 * Are the given engines downloaded? A cheap pre-check so the UI can offer the
 * download BEFORE a run instead of after it fails. Folders are versioned
 * (`chromium-1187`), hence the prefix match. This is advisory only — the
 * authority is still Playwright's own runtime error, which the run paths below
 * already translate.
 */
export function browsersReady(which: BrowserName[] = ['chromium']): boolean {
  const dir = browsersDir()
  if (!existsSync(dir)) return false
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return false
  }
  return which.every((b) => entries.some((e) => e.startsWith(`${b}-`)))
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

export interface PlaywrightStatus {
  /** Is the RUNNER present (cli.js we can spawn)? */
  installed: boolean
  root: string | null
  /** Is Chromium downloaded? Everything headless needs at least this. */
  chromium: boolean
  /** Are all three engines downloaded? F17 with Firefox/WebKit needs this. */
  allBrowsers: boolean
  /** True in an installed build — decides which install advice is honest. */
  packaged: boolean
}

// Is Playwright available to run at all? Reports the runner and the browsers
// separately: they fail for different reasons and have different fixes, and
// conflating them is what produced the useless "run npm i" message for users
// who have no repo to run it in.
export function checkPlaywright(): PlaywrightStatus {
  const root = playwrightRoot()
  return {
    installed: !!(root && playwrightCli(root)),
    root,
    chromium: browsersReady(['chromium']),
    allBrowsers: browsersReady(['chromium', 'firefox', 'webkit']),
    packaged: app.isPackaged
  }
}

/** What to tell the user when the runner itself is missing. */
function missingRunnerMessage(): string {
  return app.isPackaged
    ? 'The test engine is missing from this installation. Reinstalling QATestFlow should restore it.'
    : 'Playwright isn’t installed in this project. Run once:  npm i -D @playwright/test && npx playwright install'
}

/** What to tell the user when the engines aren’t downloaded yet. */
function missingBrowsersMessage(): string {
  return app.isPackaged
    ? 'The test browsers aren’t downloaded yet. Open 🧭 Cross-browser → “Download test browsers” (about 400 MB, one time).'
    : 'Browser binaries aren’t installed. Run once:  npx playwright install'
}

export interface BrowserInstallResult {
  ok: boolean
  message?: string
  /** The user stopped it — not a failure, and must not be reported as one. */
  cancelled?: boolean
}

// The running download, so a second IPC call can stop it. A 400 MB fetch with
// no way out is a trap on a metered or slow connection, and the person most
// likely to hit it is a first-time user who mis-clicked.
let installChild: ReturnType<typeof spawn> | null = null
let installCancelled = false

/** Stop an in-flight browser download. No-op if nothing is running. */
export function cancelBrowserInstall(): boolean {
  if (!installChild) return false
  installCancelled = true
  installChild.kill()
  return true
}

/**
 * Download the browser binaries using the cli.js we ship.
 *
 * This is the payoff for bundling the runner: the app can fix its own missing
 * dependency instead of handing the user a terminal command they may have no
 * way to run. Progress lines are streamed out so the UI can show something
 * during a multi-hundred-megabyte download rather than freezing.
 */
export async function installBrowsers(
  which: BrowserName[],
  onProgress: (line: string) => void
): Promise<BrowserInstallResult> {
  const { installed, root } = checkPlaywright()
  if (!installed || !root) return { ok: false, message: missingRunnerMessage() }
  const cli = playwrightCli(root)!
  const engines = which.length ? which : ['chromium']
  installCancelled = false
  return new Promise<BrowserInstallResult>((resolve) => {
    let err = ''
    const child = spawn(process.execPath, [cli, 'install', ...engines], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    installChild = child
    // Playwright redraws its download bar with carriage returns, so split on
    // BOTH \r and \n or the UI would sit on one enormous unbroken line.
    const emit = (chunk: string): void => {
      for (const line of chunk.split(/[\r\n]+/)) {
        const t = line.trim()
        if (t) onProgress(t)
      }
    }
    child.stdout.on('data', (d) => emit(d.toString()))
    child.stderr.on('data', (d) => {
      const s = d.toString()
      err += s
      // Playwright writes its progress to stderr, so this is NOT error text —
      // it's the download itself, and it's the only feedback there is.
      emit(s)
    })
    child.on('error', (e) => {
      installChild = null
      resolve({ ok: false, message: e.message })
    })
    child.on('close', (code) => {
      installChild = null
      // A killed process exits non-zero. Reporting that as "the download
      // failed" would blame the user's own cancel on the app.
      if (installCancelled) {
        installCancelled = false
        return resolve({ ok: false, cancelled: true, message: 'Download cancelled.' })
      }
      if (code === 0) return resolve({ ok: true })
      resolve({
        ok: false,
        message:
          stripAnsi(err).split(/[\r\n]+/).filter(Boolean).slice(-3).join(' ') ||
          `The download failed (exit code ${code}).`
      })
    })
  })
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
  /**
   * Absolute paths of the files this test uploads.
   *
   * The exported spec says setInputFiles('fixtures/<name>') — a RELATIVE path
   * that only resolves when a fixtures/ folder sits beside the spec, which is
   * what the manual export builds. A parallel run wrote the spec but never
   * copied the files, so every test with an upload step died on
   * "ENOENT … \fixtures\<name>" — a real test failing for a reason that had
   * nothing to do with the test (Surbhi, Test 12).
   */
  fixturePaths?: string[]
  /** Absolute path of this test's HAR, if it replays one (same problem). */
  harPath?: string
}

/** Escape a string for use inside a RegExp. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Point a relative asset reference at a real absolute file.
 *
 * Rewrites rather than relying on cwd: the spec lives in a temp dir, the run's
 * cwd is the project root, and a Windows absolute path can't simply be pasted
 * into the existing single-quoted literal (C:\Users… would read \U as an escape).
 * JSON.stringify produces a correctly escaped literal, so the whole quoted
 * token is swapped — matching how a copied session is already passed absolutely.
 */
function pointAtAbsolute(code: string, relRef: string, absPath: string): string {
  const lit = JSON.stringify(absPath)
  return code.replace(new RegExp(`(['"\`])${reEscape(relRef)}\\1`, 'g'), lit)
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
  /** The runner is fine, the engines just aren’t downloaded — offer the fix. */
  needsBrowsers?: boolean
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
  const { installed, root, chromium } = checkPlaywright()
  if (!installed || !root) {
    return { installed: false, ran: false, results: [], message: missingRunnerMessage() }
  }
  // Check the engines UP FRONT. Without this, a missing download surfaces as
  // every single test failing to launch — which reads as "the whole suite is
  // broken" when the truth is one one-time download away.
  if (!chromium) {
    return {
      installed: true,
      ran: false,
      results: [],
      needsBrowsers: true,
      message: missingBrowsersMessage()
    }
  }
  if (!specs.length) return { installed: true, ran: true, results: [] }
  const cli = playwrightCli(root)!
  let workDir: string
  try {
    workDir = await makeWorkDir(root, '.qaflow-parallel')
  } catch (e) {
    return {
      installed: true,
      ran: false,
      results: [],
      message: `Couldn’t prepare the run folder: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  const specDir = join(workDir, 'specs')
  // spec file base name → our test id, so the report maps back.
  const idBySlug = new Map<string, string>()
  try {
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
      // Uploads: copy each file in and repoint the spec's relative
      // `fixtures/<name>` at the copy. Per-spec folder so two tests uploading
      // different files with the SAME basename can't overwrite each other.
      for (const src of spec.fixturePaths ?? []) {
        const base = src.split(/[\\/]/).pop() || ''
        if (!base) continue
        const dstDir = join(workDir, 'fixtures', slug)
        const dst = join(dstDir, base)
        try {
          await mkdir(dstDir, { recursive: true })
          await copyFile(src, dst)
          code = pointAtAbsolute(code, `fixtures/${base}`, dst)
        } catch {
          // Leave the relative path alone: the run then fails with a missing
          // file, which is the truth — the source file really is gone.
        }
      }
      // HAR: same shape of problem, same fix.
      if (spec.harPath) {
        const base = spec.harPath.split(/[\\/]/).pop() || ''
        const dst = join(workDir, 'hars', `${slug}-${base}`)
        try {
          await mkdir(join(workDir, 'hars'), { recursive: true })
          await copyFile(spec.harPath, dst)
          code = pointAtAbsolute(code, `hars/${base}`, dst)
        } catch {
          // as above — a missing archive should fail honestly
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
    const report = JSON.parse(json) as {
      suites?: unknown[]
      // Playwright reports a failure to LOAD (bad config, a spec that doesn't
      // compile, "no tests found") here — not as test results. We used to parse
      // only `suites`, so any of those came back as an empty report and every
      // test in the batch was labelled "did not run" — i.e. the app told you 12
      // tests FAILED when in truth zero of them had been attempted. For a tool
      // whose whole claim is that a result can be trusted, inventing 12 failures
      // is worse than the original error (Surbhi, Test 7).
      errors?: { message?: string; location?: { file?: string; line?: number } }[]
    }
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
              (firstErr ? clip(stripAnsi(firstErr).replace(/\s+/g, ' ')) : undefined)
          })
        }
      }
      for (const inner of suite.suites ?? []) walk(inner as never)
    }
    for (const s of report.suites ?? []) walk(s as never)

    const loadErrors = (report.errors ?? [])
      .map((e) => {
        const where = e.location?.file
          ? ` (${e.location.file.split(/[\\/]/).pop()}${e.location.line ? `:${e.location.line}` : ''})`
          : ''
        return `${stripAnsi(e.message ?? '').replace(/\s+/g, ' ').trim()}${where}`
      })
      .filter(Boolean)

    // NOTHING ran. That is a failure of the RUNNER, not of the tests, and the two
    // must never be conflated: claiming 12 red tests when Playwright never opened
    // a browser is a fabricated result. Hand back ran:false with the real reason
    // and let the caller do what it already does when the runner is unavailable —
    // run the whole batch the normal way instead, so the user still gets answers.
    if (byId.size === 0) {
      return {
        installed: true,
        ran: false,
        results: [],
        message:
          loadErrors[0] ??
          'Playwright started but found no tests to run (nothing was written to the spec folder).'
      }
    }

    // A spec that produced no result while OTHERS did is a per-test problem —
    // that one didn't compile or crashed on load. Say which, using Playwright's
    // own error for that file when it gave us one.
    const errByFile = new Map<string, string>()
    for (const e of report.errors ?? []) {
      const f = e.location?.file?.split(/[\\/]/).pop()?.replace(/\.spec\.ts$/, '')
      const id = f ? idBySlug.get(f) : undefined
      if (id && e.message) {
        errByFile.set(id, clip(stripAnsi(e.message).replace(/\s+/g, ' ')))
      }
    }
    const results: ParallelTestResult[] = specs.map(
      (s) =>
        byId.get(s.id) ?? {
          id: s.id,
          ok: false,
          error:
            errByFile.get(s.id) ??
            'No result — the generated spec did not run (it may not compile headlessly).'
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
      needsBrowsers: needsInstall || undefined,
      message: needsInstall ? missingBrowsersMessage() : `Parallel run failed: ${clip(m)}`
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

/**
 * Shorten to `max` characters, but break at a word boundary.
 *
 * A blunt slice() cut Playwright's call log mid-word — a webhook alert ended
 * "...8 × loca", which reads as a broken message rather than a trimmed one.
 * Backs up to the last space when one is reasonably close, and marks the cut
 * with an ellipsis so it's clearly deliberate.
 */
function clip(s: string, max = 300): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + '…'
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
          error: firstErr ? clip(stripAnsi(firstErr).replace(/\s+/g, ' ')) : undefined
        })
      }
    }
    for (const inner of suite.suites ?? []) walkSuite(inner as never)
  }
  for (const s of r.suites ?? []) walkSuite(s as never)
  return out
}

// Run the given spec across the selected browsers. `specCode` is the exported
// Playwright test source. Sessions, upload fixtures and a HAR archive are all
// copied into the run folder and the spec's relative references repointed —
// the same treatment runSuiteParallel gives them. (This shipped as "no
// fixtures/sessions/HAR in v1"; sessions arrived later, and the other two were
// left behind long enough to become bugs of their own.)
export async function runCrossBrowser(
  specCode: string,
  browsers: BrowserName[],
  // F25 bridge: the active environment's variables (+ BASE_URL) so a spec that
  // reads process.env.USERNAME / process.env.BASE_URL runs against it here too.
  envVars: Record<string, string> = {},
  // F32: a saved session to start the run already logged in. `srcPath` is copied
  // into the run dir and its absolute path is fed to the config's storageState.
  session?: { name: string; srcPath: string },
  // Absolute source paths of upload fixtures, and a HAR archive to replay
  // against. Both are copied in and the spec's relative references repointed —
  // the same treatment runSuite has always given them.
  fixturePaths?: string[],
  harPath?: string
): Promise<CrossBrowserResult> {
  const { installed, root } = checkPlaywright()
  if (!installed || !root) {
    return { installed: false, ran: false, results: [], message: missingRunnerMessage() }
  }
  // Only the engines actually selected need to be downloaded — asking someone
  // running a Chromium-only check to fetch WebKit would be a pointless 400 MB.
  if (!browsersReady(browsers)) {
    return {
      installed: true,
      ran: false,
      results: [],
      needsBrowsers: true,
      message: missingBrowsersMessage()
    }
  }
  const cli = playwrightCli(root)!
  // A dedicated temp dir whose module resolution reaches @playwright/test (see
  // makeWorkDir), kept apart from the user’s own tests.
  let workDir: string
  try {
    workDir = await makeWorkDir(root, '.qaflow-xbrowser')
  } catch (e) {
    return {
      installed: true,
      ran: false,
      results: [],
      message: `Couldn’t prepare the run folder: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  const specDir = join(workDir, 'specs')
  try {
    await mkdir(specDir, { recursive: true })
    // Uploads and HAR archives, exactly as runSuite does it. This runner shipped
    // as "self-contained — no fixtures/sessions/HAR in v1", and sessions were
    // added later without the other two. The consequence was invisible from here
    // and loud everywhere else: the exported spec refers to `fixtures/<name>` by
    // RELATIVE path, so a monitored or cross-browser run of any test with an
    // upload step died on `ENOENT …\fixtures\<name>` — a real test failing for a
    // reason that had nothing to do with the test.
    let code = specCode
    for (const src of fixturePaths ?? []) {
      const base = src.split(/[\\/]/).pop() || ''
      if (!base) continue
      const dstDir = join(workDir, 'fixtures')
      const dst = join(dstDir, base)
      try {
        await mkdir(dstDir, { recursive: true })
        await copyFile(src, dst)
        code = pointAtAbsolute(code, `fixtures/${base}`, dst)
      } catch {
        // Leave the relative path alone: the run then fails with a missing file,
        // which is the truth — the source file really is gone.
      }
    }
    if (harPath) {
      const base = harPath.split(/[\\/]/).pop() || ''
      const dst = join(workDir, 'hars', base)
      try {
        await mkdir(join(workDir, 'hars'), { recursive: true })
        await copyFile(harPath, dst)
        code = pointAtAbsolute(code, `hars/${base}`, dst)
      } catch {
        // as above — a missing archive should fail honestly
      }
    }
    await writeFile(join(specDir, 'crossbrowser.spec.ts'), code, 'utf-8')
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

    // Kept outside the promise: when the JSON parses but contains no tests at
    // all, Playwright's stderr is often the only place the reason exists.
    let stderrText = ''
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
      child.stderr.on('data', (d) => {
        err += d.toString()
        stderrText = err
      })
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

    // Playwright reports LOAD failures — a spec that won't compile, a bad
    // config, a missing engine — in a top-level `errors` array, NOT as test
    // results. Discarding it is how any such failure used to be reported as
    // "browser binary may be missing" on every engine at once: a fabricated
    // diagnosis that sent the user off to re-download 400 MB that was already
    // on disk, while the real reason was thrown away. Same bug the parallel
    // runner had; fixed there, never applied here. NEVER guess at a cause we
    // were handed.
    const loadErrors = (
      Array.isArray((report as { errors?: unknown[] }).errors)
        ? (report as { errors: { message?: string }[] }).errors
        : []
    )
      .map((e) => stripAnsi(String(e?.message ?? '')).replace(/\s+/g, ' ').trim())
      .filter(Boolean)

    // Does a message actually say the binaries are missing? This is the ONLY
    // thing that may claim it.
    const saysMissingBinary = (s: string): boolean =>
      /Executable doesn.t exist|playwright install/i.test(s)

    if (!tests.length) {
      // Nothing ran at all. Report what Playwright said, in its own words.
      const why = loadErrors.join(' · ') || stripAnsi(stderrText).replace(/\s+/g, ' ').trim()
      const needsInstall = saysMissingBinary(why)
      return {
        installed: true,
        ran: false,
        results: [],
        needsBrowsers: needsInstall || undefined,
        message: needsInstall
          ? missingBrowsersMessage()
          : why
            ? `Cross-browser run failed before any test ran: ${clip(why)}`
            : 'Cross-browser run produced no tests, and Playwright gave no reason. The generated spec may be empty.'
      }
    }

    const results: BrowserResult[] = browsers.map((b) => {
      const forBrowser = tests.filter((t) => t.project === b)
      if (forBrowser.length === 0) {
        // Other engines DID report, so this is specific to this one — but we
        // still don't know why, so we say exactly that rather than inventing it.
        return {
          browser: b,
          ok: false,
          total: 0,
          passed: 0,
          error: 'no result — this engine never reported back'
        }
      }
      const failed = forBrowser.find((t) => !t.ok)
      return {
        browser: b,
        ok: !failed,
        // How many tests this engine actually ran. Already known here and
        // previously discarded, which left the UI unable to answer the one
        // question a data-driven run raises: "did it run all six rows, or one
        // test six times faster?" A green tick looks identical either way — and
        // this path DID silently collapse a 6-row test into a single test until
        // the data table started travelling with it.
        total: forBrowser.length,
        passed: forBrowser.filter((t) => t.ok).length,
        failingTest: failed?.title,
        error: failed?.error
      }
    })
    const missingBinary =
      results.some((r) => saysMissingBinary(r.error ?? '')) || loadErrors.some(saysMissingBinary)
    return {
      installed: true,
      ran: true,
      results,
      needsBrowsers: missingBinary || undefined,
      message: missingBinary
        ? missingBrowsersMessage()
        : loadErrors.length
          ? `Playwright also reported: ${clip(loadErrors.join(' · '))}`
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
      needsBrowsers: needsInstall || undefined,
      message: needsInstall
        ? missingBrowsersMessage()
        : `Cross-browser run failed: ${clip(m)}`
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
