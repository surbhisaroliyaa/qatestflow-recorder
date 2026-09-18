import { describe, it, expect } from 'vitest'
import { explainLoadError, loadErrorDetails } from '../src/shared/loadErrors'
import {
  clampPaneWidth,
  readStoredPaneWidth,
  PANE_DEFAULT,
  PANE_MIN,
  PAGE_MIN
} from '../src/renderer/src/paneLayout'

// QF-012: a page that won't load must say WHY in words a tester can act on,
// and "Copy details" must carry enough to hand to whoever runs the server.
describe('a failed page load, in plain words', () => {
  it('explains the failures a tester actually meets', () => {
    // The audit's own repro: a closed local port.
    expect(explainLoadError({ code: -102, description: 'ERR_CONNECTION_REFUSED' })).toMatch(
      /Nothing is answering/
    )
    expect(explainLoadError({ code: -105, description: 'ERR_NAME_NOT_RESOLVED' })).toMatch(
      /can’t be found/
    )
    expect(explainLoadError({ code: -106, description: 'ERR_INTERNET_DISCONNECTED' })).toMatch(
      /offline/
    )
    // Found by driving the real app: port 9 is one browsers refuse outright.
    expect(explainLoadError({ code: -312, description: 'ERR_UNSAFE_PORT' })).toMatch(
      /block this port/
    )
  })

  it('covers every certificate error with one sentence', () => {
    expect(explainLoadError({ code: -202, description: 'ERR_CERT_AUTHORITY_INVALID' })).toMatch(
      /certificate/
    )
    expect(explainLoadError({ code: -201, description: 'ERR_CERT_DATE_INVALID' })).toMatch(
      /certificate/
    )
  })

  it('still says something honest for a code it has no sentence for', () => {
    expect(explainLoadError({ code: -999, description: 'ERR_SOMETHING_NEW' })).toBe(
      'The page couldn’t be loaded.'
    )
  })

  it('copies the url, the Chromium constant and code, the reason and the time', () => {
    const text = loadErrorDetails(
      { url: 'http://localhost:3000/login', code: -102, description: 'ERR_CONNECTION_REFUSED' },
      new Date('2026-09-18T10:00:00Z')
    )
    expect(text).toContain('http://localhost:3000/login')
    expect(text).toContain('ERR_CONNECTION_REFUSED (-102)')
    expect(text).toContain('Nothing is answering')
    expect(text).toContain('2026-09-18T10:00:00.000Z')
  })
})

// QF-007/008: the step pane is resizable — within limits that keep both the
// pane and the page usable.
describe('the step pane width', () => {
  it('never goes below the minimum', () => {
    expect(clampPaneWidth(100, 1600)).toBe(PANE_MIN)
  })

  it('never takes so much that the page is left too narrow to record on', () => {
    expect(clampPaneWidth(5000, 1280)).toBe(1280 - PAGE_MIN)
  })

  it('keeps a width that fits', () => {
    expect(clampPaneWidth(420, 1280)).toBe(420)
  })

  it('on a window too small for both, keeps the pane at its minimum rather than negative', () => {
    expect(clampPaneWidth(400, 600)).toBe(PANE_MIN)
  })

  it('opens at the default when nothing (or nonsense) was remembered', () => {
    expect(readStoredPaneWidth(null)).toBe(PANE_DEFAULT)
    expect(readStoredPaneWidth('abc')).toBe(PANE_DEFAULT)
    expect(readStoredPaneWidth('-5')).toBe(PANE_DEFAULT)
    expect(readStoredPaneWidth('450')).toBe(450)
  })
})
