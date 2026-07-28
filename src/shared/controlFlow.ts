// =====================================================================
// F37 — LOOPS & BRANCHING (completes F26)
//
// F26 shipped only "optional steps" (a step allowed to be absent). This adds
// the two things a real flow needs and couldn't express:
//
//   repeat  — "add 3 items to the cart", "for each row in the results table…"
//   if/else — "if the cookie banner is there, dismiss it, otherwise carry on"
//
// == Why FLAT markers, not nested children ==
//
// The obvious model is a tree: a repeat step holding an array of children. It
// is also the wrong one HERE. This codebase addresses steps by INDEX
// everywhere — trace evidence (`runSnaps[i]`), replay progress
// (`{ index: i }`), the F4 self-heal `healable.index`, F8 baselines, the F12
// version diff, the step rows in the UI. A tree breaks every one of those.
//
// So control flow is stored the way a CPU stores it: flat, with paired marker
// steps and jumps between them. A step's index never changes meaning, and every
// existing index-based feature keeps working untouched.
//
//   0 navigate
//   1 repeat (times: 3)     ─┐
//   2   click "Add to cart"  │  body
//   3 endRepeat             ─┘  → jumps back to 1 until 3 iterations are done
//   4 if (cart badge visible) ─┐
//   5   click "Checkout"       │ true branch
//   6 else                     ┤
//   7   click "Keep shopping"  │ false branch
//   8 endIf                   ─┘
//
// This module is the SINGLE source of truth for how those markers pair up. It's
// in `src/shared` because replay (main process) and the Playwright export
// (renderer) must agree exactly — if they disagreed, a test would loop one way
// in the app and another way in CI, which is the worst possible failure for a
// tool whose whole identity is "a green run can be trusted".
// =====================================================================

/** The step shape this module needs. Deliberately structural, so both the main
 *  and renderer RecorderStep types satisfy it without importing each other. */
export interface ControlFlowStep {
  type: string
  disabled?: boolean
}

export type ControlKind = 'repeat' | 'endRepeat' | 'if' | 'else' | 'endIf'

export const CONTROL_TYPES: ReadonlySet<string> = new Set<string>([
  'repeat',
  'endRepeat',
  'if',
  'else',
  'endIf'
])

export function isControlStep(step: { type: string }): boolean {
  return CONTROL_TYPES.has(step.type)
}

/** Where a block opened at `start` continues/ends. */
export interface BlockSpan {
  /** Index of the opening `repeat` / `if`. */
  start: number
  /** Index of the matching `endRepeat` / `endIf`. */
  end: number
  /** For an `if`: index of its `else`, when it has one. */
  elseAt?: number
}

export interface ControlFlowMap {
  /** start index → span. Keyed by the OPENING marker. */
  spans: Map<number, BlockSpan>
  /** Any closing/else marker → the index of the block it belongs to. */
  ownerOf: Map<number, number>
  /** Nesting depth of every step, for indenting the UI. Markers are shown at
   *  the depth of the block they belong to, so `repeat` and `endRepeat` line up
   *  with each other and the body sits one level in. */
  depth: number[]
  /** Structural problems. A test with any of these must not run — a mismatched
   *  marker means we'd be guessing at the author's intent, and guessing wrong
   *  silently skips or repeats real test steps. */
  errors: string[]
}

/**
 * Pair up every control marker in a flat step list.
 *
 * DISABLED steps are ignored for pairing, exactly as they are for running — so
 * turning off a whole `repeat` also turns off the `endRepeat` you turned off
 * with it, and a half-disabled pair is reported as the error it is.
 */
export function analyzeControlFlow(steps: ControlFlowStep[]): ControlFlowMap {
  const spans = new Map<number, BlockSpan>()
  const ownerOf = new Map<number, number>()
  const depth: number[] = new Array(steps.length).fill(0)
  const errors: string[] = []
  // Each frame is an open block waiting for its closing marker.
  const stack: { kind: 'repeat' | 'if'; start: number; elseAt?: number }[] = []

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (step.disabled) {
      depth[i] = stack.length
      continue
    }
    switch (step.type) {
      case 'repeat':
      case 'if': {
        depth[i] = stack.length
        stack.push({ kind: step.type === 'repeat' ? 'repeat' : 'if', start: i })
        break
      }
      case 'else': {
        const top = stack[stack.length - 1]
        if (!top || top.kind !== 'if') {
          errors.push(`Step ${i + 1}: "else" without a matching "if".`)
          depth[i] = stack.length
          break
        }
        if (top.elseAt !== undefined) {
          errors.push(`Step ${i + 1}: this "if" already has an "else".`)
          depth[i] = stack.length - 1
          break
        }
        top.elseAt = i
        ownerOf.set(i, top.start)
        depth[i] = stack.length - 1
        break
      }
      case 'endRepeat':
      case 'endIf': {
        const want = step.type === 'endRepeat' ? 'repeat' : 'if'
        const top = stack[stack.length - 1]
        if (!top) {
          errors.push(`Step ${i + 1}: "${step.type}" without a matching "${want}".`)
          depth[i] = 0
          break
        }
        if (top.kind !== want) {
          // e.g. `repeat … endIf` — crossed markers. Refuse rather than guess:
          // silently re-pairing could loop over the wrong steps.
          errors.push(
            `Step ${i + 1}: "${step.type}" closes a "${top.kind}" that started at step ${top.start + 1}. Loops and if-blocks can't overlap.`
          )
          depth[i] = Math.max(0, stack.length - 1)
          stack.pop()
          break
        }
        stack.pop()
        depth[i] = stack.length
        spans.set(top.start, { start: top.start, end: i, elseAt: top.elseAt })
        ownerOf.set(i, top.start)
        break
      }
      default:
        depth[i] = stack.length
    }
  }

  for (const open of stack) {
    errors.push(
      `Step ${open.start + 1}: "${open.kind}" is never closed — add a matching "${open.kind === 'repeat' ? 'endRepeat' : 'endIf'}".`
    )
  }
  return { spans, ownerOf, depth, errors }
}

/** Does this list use any control flow at all? Lets every existing code path
 *  stay on its original, simpler branch when it doesn't. */
export function hasControlFlow(steps: ControlFlowStep[]): boolean {
  return steps.some((s) => !s.disabled && CONTROL_TYPES.has(s.type))
}

// =====================================================================
// Loop tokens
//
// Inside a `repeat`, steps can reference which iteration they're on:
//   {{loop:index}}  0-based
//   {{loop:n}}      1-based (what a human counts with)
//   {{loop:text}}   visible text of the current element, for a for-each loop
//
// These resolve per ITERATION, so they can't be substituted up-front the way
// {{env:X}} and data columns are — the same step yields a different value each
// time round. Same reasoning as F24's {{uuid}}/{{saved:x}} runtime tokens.
// =====================================================================

export interface LoopContext {
  index: number // 0-based
  total: number
  text?: string // for-each: the current element's visible text
}

const LOOP_TOKEN = /\{\{loop:(index|n|text)\}\}/g

export function hasLoopToken(value: string | undefined): boolean {
  if (!value) return false
  LOOP_TOKEN.lastIndex = 0
  return LOOP_TOKEN.test(value)
}

/**
 * Resolve loop tokens against the INNERMOST enclosing loop.
 *
 * An unresolved token is left INTACT rather than blanked — same rule as F24's
 * `{{saved:x}}`. A token that silently became an empty string could turn a real
 * assertion into a vacuous one (the F6 dead-check disease), so leaving it
 * visible makes the mistake obvious in the failure message.
 */
export function resolveLoopTokens(value: string | undefined, loop: LoopContext | null): string | undefined {
  if (value === undefined || !loop) return value
  return value.replace(LOOP_TOKEN, (whole, which: string) => {
    if (which === 'index') return String(loop.index)
    if (which === 'n') return String(loop.index + 1)
    if (which === 'text') return loop.text ?? whole
    return whole
  })
}

// =====================================================================
// Conditions — what an `if` tests, and what a `repeat` counts.
// =====================================================================

export type ConditionKind =
  | 'element-visible'
  | 'element-absent'
  | 'text-present'
  | 'text-absent'
  | 'url-contains'

export type RepeatKind = 'times' | 'each'

/** Plain-English rendering, used by the step list, living docs and the export
 *  comments so all three describe a loop the same way. */
export function conditionText(kind: ConditionKind | undefined, label?: string, value?: string): string {
  switch (kind) {
    case 'element-absent':
      return `"${label ?? 'element'}" is NOT on the page`
    case 'text-present':
      return `the page contains "${value ?? ''}"`
    case 'text-absent':
      return `the page does NOT contain "${value ?? ''}"`
    case 'url-contains':
      return `the URL contains "${value ?? ''}"`
    case 'element-visible':
    default:
      return `"${label ?? 'element'}" is visible`
  }
}

export function repeatText(kind: RepeatKind | undefined, label?: string, value?: string): string {
  if (kind === 'each') return `for each "${label ?? 'element'}" on the page`
  const n = Number(value)
  const times = Number.isFinite(n) && n > 0 ? n : 1
  return `${times} time${times === 1 ? '' : 's'}`
}
