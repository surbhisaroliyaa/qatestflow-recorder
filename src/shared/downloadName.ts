/**
 * Does a downloaded file's name match what the test expects?
 *
 * THE BUG (Round 13, 2026-09-23). SauceDemo's receipt is named
 * `swag-labs-order-2026-09-23_08-46-16.pdf` — the time of generation is IN the
 * filename. The recorder stored that literally and the replay engine compared
 * it literally, so the replay 36 seconds later read:
 *
 *   Expected download "swag-labs-order-2026-09-23_08-46-16.pdf"
 *   but got           "swag-labs-order-2026-09-23_08-46-52.pdf"
 *
 * The test was born red. The only run that could ever satisfy it was the one
 * that recorded it — and that is true of any site that stamps a timestamp, an
 * order id or a counter into a download, which is most of them.
 *
 * THE RULE: by default, runs of digits are wildcards and everything else must
 * match. So the two names above are the same file, while `invoice.pdf` and
 * `receipt.csv` are still failures. The checkpoint stays meaningful — "the
 * swag-labs order PDF arrived, non-empty" — without pinning it to one second in
 * history.
 *
 * WHEN THE DIGITS MATTER, a step can set `downloadExact` and get the old
 * literal comparison back (Surbhi's call, option 2: default loose, opt into
 * strict). `statement-2024.pdf` vs `statement-2025.pdf` is the case that needs
 * it — loose matching cannot tell those apart, and pretending otherwise would
 * be the dead-check disease this app exists to catch.
 *
 * Shared by THREE callers that must agree: the in-app replay engine, the inline
 * exporter and the Page Object exporter. They were three literal comparisons
 * before this, which is the same shape as the three export bugs found in the
 * August rounds — one behaviour, copied, and only ever fixed in one place.
 */

/** Every run of digits becomes one marker, so `08-46-16` and `08-46-52` agree. */
export function loosenDownloadName(name: string): string {
  return name.replace(/\d+/g, '#')
}

/**
 * Substring semantics, deliberately: the expected value is EDITABLE, and a
 * tester who shortens it to `swag-labs-order` means "the name contains this".
 * That was the behaviour before, and narrowing it to equality would break
 * hand-edited steps while fixing timestamps.
 */
export function downloadNameMatches(expected: string, actual: string, exact = false): boolean {
  const want = expected.trim()
  if (!want) return true // nothing to check beyond "a file arrived, non-empty"
  if (exact) return actual.includes(want)
  return loosenDownloadName(actual).includes(loosenDownloadName(want))
}

/** Regex-escape every character that would otherwise be a metacharacter. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, (m) => '\\' + m)
}

/**
 * The body of the regex an exported spec asserts with — escaped literal text,
 * with each run of digits as `\d+`.
 *
 * UNANCHORED on purpose: the in-app check is a substring test, and an exported
 * spec that asserted something stricter than the app would be a second, quietly
 * different rule. The whole point of this module is that there is one.
 */
export function downloadNameRegexSource(expected: string): string {
  return expected
    .trim()
    .split(/(\d+)/)
    .map((part, i) => (i % 2 === 1 ? '\\d+' : escapeRegex(part)))
    .join('')
}

/**
 * How to phrase the expectation when it FAILS. A message naming only the
 * recorded filename sent Surbhi looking for a difference between two names that
 * differed by 36 seconds; it has to say which part it actually compared.
 */
export function describeDownloadExpectation(expected: string, exact = false): string {
  return exact ? `"${expected}" (exactly)` : `"${expected}" (numbers may differ)`
}
