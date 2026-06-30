// =====================================================================
// DATA-DRIVEN RUNS (Day 20)
// Record a flow ONCE, then run it once per row of a data table — the classic
// "login matrix" / parameterized test. A step's value (or a navigate URL)
// can carry a {{token}}; each token becomes a COLUMN in the data table, and
// every row supplies one set of values.
//
// Two token kinds:
//   {{username}}      → a DATA column, filled from the table per row
//   {{env:LOGIN_PW}}  → read from the environment at run time, so a real
//                       secret never has to sit in the table or the export
//
// This module is the pure ENGINE: it finds the tokens, derives the columns,
// and substitutes a row's values back into the steps. The renderer drives the
// per-row loop (reusing the normal replay); the exporter reuses these helpers
// to emit `data.username` / `process.env.LOGIN_PW` references.
// =====================================================================

// A {{token}} — letters/digits/_-. plus ':' (for env:NAME) and spaces, lazily
// matched so "{{a}} {{b}}" doesn't swallow the gap between two tokens.
export const TOKEN_RE = /\{\{\s*([A-Za-z0-9_:.\- ]+?)\s*\}\}/g

const ENV_PREFIX = 'env:'
const isEnvToken = (name: string): boolean => name.startsWith(ENV_PREFIX)
export const envVarOf = (name: string): string => name.slice(ENV_PREFIX.length).trim()

// Every token name inside a string, trimmed and in order (duplicates kept —
// callers dedupe when they need to).
export function extractTokens(text: string | undefined | null): string[] {
  if (!text) return []
  const out: string[] = []
  for (const m of text.matchAll(TOKEN_RE)) out.push(m[1].trim())
  return out
}

// The fields of a step that can carry tokens: the typed/selected/expected
// value, and a navigate step's URL. (Selectors, labels etc. are never
// tokenized — only the user-supplied data values are.)
function tokenFields(step: RecorderStep): string[] {
  const fields: string[] = []
  if (typeof step.value === 'string') fields.push(step.value)
  if (typeof step.url === 'string') fields.push(step.url)
  return fields
}

// Does this step reference any data column or env token? (Used to show the
// "parameterized" marker and to decide whether plain Replay needs a row.)
export function stepHasTokens(step: RecorderStep): boolean {
  return tokenFields(step).some((f) => extractTokens(f).length > 0)
}

// The DATA columns the table needs = every non-env token used across the
// steps, in first-seen order. Env tokens are NOT columns (they come from the
// environment, not the table).
export function dataColumns(steps: RecorderStep[]): string[] {
  const seen = new Set<string>()
  const cols: string[] = []
  for (const s of steps) {
    for (const f of tokenFields(s)) {
      for (const t of extractTokens(f)) {
        if (isEnvToken(t) || seen.has(t)) continue
        seen.add(t)
        cols.push(t)
      }
    }
  }
  return cols
}

// Every environment variable name referenced — by the steps AND by the data
// rows' cells (a cell may itself be "{{env:REAL_PW}}"). The renderer resolves
// these once (via main) before a run.
export function envVarNames(steps: RecorderStep[], rows: Record<string, string>[]): string[] {
  const names = new Set<string>()
  const collect = (text: string | undefined): void => {
    for (const t of extractTokens(text)) if (isEnvToken(t)) names.add(envVarOf(t))
  }
  for (const s of steps) for (const f of tokenFields(s)) collect(f)
  for (const row of rows) for (const v of Object.values(row)) collect(v)
  return [...names]
}

// Replace every token in a string: {{col}} → the row's cell, {{env:NAME}} →
// the resolved env value. An unknown token resolves to '' (honest — the field
// ends up empty and the step typically fails, which is the right signal).
export function substituteText(
  text: string,
  row: Record<string, string>,
  envMap: Record<string, string>
): string {
  return text.replace(TOKEN_RE, (_m, raw) => {
    const name = String(raw).trim()
    if (isEnvToken(name)) return envMap[envVarOf(name)] ?? ''
    return row[name] ?? ''
  })
}

// A copy of the steps with one row's data substituted into every value/URL.
// Everything else (selectors, frames, windowIds) is untouched, so the
// substituted list replays exactly like a normal recording.
export function substituteSteps(
  steps: RecorderStep[],
  row: Record<string, string>,
  envMap: Record<string, string>
): RecorderStep[] {
  return steps.map((s) => {
    const next: RecorderStep = { ...s }
    if (typeof s.value === 'string') next.value = substituteText(s.value, row, envMap)
    if (typeof s.url === 'string') next.url = substituteText(s.url, row, envMap)
    return next
  })
}

// Resolve a row whose CELLS may contain {{env:…}} tokens into concrete values,
// so the substituted steps see plain strings. (Cells can't reference data
// columns — that would be circular — so only env tokens are resolved here.)
export function resolveRow(
  row: Record<string, string>,
  envMap: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(row)) out[k] = substituteText(v ?? '', {}, envMap)
  return out
}

// Turn a step's human label into a column name for the "make variable" button,
// e.g. "Username" → "username", "First name" → "firstName". Always a valid JS
// identifier (so the export can write `data.firstName`).
export function toColumnName(label: string | undefined): string {
  const words = (label || 'value')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return 'value'
  const camel = words
    .map((w, i) =>
      i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    )
    .join('')
  return /^[A-Za-z_]/.test(camel) ? camel : `v${camel.charAt(0).toUpperCase()}${camel.slice(1)}`
}
