import { describe, it, expect, vi } from 'vitest'

// library.ts asks Electron where Documents is. Nothing under test touches the
// filesystem, but the module-level import has to resolve.
vi.mock('electron', () => ({ app: { getPath: () => '/Users/test/Documents' } }))

const { harNameForFile, safeRel, safeSegment, slugify, stepStats } = await import(
  '../src/main/library'
)

// =====================================================================
// THE LIBRARY — where saved tests live on disk.
//
// A bug here costs work that cannot be got back. Everything below either
// decides WHERE a file is written, or decides what the library UI says
// about a test, and both take input that arrives over IPC.
// =====================================================================

describe('nothing can escape the library folder', () => {
  // saveTest / loadTest / deleteTest all take a name from the renderer. A
  // segment that walked upward would let a save land anywhere the user can
  // write — and a delete remove anything they own.
  it('strips path separators', () => {
    expect(safeSegment('a/b')).toBe('ab')
    expect(safeSegment('a\\b')).toBe('ab')
  })

  it('refuses a segment that is exactly .. or .', () => {
    expect(safeSegment('..')).toBe('')
    expect(safeSegment('.')).toBe('')
  })

  it('strips characters Windows reserves in a filename', () => {
    expect(safeSegment('a:b*c?d"e<f>g|h')).toBe('abcdefgh')
  })

  it('cannot be walked up, however the traversal is written', () => {
    for (const attempt of [
      '../../etc/passwd',
      '..\\..\\Windows\\System32',
      'suite/../../../secrets.json',
      './../x',
      '....//....//x'
    ]) {
      const out = safeRel(attempt)
      // The property that matters is per SEGMENT: no segment may be a parent
      // reference. A segment merely CONTAINING dots ("...." ) is a legal, if
      // odd, directory name and goes nowhere — testing for the substring ".."
      // would be testing the wrong thing.
      for (const seg of out.split('/')) {
        expect(seg, `${attempt} → ${out}`).not.toBe('..')
        expect(seg, `${attempt} → ${out}`).not.toBe('.')
      }
      expect(out, attempt).not.toMatch(/^[/\\]/)
      // …and whatever survives is at most suite/file, inside the library.
      expect(out.split('/').length, attempt).toBeLessThanOrEqual(2)
    }
  })

  it('keeps a legitimate suite/file path intact', () => {
    expect(safeRel('E2E/login.json')).toBe('E2E/login.json')
    expect(safeRel('E2E\\login.json')).toBe('E2E/login.json')
  })

  it('never returns more than two segments', () => {
    // The layout is one suite folder deep. Anything deeper is not a path we
    // wrote, so it is truncated rather than trusted.
    expect(safeRel('a/b/c/d.json').split('/')).toHaveLength(2)
  })

  it('drops empty segments instead of producing a double slash', () => {
    expect(safeRel('E2E//login.json')).toBe('E2E/login.json')
    expect(safeRel('/login.json')).toBe('login.json')
  })

  it('an entirely hostile path collapses to nothing, not to something', () => {
    expect(safeRel('../..')).toBe('')
    expect(safeRel('///')).toBe('')
  })
})

describe('turning a test name into a filename', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Login flow (staging)')).toBe('login-flow-staging')
  })

  it('never yields an empty name', () => {
    // A file called ".json" would be invisible and unopenable.
    expect(slugify('')).toBe('untitled')
    expect(slugify('!!!')).toBe('untitled')
    expect(slugify('   ')).toBe('untitled')
  })

  it('caps the length so the full path stays under the OS limit', () => {
    expect(slugify('x'.repeat(500)).length).toBeLessThanOrEqual(60)
  })

  it('leaves no leading or trailing hyphen', () => {
    expect(slugify('  Login!  ')).toBe('login')
    expect(slugify('---a---')).toBe('a')
  })

  it('keeps non-ascii names usable rather than empty', () => {
    // Falls back rather than producing an unnamed file.
    expect(slugify('测试')).toBe('untitled')
  })
})

describe('the HAR that belongs to a test', () => {
  it('derives a flat name from the test path', () => {
    // The archive lives in one _hars folder, so the suite has to survive in the
    // NAME or two suites' "login" tests would share one archive.
    expect(harNameForFile('E2E/login.json')).toBe('E2E__login.har')
  })

  it('produces a name the loader will accept', () => {
    // loadHar guards on /^[a-zA-Z0-9_-]+\.har$/ — a name this function generates
    // must pass that guard, or a test's own archive becomes unreadable.
    const SAFE_HAR = /^[a-zA-Z0-9_-]+\.har$/
    for (const file of ['E2E/login.json', 'Daily/checkout-flow.json', 'plain.json']) {
      expect(SAFE_HAR.test(harNameForFile(file)), file).toBe(true)
    }
  })
})

describe('what the library says about a test', () => {
  const step = (o: Record<string, unknown>): unknown => o

  it('counts every kind of CHECK, not just assertions', () => {
    // The trust score is built on this: a test with no checks is a test that
    // proves nothing, and the library flags it.
    expect(
      stepStats([
        step({ type: 'assert' }),
        step({ type: 'snapshot' }),
        step({ type: 'a11y' }),
        step({ type: 'perf' }),
        step({ type: 'click' })
      ]).assertCount
    ).toBe(4)
  })

  it('does not count a DISABLED check', () => {
    // It won't run, so counting it would overstate what the test proves.
    expect(stepStats([step({ type: 'assert', disabled: true })]).assertCount).toBe(0)
  })

  it('averages the score of the selector each step actually uses', () => {
    expect(
      stepStats([
        step({
          type: 'click',
          selector: "getByTestId('a')",
          candidates: [
            { locator: "locator('#x')", score: 40 },
            { locator: "getByTestId('a')", score: 90 }
          ]
        })
      ]).selectorHealth
    ).toBe(90)
  })

  it('falls back to the strongest candidate when the selector was hand-edited', () => {
    expect(
      stepStats([
        step({
          type: 'click',
          selector: "locator('.hand-written')",
          candidates: [{ locator: "getByTestId('a')", score: 95 }]
        })
      ]).selectorHealth
    ).toBe(95)
  })

  it('reports no health at all rather than a misleading zero', () => {
    // Zero would read as "every selector is terrible"; absent reads as
    // "nothing to measure", which is the truth.
    expect(stepStats([step({ type: 'navigate' })]).selectorHealth).toBeUndefined()
    expect(stepStats([]).selectorHealth).toBeUndefined()
  })

  it('survives a malformed or hand-edited test file', () => {
    // These files are plain JSON on disk and people do edit them.
    expect(() => stepStats(null as unknown as unknown[])).not.toThrow()
    expect(() => stepStats([null, undefined, 'nonsense', 42] as unknown[])).not.toThrow()
    expect(stepStats(null as unknown as unknown[]).assertCount).toBe(0)
  })
})
