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
// == Encrypted at rest (QF-003) ==
//
// F40 originally stored these values as plain JSON, and said so. That stopped
// you MAILING a password — the failure mode that actually bites — but it left
// the PRD's encrypt-at-rest requirement unmet: any process running as you, any
// backup tool, and any synced Documents folder could read the lot.
//
// The values are now sealed with Electron's `safeStorage`, which is the OS
// keychain underneath (DPAPI on Windows, Keychain on macOS, libsecret on
// Linux). A file copied off the machine is useless on another one.
//
// The file format and the migration live in src/shared/secretsCodec.ts, away
// from Electron, so they can be tested with a fake cipher.
//
// WHAT THIS STILL ISN'T: protection from code running AS YOU on YOUR unlocked
// machine — safeStorage will happily decrypt for it, because it decrypts for
// us. It raises "readable by anything that can open a file" to "readable only
// on this machine, by this user account".
// =====================================================================

import { app, safeStorage } from 'electron'
import { mkdir, readFile, writeFile, copyFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'node:crypto'
import {
  decodeStore,
  encodeStore,
  orphanedRefs,
  type SecretMap
} from '../shared/secretsCodec'

function secretsPath(): string {
  return join(app.getPath('userData'), 'secrets.json')
}

/** Is the OS secure store usable right now? False on a Linux box with no
 *  keyring, and during very early startup before the app is ready. */
function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

const encrypt = (plain: string): string | null => {
  if (!encryptionAvailable()) return null
  try {
    return safeStorage.encryptString(plain).toString('base64')
  } catch {
    return null
  }
}

const decrypt = (stored: string): string | null => {
  if (!encryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    // Written on another machine, under another user, or after an OS key
    // rotation. Not recoverable — and not a crash.
    return null
  }
}

let cache: SecretMap | null = null
/** Refs on disk we could not decrypt, so a caller can say so out loud rather
 *  than letting a test fail later with an empty password. */
let unreadableRefs: string[] = []
/** Did the last write end up unencrypted because the platform had no secure
 *  store? Surfaced to the user rather than hidden. */
let storedInPlaintext = false

async function load(): Promise<SecretMap> {
  if (cache) return cache
  let raw = ''
  try {
    raw = await readFile(secretsPath(), 'utf-8')
  } catch {
    cache = {}
    return cache
  }

  const { map, needsMigration, unreadable } = decodeStore(raw, decrypt)
  cache = map
  unreadableRefs = unreadable

  // Upgrade a pre-QF-003 plaintext file the first time it is read — but only
  // if we can actually encrypt, or we would rewrite plaintext as plaintext and
  // call it a migration.
  if (needsMigration && encryptionAvailable()) {
    await persist(map)
  }
  return cache
}

async function persist(map: SecretMap): Promise<void> {
  cache = map
  const file = encodeStore(map, encrypt)
  storedInPlaintext = !file.encrypted
  await mkdir(app.getPath('userData'), { recursive: true })
  // Overwrites the old plaintext file in place. Deliberately no backup copy —
  // see the note in secretsCodec.ts: a backup here would be a plaintext copy of
  // the very thing being encrypted.
  await writeFile(secretsPath(), JSON.stringify(file, null, 2), 'utf-8')
}

/** How the secret store is actually behaving, for the UI to report honestly. */
export async function secretStoreStatus(): Promise<{
  encrypted: boolean
  unreadable: string[]
  count: number
}> {
  const map = await load()
  return {
    encrypted: encryptionAvailable() && !storedInPlaintext,
    unreadable: [...unreadableRefs],
    count: Object.keys(map).length
  }
}

/**
 * Delete stored secrets nothing refers to any more (QF-003).
 *
 * Without this, deleting a test leaves its password in userData forever — so
 * "I deleted that test" was not true of the part that mattered most. `liveRefs`
 * is every secretRef still reachable from a saved test, block or draft; the
 * caller gathers it, because only main knows where those live.
 *
 * Returns how many were removed.
 */
export async function collectOrphanedSecrets(liveRefs: Iterable<string>): Promise<number> {
  const map = await load()
  const orphans = orphanedRefs(map, liveRefs)
  if (!orphans.length) return 0
  const next = { ...map }
  for (const ref of orphans) delete next[ref]
  await persist(next)
  return orphans.length
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
