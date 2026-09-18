// =====================================================================
// WHEN A PAGE WON'T LOAD  (audit finding QF-012)
// =====================================================================
// The audit navigated to a closed local port and got Chromium's generic
// chrome-error page: no app-level message, no retry, nothing a screen reader
// would announce. For a tester, "the environment is down" and "my test is
// broken" then look identical — and that confusion is expensive.
//
// Electron reports a failed load as a numeric Chromium net error code plus
// its constant name (ERR_CONNECTION_REFUSED). This turns the common ones into
// a sentence a non-developer can act on, and builds the "Copy details" text
// for a bug report or a message to whoever runs the server.
// =====================================================================

export interface LoadError {
  url: string
  code: number
  description: string // Chromium's constant, e.g. "ERR_CONNECTION_REFUSED"
  // Numbers each failure, so ✕ dismisses THAT one only. Keyed on url + code,
  // a dismissed bar stayed hidden when the same address failed again.
  attempt?: number
}

// Codes from Chromium's net/base/net_error_list.h — the ones a tester meets.
const EXPLAIN: Record<number, string> = {
  [-102]: 'Nothing is answering at this address. The server may be down, or the port may be wrong.',
  [-105]: 'This address can’t be found. Check the spelling of the domain.',
  [-137]: 'This address can’t be found. Check the spelling of the domain.',
  [-106]: 'This computer is offline. Check your internet connection.',
  [-21]: 'The network changed while the page was loading. Try again.',
  [-7]: 'The server took too long to answer.',
  [-118]: 'The server took too long to answer.',
  [-109]: 'This address can’t be reached from this computer (network or firewall).',
  [-100]: 'The server closed the connection before the page arrived.',
  [-101]: 'The connection was reset before the page arrived.',
  [-300]: 'This isn’t a valid web address.',
  [-10]: 'Access to this page was denied.',
  [-6]: 'The file or page wasn’t found.',
  [-310]: 'The page redirected too many times — it’s stuck in a loop.',
  [-324]: 'The server sent back an empty response.',
  [-312]: 'Browsers block this port for safety. Run the site on a different port.',
  [-20]: 'This page was blocked from loading.',
  [-27]: 'This page was blocked by the browser (for example by a security policy).'
}

/** A plain-language sentence for a failed load. */
export function explainLoadError(e: Pick<LoadError, 'code' | 'description'>): string {
  const known = EXPLAIN[e.code]
  if (known) return known
  // -200…-299: certificate problems — one sentence covers them all.
  if (e.code <= -200 && e.code >= -299) {
    return 'The site’s security certificate isn’t trusted, so the page wasn’t loaded.'
  }
  return 'The page couldn’t be loaded.'
}

/** The text "Copy details" puts on the clipboard. */
export function loadErrorDetails(e: LoadError, at: Date = new Date()): string {
  return [
    'Page failed to load',
    `URL:   ${e.url}`,
    `Error: ${e.description || 'unknown'} (${e.code})`,
    `Why:   ${explainLoadError(e)}`,
    `When:  ${at.toISOString()}`,
    'App:   QATestFlow Recorder'
  ].join('\n')
}
