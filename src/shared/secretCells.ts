// =====================================================================
// NO PLAINTEXT PASSWORD ON DISK — the parts F40/QF-003 missed
// =====================================================================
// F40 moved a recorded password out of the test file into the secret store,
// and QF-003 encrypted that store. A sweep of a real library on 2026-09-18
// still found `secret_sauce` in plaintext in five places, because the
// choke point only ever looked at ONE of them — a saved test's CURRENT steps,
// and only steps already marked `secret: true`:
//
//   1. password steps never marked secret (hand-built tests, and anything a
//      recording didn't flag) — found here BY NAME, once, at migration
//   2. data-table cells in a sensitive column (`password`, `api-key`, …)
//   3. version HISTORY — snapshots taken before F40 kept their literal
//   4. `_backups/` — including the backup the F40 migration itself made
//   5. auto-saved drafts and blocks, which never went through the choke point
//
// This module is the pure part of the fix: which values count as secret, how
// a secret data cell is written, and how the export names them. No Electron,
// no disk — the store is passed in as a `SecretSink`, so it is testable with
// a plain object. src/main/secrets.ts wires it to the real encrypted store.
// =====================================================================

/** A column whose name says it holds a credential. The same convention CI
 *  systems use for masking.
 *
 *  `api[-_ ]?key` rather than two literal spellings: it used to miss `api-key`,
 *  the commonest of the three. The space is there because a column name comes
 *  from a {{token}}, and the token syntax permits spaces ("api key"). */
export const SENSITIVE_COLUMN = /pass|pwd|secret|token|api[-_ ]?key|card|cvv|ssn|auth/i

export const isSensitiveColumn = (column: string): boolean => SENSITIVE_COLUMN.test(column)

// ── secret data cells ─────────────────────────────────────────────────
// A sensitive cell is stored as `{{secret:sec_…}}` — the same {{token}} shape
// as `{{env:NAME}}`, so the data-driven engine resolves it through the road it
// already has for env values, and a cell stays one string.

const SECRET_CELL_RE = /^\{\{\s*secret:(sec_[A-Za-z0-9]+)\s*\}\}$/

/** The ref inside a secret cell, or null if the cell is anything else. */
export function secretCellRef(cell: unknown): string | null {
  if (typeof cell !== 'string') return null
  const m = SECRET_CELL_RE.exec(cell)
  return m ? m[1] : null
}

export const secretCell = (ref: string): string => `{{secret:${ref}}}`

/** Is this a value worth protecting? Empty is not a secret — and a data row
 *  that tests "Password is required" depends on its cell STAYING empty. A
 *  {{token}} is already a reference, not a value. */
const isPlainValue = (v: unknown): v is string =>
  typeof v === 'string' && v !== '' && !v.includes('{{')

// ── password steps found by name ──────────────────────────────────────
// A recording marks a `type="password"` field secret. A hand-built step, or
// one recorded into a field that isn't typed as a password, carries no such
// mark — and an old test file can't say what type its field was. The name is
// the only evidence left, so it is used ONCE, by the migration: doing it on
// every save would undo a user who deliberately unmasked a step.
const PASSWORD_NAME = /password|passwd|pwd/i

export function looksLikePasswordStep(step: unknown): boolean {
  const s = step as Record<string, unknown> | null
  if (!s || s.type !== 'type' || s.secret === true) return false
  // An F20 edge variant typing a hostile value into a password field: shown
  // on purpose, and not a credential.
  if (s.revealValue === true) return false
  if (!isPlainValue(s.value)) return false
  return [s.label, s.selector].some((f) => typeof f === 'string' && PASSWORD_NAME.test(f))
}

/** Should this step's value be shown as dots wherever it is DESCRIBED — the
 *  step list, a trace, a failure record, a report, a code comment? A data-
 *  driven run substitutes the row's password into a COPY of the step, and that
 *  copy is what gets described; it isn't marked secret, but its name says what
 *  it is. Every description of a step goes through stepText(), so this is the
 *  one place that has to know. */
export function isSecretForDisplay(step: unknown): boolean {
  const s = step as Record<string, unknown> | null
  return !!s && (s.secret === true || looksLikePasswordStep(s))
}

// ── run traces ────────────────────────────────────────────────────────

/**
 * Blank the typed value of every password field in a page snapshot.
 *
 * A trace saves `document.documentElement.outerHTML` after each step. Sites
 * that mirror a field's value into its `value` ATTRIBUTE (React does, for
 * controlled inputs) therefore put the typed password in the snapshot:
 * `<input type="password" value="secret_sauce">`, in _traces/ and in any report
 * built from it. Only the attribute is blanked; the page is otherwise intact.
 */
export function maskPasswordInputs(html: string): string {
  return html.replace(/<input\b[^>]*>/gi, (tag) =>
    /\btype\s*=\s*["']?password\b/i.test(tag)
      ? tag.replace(/(\bvalue\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/i, '$1""')
      : tag
  )
}

/** A step description that already went to disk with a password in it —
 *  `Type "secret_sauce" into Password` — with the value replaced by dots. */
export function maskStepDescription(text: string): string {
  return text.replace(/^Type "(.*)" into (.*)$/s, (whole, value: string, target: string) =>
    value && value !== '••••••••' && PASSWORD_NAME.test(target)
      ? `Type "••••••••" into ${target}`
      : whole
  )
}

// ── the store, abstracted ─────────────────────────────────────────────

export interface SecretSink {
  /** The stored value for a ref, or undefined. */
  get(ref: string): string | undefined
  put(ref: string, value: string): void
  newRef(): string
}

export interface StripOptions {
  /** Also protect unmarked password steps, by name. Migration only. */
  byName?: boolean
  /** Refs from the last write of this same file, by step id. An auto-saved
   *  draft is re-written every few seconds from a renderer that never learns
   *  the ref — without this, every autosave minted a new entry. */
  refsById?: Map<unknown, string>
}

/** Steps with every secret value moved into the sink. Pure apart from `sink`. */
export function stripStepSecrets(
  steps: unknown[],
  sink: SecretSink,
  opts: StripOptions = {}
): { steps: unknown[]; changed: boolean } {
  if (!Array.isArray(steps)) return { steps, changed: false }
  let changed = false
  const out = steps.map((raw) => {
    const s = raw as Record<string, unknown> | null
    if (!s) return raw
    const flagged = s.secret === true || (opts.byName === true && looksLikePasswordStep(s))
    if (!flagged || !isPlainValue(s.value)) return raw
    const ref =
      (typeof s.secretRef === 'string' && s.secretRef) ||
      (s.id !== undefined ? opts.refsById?.get(s.id) : undefined) ||
      sink.newRef()
    sink.put(ref, s.value)
    changed = true
    return { ...s, secret: true, secretRef: ref, value: '' }
  })
  return { steps: out, changed }
}

/** Refs a file's steps hold, keyed by step id — the input to `refsById`. */
export function refsByStepId(steps: unknown): Map<unknown, string> {
  const map = new Map<unknown, string>()
  if (!Array.isArray(steps)) return map
  for (const raw of steps) {
    const s = raw as Record<string, unknown> | null
    if (s && s.id !== undefined && typeof s.secretRef === 'string' && s.secretRef) {
      map.set(s.id, s.secretRef)
    }
  }
  return map
}

/**
 * Data rows with every sensitive, non-empty cell moved into the sink.
 *
 * Within one column, the SAME value shares ONE ref. That is what lets the
 * export number distinct values (PASSWORD_1, PASSWORD_2) from refs alone,
 * without ever holding the plaintext — and it keeps an edit from minting a new
 * entry for a value that is already stored.
 */
export function stripRowSecrets(
  rows: Record<string, string>[] | undefined,
  sink: SecretSink
): { rows: Record<string, string>[] | undefined; changed: boolean } {
  if (!Array.isArray(rows) || !rows.length) return { rows, changed: false }
  const columns = columnsOf(rows).filter(isSensitiveColumn)
  if (!columns.length) return { rows, changed: false }
  let changed = false
  const out = rows.map((r) => ({ ...r }))
  for (const col of columns) {
    // value → ref, seeded from the cells already protected in this column.
    const known = new Map<string, string>()
    for (const r of out) {
      const ref = secretCellRef(r[col])
      const v = ref ? sink.get(ref) : undefined
      if (ref && v !== undefined && !known.has(v)) known.set(v, ref)
    }
    for (const r of out) {
      const v = r[col]
      if (!isPlainValue(v)) continue
      let ref = known.get(v)
      if (!ref) {
        ref = sink.newRef()
        sink.put(ref, v)
        known.set(v, ref)
      }
      r[col] = secretCell(ref)
      changed = true
    }
  }
  return { rows: out, changed }
}

/** Every column across all rows, in first-seen order. */
function columnsOf(rows: Record<string, string>[]): string[] {
  const seen = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r ?? {})) seen.add(k)
  return [...seen]
}

// ── how the export names them ─────────────────────────────────────────

/** `api-key` → `API_KEY`: a legal environment variable name. */
export const envBaseName = (column: string): string =>
  column.toUpperCase().replace(/[^A-Z0-9]/g, '_')

export interface SecretEnvPlan {
  /** Per row, per sensitive column: the env var that row's cell reads. */
  cells: Record<string, string>[]
  /** env var name → what fills it: a stored ref, or (for a row not yet
   *  saved) the plaintext value itself. */
  sources: Record<string, { ref?: string; value?: string }>
}

/**
 * Name the environment variables an EXPORTED spec reads for sensitive cells.
 *
 * One name per DISTINCT value, not one for the whole column: a negative-login
 * matrix deliberately has a different password per row ("secret_sauce",
 * "wrong_pass", ""), and a single process.env.PASSWORD would give every row the
 * same one — so the "wrong password" row would log in, and the test would stop
 * testing what it was written to test. A column with only one distinct value
 * keeps the plain name (PASSWORD); empty cells stay empty.
 */
export function planSecretEnv(rows: Record<string, string>[] | undefined): SecretEnvPlan {
  const plan: SecretEnvPlan = { cells: [], sources: {} }
  if (!Array.isArray(rows) || !rows.length) return plan
  plan.cells = rows.map(() => ({}))
  for (const col of columnsOf(rows).filter(isSensitiveColumn)) {
    // Distinct values in first-seen order. Identity is the ref for a stored
    // cell and the text for a plaintext one.
    const keys: string[] = []
    const sourceOf = new Map<string, { ref?: string; value?: string }>()
    const keyOfRow: (string | null)[] = rows.map((r) => {
      const cell = r?.[col]
      const ref = secretCellRef(cell)
      if (ref) {
        const k = `ref:${ref}`
        if (!sourceOf.has(k)) sourceOf.set(k, { ref })
        return k
      }
      if (!isPlainValue(cell)) return null // empty or an {{env:…}} token — left alone
      const k = `val:${cell}`
      if (!sourceOf.has(k)) sourceOf.set(k, { value: cell })
      return k
    })
    for (const k of keyOfRow) if (k && !keys.includes(k)) keys.push(k)
    const base = envBaseName(col)
    const nameOf = new Map(keys.map((k, i) => [k, keys.length === 1 ? base : `${base}_${i + 1}`]))
    keyOfRow.forEach((k, i) => {
      if (!k) return
      const name = nameOf.get(k)!
      plan.cells[i][col] = name
      plan.sources[name] = sourceOf.get(k)!
    })
  }
  return plan
}

/**
 * The environment an EXPORTED spec needs for its sensitive cells, for a run
 * the app launches itself (cross-browser, parallel suite, monitor). `resolved`
 * is what env:get returned — protected cells arrive under `secret:<ref>`.
 * A plaintext cell (edited, not yet saved) supplies its own value.
 */
export function secretCellEnv(
  rows: Record<string, string>[] | undefined,
  resolved: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, src] of Object.entries(planSecretEnv(rows).sources)) {
    const v = src.ref !== undefined ? resolved[`secret:${src.ref}`] : src.value
    if (v !== undefined) out[name] = v
  }
  return out
}

/** An env map without the `secret:<ref>` entries — those are lookup keys for
 *  the in-app run, not variable names to hand a child process. */
export function withoutSecretKeys(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('secret:')) out[k] = v
  return out
}

/** The rows with each planned cell replaced by `{{env:NAME}}` — what a bundle
 *  (a file meant for git) carries. */
export function placeholderRows(rows: Record<string, string>[] | undefined): {
  rows: Record<string, string>[]
  scrubbed: string[]
} {
  if (!Array.isArray(rows) || !rows.length) return { rows: rows ?? [], scrubbed: [] }
  const plan = planSecretEnv(rows)
  const scrubbed = new Set<string>()
  const out = rows.map((r, i) => {
    const copy = { ...r }
    for (const [col, name] of Object.entries(plan.cells[i] ?? {})) {
      copy[col] = `{{env:${name}}}`
      scrubbed.add(col)
    }
    return copy
  })
  return { rows: out, scrubbed: [...scrubbed] }
}
