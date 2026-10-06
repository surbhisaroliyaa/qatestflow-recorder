import { describe, it, expect, vi } from 'vitest'
import { join, resolve } from 'path'

// evidenceStorage.ts reaches library.ts, which asks Electron where Documents
// is. Nothing under test touches the disk, but the import has to resolve.
vi.mock('electron', () => ({ app: { getPath: () => '/Users/test/Documents' } }))

const { confinedPath } = await import('../src/main/evidenceStorage')
const {
  collectTestRefs,
  emptyRefs,
  EVIDENCE_CATEGORIES,
  formatBytes,
  isEvidenceCategory,
  planDeletion,
  sweptBy,
  tracesBeyondKeep
} = await import('../src/shared/evidenceStorage')
const { cleanRetention } = await import('../src/shared/evidencePrivacy')

// =====================================================================
// EVIDENCE STORAGE — the part that decides what gets DELETED.
//
// Deleting run evidence is the point; deleting a file a saved test needs to
// run is the one thing this must never do. Everything below is either "what
// is still in use" or "what would this rule remove", tested without a disk.
// =====================================================================

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 28)

describe('what a saved test still needs', () => {
  it('its HAR, every file of a multi-file upload, and its version history', () => {
    const refs = emptyRefs()
    collectTestRefs(
      {
        har: 'E2E__login.har',
        steps: [
          { type: 'click' },
          {
            type: 'upload',
            value: 'C:\\Users\\sam\\QATestFlow Tests\\_uploads\\a.pdf\nC:\\x\\_uploads\\b.png'
          }
        ],
        versions: [{ steps: [{ type: 'upload', value: '/lib/_uploads/old.csv' }] }]
      },
      refs
    )
    expect([...refs.hars]).toEqual(['E2E__login.har'])
    expect([...refs.uploads].sort()).toEqual(['a.pdf', 'b.png', 'old.csv'])
  })

  it('a file named in the data table (an upload whose value is a {{token}})', () => {
    const refs = emptyRefs()
    collectTestRefs(
      {
        steps: [{ type: 'upload', value: '{{file}}' }],
        dataRows: [{ file: 'C:\\lib\\_uploads\\row1.pdf' }, { file: 'row2.pdf' }]
      },
      refs
    )
    expect(refs.uploads.has('row1.pdf')).toBe(true)
    expect(refs.uploads.has('row2.pdf')).toBe(true)
  })

  it("the last run's failure screenshot (the library card shows it), not older ones", () => {
    const refs = emptyRefs()
    collectTestRefs(
      {
        lastRun: { status: 'failed', screenshotPath: 'C:\\lib\\_failures\\failure-2.png' },
        runs: [{ status: 'failed', screenshotPath: 'C:\\lib\\_failures\\failure-1.png' }]
      },
      refs
    )
    expect([...refs.failures]).toEqual(['failure-2.png'])
  })

  it('ignores junk instead of throwing — one bad file must not stop the walk', () => {
    const refs = emptyRefs()
    expect(() => collectTestRefs(null, refs)).not.toThrow()
    expect(() =>
      collectTestRefs({ steps: 'nope', versions: [null], dataRows: [null] }, refs)
    ).not.toThrow()
    expect(refs.uploads.size + refs.hars.size).toBe(0)
  })
})

describe('what a delete rule selects', () => {
  const items = [
    { name: 'new.png', bytes: 10, mtimeMs: NOW - 1 * DAY },
    { name: 'old.png', bytes: 20, mtimeMs: NOW - 40 * DAY },
    { name: 'used-old.pdf', bytes: 30, mtimeMs: NOW - 90 * DAY },
    { name: 'used-new.pdf', bytes: 30, mtimeMs: NOW - 2 * DAY }
  ]
  const inUse = new Set(['used-old.pdf', 'used-new.pdf'])

  it('"Delete…" takes everything not in use, and counts what it kept', () => {
    const plan = planDeletion(items, {}, inUse, NOW)
    expect(plan.delete.map((i) => i.name).sort()).toEqual(['new.png', 'old.png'])
    expect(plan.keptInUse).toBe(2)
  })

  it('"older than N days" takes only old, unused items', () => {
    const plan = planDeletion(items, { olderThanDays: 30 }, inUse, NOW)
    expect(plan.delete.map((i) => i.name)).toEqual(['old.png'])
    // Only the in-use item that was OLD enough to be at risk is reported kept.
    expect(plan.keptInUse).toBe(1)
  })

  it('never selects an in-use item, whatever the rule', () => {
    for (const rule of [{}, { olderThanDays: 0 }, { olderThanDays: 1 }, { olderThanDays: 365 }]) {
      const names = planDeletion(items, rule, inUse, NOW).delete.map((i) => i.name)
      expect(names).not.toContain('used-old.pdf')
      expect(names).not.toContain('used-new.pdf')
    }
  })
})

describe('keep the last N run recordings', () => {
  const ids = [
    'trace-1700000000003',
    'trace-1700000000001',
    'trace-1700000000002',
    'trace-1700000000004'
  ]

  it('drops the oldest beyond the cap, by id (not by folder date)', () => {
    expect(tracesBeyondKeep(ids, 2)).toEqual(['trace-1700000000001', 'trace-1700000000002'])
    expect(tracesBeyondKeep(ids, 10)).toEqual([])
  })

  it('an edge run’s trace is kept AND does not use up a slot', () => {
    const out = tracesBeyondKeep(ids, 2, new Set(['trace-1700000000001']))
    expect(out).toEqual(['trace-1700000000002'])
  })
})

describe('retention settings', () => {
  it('an older settings file (no fields) keeps the old behaviour: 40, no age sweep', () => {
    expect(cleanRetention({})).toEqual({ keepTraces: 40, maxAgeDays: 0 })
  })

  it('never lets "keep" reach 0 — that would delete the run just finished', () => {
    expect(cleanRetention({ keepTraces: 0 }).keepTraces).toBe(1)
    expect(cleanRetention({ keepTraces: -5, maxAgeDays: -1 })).toEqual({
      keepTraces: 1,
      maxAgeDays: 0
    })
    expect(cleanRetention({ keepTraces: 'abc' }).keepTraces).toBe(40)
  })
})

describe('deletion is confined to the category folder', () => {
  const dir = resolve('/lib/_uploads')

  it('allows a direct child', () => {
    expect(confinedPath(dir, 'a.pdf')).toBe(join(dir, 'a.pdf'))
  })

  it('refuses anything that walks out, is absolute, or is the folder itself', () => {
    for (const bad of [
      '..',
      '../_baselines',
      '..\\x',
      '/etc/passwd',
      'C:\\Windows',
      '',
      '.',
      'a/b',
      'a\u0000b'
    ]) {
      expect(confinedPath(dir, bad)).toBeNull()
    }
  })

  it('the renderer can only name a known category', () => {
    expect(isEvidenceCategory('traces')).toBe(true)
    expect(isEvidenceCategory('../_baselines')).toBe(false)
    expect(isEvidenceCategory('baselines')).toBe(false)
    // The user's own work is never an evidence category.
    const folders = EVIDENCE_CATEGORIES.map((c) => c.folder)
    for (const off of ['_baselines', '_blocks', '_drafts', '_backups']) {
      expect(folders).not.toContain(off)
    }
    // Saved logins and edge runs ARE listed now — but manual-only.
    expect(isEvidenceCategory('sessions')).toBe(true)
    expect(isEvidenceCategory('edgeRuns')).toBe(true)
  })
})

describe('saved logins and saved edge-case runs', () => {
  const cat = (id: string): (typeof EVIDENCE_CATEGORIES)[number] =>
    EVIDENCE_CATEGORIES.find((c) => c.id === id)!

  it('a login named by a test, draft or backup is in use — by bare file name', () => {
    const refs = emptyRefs()
    collectTestRefs({ storageState: 'saucedemo-auth.json', steps: [] }, refs)
    // A backup/draft that carried a path still resolves to the file name.
    collectTestRefs({ storageState: 'C:\\lib\\_sessions\\admin.json' }, refs)
    collectTestRefs({ storageState: '' }, refs)
    collectTestRefs({ storageState: 42 }, refs)
    expect([...refs.sessions].sort()).toEqual(['admin.json', 'saucedemo-auth.json'])
    // Nothing on disk points at an edge-run record.
    expect(refs.edgeRuns.size).toBe(0)
  })

  it('Delete… on saved logins keeps the one a test uses and counts it', () => {
    const items = [
      { name: 'saucedemo-auth.json', bytes: 900, mtimeMs: NOW - 90 * DAY },
      { name: 'old-admin.json', bytes: 700, mtimeMs: NOW - 90 * DAY },
      { name: 'fresh.json', bytes: 500, mtimeMs: NOW - 1 * DAY }
    ]
    const refs = emptyRefs()
    collectTestRefs({ storageState: 'saucedemo-auth.json' }, refs)
    const plan = planDeletion(items, {}, refs.sessions, NOW)
    expect(plan.delete.map((i) => i.name).sort()).toEqual(['fresh.json', 'old-admin.json'])
    expect(plan.keptInUse).toBe(1)
  })

  it('Delete… on saved edge-case runs takes every record', () => {
    const items = [
      { name: 'edge-1.json', bytes: 10, mtimeMs: NOW },
      { name: 'edge-2.json', bytes: 10, mtimeMs: NOW - 400 * DAY }
    ]
    const plan = planDeletion(items, {}, emptyRefs().edgeRuns, NOW)
    expect(plan.delete).toHaveLength(2)
    expect(plan.keptInUse).toBe(0)
  })

  it('the age rule and the after-run sweep never reach them', () => {
    // 'all' is what both "older than N days" and applyRetention send.
    const swept = sweptBy('all').map((c) => c.id)
    expect(swept).not.toContain('sessions')
    expect(swept).not.toContain('edgeRuns')
    // …while every run-evidence category is still swept.
    for (const id of [
      'traces',
      'failures',
      'hars',
      'uploads',
      'reports',
      'downloads',
      'nlchecks'
    ]) {
      expect(swept).toContain(id)
    }
    // Their own Delete… button still reaches them.
    expect(sweptBy('sessions').map((c) => c.id)).toEqual(['sessions'])
    expect(sweptBy('edgeRuns').map((c) => c.id)).toEqual(['edgeRuns'])
    expect(cat('sessions').manualOnly).toBe(true)
    expect(cat('edgeRuns').manualOnly).toBe(true)
  })

  it('only the file shapes the app writes there are ever listed', () => {
    const s = cat('sessions').only!
    expect(s.test('saucedemo-auth.json')).toBe(true)
    expect(s.test('notes.txt')).toBe(false)
    const e = cat('edgeRuns').only!
    expect(e.test('edge-1727000000000.json')).toBe(true)
    expect(e.test('readme.json')).toBe(false)
    expect(e.test('edge-../x.json')).toBe(false)
  })
})

describe('formatBytes', () => {
  it('reads like a file manager', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB')
  })
})
