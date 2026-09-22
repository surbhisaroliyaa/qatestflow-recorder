import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// =====================================================================
// THE 100+ TEST SCALE PROOF  (Phase 4, audit gap)
// =====================================================================
// The audit listed "100+ test scale proof" as missing, and it was: every
// scaling claim in this repo was an argument, not a measurement. The tags live
// in the summary "so Run-all-@smoke doesn't open every test on disk" — but
// nothing checked that it doesn't.
//
// So this file builds a REAL library of 240 tests on disk, across projects and
// suites, and runs the real library code over it. Not mocks: the thing that
// stops scaling is file I/O, and a mocked file system would prove the opposite
// of what is claimed.
//
// == What is actually asserted ==
//
// Timings are here, but they are deliberately loose — a CI box under load is
// not a benchmark, and a tight threshold would be a flaky test that eventually
// gets deleted, taking the proof with it. The load-bearing assertions are
// STRUCTURAL, and they are the ones that catch a real regression:
//
//   · the listing returns summaries with NO step arrays in them. That is the
//     one property that decides whether this scales: the moment a summary
//     carries its steps, listing 240 tests reads every step of every test, and
//     the library screen goes from instant to unusable. It is also exactly the
//     kind of thing a well-meaning refactor adds back.
//   · filtering and selection are done over the summaries, so they cost
//     nothing extra per test.
//   · a 240-test library still reads correctly — the right count, in the right
//     projects and suites, with tags intact.
// =====================================================================

// A real temp library. The path has a SPACE in it on purpose: the real one is
// "Documents\QATestFlow Tests", and a path assumption that only breaks on
// spaces is the classic Windows bug this project has already hit once.
let libRoot = ''

vi.mock('electron', () => ({
  app: {
    getPath: (): string => libRoot
  }
}))

const { listTests, listProjects, listSuites, stepStats } = await import('../src/main/library')
const { selectTests } = await import('../src/main/cli')

/** How many tests to build. Above the audit's "100+", and enough that an
 *  accidental O(n·steps) read would show up as a stall rather than a blip. */
const TEST_COUNT = 240
/** Steps per test — a realistic checkout flow, not a toy. */
const STEPS_PER_TEST = 25

const PROJECTS = ['', 'Checkout', 'Admin']
const SUITES = ['E2E', 'Daily', 'Regression']

function bigSteps(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    type: i % 5 === 0 ? 'assert' : 'click',
    label: `Element ${i}`,
    assertKind: i % 5 === 0 ? 'visible' : undefined,
    selector: `getByTestId('el-${i}')`,
    // The bulky part of a real step, and the reason summaries must not carry
    // steps: a full ranked ladder per step.
    candidates: Array.from({ length: 6 }, (_, c) => ({
      kind: 'testId',
      score: 95 - c,
      css: `[data-test="el-${i}"]`,
      locator: `getByTestId('el-${i}')`
    }))
  }))
}

beforeAll(async () => {
  libRoot = await mkdtemp(join(tmpdir(), 'qaflow scale '))
  const library = join(libRoot, 'QATestFlow Tests')
  for (let i = 0; i < TEST_COUNT; i++) {
    // Decorrelated on purpose. Indexing project, suite and tag all by `i % 3`
    // makes them perfectly correlated — every @smoke test lands in the same
    // project, and every project holds exactly one suite — so the cross-filter
    // cases below would pass vacuously on an empty set. The first draft of this
    // file did exactly that, and two assertions "failed" for no reason but the
    // shape of the fixture.
    const project = PROJECTS[i % PROJECTS.length]
    const suite = SUITES[Math.floor(i / PROJECTS.length) % SUITES.length]
    const folder = [library, project, suite].filter(Boolean).join('/')
    await mkdir(folder, { recursive: true })
    await writeFile(
      join(folder, `test-${i}.json`),
      JSON.stringify({
        version: 1,
        name: `Flow ${i}`,
        baseURL: 'https://shop.example.com',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
        tags: i % 2 === 0 ? ['@smoke'] : ['@regression'],
        steps: bigSteps(STEPS_PER_TEST)
      }),
      'utf-8'
    )
  }
}, 120_000)

afterAll(async () => {
  if (libRoot) await rm(libRoot, { recursive: true, force: true })
})

describe(`a library of ${TEST_COUNT} tests`, () => {
  it('lists every one of them, in the right places', async () => {
    const all = await listTests()
    expect(all).toHaveLength(TEST_COUNT)
    // Across projects AND suites — the Phase 4 three-level layout, at scale.
    expect(new Set(all.map((t) => t.project))).toEqual(new Set(PROJECTS))
    expect(new Set(all.map((t) => t.suite))).toEqual(new Set(SUITES))
    expect(all.every((t) => t.stepCount === STEPS_PER_TEST)).toBe(true)
  }, 60_000)

  it('the summary carries NO steps — the property the whole thing rests on', async () => {
    // The load-bearing assertion in this file. A summary that carried its steps
    // would turn listing 240 tests into reading 6,000 steps with 36,000 selector
    // candidates, and the library screen would go from instant to unusable.
    // Nothing else in the codebase checks this, and a helpful refactor that
    // "just returns the whole file" would pass every other test in the repo.
    const all = await listTests()
    for (const summary of all.slice(0, 20)) {
      expect('steps' in summary, summary.fileName).toBe(false)
      expect('versions' in summary, summary.fileName).toBe(false)
    }
    // The aggregates the UI needs ARE there, so nothing has to open a file to
    // draw a row.
    expect(all[0].tags?.length).toBeGreaterThan(0)
    expect(all[0].assertCount).toBeGreaterThan(0)
    expect(all[0].selectorHealth).toBeGreaterThan(0)
  }, 60_000)

  it('lists projects and suites without reading any test', async () => {
    expect(await listProjects()).toEqual(['Admin', 'Checkout'])
    // Inside a project, every folder is a suite.
    expect(await listSuites('Checkout')).toEqual(expect.arrayContaining(SUITES))
  }, 60_000)

  it('selects a tag subset from the summaries alone', async () => {
    const all = await listTests()
    const smoke = selectTests(
      all.map((t) => ({
        fileName: t.fileName,
        name: t.name,
        suite: t.suite,
        project: t.project,
        tags: t.tags
      })),
      {
        command: 'run',
        tags: ['@smoke'],
        reporter: 'text',
        workers: 4,
        allowFailures: false
      }
    )
    expect(smoke.length).toBe(TEST_COUNT / 2)
    // Narrowing further still costs nothing — no file is opened for any of it.
    const smokeCheckout = selectTests(
      smoke.map((t) => t),
      {
        command: 'run',
        tags: ['@smoke'],
        project: 'Checkout',
        reporter: 'text',
        workers: 4,
        allowFailures: false
      }
    )
    expect(smokeCheckout.length).toBeGreaterThan(0)
    expect(smokeCheckout.every((t) => t.project === 'Checkout')).toBe(true)
  }, 60_000)

  it('lists the whole library in a reasonable time', async () => {
    // Deliberately loose. A CI box under load is not a benchmark, and a tight
    // threshold here becomes a flaky test that someone eventually deletes —
    // taking the proof with it. This catches an ORDER-OF-MAGNITUDE regression
    // (a listing that started reading every step), which is the failure that
    // actually matters, and nothing subtler.
    const started = Date.now()
    const all = await listTests()
    const elapsed = Date.now() - started
    expect(all).toHaveLength(TEST_COUNT)
    expect(elapsed, `listing ${TEST_COUNT} tests took ${elapsed}ms`).toBeLessThan(15_000)
  }, 60_000)

  it('computes per-test aggregates without walking the ladder twice', async () => {
    // stepStats runs once per test during the listing. It is the only thing in
    // that path that touches step data at all, so it is the one place an
    // accidental O(steps × candidates) cost could hide.
    const steps = bigSteps(STEPS_PER_TEST)
    const started = Date.now()
    for (let i = 0; i < TEST_COUNT; i++) stepStats(steps)
    expect(Date.now() - started).toBeLessThan(5_000)
    const stats = stepStats(steps)
    expect(stats.assertCount).toBe(Math.ceil(STEPS_PER_TEST / 5))
    expect(stats.selectorHealth).toBe(95)
  })
})
