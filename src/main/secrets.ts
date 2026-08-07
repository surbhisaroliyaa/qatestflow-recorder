// =====================================================================
// F40 — SECRET STORE
//
// == The problem this fixes ==
//
// A password field is marked `secret: true`, which masks it on screen and makes
// the export emit `process.env.PASSWORD` instead of the literal. Both good. But
// the VALUE was still written into the test's JSON, in plaintext, in a folder
// whose whole design goal is to be shared and committed:
//
//   Documents/QATestFlow Tests/E2E/login.json → "value": "SuperSecretPassword!"
//
// So `secret: true` protected every surface except the one that persists. F40
// makes that folder shareable, which turns a latent problem into a live one.
//
// == The fix ==
//
// The value moves to `secrets.json` in userData — the same home environments.json
// already uses, and for the same reason (F25 put credentials there deliberately).
// The step keeps a `secretRef`, a random opaque id, and no value.
//
//   test file:    { type:'type', secret:true, secretRef:'sec_k3f9…' }
//   userData:     { "sec_k3f9…": "SuperSecretPassword!" }
//
// == Why a ref on the step, and not the step's index ==
//
// Steps are copied constantly: blocks are flattened into the tests that link
// them, data-driven runs substitute a COPY per row, F20 generates hostile
// variants, clone duplicates everything. An index-keyed store would break on
// every one of those. A ref travelling ON the step survives all of them, because
// copying the step copies the ref.
//
// == What this is and isn't ==
//
// This is NOT encryption — it's the same trust model as environments.json: a
// file readable by the logged-in user, kept out of the artefact you share. It
// stops you MAILING a password, which is the actual failure mode. Anyone with
// your unlocked machine could already read the browser's saved passwords.
// =====================================================================

import { app } from 'electron'
import { mkdir, readFile, writeFile, copyFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'node:crypto'

type SecretMap = Record<string, string>

function secretsPath(): string {
  return join(app.getPath('userData'), 'secrets.json')
}

let cache: SecretMap | null = null

async function load(): Promise<SecretMap> {
  if (cache) return cache
  try {
    cache = JSON.parse(await readFile(secretsPath(), 'utf-8')) as SecretMap
  } catch {
    cache = {}
  }
  return cache
}

async function persist(map: SecretMap): Promise<void> {
  cache = map
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(secretsPath(), JSON.stringify(map, null, 2), 'utf-8')
}

export function newSecretRef(): string {
  return `sec_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

export async function getSecret(ref: string | undefined): Promise<string | undefined> {
  if (!ref) return undefined
  return (await load())[ref]
}

export async function setSecret(ref: string, value: string): Promise<void> {
  const map = await load()
  map[ref] = value
  await persist(map)
}

/** Resolve several refs at once — the monitor path needs PASSWORD for its run. */
export async function getSecrets(refs: string[]): Promise<Record<string, string>> {
  const map = await load()
  const out: Record<string, string> = {}
  for (const r of refs) if (map[r] !== undefined) out[r] = map[r]
  return out
}

/**
 * The choke point every save goes through.
 *
 * Takes the steps about to be written to disk and returns a copy in which no
 * secret step carries a literal value. Any plaintext found is moved into the
 * store under the step's existing ref, or a fresh one.
 *
 * A step whose value is a TOKEN (`{{env:PASSWORD}}`, `{{saved:x}}`) is left
 * exactly as-is — that's already a reference, not a secret, and rewriting it
 * would break the F25 environment machinery that deliberately puts the value in
 * an environment.
 */
export async function stripSecrets(steps: unknown[]): Promise<unknown[]> {
  if (!Array.isArray(steps)) return steps
  const map = await load()
  let changed = false
  const out = steps.map((raw) => {
    const s = raw as Record<string, unknown>
    if (!s || s.secret !== true) return raw
    const value = typeof s.value === 'string' ? s.value : ''
    // Already a token, or already empty → nothing to protect.
    if (!value || value.includes('{{')) return raw
    const ref = typeof s.secretRef === 'string' && s.secretRef ? s.secretRef : newSecretRef()
    map[ref] = value
    changed = true
    return { ...s, secretRef: ref, value: '' }
  })
  if (changed) await persist(map)
  return out
}

/** Put the real values back — used by replay, on a COPY, in main only. */
export async function resolveSecrets(steps: unknown[]): Promise<unknown[]> {
  if (!Array.isArray(steps)) return steps
  const map = await load()
  return steps.map((raw) => {
    const s = raw as Record<string, unknown>
    if (!s || typeof s.secretRef !== 'string') return raw
    const value = map[s.secretRef as string]
    if (value === undefined) return raw
    return { ...s, value }
  })
}

/**
 * One-time migration of tests saved before F40.
 *
 * Walks every test file, moves any plaintext secret into the store, and rewrites
 * the file. The whole library is BACKED UP first: this rewrites the user's real
 * test files, and a migration that eats them would be unforgivable — a backup
 * costs a few hundred KB.
 *
 * Idempotent: a second run finds nothing to move.
 */
export async function migratePlaintextSecrets(
  libraryPath: string,
  listFiles: () => Promise<string[]>,
  readTest: (f: string) => Promise<Record<string, unknown> | null>,
  writeTest: (f: string, data: Record<string, unknown>) => Promise<void>
): Promise<{ migrated: number; tests: string[] }> {
  const files = await listFiles()
  const touched: string[] = []
  let migrated = 0
  let backedUp = false
  for (const file of files) {
    const data = await readTest(file)
    if (!data || !Array.isArray(data.steps)) continue
    const hasPlaintext = (data.steps as Record<string, unknown>[]).some(
      (s) => s && s.secret === true && typeof s.value === 'string' && s.value && !s.value.includes('{{')
    )
    if (!hasPlaintext) continue
    if (!backedUp) {
      // Back up ONCE, on the first file that actually needs changing — so a
      // library with nothing to migrate leaves no clutter behind.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backupDir = join(libraryPath, '_backups', `pre-f40-${stamp}`)
      await mkdir(backupDir, { recursive: true })
      for (const f of files) {
        const src = join(libraryPath, f)
        if (!existsSync(src)) continue
        const dst = join(backupDir, f.replace(/[\\/]/g, '__'))
        await copyFile(src, dst).catch(() => {})
      }
      backedUp = true
    }
    const steps = await stripSecrets(data.steps)
    await writeTest(file, { ...data, steps })
    touched.push(file)
    migrated++
  }
  return { migrated, tests: touched }
}

/**
 * F40 bundle export: replace every secret with a portable placeholder.
 *
 * The bundle must be safe to commit and to email, so it carries NO value and NO
 * ref (a ref would be a dangling pointer into someone else's userData). The
 * recipient gets `{{env:PASSWORD}}`, which the F25 environment machinery already
 * knows how to fill — so the test is one setup step from running, and that step
 * is one they should be doing anyway.
 */
export function placeholderSecrets(steps: unknown[]): unknown[] {
  if (!Array.isArray(steps)) return steps
  return steps.map((raw) => {
    const s = raw as Record<string, unknown>
    if (!s || s.secret !== true) return raw
    const rest = { ...s }
    delete rest.secretRef
    return { ...rest, value: '{{env:PASSWORD}}' }
  })
}

/**
 * F40 bundle export: scrub sensitive columns out of a data table.
 *
 * A data-driven test is useless without its rows (it would run zero times and
 * verify nothing), but rows are exactly where real test-account credentials
 * live. So the rows travel and the sensitive COLUMNS are placeholdered, matched
 * by name — the same convention CI systems use.
 */
// `api[-_ ]?key` rather than the two literal spellings it used to list: it
// covered `apikey` and `api_key` and missed `api-key`, which is the commonest of
// the three — so a column named that carried a live key into a bundle meant for
// git. The space is there because a data column's name comes from a {{token}},
// and the token syntax permits spaces ("api key").
//
// MIRROR: apiStep.ts's SECRET_KEY already got this right (`api[-_]?key`). Two
// "is this name a credential?" patterns in one codebase, and the weaker one was
// guarding the artefact that gets COMMITTED.
const SENSITIVE_COLUMN = /pass|pwd|secret|token|api[-_ ]?key|card|cvv|ssn|auth/i

export function scrubDataRows(
  rows: Record<string, string>[] | undefined
): { rows: Record<string, string>[]; scrubbed: string[] } {
  if (!Array.isArray(rows) || !rows.length) return { rows: rows ?? [], scrubbed: [] }
  const columns = Object.keys(rows[0] ?? {})
  const sensitive = columns.filter((c) => SENSITIVE_COLUMN.test(c))
  if (!sensitive.length) return { rows, scrubbed: [] }
  return {
    rows: rows.map((row) => {
      const copy = { ...row }
      for (const c of sensitive) copy[c] = `{{env:${c.toUpperCase().replace(/[^A-Z0-9]/g, '_')}}}`
      return copy
    }),
    scrubbed: sensitive
  }
}
