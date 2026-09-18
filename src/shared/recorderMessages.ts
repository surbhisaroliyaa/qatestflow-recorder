// =====================================================================
// THE PAGE → ELECTRON TRUST BOUNDARY  (audit finding QF-002)
// =====================================================================
// WHAT WENT WRONG
//
// The recorder observer runs inside the page being tested and posts its events
// up to the top frame, where a preload relay forwards them to main over IPC.
// That relay used to be four lines:
//
//     if (data.__qaflow === true && typeof data.channel === 'string')
//       ipcRenderer.send(data.channel, data.payload)
//
// Any script on the tested page could post that shape. So a tested website
// could:
//
//   · insert fabricated steps into the user's recording (the audit proved this
//     with a step literally labelled "Forged by page"), and
//   · reach ANY `ipcMain.on` channel in the application, with any payload —
//     including `recorder:upload`, whose handler copies caller-supplied file
//     paths into the local test library.
//
// The second one is the part that matters. A page choosing its own IPC channel
// name is not a recorder bug, it is a privilege boundary that isn't there.
//
// HOW IT WAS CLOSED (2026-09-18)
//
// First, this module became the boundary: an allowlist of channels, a nonce,
// a strict schema. That stopped arbitrary channels and upload paths — but the
// observer still ran in the page's own world, so a page watching a live
// recording could read the nonce off a real message and imitate the recorder.
//
// Then the observer moved OUT of the page world. It now runs in each frame's
// isolated world, inside the recorder preload, and sends with ipcRenderer —
// which does not exist in the page world. Main identifies the sending frame
// from Electron (event.senderFrame). Nothing crosses the page world any more,
// so the nonce, and the relay that checked it, are gone. The recorder also
// ignores input the page generates itself (isTrusted), so page scripts can't
// create steps by clicking.
//
// WHAT THIS MODULE STILL DOES
//
// Main re-validates every message from a tab before acting on it — defence in
// depth, owed regardless of which process is talking:
//   1. the channel must be on the ALLOWLIST below;
//   2. the payload must match a strict SCHEMA, rebuilt from known keys only —
//      nothing received travels onward by reference;
//   3. sizes are capped, so a malformed message can't exhaust memory.
// =====================================================================

/** The only channels a tab's recorder speaks on (plus recorder:upload, which
 *  has its own validation in main because it carries file paths).
 *
 *  Anything not listed here (recovery decisions, manual-continue, check
 *  offers, and every other ipcMain.on channel in the app) is refused from a
 *  tab. */
export const PAGE_CHANNELS = [
  'recorder:event',
  'recorder:dialog',
  'recorder:picked',
  'recorder:pick-cancel'
] as const

export type PageChannel = (typeof PAGE_CHANNELS)[number]

/** Step types the observer itself can emit. Anything else is not something the
 *  recorder produces, so it can only have been made up. */
const OBSERVER_EVENT_TYPES = new Set(['click', 'hover', 'type', 'check', 'select', 'press'])

const DIALOG_KINDS = new Set(['alert', 'confirm', 'prompt'])

// Caps. Generous enough for real pages (a long textarea value, a deep frame
// chain), small enough that a hostile page cannot exhaust memory through them.
const MAX_STRING = 10_000
const MAX_TEXT = 1_000
const MAX_FRAME_DEPTH = 20
const MAX_DUP_KEYS = 16

export function isPageChannel(channel: unknown): channel is PageChannel {
  return typeof channel === 'string' && (PAGE_CHANNELS as readonly string[]).includes(channel)
}

// ── primitive readers ────────────────────────────────────────────────
// Each returns a CLEAN value or undefined. They never throw and never pass the
// caller's object through — the output is always freshly built.

function str(v: unknown, max = MAX_STRING): string | undefined {
  return typeof v === 'string' && v.length <= max ? v : undefined
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function plainObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** Drop keys whose value came back undefined, so the rebuilt object has only
 *  what actually validated. */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v
  return out
}

// ── the element facts ────────────────────────────────────────────────
// The observer's description of the element that was interacted with. Rebuilt
// key by key: a page that adds `__proto__` or a function-valued field gets it
// dropped here rather than somewhere deeper in the selector engine.

function facts(v: unknown): Record<string, unknown> | undefined {
  const f = plainObject(v)
  if (!f) return undefined
  const tag = str(f.tag, 100)
  if (!tag) return undefined // an element with no tag is not an element

  const dupIn = plainObject(f.dup)
  let dup: Record<string, unknown> | undefined
  if (dupIn) {
    const cleaned: Record<string, unknown> = {}
    for (const key of Object.keys(dupIn).slice(0, MAX_DUP_KEYS)) {
      const d = plainObject(dupIn[key])
      if (!d) continue
      const count = num(d.count)
      const index = num(d.index)
      if (count === undefined || index === undefined) continue
      cleaned[key] = { count, index }
    }
    if (Object.keys(cleaned).length) dup = cleaned
  }

  const anchorIn = plainObject(f.anchor)
  let anchor: Record<string, unknown> | undefined
  if (anchorIn) {
    const css = str(anchorIn.css)
    const count = num(anchorIn.count)
    const index = num(anchorIn.index)
    if (css !== undefined && count !== undefined && index !== undefined) {
      anchor = { css, count, index }
    }
  }

  return compact({
    tag,
    testId: str(f.testId, MAX_TEXT),
    testIdAttr:
      f.testIdAttr === 'data-test' || f.testIdAttr === 'data-testid' ? f.testIdAttr : undefined,
    id: str(f.id, MAX_TEXT),
    name: str(f.name, MAX_TEXT),
    role: str(f.role, MAX_TEXT),
    type: str(f.type, MAX_TEXT),
    ariaLabel: str(f.ariaLabel, MAX_TEXT),
    title: str(f.title, MAX_TEXT),
    placeholder: str(f.placeholder, MAX_TEXT),
    text: str(f.text, MAX_TEXT),
    imgAlt: str(f.imgAlt, MAX_TEXT),
    inputValue: str(f.inputValue, MAX_STRING),
    labelText: str(f.labelText, MAX_TEXT),
    dup,
    anchor
  })
}

/**
 * The same element-facts check, for the ONE trusted channel that isn't a page
 * channel: `recorder:upload`, which the relay preload produces itself from an
 * isolated-world file event. Main validates it anyway — it owes that to itself
 * regardless of which of its own processes is talking.
 */
export function validateElementFacts(v: unknown): Record<string, unknown> | undefined {
  return facts(v)
}

/** The frame chain the event fired in — an array of { url, name }. */
function frame(v: unknown): { url: string; name?: string }[] | undefined {
  if (v === null || v === undefined) return undefined
  if (!Array.isArray(v) || v.length > MAX_FRAME_DEPTH) return undefined
  const out: { url: string; name?: string }[] = []
  for (const raw of v) {
    const f = plainObject(raw)
    if (!f) return undefined
    const url = str(f.url, 4_000)
    if (url === undefined) return undefined
    const name = str(f.name, MAX_TEXT)
    out.push(name === undefined ? { url } : { url, name })
  }
  return out
}

// ── the per-channel schemas ──────────────────────────────────────────

function recorderEvent(p: Record<string, unknown>): Record<string, unknown> | null {
  const type = str(p.type, 50)
  if (!type || !OBSERVER_EVENT_TYPES.has(type)) return null
  const f = facts(p.facts)
  if (!f) return null
  return compact({
    type,
    facts: f,
    value: str(p.value),
    secret: bool(p.secret),
    key: str(p.key, 50),
    frame: frame(p.frame)
  })
}

function recorderDialog(p: Record<string, unknown>): Record<string, unknown> | null {
  const kind = str(p.kind, 20)
  if (!kind || !DIALOG_KINDS.has(kind)) return null
  return compact({
    kind,
    message: str(p.message),
    value: str(p.value),
    accept: bool(p.accept)
  })
}

function recorderPicked(p: Record<string, unknown>): Record<string, unknown> | null {
  const f = facts(p.facts)
  if (!f) return null
  return compact({
    facts: f,
    text: str(p.text, MAX_TEXT),
    inputValue: str(p.inputValue),
    disabled: bool(p.disabled),
    checked: bool(p.checked),
    groupCount: num(p.groupCount),
    frame: frame(p.frame)
  })
}

/**
 * Validate one recorder message and return a CLEAN payload, or null to drop it.
 *
 * Returning a rebuilt object rather than the original is the point: after this
 * function, nothing downstream is holding a reference to anything received, so
 * no getter, proto trick or extra field survives the crossing.
 */
export function validatePageMessage(channel: string, payload: unknown): unknown | null {
  if (!isPageChannel(channel)) return null

  // The one channel with no payload at all.
  if (channel === 'recorder:pick-cancel') return undefined

  const p = plainObject(payload)
  if (!p) return null

  switch (channel) {
    case 'recorder:event':
      return recorderEvent(p)
    case 'recorder:dialog':
      return recorderDialog(p)
    case 'recorder:picked':
      return recorderPicked(p)
    default:
      return null
  }
}
