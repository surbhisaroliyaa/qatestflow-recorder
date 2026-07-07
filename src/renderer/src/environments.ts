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
