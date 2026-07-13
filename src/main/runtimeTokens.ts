// =====================================================================
// RUNTIME TOKENS (F24.1 — re-runnable API tests)
//
// The problem this solves: an API test that touches a REAL system can only be
// written once and then never runs cleanly again.
//
//   POST /users {"email":"qa@x.com"}   run 1 ✅   run 2 ❌ 409 (email taken)
//   DELETE /orders/123                 run 1 ✅   run 2 ❌ 404 (already gone)
//
// A test that passes exactly once is worse than no test — it goes red forever
// and looks like a product bug. Two token kinds fix it:
//
//   {{uuid}} {{timestamp}} {{randomInt}}   DYNAMIC — a fresh value each RUN, so
//                                          every run creates its own data and
//                                          nothing ever collides.
//   {{saved:orderId}}                      SAVED   — a value lifted OUT of an
//                                          earlier API response, so a test can
//                                          create → verify → delete the very
//                                          record it made (you can't type the id
//                                          in advance; the server invents it).
//
// Both resolve at RUN TIME, per step, in main — unlike {{env:X}} and data-table
// {{column}} tokens, which the renderer substitutes before the run. They HAVE to
// be late: a saved id doesn't exist until the step that creates it has run.
//
// Dynamic values are memoised per run: {{uuid}} used in two steps is the SAME
// uuid, so a POST body and a later assertion agree. A fresh run gets a fresh one.
// =====================================================================

import type { ReplayStep } from './replay'

// MIRROR: the same token syntax the renderer's dataDriven.ts uses.
const TOKEN_RE = /\{\{\s*([A-Za-z0-9_:.\- ]+?)\s*\}\}/g

const SAVED_PREFIX = 'saved:'

// The dynamic generators, by token name.
const DYNAMIC: Record<string, () => string> = {
  uuid: () =>
    // Not crypto-grade and doesn't need to be — it only has to be unique enough
    // that two runs never collide on a unique-constraint column.
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
    }),
  timestamp: () => String(Date.now()),
  randomInt: () => String(Math.floor(Math.random() * 1_000_000))
}

export const savedNameOf = (token: string): string =>
  token.trim().slice(SAVED_PREFIX.length).trim()

// Is this a token main resolves at run time (rather than the renderer up-front)?
// MIRROR: dataDriven.ts has the same predicate — it must NOT treat these as data
// columns or blank them out before main ever sees them.
export function isRuntimeToken(name: string): boolean {
  const n = name.trim()
  return n.startsWith(SAVED_PREFIX) || Object.prototype.hasOwnProperty.call(DYNAMIC, n)
}

// One run's token state. `dynamic` memoises generated values so a token used
// twice in a run means the same thing both times.
export interface RunTokens {
  saved: Record<string, string>
  dynamic: Record<string, string>
}

export const newRunTokens = (): RunTokens => ({ saved: {}, dynamic: {} })

// Replace the runtime tokens in one string. Anything else ({{env:X}}, a data
// column) is left EXACTLY as found — it was already substituted, or it isn't
// ours to touch.
//
// An unresolved {{saved:x}} is left as the literal token rather than blanked:
// a silent '' would turn `DELETE /orders/{{saved:id}}` into `DELETE /orders/`,
// which on a real API can mean "delete the whole collection". Failing loudly on
// a nonsense URL is the safe direction.
export function resolveRuntimeText(text: string, tokens: RunTokens): string {
  if (!text) return text
  return text.replace(TOKEN_RE, (whole, raw: string) => {
    const name = String(raw).trim()
    if (name.startsWith(SAVED_PREFIX)) {
      const key = savedNameOf(name)
      return Object.prototype.hasOwnProperty.call(tokens.saved, key) ? tokens.saved[key] : whole
    }
    const gen = DYNAMIC[name]
    if (!gen) return whole
    if (!Object.prototype.hasOwnProperty.call(tokens.dynamic, name)) {
      tokens.dynamic[name] = gen()
    }
    return tokens.dynamic[name]
  })
}

// The step fields that may carry tokens. Selectors are deliberately excluded —
// only user-supplied DATA is tokenized (same rule as the renderer's).
//
// Returns a COPY: the saved test keeps its {{tokens}} (that's what you authored,
// and what the step list should keep showing); only the run sees the values.
export function resolveRuntimeStep<T extends ReplayStep>(step: T, tokens: RunTokens): T {
  // Nothing to do for the overwhelmingly common case — don't clone every step.
  const fields = ['url', 'value', 'apiHeaders', 'apiBody'] as const
  const needs = fields.some((f) => typeof step[f] === 'string' && step[f]!.includes('{{'))
  if (!needs) return step

  const next: T = { ...step }
  for (const field of fields) {
    const v = next[field]
    if (typeof v === 'string' && v.includes('{{')) {
      next[field] = resolveRuntimeText(v, tokens) as T[typeof field]
    }
  }
  return next
}

// === Saving a value OUT of a response ================================
// The editor's "save from response" box is one `name = path` per line:
//
//   orderId = id            → body.id
//   token   = data.token    → body.data.token
//   first   = items.0.sku   → body.items[0].sku
//
// Dot notation only (with numeric segments for arrays). It covers the shapes a
// REST API actually returns, and stays something you can read at a glance —
// a full JSONPath dialect would be a second language to learn for no gain here.
export function parseSaveSpec(text?: string): { name: string; path: string }[] {
  if (!text) return []
  const out: { name: string; path: string }[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const name = trimmed.slice(0, eq).trim()
    const path = trimmed.slice(eq + 1).trim()
    if (name && path) out.push({ name, path })
  }
  return out
}

// Walk a dot path into a parsed JSON body. Returns undefined if the path misses
// — the caller decides what to do (we fail the step, loudly).
export function pickPath(body: unknown, path: string): unknown {
  let cur: unknown = body
  for (const seg of path.split('.')) {
    const key = seg.trim()
    if (!key) continue
    if (cur == null) return undefined
    if (Array.isArray(cur)) {
      const idx = Number(key)
      if (!Number.isInteger(idx)) return undefined
      cur = cur[idx]
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[key]
    } else {
      return undefined
    }
  }
  return cur
}

// Extract every saved value from a response body into the run's token store.
// Returns an error message when a path misses — a test that silently saved
// nothing would fail LATER with a baffling URL, so we fail here, where the
// cause is obvious.
export function applySaves(
  bodyText: string,
  saveSpec: string | undefined,
  tokens: RunTokens
): string | null {
  const specs = parseSaveSpec(saveSpec)
  if (!specs.length) return null

  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch {
    return `Could not save from the response — it isn't JSON. Body starts: "${bodyText
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)}".`
  }

  for (const { name, path } of specs) {
    const value = pickPath(body, path)
    if (value === undefined || value === null) {
      return `Could not save "${name}" — the response has no value at "${path}".`
    }
    if (typeof value === 'object') {
      return `Could not save "${name}" — "${path}" is an object/array, not a single value.`
    }
    tokens.saved[name] = String(value)
  }
  return null
}
