// =====================================================================
// OS-DEFINED ENVIRONMENT VARIABLE NAMES
// Shared by main (which resolves {{env:…}} for an in-app run) and the renderer
// (which warns at export and emits the QA_-prefixed read). One list, one
// meaning — this codebase has repeatedly been bitten by the same rule living in
// two places with only one copy getting the fix.
//
// WHY THIS EXISTS: `{{env:USERNAME}}` resolves to `process.env.USERNAME`, and on
// Windows that is ALWAYS set — to the logged-in account name. So a fallback
// meant to catch an UNSET variable can never fire: the value silently becomes
// the OS one. Proven twice on the same test:
//   · exported spec — typed `samee` into the login, login failed, test PASSED
//     (nothing asserted after the click)
//   · in-app suite run with no environment active — typed `samee`, login failed,
//     and the failure surfaced three steps later as "Expected URL to contain
//     /inventory.html", categorised "stale data". A plausible, wrong explanation
//     that sends you looking at the test instead of the environment.
//
// CI is not safer: GitHub Actions and most runners set USERNAME/USER too, so it
// becomes the classic "works locally, breaks in CI" with nothing pointing at the
// cause.
// =====================================================================

/**
 * Compared case-insensitively: Windows environment variables are
 * case-insensitive, so `{{env:username}}` reads the same variable as
 * `{{env:USERNAME}}`.
 */
const OS_ENV_NAMES = new Set([
  'username',
  'user',
  'userprofile',
  'userdomain',
  'home',
  'homepath',
  'homedrive',
  'path',
  'pathext',
  'temp',
  'tmp',
  'os',
  'computername',
  'hostname',
  'shell',
  'lang',
  'pwd',
  'logname',
  'appdata',
  'localappdata',
  'programfiles',
  'systemroot',
  'windir',
  'processor_architecture',
  'number_of_processors',
  'session_name'
])

/** Does this `{{env:NAME}}` collide with a variable the OS already sets? */
export function collidesWithOsEnv(name: string): boolean {
  return OS_ENV_NAMES.has(name.trim().toLowerCase())
}
