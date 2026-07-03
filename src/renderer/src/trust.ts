// =====================================================================
// TRUST SCORE (F5)
// A single 0–100 score (and A–F grade) per test answering: "how much
// should I trust what this test tells me?" It's a COMPOSITE of four
// things a QA weighs by instinct:
//
//   reliability  — its run history (from F2: stable vs flaky vs failing)
//   checks       — does it actually VERIFY things (assertions), or just click?
//   selectors    — how stable are the selectors it uses (testId > css)
//   freshness    — has it run recently, or is it stale/never-run?
//
// A test that clicks through a flow but asserts nothing, on brittle
// selectors, last run months ago, is worth very little even if it's
// "passing" — the score makes that visible instead of a false green tick.
// =====================================================================

import { classifyRuns, type FlakyTag } from './flaky'

export interface TrustFactor {
  key: 'reliability' | 'checks' | 'selectors' | 'freshness'
  label: string
  score: number // 0–100
  note: string // plain-language explanation of THIS test's value
}

export interface TrustScore {
  score: number // 0–100 composite
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  factors: TrustFactor[]
}

// How much each factor counts. Reliability + checks matter most: a test that
// lies (flaky) or checks nothing is the least trustworthy.
const WEIGHTS = { reliability: 0.3, checks: 0.3, selectors: 0.25, freshness: 0.15 }

// Run history → a reliability score. Mirrors the F2 verdict.
const RELIABILITY_BY_TAG: Record<FlakyTag, number> = {
  stable: 100,
  new: 55,
  untested: 45,
  flaky: 25,
  'newly-broken': 15,
  failing: 5
}

// Assertion strength: 0 checks = worthless as verification; each check adds
// confidence, with diminishing returns.
function checksScore(assertCount: number): number {
  if (assertCount <= 0) return 0
  return Math.min(100, 45 + assertCount * 20) // 1→65, 2→85, 3→100
}

// Days since the last run → a freshness score (a stale test proves little today).
function freshnessScore(lastRunAt?: string, nowMs = 0): number {
  if (!lastRunAt) return 20 // never run
  const then = Date.parse(lastRunAt)
  if (!Number.isFinite(then) || !nowMs) return 50
  const days = (nowMs - then) / 86_400_000
  if (days <= 7) return 100
  if (days <= 30) return 75
  if (days <= 90) return 45
  return 25
}

function gradeOf(score: number): TrustScore['grade'] {
  return score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F'
}

export function trustScore(
  summary: {
    runs?: RunInfo[]
    lastRun?: RunInfo
    assertCount?: number
    selectorHealth?: number
    stepCount?: number
  },
  nowMs = 0
): TrustScore {
  const runs =
    summary.runs && summary.runs.length ? summary.runs : summary.lastRun ? [summary.lastRun] : []
  const reliability = RELIABILITY_BY_TAG[classifyRuns(runs).tag] ?? 50
  const checks = checksScore(summary.assertCount ?? 0)
  // No element steps (e.g. an all-navigation/assert test) → neutral 70, not a
  // penalty (there are simply no selectors to be brittle).
  const selectors = summary.selectorHealth ?? 70
  const freshness = freshnessScore(summary.lastRun?.at, nowMs)

  const factors: TrustFactor[] = [
    {
      key: 'reliability',
      label: 'Reliability',
      score: reliability,
      note:
        reliability >= 80
          ? 'passes consistently'
          : reliability >= 40
            ? 'unproven or occasionally red'
            : 'flaky or failing — results not dependable'
    },
    {
      key: 'checks',
      label: 'Checks',
      score: checks,
      note:
        (summary.assertCount ?? 0) === 0
          ? 'verifies nothing — only clicks through'
          : `makes ${summary.assertCount} check${summary.assertCount === 1 ? '' : 's'}`
    },
    {
      key: 'selectors',
      label: 'Selectors',
      score: selectors,
      note:
        selectors >= 75
          ? 'stable selectors (test-ids / roles)'
          : selectors >= 45
            ? 'mixed selector stability'
            : 'brittle selectors — likely to break'
    },
    {
      key: 'freshness',
      label: 'Freshness',
      score: freshness,
      note:
        freshness >= 90
          ? 'run recently'
          : freshness >= 45
            ? 'not run in a while'
            : 'stale or never run'
    }
  ]

  const composite = Math.round(
    reliability * WEIGHTS.reliability +
      checks * WEIGHTS.checks +
      selectors * WEIGHTS.selectors +
      freshness * WEIGHTS.freshness
  )
  return { score: composite, grade: gradeOf(composite), factors }
}
