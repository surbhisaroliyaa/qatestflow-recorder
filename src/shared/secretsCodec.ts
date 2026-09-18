// =====================================================================
// THE SECRET FILE FORMAT  (audit finding QF-003)
// =====================================================================
// F40 moved captured passwords OUT of the shareable test files and into
// `userData/secrets.json`. That fixed the failure mode that actually bites —
// mailing someone a password, or committing one to git — and the audit gave it
// credit for that.
//
// What it did not do is encrypt the file. The source said so honestly ("this is
// NOT encryption"), but the PRD promises encryption at rest, so any local
// process running as the user, any backup tool, and anyone reading a synced
// Documents folder could still read every stored password in plaintext.
//
// This module is the codec for the file, kept separate from Electron so it can
// be tested without an app: encryption is injected as a pair of functions, and
// the tests drive it with a fake cipher.
//
// ── THE FORMAT ──────────────────────────────────────────────────────────
//   v1 (pre-QF-003)   { "sec_abc": "hunter2" }              ← flat, plaintext
//   v2                { version: 2, encrypted: true,
//                       values: { "sec_abc": "<base64>" } }
//
// v1 is detected by the ABSENCE of a version, and upgraded on first read.
//
// ── WHY THE MIGRATION KEEPS NO BACKUP ───────────────────────────────────
// Everywhere else in this codebase a migration backs the old file up first
// (see migratePlaintextSecrets — whose backups are now written SCRUBBED, for
// this same reason: its first version copied the library verbatim and left a
// plaintext copy of every password in _backups/). Here a backup would be
// actively wrong: a plaintext copy of exactly the secrets we are encrypting,
// sitting next to the encrypted one forever. The
// old file is overwritten in place instead, and the safety comes from only
// writing once the new content has been successfully built.
// =====================================================================

export const SECRETS_VERSION = 2

export type SecretMap = Record<string, string>

export interface SecretFile {
  version: number
  encrypted: boolean
  values: SecretMap
}

/** Encrypt one value to a storable string, or return null if unavailable. */
export type EncryptFn = (plain: string) => string | null
/** Decrypt one stored string, or return null if it cannot be read. */
export type DecryptFn = (stored: string) => string | null

export interface DecodeResult {
  map: SecretMap
  /** The file was the old plaintext shape and should be re-persisted encrypted. */
  needsMigration: boolean
  /** Refs present on disk that could not be decrypted — kept so a caller can
   *  report them rather than silently losing the user's passwords. */
  unreadable: string[]
}

/**
 * Read whatever is on disk into a usable map.
 *
 * Never throws: a corrupt or foreign file yields an empty store rather than
 * taking the app down. A secret you cannot read is a nuisance; an app that
 * won't start is an outage.
 */
export function decodeStore(raw: string, decrypt: DecryptFn): DecodeResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { map: {}, needsMigration: false, unreadable: [] }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { map: {}, needsMigration: false, unreadable: [] }
  }

  const obj = parsed as Record<string, unknown>

  // ── v1: a flat map of ref → plaintext, with no version marker ──────
  if (typeof obj.version !== 'number') {
    const map: SecretMap = {}
    for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') map[k] = v
    // Only worth rewriting if there is actually something in it.
    return { map, needsMigration: Object.keys(map).length > 0, unreadable: [] }
  }

  // ── v2 ────────────────────────────────────────────────────────────
  const values = obj.values && typeof obj.values === 'object' ? obj.values : {}
  const encrypted = obj.encrypted === true
  const map: SecretMap = {}
  const unreadable: string[] = []

  for (const [ref, stored] of Object.entries(values as Record<string, unknown>)) {
    if (typeof stored !== 'string') continue
    if (!encrypted) {
      map[ref] = stored
      continue
    }
    const plain = decrypt(stored)
    if (plain === null) {
      // Wrong machine, wrong user, or a rotated OS key. Report it; do not
      // pretend the secret is an empty string, which would silently log the
      // user in as nobody and look like a broken test.
      unreadable.push(ref)
      continue
    }
    map[ref] = plain
  }

  // A store written WITHOUT encryption should be upgraded as soon as
  // encryption becomes available on this machine.
  return { map, needsMigration: !encrypted && Object.keys(map).length > 0, unreadable }
}

/**
 * Build the file to write.
 *
 * `encrypt` returning null means the platform has no secure store available
 * (a Linux box with no keyring, typically). The values are then written
 * unencrypted and the file SAYS SO, so the app can tell the user the truth
 * rather than a reassuring lie — and so the next start, on a machine where
 * encryption works, upgrades the file.
 */
export function encodeStore(map: SecretMap, encrypt: EncryptFn): SecretFile {
  const values: SecretMap = {}
  let encrypted = true

  for (const [ref, plain] of Object.entries(map)) {
    if (typeof plain !== 'string') continue
    const sealed = encrypt(plain)
    if (sealed === null) {
      encrypted = false
      break
    }
    values[ref] = sealed
  }

  if (!encrypted) {
    return { version: SECRETS_VERSION, encrypted: false, values: { ...map } }
  }
  return { version: SECRETS_VERSION, encrypted: true, values }
}

/**
 * Which stored refs are no longer referenced by anything.
 *
 * The audit asked for secrets to be garbage-collected when the tests and steps
 * that used them are deleted — otherwise deleting a test leaves its password in
 * userData forever, and "I deleted it" turns out not to be true.
 */
export function orphanedRefs(map: SecretMap, liveRefs: Iterable<string>): string[] {
  const live = new Set(liveRefs)
  return Object.keys(map).filter((ref) => !live.has(ref))
}
