import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/Users/test/AppData' } }))

const { blockRefsIn, hasVisualStep, uploadFilesIn } = await import('../src/main/bundle')
const { placeholderSecrets, scrubDataRows } = await import('../src/main/secrets')

// =====================================================================
// F40 — THE SHAREABLE BUNDLE: what leaves your machine.
//
// A bundle is meant to be committed to git or handed to a teammate, which
// makes two failures matter more than anything else in the feature:
//
//   1. It carries a credential. Your test-account password is now in a
//      repo, in someone's inbox, permanently, and nothing warns you.
//   2. It arrives INCOMPLETE. A test whose linked block or upload file
//      stayed behind is broken for the recipient — and it fails in a way
//      that looks like their machine, not like a missing file.
// =====================================================================

const s = (o: Record<string, unknown>): unknown => o

describe('a password must never travel', () => {
  it('replaces a secret value with an env placeholder', () => {
    const [out] = placeholderSecrets([
      s({ type: 'type', secret: true, value: 'hunter2', selector: "getByTestId('p')" })
    ]) as Record<string, unknown>[]
    expect(out.value).toBe('{{env:PASSWORD}}')
    expect(JSON.stringify(out)).not.toContain('hunter2')
  })

  it('drops the reference to the local secret store as well', () => {
    // secretRef points at a file on THIS machine. Shipping it hands the
    // recipient a dangling pointer that reads as "the password is missing"
    // rather than "you need to supply one".
    const [out] = placeholderSecrets([
      s({ type: 'type', secret: true, value: 'x', secretRef: 'sec-123' })
    ]) as Record<string, unknown>[]
    expect(out.secretRef).toBeUndefined()
  })

  it('leaves an ordinary typed value alone', () => {
    // Only steps FLAGGED secret are placeholdered; scrubbing everything would
    // ship a test that types nothing.
    const [out] = placeholderSecrets([
      s({ type: 'type', value: 'standard_user' })
    ]) as Record<string, unknown>[]
    expect(out.value).toBe('standard_user')
  })

  it('does not mutate the caller’s steps', () => {
    // These are the live steps in the app. Scrubbing them in place would blank
    // the password in the test you are still working on.
    const steps = [s({ type: 'type', secret: true, value: 'hunter2' })]
    placeholderSecrets(steps)
    expect((steps[0] as Record<string, unknown>).value).toBe('hunter2')
  })

  it('survives a malformed step list', () => {
    expect(() => placeholderSecrets(null as unknown as unknown[])).not.toThrow()
    expect(() => placeholderSecrets([null, 'nonsense'] as unknown[])).not.toThrow()
  })
})

describe('a data table must travel WITHOUT its credentials', () => {
  // The rows have to go — a data-driven test without them runs zero times and
  // verifies nothing. But rows are exactly where real test-account credentials
  // live, so the sensitive COLUMNS are placeholdered by name.
  it('placeholders a password column and reports which it scrubbed', () => {
    const out = scrubDataRows([
      { username: 'standard_user', password: 'secret_sauce' },
      { username: 'locked_out_user', password: 'secret_sauce' }
    ])
    expect(out.scrubbed).toEqual(['password'])
    expect(JSON.stringify(out.rows)).not.toContain('secret_sauce')
    // …and the row still has its non-sensitive data, or the test can't run.
    expect(out.rows[0].username).toBe('standard_user')
  })

  it('recognises the many ways a column gets named', () => {
    for (const col of ['pass', 'passwd', 'Password', 'pwd', 'apiKey', 'api_key', 'token',
      'secret', 'cardNumber', 'cvv', 'ssn', 'authToken']) {
      const out = scrubDataRows([{ [col]: 'LIVE-VALUE' }])
      expect(out.scrubbed, col).toContain(col)
      expect(JSON.stringify(out.rows), col).not.toContain('LIVE-VALUE')
    }
  })

  it('recognises api-key however it is punctuated', () => {
    // It listed `apikey` and `api_key` literally and missed `api-key` — the
    // commonest of the three — so a column named that carried a live key into a
    // bundle meant for git. apiStep's own pattern already handled all of them.
    for (const col of ['api-key', 'API-Key', 'x-api-key', 'api key']) {
      const out = scrubDataRows([{ [col]: 'LIVE-KEY' }])
      expect(out.scrubbed, col).toContain(col)
      expect(JSON.stringify(out.rows), col).not.toContain('LIVE-KEY')
    }
  })

  it('turns the column into a placeholder the recipient can actually supply', () => {
    // It must be a legal env-var name: they set it and the test runs.
    const out = scrubDataRows([{ 'api key-2': 'x' }])
    expect(out.rows[0]['api key-2']).toBe('{{env:API_KEY_2}}')
  })

  it('leaves a table with nothing sensitive completely untouched', () => {
    const rows = [{ username: 'a', item: 'backpack' }]
    const out = scrubDataRows(rows)
    expect(out.scrubbed).toEqual([])
    expect(out.rows).toEqual(rows)
  })

  it('does not mutate the caller’s rows', () => {
    const rows = [{ password: 'secret_sauce' }]
    scrubDataRows(rows)
    expect(rows[0].password).toBe('secret_sauce')
  })

  it('handles an empty or missing table', () => {
    expect(scrubDataRows([])).toEqual({ rows: [], scrubbed: [] })
    expect(scrubDataRows(undefined)).toEqual({ rows: [], scrubbed: [] })
  })
})

describe('a bundle must arrive complete', () => {
  // A test whose dependency stayed behind is broken for the recipient, and it
  // fails in a way that looks like THEIR machine rather than a missing file.
  it('finds every linked block a test depends on', () => {
    expect(
      blockRefsIn([
        s({ type: 'navigate' }),
        s({ type: 'block', blockRef: 'login-block.json' }),
        s({ type: 'click' }),
        s({ type: 'block', blockRef: 'checkout-block.json' })
      ])
    ).toEqual(['login-block.json', 'checkout-block.json'])
  })

  it('ignores a block step with no reference', () => {
    expect(blockRefsIn([s({ type: 'block' })])).toEqual([])
  })

  it('finds every upload fixture, by base name', () => {
    // The bundle stores files flat, so the path on THIS machine is irrelevant —
    // what travels is the name the step will look for.
    expect(
      uploadFilesIn([
        s({ type: 'upload', value: 'C:\\Users\\samee\\Documents\\invoice.pdf' }),
        s({ type: 'upload', value: '/home/qa/photo.png' }),
        s({ type: 'click' })
      ])
    ).toEqual(['invoice.pdf', 'photo.png'])
  })

  it('ignores an upload step with no file', () => {
    expect(uploadFilesIn([s({ type: 'upload', value: '' }), s({ type: 'upload' })])).toEqual([])
  })

  it('spots a visual test, which needs its baselines to mean anything', () => {
    // Without the baseline images a snapshot step has nothing to compare
    // against, so the recipient's first run either errors or silently adopts
    // whatever it sees as correct.
    expect(hasVisualStep([s({ type: 'click' }), s({ type: 'snapshot' })])).toBe(true)
    expect(hasVisualStep([s({ type: 'click' })])).toBe(false)
  })

  it('every collector survives a malformed test file', () => {
    // Bundles are built from JSON on disk, which people edit.
    for (const bad of [null, undefined, 'nonsense', [null, 42]]) {
      expect(() => blockRefsIn(bad as unknown[])).not.toThrow()
      expect(() => uploadFilesIn(bad as unknown[])).not.toThrow()
      expect(() => hasVisualStep(bad as unknown[])).not.toThrow()
    }
  })
})
