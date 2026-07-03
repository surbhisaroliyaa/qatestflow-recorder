// =====================================================================
// STEP DIFF (F12) — a git-style diff between two versions of a test.
// We diff the HUMAN sentence of each step (what the step list shows), so
// the diff reads the way the test reads. Standard LCS: 'same' lines are
// unchanged, 'del' were in the OLD version, 'add' are in the NEW one.
// =====================================================================

import { stepText } from './playwrightExport'

export type DiffKind = 'same' | 'add' | 'del'
export interface DiffLine {
  kind: DiffKind
  text: string
}

// Longest-common-subsequence diff of two string lists → an ordered line list.
function diffLines(oldL: string[], newL: string[]): DiffLine[] {
  const m = oldL.length
  const n = newL.length
  // dp[i][j] = LCS length of oldL[i..] and newL[j..]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = oldL[i] === newL[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (oldL[i] === newL[j]) {
      out.push({ kind: 'same', text: newL[j] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: oldL[i] })
      i++
    } else {
      out.push({ kind: 'add', text: newL[j] })
      j++
    }
  }
  while (i < m) out.push({ kind: 'del', text: oldL[i++] })
  while (j < n) out.push({ kind: 'add', text: newL[j++] })
  return out
}

// Diff two step arrays (old version → current), by their human sentences.
export function diffSteps(oldSteps: RecorderStep[], newSteps: RecorderStep[]): DiffLine[] {
  return diffLines(
    oldSteps.map((s) => stepText(s)),
    newSteps.map((s) => stepText(s))
  )
}

// Quick counts for a version's summary line ("+2 −1").
export function diffCounts(
  oldSteps: RecorderStep[],
  newSteps: RecorderStep[]
): {
  added: number
  removed: number
} {
  const d = diffSteps(oldSteps, newSteps)
  return {
    added: d.filter((l) => l.kind === 'add').length,
    removed: d.filter((l) => l.kind === 'del').length
  }
}
