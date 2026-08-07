// =====================================================================
// URL HANDLING
// Two small, pure functions lifted out of index.ts: the one that decides
// what a typed address MEANS, and the one that decides what a user is TOLD
// when it can't be reached. Both are user-facing — the first silently
// rewrites what they typed, the second is the whole error message — and
// both were sitting in a 5,900-line file with no way to test them.
// =====================================================================

/** If the user types "google.com" we turn it into "https://google.com". */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  // Leave ANY explicit scheme alone — http(s)://, file://, chrome://, about:,
  // data:, etc. Only a bare domain like "example.com" or "localhost:5173" gets
  // https:// prepended. A `host:port` is NOT a scheme (no `//` after the colon),
  // so it still gets the prefix. (The old whitelist mangled `chrome://version`
  // into `https://chrome://version` because chrome wasn't on the list.)
  if (/^[a-zA-Z][\w+.-]*:\/\//.test(trimmed) || /^(about|data|blob|view-source):/i.test(trimmed))
    return trimmed
  return `https://${trimmed}`
}

/**
 * Turn a fetch/navigation failure into a sentence a tester can act on.
 *
 * The raw text is either a Node error code nobody outside the team can read
 * (`ENOTFOUND`, `EAI_AGAIN`) or a TLS wall of words. Both mean something simple
 * — the address is wrong, the machine is offline, or the certificate isn't
 * trusted — and saying which is the difference between "the tool is broken" and
 * "oh, I typed the wrong host".
 */
export function reachError(e: unknown, url: string): string {
  const raw = e instanceof Error ? e.message : String(e)
  const host = (() => {
    try {
      return new URL(url).host
    } catch {
      return url
    }
  })()
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET/i.test(raw)) {
    // `cause` is where Node hides the actual reason; include it when it's there.
    const cause = (e as { cause?: { code?: string } })?.cause?.code
    return `Couldn’t reach ${host} — check the URL and your connection.${cause ? ` (${cause})` : ''}`
  }
  if (/certificate|self.signed|CERT_/i.test(raw)) {
    return `Couldn’t verify the HTTPS certificate for ${host}. (${raw})`
  }
  return raw
}
