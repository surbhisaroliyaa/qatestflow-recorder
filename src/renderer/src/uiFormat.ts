// =====================================================================
// SMALL PURE HELPERS THE UI FORMATS WITH
//
// Extracted from App.tsx. Every function here is pure — same input, same output,
// no state, no IPC — which is exactly why they were worth moving first: they are
// the part of that file that could be unit-tested and never was.
// =====================================================================

import { A11Y_IMPACT_ORDER } from './uiLabels'

/** Human-friendly byte size for the browser-download toast. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Shorten text but break at a word boundary — a blunt slice() ends messages
 * mid-word ("…8 × loca"), which reads as broken rather than trimmed. Mirrors
 * clip() in main/xbrowser.ts, which trims the same errors upstream.
 */
export function clip(s: string, max = 300): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + '…'
}

// Day 13: network evidence lines carry [site] / [third-party] tags (whose
// server failed — stamped at capture in main). Third-party noise is shown
// DIMMED and sorted last, never hidden: the tag is a fact, not a judgment.
// MIRROR WARNING: tag text + ordering must match relationTag (main/index.ts)
// and siteFirst (main/translator.ts).
export const isThirdPartyLine = (l: string): boolean => l.includes('[third-party]')

export const siteFirstLines = (lines: string[]): string[] =>
  [...lines].sort((a, b) => Number(isThirdPartyLine(a)) - Number(isThirdPartyLine(b)))

/** Sort rank for an axe impact. Anything unrated sorts last. */
export const a11yImpactRank = (impact: string): number => A11Y_IMPACT_ORDER[impact] ?? 4

/** These kinds compare against an expected value the user can edit. */
export const assertNeedsValue = (kind: AssertKind): boolean =>
  kind === 'text-equals' ||
  kind === 'text-contains' ||
  kind === 'value' ||
  kind === 'count' ||
  kind === 'attribute' ||
  kind === 'class' ||
  kind === 'url-contains' ||
  kind === 'title' ||
  kind === 'nl'

/**
 * The candidate the step's primary selector points at. After a hand-pick the
 * primary is no longer necessarily the top-scored candidates[0].
 */
export function primaryCandidate(step: RecorderStep): SelectorCandidate | undefined {
  return step.candidates?.find((c) => c.locator === step.selector) ?? step.candidates?.[0]
}

/** Map a stability score (0–100) to a traffic-light class for the dot. */
export function stabilityClass(score: number | undefined): string {
  if (score === undefined) return ''
  if (score >= 80) return 'high'
  if (score >= 50) return 'med'
  return 'low'
}
