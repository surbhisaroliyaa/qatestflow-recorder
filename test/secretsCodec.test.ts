import { describe, it, expect } from 'vitest'
import {
  SECRETS_VERSION,
  decodeStore,
  encodeStore,
  orphanedRefs,
  type SecretMap
} from '../src/shared/secretsCodec'

// =====================================================================
// QF-003 — encrypting the secret store.
//
// Two things can go wrong here, and they are not equally bad:
//
//   · a secret is not encrypted   → the finding isn't fixed
//   · a secret is LOST            → the user's password is gone, and no
//                                   amount of security was worth that
//
// So most of what follows is about the second one: migration, unreadable
// values, and the garbage collector's live set.
// =====================================================================

// A reversible stand-in for the OS keychain. Distinctive enough that a test
// can assert a value is genuinely sealed, not merely copied.
const seal = (plain: string): string => `SEALED(${Buffer.from(plain).toString('base64')})`
const unseal = (stored: string): string | null => {
  const m = /^SEALED\((.*)\)$/.exec(stored)
  return m ? Buffer.from(m[1], 'base64').toString('utf-8') : null
}

/** A platform with no secure store — Linux with no keyring. */
const noCipher = (): null => null

describe('writing the store', () => {
  it('encrypts every value', () => {
    const file = encodeStore({ sec_a: 'hunter2', sec_b: 'p@ssw0rd' }, seal)

    expect(file.version).toBe(SECRETS_VERSION)
    expect(file.encrypted).toBe(true)
    // The point of the whole finding: the plaintext must not appear on disk.
    const onDisk = JSON.stringify(file)
    expect(onDisk).not.toContain('hunter2')
    expect(onDisk).not.toContain('p@ssw0rd')
  })

  it('round-trips back to the original values', () => {
    const map: SecretMap = { sec_a: 'hunter2', sec_b: 'a value with "quotes" and \n newlines' }
    const back = decodeStore(JSON.stringify(encodeStore(map, seal)), unseal)
    expect(back.map).toEqual(map)
    expect(back.unreadable).toEqual([])
  })

  it('says so honestly when the platform cannot encrypt', () => {
    // Writing plaintext while claiming encryption would be the worst outcome —
    // the user would believe a guarantee they do not have.
    const file = encodeStore({ sec_a: 'hunter2' }, noCipher)
    expect(file.encrypted).toBe(false)
    expect(file.values.sec_a).toBe('hunter2')
  })

  it('handles an empty store', () => {
    const file = encodeStore({}, seal)
    expect(file.encrypted).toBe(true)
    expect(file.values).toEqual({})
  })
})

describe('reading a pre-QF-003 file', () => {
  const V1 = JSON.stringify({ sec_a: 'hunter2', sec_b: 'p@ssw0rd' })

  it('reads the old flat plaintext format without losing anything', () => {
    // The upgrade path. If this drops a value, every test with a login breaks
    // and the password is unrecoverable.
    const { map, needsMigration } = decodeStore(V1, unseal)
    expect(map).toEqual({ sec_a: 'hunter2', sec_b: 'p@ssw0rd' })
    expect(needsMigration).toBe(true)
  })

  it('migrates into the encrypted format with the same values', () => {
    const { map } = decodeStore(V1, unseal)
    const migrated = decodeStore(JSON.stringify(encodeStore(map, seal)), unseal)
    expect(migrated.map).toEqual({ sec_a: 'hunter2', sec_b: 'p@ssw0rd' })
    expect(migrated.needsMigration).toBe(false)
  })

  it('does not ask to migrate an empty old file', () => {
    expect(decodeStore('{}', unseal).needsMigration).toBe(false)
  })

  it('asks to migrate a v2 file that was written unencrypted', () => {
    // Written on a machine with no keyring; now opened on one that has it.
    const plain = JSON.stringify({ version: 2, encrypted: false, values: { sec_a: 'hunter2' } })
    const { map, needsMigration } = decodeStore(plain, unseal)
    expect(map).toEqual({ sec_a: 'hunter2' })
    expect(needsMigration).toBe(true)
  })
})

describe('reading a store that cannot be decrypted', () => {
  it('reports unreadable refs instead of returning empty passwords', () => {
    // Copied from another machine, or the OS key was rotated. Returning '' here
    // would log the user in as nobody and surface much later as a mystery test
    // failure — the value must be reported missing, not silently blanked.
    const file = JSON.stringify({
      version: 2,
      encrypted: true,
      values: { sec_a: seal('hunter2'), sec_b: 'not-sealed-at-all' }
    })
    const { map, unreadable } = decodeStore(file, unseal)

    expect(map).toEqual({ sec_a: 'hunter2' })
    expect(unreadable).toEqual(['sec_b'])
    expect(map.sec_b).toBeUndefined()
  })

  it('survives a corrupt file rather than taking the app down', () => {
    // A secret you can't read is a nuisance; an app that won't start is an
    // outage.
    for (const bad of ['not json at all', '[]', 'null', '', '"a string"']) {
      const out = decodeStore(bad, unseal)
      expect(out.map, bad).toEqual({})
      expect(out.needsMigration, bad).toBe(false)
    }
  })

  it('ignores non-string values without choking', () => {
    const file = JSON.stringify({
      version: 2,
      encrypted: false,
      values: { sec_a: 'hunter2', sec_b: 42, sec_c: null, sec_d: { nested: true } }
    })
    expect(decodeStore(file, unseal).map).toEqual({ sec_a: 'hunter2' })
  })
})

describe('garbage-collecting orphaned secrets', () => {
  const STORE: SecretMap = { sec_a: 'a', sec_b: 'b', sec_c: 'c' }

  it('finds the refs nothing points at any more', () => {
    expect(orphanedRefs(STORE, ['sec_a'])).toEqual(['sec_b', 'sec_c'])
  })

  it('keeps every ref that is still live', () => {
    expect(orphanedRefs(STORE, ['sec_a', 'sec_b', 'sec_c'])).toEqual([])
  })

  it('collects everything when nothing references anything', () => {
    expect(orphanedRefs(STORE, [])).toEqual(['sec_a', 'sec_b', 'sec_c'])
  })

  it('is not confused by a live ref with no stored value', () => {
    // A test referencing a secret that was never saved — a dangling pointer,
    // not a reason to delete somebody else's password.
    expect(orphanedRefs(STORE, ['sec_a', 'sec_missing'])).toEqual(['sec_b', 'sec_c'])
  })

  it('accepts a Set as the live list', () => {
    expect(orphanedRefs(STORE, new Set(['sec_b']))).toEqual(['sec_a', 'sec_c'])
  })
})
