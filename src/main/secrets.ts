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
import { mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'node:crypto'
import { decodeStore, encodeStore, orphanedRefs, type SecretMap } from '../shared/secretsCodec'
import {
  maskPasswordInputs,
  maskStepDescription,
  placeholderRows,
  refsByStepId,
  stripRowSecrets,
  stripStepSecrets,
  type SecretSink,
  type StripOptions
} from '../shared/secretCells'

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
export async function stripSecrets(steps: unknown[], opts: StripOptions = {}): Promise<unknown[]> {
  if (!Array.isArray(steps)) return steps
  const map = await load()
  const { steps: out, changed } = stripStepSecrets(steps, sinkOver(map), opts)
  if (changed) await persist(map)
  return out
}

/** A data table with its sensitive cells moved into the store. */
export async function stripDataRows(
  rows: Record<string, string>[] | undefined
): Promise<Record<string, string>[] | undefined> {
  if (!Array.isArray(rows) || !rows.length) return rows
  const map = await load()
  const { rows: out, changed } = stripRowSecrets(rows, sinkOver(map))
  if (changed) await persist(map)
  return out
}

/** The live store as a SecretSink — the pure logic in secretCells.ts writes
 *  into it, and the caller persists once at the end. */
const sinkOver = (map: SecretMap): SecretSink => ({
  get: (ref) => map[ref],
  put: (ref, value) => {
    map[ref] = value
  },
  newRef: newSecretRef
})

/**
 * Everything in one test-shaped file that can hold a secret: the current
 * steps, every version in its history, and its data rows. One read of the
 * store, one write.
 *
 * History matters as much as the current steps: F12 keeps previous edits for
 * rollback, and snapshots taken before F40 still carried the literal password
 * — so the file on disk held it even though the live steps didn't.
 */
export async function stripTestFile(
  data: Record<string, unknown>,
  opts: StripOptions = {}
): Promise<{ data: Record<string, unknown>; changed: boolean }> {
  const map = await load()
  const sink = sinkOver(map)
  let changed = false
  const next: Record<string, unknown> = { ...data }

  if (Array.isArray(data.steps)) {
    const r = stripStepSecrets(data.steps, sink, opts)
    next.steps = r.steps
    changed ||= r.changed
  }
  if (Array.isArray(data.versions)) {
    next.versions = (data.versions as Record<string, unknown>[]).map((v) => {
      if (!v || !Array.isArray(v.steps)) return v
      // A version's own ids are the same steps as the current ones, so they
      // can share refs — but never refsById from a DIFFERENT file.
      const r = stripStepSecrets(v.steps, sink, { byName: opts.byName })
      changed ||= r.changed
      return r.changed ? { ...v, steps: r.steps } : v
    })
  }
  if (Array.isArray(data.dataRows)) {
    const r = stripRowSecrets(data.dataRows as Record<string, string>[], sink)
    next.dataRows = r.rows
    changed ||= r.changed
  }

  if (changed) await persist(map)
  return { data: changed ? next : data, changed }
}

export { refsByStepId }

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

/** Stamped on a test file once the by-name pass has run over it (and on every
 *  save from this version on). The by-name guess is a one-time repair: running
 *  it again would re-mask a step the user deliberately unmasked. */
export const SECRETS_FILE_VERSION = 2

/**
 * One-time migration of tests saved before F40 / before this sweep.
 *
 * Walks every test file and moves any plaintext secret — marked steps,
 * password steps found by name (once per file), version history, sensitive
 * data cells — into the store, then rewrites the file.
 *
 * The library is backed up first, because this rewrites the user's real test
 * files. The backup is written SCRUBBED: the first version of this migration
 * copied the files verbatim, which left a plaintext copy of every password it
 * was moving in _backups/ — the exact thing it existed to remove. A backup
 * guards the files' STRUCTURE against a bad rewrite; the values are safe in
 * the store by the time it is written, under the refs the backup carries.
 *
 * Idempotent: a second run finds nothing to move.
 */
export async function migratePlaintextSecrets(
  libraryPath: string,
  listFiles: () => Promise<string[]>,
  readTest: (f: string) => Promise<Record<string, unknown> | null>,
  writeTest: (f: string, data: Record<string, unknown>) => Promise<void>
): Promise<{ migrated: number; tests: string[]; backupDir?: string }> {
  const files = await listFiles()
  const touched: string[] = []
  let backupDir: string | null = null
  for (const file of files) {
    const data = await readTest(file)
    if (!data) continue
    const byName = !((data.secretsVersion as number) >= SECRETS_FILE_VERSION)
    const { data: safe, changed } = await stripTestFile(data, { byName })
    if (!changed) continue
    if (!backupDir) {
      // Created on the first file that actually changes, so a library with
      // nothing to migrate leaves no clutter behind.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      backupDir = join(libraryPath, '_backups', `pre-secrets-sweep-${stamp}`)
      await mkdir(backupDir, { recursive: true })
    }
    // `safe`, not `data`: see above. Structure preserved, values by ref.
    await writeFile(
      join(backupDir, file.replace(/[\\/]/g, '__')),
      JSON.stringify(safe, null, 2),
      'utf-8'
    )
    await writeTest(file, { ...safe, secretsVersion: SECRETS_FILE_VERSION })
    touched.push(file)
  }
  return {
    migrated: touched.length,
    tests: touched,
    // Relative to the library, for the notice to name exactly where it went.
    backupDir: backupDir ? `_backups/${backupDir.split(/[\\/]/).pop()}` : undefined
  }
}

/**
 * Scrub the plaintext out of a folder of test-shaped JSON files that already
 * exist on disk: `_backups/` (the decision of 2026-09-18 — keep every backup,
 * remove the passwords), and `_drafts/` / `_blocks/`, which were written
 * without any stripping until today.
 *
 * Each test-shaped file gets the same treatment as a live test. Values move
 * into the store under refs the file now carries, so restoring a backup still
 * gets its password back — and allSecretRefs() counts refs in all three
 * folders, so the orphan sweep never deletes one out from under it. Anything
 * that isn't a test-shaped JSON file is left exactly as it is.
 *
 * `byName` for backups only: they are frozen copies nobody edits, so the
 * one-time guess can't undo a deliberate unmask there.
 */
export async function scrubFolder(root: string, byName: boolean): Promise<number> {
  if (!existsSync(root)) return 0
  let scrubbed = 0
  for (const file of await jsonFilesUnder(root)) {
    let data: Record<string, unknown>
    try {
      data = JSON.parse(await readFile(file, 'utf-8'))
    } catch {
      continue // not JSON — not ours to rewrite
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    if (!Array.isArray(data.steps) && !Array.isArray(data.dataRows)) continue
    const { data: safe, changed } = await stripTestFile(data, { byName })
    if (!changed) continue
    await writeFile(file, JSON.stringify(safe, null, 2), 'utf-8')
    scrubbed++
  }
  return scrubbed
}

/**
 * Edge-case batches already on disk (`_edgeRuns/`). Each variant carries the
 * full step list it ran, so the login's password sat in every one of them.
 * Only steps flagged secret are moved — a hostile value an edge variant typed
 * into the password field is the EVIDENCE, and is left exactly as it is.
 */
export async function scrubEdgeRuns(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0
  let scrubbed = 0
  for (const file of await jsonFilesUnder(dir)) {
    let rec: { results?: { steps?: unknown[] }[] }
    try {
      rec = JSON.parse(await readFile(file, 'utf-8'))
    } catch {
      continue
    }
    if (!Array.isArray(rec?.results)) continue
    let changed = false
    const map = await load()
    const results = rec.results.map((r) => {
      if (!r || !Array.isArray(r.steps)) return r
      const out = stripStepSecrets(r.steps, sinkOver(map))
      changed ||= out.changed
      return out.changed ? { ...r, steps: out.steps } : r
    })
    if (!changed) continue
    await persist(map)
    await writeFile(file, JSON.stringify({ ...rec, results }, null, 2), 'utf-8')
    scrubbed++
  }
  return scrubbed
}

/**
 * Run traces already on disk (`_traces/<id>/`):
 *   · step-N.html — page snapshots with the typed password in the password
 *     field's value attribute (maskPasswordInputs)
 *   · trace.json  — step descriptions like `Type "secret_sauce" into Password`
 *     (maskStepDescription)
 * `revealTraceIds` are edge-case VARIANT recordings: the value typed into their
 * password field is a hostile test input the report must keep showing.
 */
export async function scrubTraces(dir: string, revealTraceIds: Set<string>): Promise<number> {
  if (!existsSync(dir)) return 0
  let scrubbed = 0
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const traceRoot = join(dir, e.name)
    for (const f of await readdir(traceRoot)) {
      const p = join(traceRoot, f)
      let before: string
      try {
        before = await readFile(p, 'utf-8')
      } catch {
        continue
      }
      let after = before
      if (f.endsWith('.html')) after = maskPasswordInputs(before)
      else if (f === 'trace.json' && !revealTraceIds.has(e.name)) {
        try {
          after = JSON.stringify(maskStrings(JSON.parse(before)), null, 2)
        } catch {
          continue // not JSON — leave it
        }
      }
      if (after !== before) {
        await writeFile(p, after, 'utf-8')
        scrubbed++
      }
    }
  }
  return scrubbed
}

/**
 * F8 green baselines already on disk (`_baselines/<test>.json`). Each step's
 * page snapshot lists notable elements with their attributes — including a
 * password field's `value`, which React-style sites mirror from what was
 * typed. Drop that one attribute; the rest of the baseline is untouched.
 * (The `.png` files beside them are visual baselines — pixels, where a
 * password field already shows dots.)
 */
export async function scrubBaselines(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0
  let scrubbed = 0
  for (const file of await jsonFilesUnder(dir)) {
    let b: { steps?: Record<string, { elements?: Record<string, string>[] }> }
    try {
      b = JSON.parse(await readFile(file, 'utf-8'))
    } catch {
      continue
    }
    let changed = false
    for (const snap of Object.values(b?.steps ?? {})) {
      for (const el of snap?.elements ?? []) {
        if (el && String(el.type).toLowerCase() === 'password' && 'value' in el) {
          delete el.value
          changed = true
        }
      }
    }
    if (!changed) continue
    await writeFile(file, JSON.stringify(b), 'utf-8')
    scrubbed++
  }
  return scrubbed
}

/** Every string anywhere in a JSON value, passed through maskStepDescription.
 *  Returns the SAME object when nothing changed, so an unchanged trace.json is
 *  never rewritten (and never reformatted). */
function maskStrings(v: unknown): unknown {
  if (typeof v === 'string') return maskStepDescription(v)
  if (Array.isArray(v)) {
    const out = v.map(maskStrings)
    return out.some((x, i) => x !== v[i]) ? out : v
  }
  if (v && typeof v === 'object') {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      out[k] = maskStrings(x)
      if (out[k] !== x) changed = true
    }
    return changed ? out : v
  }
  return v
}

async function jsonFilesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await jsonFilesUnder(p)))
    else if (e.isFile() && e.name.endsWith('.json')) out.push(p)
  }
  return out
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
 * live. So the rows travel and the sensitive cells are placeholdered, matched
 * by column name — the same convention CI systems use.
 *
 * One `{{env:…}}` name per DISTINCT value, and empty cells left empty. The old
 * version wrote one `{{env:PASSWORD}}` into every row, which silently collapsed
 * a negative-login matrix: the "wrong password" row got the right one. The
 * naming rule lives in secretCells.ts, shared with the spec exporter, so a
 * bundle and an export always ask for the same variables.
 */
export function scrubDataRows(rows: Record<string, string>[] | undefined): {
  rows: Record<string, string>[]
  scrubbed: string[]
} {
  return placeholderRows(rows)
}
