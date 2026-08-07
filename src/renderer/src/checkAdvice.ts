// =====================================================================
// CHECK ADVICE
// Small judgements about a check the user is ABOUT to add — shown in the
// pick panel, where the choice can still be changed, rather than left to
// fail (or worse, pass emptily) at replay time.
// =====================================================================

/**
 * Is a text check on this element circular?
 *
 * When an element has no id / role / name, its only hook is the words written
 * on it, so the step is found with `getByText('…')`. A "text is …" check on that
 * element then asserts the very thing the locator already matched:
 *
 *     await expect(page.getByText('Order complete')).toHaveText('Order complete')
 *
 * That can only fail when the element is ABSENT — the text can never be "wrong",
 * because a different text means the locator found nothing. So it is a
 * visibility check wearing a text check's clothes, and it reads in a report as
 * if the wording were verified when it wasn't.
 *
 * `Visible` says the same thing honestly and is one word shorter to read.
 *
 * Not a refusal — a nudge. The check does work; it just proves less than it
 * looks like it proves. (Contrast `unreliable`, which blocks: that element
 * cannot be found again at all.)
 *
 * Candidates arrive score-ordered, so the first non-css one is the hook the step
 * will actually use.
 */
export function textCheckIsCircular(
  candidates: SelectorCandidate[] | undefined,
  assertKind: AssertKind | undefined
): boolean {
  if (assertKind !== 'text-equals' && assertKind !== 'text-contains') return false
  const primary = (candidates ?? []).find((c) => c.kind !== 'css')
  return primary?.kind === 'text'
}
