import { describe, it, expect } from 'vitest'
import { collidesWithOsEnv } from '../src/shared/osEnvNames'

// This list exists because of one of the nastiest bugs in the project's history:
// {{env:USERNAME}} silently resolved to the Windows account name ("samee"),
// because Windows ALWAYS sets USERNAME. The login typed the wrong user, failed,
// and the test still passed (nothing asserted after the click). In the in-app
// suite run it surfaced three steps later as "Expected URL to contain
// /inventory.html", categorised "stale data" — a plausible, wrong explanation.
//
// The rule previously lived in two places with only one copy getting the fix,
// which is why it now lives in src/shared/. These tests pin the behaviour so a
// future "tidy-up" of the list can't quietly reopen the hole.

describe('collidesWithOsEnv', () => {
  it('catches the name that actually caused the bug', () => {
    expect(collidesWithOsEnv('USERNAME')).toBe(true)
  })

  it('is case-insensitive, because Windows env vars are', () => {
    // {{env:username}} reads the same variable as {{env:USERNAME}}.
    expect(collidesWithOsEnv('username')).toBe(true)
    expect(collidesWithOsEnv('UserName')).toBe(true)
  })

  it('ignores surrounding whitespace from a sloppy token', () => {
    expect(collidesWithOsEnv('  USERNAME  ')).toBe(true)
  })

  it('covers the other names CI runners commonly set', () => {
    // "Works locally, breaks in CI" with nothing pointing at the cause.
    for (const name of ['USER', 'HOME', 'PATH', 'TEMP', 'TMP', 'HOSTNAME', 'LOGNAME', 'SHELL']) {
      expect(collidesWithOsEnv(name), `${name} should be treated as OS-defined`).toBe(true)
    }
  })

  it('does NOT block an ordinary project variable', () => {
    // The guard must stay narrow — over-blocking would break real credentials.
    for (const name of ['SAUCE_PW', 'API_KEY', 'BASE_URL', 'PASSWORD', 'LOGIN_PW', 'QA_USERNAME']) {
      expect(collidesWithOsEnv(name), `${name} should be usable`).toBe(false)
    }
  })

  it('matches whole names only, not substrings', () => {
    // USERNAME_2 is the user's own variable and must resolve normally.
    expect(collidesWithOsEnv('USERNAME_2')).toBe(false)
    expect(collidesWithOsEnv('MY_USERNAME')).toBe(false)
  })
})
