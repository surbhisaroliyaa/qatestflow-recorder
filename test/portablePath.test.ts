import { describe, it, expect } from 'vitest'
import { portableBasename } from '../src/shared/portablePath'

// =====================================================================
// QF-005 — taking a filename off a path that came from another machine.
//
// The audit hit this as a bundle test that passed on Windows and failed on
// macOS: Node's `path.basename` doesn't treat `\` as a separator off Windows,
// so a Windows upload fixture came back as the entire
// `C:\Users\…\invoice.pdf` string. A bug that only exists on the OS you don't
// develop on is one nobody sees until a teammate opens your bundle.
//
// These assert BOTH separator styles from a single process, so the result no
// longer depends on which machine ran the suite.
// =====================================================================

describe('portableBasename', () => {
  it('takes the filename off a Windows path', () => {
    expect(portableBasename('C:\\Users\\samee\\Documents\\invoice.pdf')).toBe('invoice.pdf')
  })

  it('takes the filename off a POSIX path', () => {
    expect(portableBasename('/home/qa/photo.png')).toBe('photo.png')
  })

  it('handles a UNC share path', () => {
    expect(portableBasename('\\\\server\\share\\report.xlsx')).toBe('report.xlsx')
  })

  it('handles mixed separators', () => {
    expect(portableBasename('C:/Users/samee\\Downloads/data.csv')).toBe('data.csv')
  })

  it('ignores trailing separators, like basename does', () => {
    expect(portableBasename('/home/qa/folder/')).toBe('folder')
    expect(portableBasename('C:\\Users\\samee\\folder\\')).toBe('folder')
  })

  it('returns a bare filename unchanged', () => {
    expect(portableBasename('invoice.pdf')).toBe('invoice.pdf')
  })

  it('finds nothing in a bare drive or an empty string', () => {
    expect(portableBasename('C:')).toBe('')
    expect(portableBasename('')).toBe('')
  })

  it('keeps spaces and dots in the name', () => {
    expect(portableBasename('C:\\My Files\\Q3 report.final.pdf')).toBe('Q3 report.final.pdf')
  })
})
