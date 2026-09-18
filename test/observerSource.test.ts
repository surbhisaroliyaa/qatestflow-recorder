import { describe, it, expect } from 'vitest'
import ts from 'typescript'
import { createObserver, dialogShimProgram } from '../src/main/observerSource'

// =====================================================================
// Both halves of the recorder are STRINGIFIED somewhere:
//
//   · dialogShimProgram — injected into each frame's PAGE world (by the
//     recorder preload, and into adopted frames as an inline <script>);
//   · createObserver    — bundled into the preload, but also stringified by
//     the DOM tests to run it in a plain page.
//
// That makes one property load-bearing in a way the compiler cannot see: each
// must be completely self-contained. The moment one references anything
// outside itself, the stringified copy throws `X is not defined` in the page,
// and recording (or dialog capture) stops on every site at once. tsc is happy
// either way, because in the SOURCE those references resolve. Only
// stringifying and looking at what comes out can tell.
// Behaviour lives in test-dom/observer.spec.ts and tools/e2e-smoke.mjs.
// =====================================================================

const parses = (code: string): string[] => {
  const sf = ts.createSourceFile('inject.js', code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
  const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []
  return diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))
}
const FORBIDDEN = ['require(', 'import(', 'exports.', '__importDefault', 'module.']

describe('the page-world dialog shim', () => {
  const source = dialogShimProgram.toString()

  it('parses once wrapped the way it is injected', () => {
    expect(source).toMatch(/^function dialogShimProgram\(\)/)
    expect(parses(`(${source})();`)).toEqual([])
  })

  it('carries no import, require or module reference into the page', () => {
    for (const f of FORBIDDEN) expect(source, f).not.toContain(f)
  })

  it('is the ONLY part of the recorder in the page world, and it holds no secret', () => {
    // QF-002: nothing the page can read may let it imitate the recorder. The
    // shim reports dialogs by DOM event — the page controls its own dialogs
    // anyway — and never touches a nonce, ipc or the recorder's state.
    for (const s of ['nonce', 'ipcRenderer', 'postMessage', 'recorder:event']) {
      expect(source, s).not.toContain(s)
    }
  })
})

describe('the isolated-world observer', () => {
  const source = createObserver.toString()

  it('is a self-contained function', () => {
    expect(source).toMatch(/^function createObserver\(/)
    expect(source.length).toBeGreaterThan(1000)
    expect(parses(`(${source})`)).toEqual([])
  })

  it('carries no import, require or module reference', () => {
    for (const f of FORBIDDEN) expect(source, f).not.toContain(f)
  })

  it('sends only through the transport it is given — never postMessage, never a nonce', () => {
    // The whole point of QF-002's completion: its channel out is `send`
    // (ipcRenderer, in the preload), which the page world has no access to.
    expect(source).toContain('opts.send')
    expect(source).not.toContain('postMessage')
    expect(source).not.toContain('nonce')
  })

  it('publishes nothing on the page’s window', () => {
    // The old observer hung its API off window.__qaflow for main to call. In
    // an isolated world that would be invisible anyway — but a leftover
    // assignment is a sign code still assumes the page world.
    expect(source).not.toMatch(/window\.__qaflow\w*\s*=/)
  })
})
