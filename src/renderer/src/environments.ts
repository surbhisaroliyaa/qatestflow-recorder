// =====================================================================
// ENVIRONMENT RETARGETING (F25) — renderer helpers
// When an environment is ACTIVE, a run's navigations are re-pointed from the
// test's recorded base URL to the active environment's base URL — transiently,
// on a COPY of the steps, so the saved test is never rewritten. (Credentials
// travel a different road: the active env's vars feed the existing {{env:NAME}}
// token resolution in main — see dataDriven.ts + env:get.)
//
// The rewrite mirrors the existing in-place "edit base URL" retarget (a plain
// prefix swap), so behavior is consistent, with a same-origin fallback so a
// path-only base still re-points. Navigations to a DIFFERENT origin (an OAuth
// provider, an external link) are deliberately left alone.
// =====================================================================

const trimSlash = (s: string): string => s.replace(/\/+$/, '')

// Re-point ONE url from `fromBase` to `toBase`. Same-origin URLs that don't
// share the recorded prefix still get their origin swapped; anything on another
// origin (or unparseable) is returned untouched.
export function retargetUrl(url: string, fromBase: string, toBase: string): string {
  if (!url || !fromBase || !toBase) return url
  const from = trimSlash(fromBase)
  const to = trimSlash(toBase)
  if (from === to) return url
  if (url.startsWith(from)) return to + url.slice(from.length)
  try {
    const u = new URL(url)
    if (u.origin === new URL(from).origin) {
      return new URL(to).origin + u.pathname + u.search + u.hash
    }
  } catch {
    // not a full URL (or bases aren't) — leave it as recorded
  }
  return url
}

// The HOST of a base URL ("https://www.saucedemo.com" → "www.saucedemo.com"),
// or '' when it isn't a parseable URL.
export function hostOfBase(base: string): string {
  try {
    return new URL(base).host
  } catch {
    return ''
  }
}

// Would an active environment send this test to a DIFFERENT SITE than the one
// it was recorded on? Retargeting across hosts is the whole point of F25 —
// dev/staging/prod live on different hosts — so this can't be an error. But a
// library spanning several sites (saucedemo, the-internet, expandtesting) has a
// trap: one active env silently re-points every test at its own host, and the
// steps panel still shows the RECORDED url. Returns the two hosts so a caller
// can warn, or null when there's nothing to warn about.
export function retargetHostMismatch(
  fromBase: string,
  toBase: string
): { from: string; to: string } | null {
  const from = hostOfBase(fromBase)
  const to = hostOfBase(toBase)
  if (!from || !to || from === to) return null
  return { from, to }
}

// === Host-mismatch warning suppression ("don't ask again") ==============
// Keyed on the ENVIRONMENT *and* the host pair, never the environment alone.
// Silencing per-environment would mean one "don't ask again" on a herokuapp
// test also silences the warning for every other site in the library — the
// exact trap the warning exists to catch. Per-pair, a staging env asks once for
// the app's host and then stays quiet, while a NEW host still asks.
//
// The stored value is the CHOICE, so the next run can replay the decision. The
// map itself lives in the main-process EnvState (userData) — NOT renderer
// localStorage, which the per-run test-isolation clearStorageData() wipes. It
// arrives via window.api.environments.* and is read here from that map.
export type RetargetChoice = 'run' | 'noenv'

export function retargetWarnKey(envId: string, from: string, to: string): string {
  return `${envId}|${from}|${to}`
}

// Look up a remembered choice in the suppression map from EnvState.
export function suppressedChoice(
  suppress: Record<string, RetargetChoice> | undefined,
  envId: string,
  from: string,
  to: string
): RetargetChoice | null {
  return suppress?.[retargetWarnKey(envId, from, to)] ?? null
}

// A COPY of the steps with every navigation re-pointed to `toBase`. No-op when
// there's no target (no active env) or no source base to anchor the swap.
export function retargetSteps(
  steps: RecorderStep[],
  fromBase: string,
  toBase: string
): RecorderStep[] {
  if (!toBase || !fromBase) return steps
  return steps.map((s) =>
    s.type === 'navigate' && typeof s.url === 'string'
      ? { ...s, url: retargetUrl(s.url, fromBase, toBase) }
      : s
  )
}
