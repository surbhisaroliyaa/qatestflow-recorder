import { describe, it, expect, vi, afterAll } from 'vitest'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ app: { getPath: () => '/Users/test/AppData' } }))

const {
  blockRefsIn,
  exportBundle,
  hasVisualStep,
  importBundle,
  localUploadPath,
  relinkUploads,
  uploadFilesIn,
  uploadPathsOf
} = await import('../src/main/bundle')
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
    const [out] = placeholderSecrets([s({ type: 'type', value: 'standard_user' })]) as Record<
      string,
      unknown
    >[]
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
    for (const col of [
      'pass',
      'passwd',
      'Password',
      'pwd',
      'apiKey',
      'api_key',
      'token',
      'secret',
      'cardNumber',
      'cvv',
      'ssn',
      'authToken'
    ]) {
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
      expect(() => relinkUploads(bad as unknown[], '/lib/_uploads')).not.toThrow()
    }
  })

  it('finds EVERY file of a multi-file upload, not just the last', () => {
    // A multi-select is stored one path per line. Read as one path, its
    // basename was the LAST file's name, and only that file shipped.
    expect(
      uploadFilesIn([s({ type: 'upload', value: 'C:\\Users\\sam\\a.pdf\nC:\\Users\\sam\\b.pdf' })])
    ).toEqual(['a.pdf', 'b.pdf'])
  })
})

// =====================================================================
// An upload must still RUN on the machine that imports the bundle.
//
// The fixture travelling is half of it. The step stores an ABSOLUTE path —
// the exporter's own `C:\Users\sam\…\_uploads\invoice.pdf` — and in-app replay
// hands that path straight to the browser. So the file arrived, sat in the
// recipient's _uploads, and the upload still failed: on a Mac, on Linux, and
// for any other Windows user. These run export → import for real, on disk.
// =====================================================================
describe('an imported upload points at a file that exists HERE', () => {
  const made: string[] = []
  const tmp = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), 'qaflow-bundle-'))
    made.push(d)
    return d
  }
  afterAll(async () => {
    for (const d of made) await rm(d, { recursive: true, force: true })
  })

  /** A library whose one test uploads two fixtures, recorded at `recordedDir`. */
  const exporterLibrary = async (recordedDir: string, sep: string): Promise<string> => {
    const lib = await tmp()
    await mkdir(join(lib, '_uploads'), { recursive: true })
    await mkdir(join(lib, 'E2E'), { recursive: true })
    await writeFile(join(lib, '_uploads', 'invoice.pdf'), 'INVOICE-BYTES')
    await writeFile(join(lib, '_uploads', 'photo 1.png'), 'PHOTO-BYTES')
    const test = {
      version: 1,
      name: 'Upload',
      baseURL: '',
      steps: [
        { type: 'navigate', url: 'https://x.test/' },
        {
          type: 'upload',
          label: 'invoice.pdf, photo 1.png',
          value: [`${recordedDir}${sep}invoice.pdf`, `${recordedDir}${sep}photo 1.png`].join('\n'),
          selector: "locator('#f')"
        }
      ]
    }
    await writeFile(join(lib, 'E2E', 'upload.json'), JSON.stringify(test))
    return lib
  }

  const roundTrip = async (
    exporter: string,
    importer: string
  ): Promise<Record<string, unknown>[]> => {
    const bundle = await tmp()
    const out = await exportBundle(exporter, bundle, ['E2E/upload.json'], null)
    expect(out.ok, out.error).toBe(true)
    expect(out.manifest?.uploads.sort()).toEqual(['invoice.pdf', 'photo 1.png'])
    const res = await importBundle(bundle, importer, [
      { file: 'E2E__upload.json', choice: 'overwrite' }
    ])
    expect(res.ok, res.error).toBe(true)
    const back = JSON.parse(await readFile(join(importer, 'E2E', 'upload.json'), 'utf-8'))
    return back.steps
  }

  const expectLocal = async (steps: Record<string, unknown>[], importer: string): Promise<void> => {
    const paths = String(steps[1].value).split('\n')
    expect(paths).toHaveLength(2)
    for (const p of paths) {
      expect(existsSync(p), p).toBe(true)
      expect(p.startsWith(join(importer, '_uploads'))).toBe(true)
    }
    expect(await readFile(paths[0], 'utf-8')).toBe('INVOICE-BYTES')
    expect(await readFile(paths[1], 'utf-8')).toBe('PHOTO-BYTES')
  }

  it('a bundle recorded on WINDOWS opens anywhere', async () => {
    const lib = await exporterLibrary('C:\\Users\\sam\\Documents\\QATestFlow Tests\\_uploads', '\\')
    const importer = await tmp()
    await expectLocal(await roundTrip(lib, importer), importer)
  })

  it('a bundle recorded on macOS / Linux opens anywhere', async () => {
    const lib = await exporterLibrary('/Users/sam/Documents/QATestFlow Tests/_uploads', '/')
    const importer = await tmp()
    await expectLocal(await roundTrip(lib, importer), importer)
  })

  it('never reuses a DIFFERENT local file that happens to share the name', async () => {
    // Keeping the local file and pointing the step at it would make the
    // imported test upload someone else's invoice — and pass.
    const lib = await exporterLibrary('C:\\Users\\sam\\_uploads', '\\')
    const importer = await tmp()
    await mkdir(join(importer, '_uploads'), { recursive: true })
    await writeFile(join(importer, '_uploads', 'invoice.pdf'), 'SOMEONE-ELSES')
    await writeFile(join(importer, '_uploads', 'photo 1.png'), 'PHOTO-BYTES') // identical
    const steps = await roundTrip(lib, importer)
    await expectLocal(steps, importer)
    expect(String(steps[1].value)).toContain('invoice-imported.pdf')
    expect(String(steps[1].value)).not.toContain('photo 1-imported')
    // …and the local file is untouched.
    expect(await readFile(join(importer, '_uploads', 'invoice.pdf'), 'utf-8')).toBe('SOMEONE-ELSES')
  })
})

describe('replay finds a fixture whose recorded path is from another machine', () => {
  const have = (...files: string[]): ((p: string) => boolean) => {
    return (p) => files.includes(p)
  }
  const uploads = join('/lib', '_uploads')

  it('keeps a recorded path that exists here', () => {
    expect(localUploadPath('/real/a.pdf', uploads, have('/real/a.pdf'))).toBe('/real/a.pdf')
  })

  it('falls back to this library’s _uploads copy, for either separator', () => {
    const local = join(uploads, 'a.pdf')
    expect(localUploadPath('C:\\Users\\sam\\a.pdf', uploads, have(local))).toBe(local)
    expect(localUploadPath('/Users/sam/a.pdf', uploads, have(local))).toBe(local)
  })

  it('leaves the path alone when the file is nowhere, so the error names it', () => {
    expect(localUploadPath('C:\\gone\\a.pdf', uploads, have())).toBe('C:\\gone\\a.pdf')
  })

  it('reads a multi-file value as a list', () => {
    expect(uploadPathsOf('C:\\a.pdf\r\n/b.png\n\n')).toEqual(['C:\\a.pdf', '/b.png'])
  })
})
