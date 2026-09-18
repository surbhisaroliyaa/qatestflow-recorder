// =====================================================================
// FILENAMES FROM PATHS THAT CAME FROM ANOTHER MACHINE  (audit finding QF-005)
// =====================================================================
// Node's `path.basename` is PLATFORM-SPECIFIC. On Linux and macOS it does not
// treat `\` as a separator, so:
//
//     basename('C:\\Users\\sam\\invoice.pdf')   // on macOS → the WHOLE string
//
// That is fine for a path this machine just produced, and wrong for every path
// that arrived from somewhere else — a library bundle recorded on Windows and
// opened on a Mac, an imported test, a spec exported on one OS and run on
// another. The audit caught it as a failing bundle-portability test: a Windows
// upload fixture came back as the entire `C:\Users\…\invoice.pdf` string
// instead of `invoice.pdf`, so the fixture never resolved.
//
// One definition, used by everything that takes a filename off a SERIALIZED
// path, because this is precisely the rule that gets re-derived slightly
// differently in the fourth place it is needed.
// =====================================================================

/**
 * The final segment of a path, treating BOTH `/` and `\` as separators
 * regardless of the OS this is running on.
 *
 * Use for any path that was stored, shared or received. For a path this process
 * just built from its own filesystem, Node's `path.basename` is still correct
 * and more precise.
 */
export function portableBasename(p: string): string {
  if (typeof p !== 'string') return ''
  // Trailing separators ('a/b/' → 'b'), matching basename's behaviour.
  const trimmed = p.replace(/[\\/]+$/, '')
  const last = trimmed.split(/[\\/]/).pop() ?? ''
  // A bare Windows drive ('C:') has no filename in it to find.
  return /^[a-zA-Z]:$/.test(last) ? '' : last
}
