import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// =====================================================================
// EVIDENCE STORAGE on a real (temporary) library folder — the saved-login and
// saved-edge-run rows. The pure tests prove the rules; this proves the disk
// half actually follows them: the age sweep leaves a saved login alone, and
// the login a saved test starts from survives its own Delete….
// =====================================================================

const docs = mkdtempSync(join(tmpdir(), 'qatf-evidence-'))
vi.mock('electron', () => ({ app: { getPath: () => docs } }))

const { deleteEvidence, scanEvidence, setOpenWorkspace } =
  await import('../src/main/evidenceStorage')

const lib = join(docs, 'QATestFlow Tests')
const OLD = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)

function put(rel: string, body = '{}', old = true): void {
  const p = join(lib, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
  // Run evidence and saved things are all "400 days old", so only manualOnly
  // can explain which ones survive the age sweep.
  if (old) utimesSync(p, OLD, OLD)
}

beforeEach(() => {
  rmSync(lib, { recursive: true, force: true })
  setOpenWorkspace(null) // module state: no open workspace unless a test sets one
  put('_sessions/used-login.json', '{"cookies":[{"name":"sid","value":"secret"}]}')
  put('_sessions/spare-login.json', '{"cookies":[]}')
  put('_sessions/notes.txt', 'not ours')
  put('_edgeRuns/edge-1700000000000.json', '{"id":"edge-1700000000000","results":[]}')
  put('_reports/old-report.html', '<html></html>')
  put(
    'Login__starts-logged-in.json',
    JSON.stringify({
      version: 1,
      name: 'starts logged in',
      baseURL: 'https://www.saucedemo.com',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      storageState: 'used-login.json',
      steps: []
    }),
    false
  )
})

afterAll(() => rmSync(docs, { recursive: true, force: true }))

describe('saved logins and edge runs on disk', () => {
  it('the age sweep ("all") deletes old evidence but never a saved login or edge run', async () => {
    const r = await deleteEvidence('all', 1)
    expect(existsSync(join(lib, '_reports/old-report.html'))).toBe(false)
    expect(r.deleted).toBe(1)
    expect(existsSync(join(lib, '_sessions/used-login.json'))).toBe(true)
    expect(existsSync(join(lib, '_sessions/spare-login.json'))).toBe(true)
    expect(existsSync(join(lib, '_edgeRuns/edge-1700000000000.json'))).toBe(true)
  })

  it('Delete… on saved logins removes the spare file, keeps the one a test uses', async () => {
    const scan = (await scanEvidence()).find((u) => u.id === 'sessions')!
    expect(scan.count).toBe(2) // notes.txt is not a saved login
    expect(scan.inUse).toBe(1)
    const r = await deleteEvidence('sessions')
    expect(r).toMatchObject({ deleted: 1, keptInUse: 1, failed: 0 })
    expect(existsSync(join(lib, '_sessions/spare-login.json'))).toBe(false)
    expect(existsSync(join(lib, '_sessions/used-login.json'))).toBe(true)
    expect(existsSync(join(lib, '_sessions/notes.txt'))).toBe(true)
  })

  it('the OPEN workspace keeps its login and upload files even before it is saved', async () => {
    put('_uploads/picked.pdf', 'x')
    put('_uploads/stale.pdf', 'x')
    // A recording that isn't saved: the library walk can't see it.
    setOpenWorkspace({
      storageState: 'spare-login.json',
      steps: [{ type: 'upload', value: 'C:\\Users\\me\\Desktop\\picked.pdf' }]
    })
    const logins = await deleteEvidence('sessions')
    expect(logins).toMatchObject({ deleted: 0, keptInUse: 2 })
    expect(existsSync(join(lib, '_sessions/spare-login.json'))).toBe(true)
    // The automatic age sweep goes through the same rule.
    await deleteEvidence('all', 1)
    expect(existsSync(join(lib, '_uploads/picked.pdf'))).toBe(true)
    expect(existsSync(join(lib, '_uploads/stale.pdf'))).toBe(false)
  })
  it('Delete… on saved edge-case runs removes the records and nothing else', async () => {
    const r = await deleteEvidence('edgeRuns')
    expect(r).toMatchObject({ deleted: 1, keptInUse: 0 })
    expect(existsSync(join(lib, '_edgeRuns/edge-1700000000000.json'))).toBe(false)
    expect(existsSync(join(lib, '_edgeRuns'))).toBe(true) // folder itself stays
    expect(existsSync(join(lib, '_sessions/spare-login.json'))).toBe(true)
  })
})
