import { describe, it, expect } from 'vitest'
import ts from 'typescript'
import { observerProgram } from '../src/main/observerSource'

// =====================================================================
// The observer is not called — it is STRINGIFIED and injected into every
// frame of the page under test. That makes one property load-bearing in a
// way the compiler cannot see:
//
//   it must be completely self-contained.
//
// The moment it references anything outside itself — a helper from another
// module, a bundler shim, a const from the top of its own file — the
// injected copy throws `X is not defined` in the page, and recording stops
// working on every site at once. Types are fine: they are erased.
//
// tsc is happy either way, because in the SOURCE those references resolve
// perfectly. Only stringifying it and looking at what comes out can tell.
// Behaviour lives in test-dom/observer.spec.ts, which runs it in a real DOM.
// =====================================================================

const source = observerProgram.toString()

describe('the injected observer is self-contained', () => {
  it('stringifies to a callable function expression', () => {
    expect(source).toMatch(/^function observerProgram\(\)/)
    expect(source.length).toBeGreaterThan(1000)
  })

  it('parses as JavaScript once wrapped the way main injects it', () => {
    // main runs `(${observerProgram.toString()})()`. If that does not parse,
    // every frame on every site fails to arm, silently.
    const injected = `(${source})()`
    const sf = ts.createSourceFile('inject.js', injected, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
    const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []
    expect(diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))).toEqual([])
  })

  it('carries no import, require or module reference into the page', () => {
    // A bundler shim (`__importDefault`, `exports.`) or a stray `require(` means
    // the build inlined something that does not exist in a page world.
    for (const forbidden of ['require(', 'import(', 'exports.', '__importDefault', 'module.']) {
      expect(source, forbidden).not.toContain(forbidden)
    }
  })

  it('reads its state only from the globals main hands it', () => {
    // Arming and identity arrive as page globals set immediately before
    // injection. If the names drift apart from main's, the observer comes up
    // disarmed and the recording is silently empty.
    for (const global of [
      '__qaflowInstalled',
      '__qaflowFrame',
      '__qaflowInitActive',
      '__qaflowInitPicking'
    ]) {
      expect(source, global).toContain(global)
    }
  })

  it('re-injection re-asserts the armed state instead of installing twice', () => {
    // main re-injects EVERY frame on a record/pick toggle, because that reaches
    // deeply-nested frames a one-off call can miss. Without the guard, one click
    // would be recorded once per injection.
    expect(source).toContain('__qaflowInstalled')
    expect(source).toMatch(/setActive\(!!/)
  })

  it('talks to the host only by posting to the top window', () => {
    // It runs in the page world: no Node, no ipcRenderer. The single channel out
    // is window.top.postMessage, picked up by the preload relay.
    expect(source).toContain('postMessage')
    expect(source).not.toContain('ipcRenderer')
    expect(source).not.toContain('electron')
  })
})
