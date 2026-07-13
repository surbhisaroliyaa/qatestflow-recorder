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
//
// F24: an `api` step carries a URL too, and it MUST follow the environment. If
// it didn't, "run the suite against staging" would send the UI to staging while
// the API calls kept hitting PROD — and an API setup step is usually a POST /
// DELETE, so a staging run would quietly write to the production database. The
// safety rule lives in retargetUrl: only a URL on the recorded base's own origin
// is swapped, so a THIRD-PARTY endpoint (Stripe, Auth0, a public API) is left
// exactly as recorded — it was never ours to retarget.
export function retargetSteps(
  steps: RecorderStep[],
  fromBase: string,
  toBase: string
): RecorderStep[] {
  if (!toBase || !fromBase) return steps
  return steps.map((s) =>
    (s.type === 'navigate' || s.type === 'api') && typeof s.url === 'string'
      ? { ...s, url: retargetUrl(s.url, fromBase, toBase) }
      : s
  )
}

// F24 × F25 guard: which hosts will this test's API steps ACTUALLY call once the
// active environment has done its retargeting? Any host that isn't the
// environment's own is reported — because retargetUrl only rewrites URLs on the
// recorded base's origin, and that leaves two very different cases looking the
// same from the outside:
//
//   • a deliberate third-party call (jsonplaceholder, Stripe) — correct, ignore;
//   • the app's OWN API on a separate host (api.shop.com next to www.shop.com) —
//     NOT retargeted, so a "staging" run still hits the PRODUCTION API. This is
//     the trap, and it is invisible: every navigation went to staging, so the
//     existing host-mismatch check sees nothing wrong.
//
// We can't tell those two apart automatically (both are "a host the env doesn't
// cover"), so we don't guess — we name the hosts and let the human decide.
export function apiHostsOutsideEnv(
  steps: RecorderStep[],
  fromBase: string,
  toBase: string
): string[] {
  if (!toBase) return []
  const envHost = hostOfBase(toBase)
  const hosts = new Set<string>()
  for (const s of steps) {
    if (s.type !== 'api' || typeof s.url !== 'string' || !s.url.trim()) continue
    // The URL as it will be CALLED (after any retarget), not as recorded.
    const host = hostOfBase(retargetUrl(s.url, fromBase, toBase))
    if (host && host !== envHost) hosts.add(host)
  }
  return [...hosts]
}
