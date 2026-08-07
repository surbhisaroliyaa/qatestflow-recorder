import React from 'react'
import { ASSERT_KINDS, ASSERT_LABELS } from '../uiLabels'
import { assertNeedsValue } from '../uiFormat'
import { textCheckIsCircular } from '../checkAdvice'

// =====================================================================
// AssertPanel — lifted out of App.tsx verbatim.
//
// Was an inline {cond && (…)} block inside the workspace return. Props are
// destructured under the names the markup already used; the open condition is
// re-expressed as an early return, because a component that simply returns the
// JSX would render ALWAYS.
// =====================================================================

export interface AssertPanelProps {
  assertAttr: string
  assertKind: AssertKind
  assertValue: string
  checkPanelRef: React.RefObject<HTMLDivElement | null>
  handleAddAssert: () => void
  handleChooseKind: (kind: AssertKind) => void
  pickedElement: PickedElement | null
  setAssertAttr: React.Dispatch<React.SetStateAction<string>>
  setAssertValue: React.Dispatch<React.SetStateAction<string>>
  setInsertAt: React.Dispatch<React.SetStateAction<number | null>>
  setPickedElement: React.Dispatch<React.SetStateAction<PickedElement | null>>
}

export function AssertPanel({
  assertAttr,
  assertKind,
  assertValue,
  checkPanelRef,
  handleAddAssert,
  handleChooseKind,
  pickedElement,
  setAssertAttr,
  setAssertValue,
  setInsertAt,
  setPickedElement
}: AssertPanelProps): React.JSX.Element | null {
  if (!(pickedElement)) return null
  return (
            <div className="assert-panel" ref={checkPanelRef}>
              <div className="assert-target">
                <span className="assert-title">Add check:</span>
                <span className="assert-label">{pickedElement.label}</span>
              </div>
              <code className="assert-selector">{pickedElement.selector}</code>
              {/* Day 12: warn NOW about an element replay will refuse later */}
              {pickedElement.unreliable && (
                <div className="pick-warning">
                  ⚠ This element has no stable hooks (no id / role / text) — a check on it cannot
                  replay reliably. Pick a more specific element instead (its label, or a container
                  with an id).
                </div>
              )}
              {/* This element is found BY its text, so a text check re-asserts what
                  the locator already matched — it can only fail when the element is
                  missing. Say so while the kind can still be changed. */}
              {!pickedElement.unreliable &&
                textCheckIsCircular(pickedElement.candidates, assertKind) && (
                  <div className="pick-warning">
                    ⚠ This element is found <em>by</em> its text, so a text check can only fail when
                    the element is missing — it never really checks the wording.{' '}
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => handleChooseKind('visible')}
                    >
                      Use “Visible”
                    </button>{' '}
                    to say that honestly, or pick an element with an id / role.
                  </div>
                )}
              <div className="assert-kinds">
                {ASSERT_KINDS.filter(
                  (kind) =>
                    (kind !== 'checked' && kind !== 'unchecked') ||
                    pickedElement.checked !== undefined
                ).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={`assert-kind${assertKind === kind ? ' chosen' : ''}`}
                    onClick={() => handleChooseKind(kind)}
                  >
                    {ASSERT_LABELS[kind]}
                  </button>
                ))}
              </div>
              {assertKind === 'attribute' && (
                <input
                  className="assert-value"
                  value={assertAttr}
                  onChange={(e) => setAssertAttr(e.target.value)}
                  placeholder="attribute name (e.g. href, src, alt)…"
                  spellCheck={false}
                />
              )}
              {assertNeedsValue(assertKind) && (
                <input
                  className="assert-value"
                  value={assertValue}
                  onChange={(e) => setAssertValue(e.target.value)}
                  placeholder={
                    assertKind === 'count'
                      ? 'expected number of matches…'
                      : assertKind === 'class'
                        ? 'class name (one token, e.g. error)…'
                        : assertKind === 'attribute'
                          ? 'expected attribute value…'
                          : 'expected value…'
                  }
                  spellCheck={false}
                />
              )}
              <div className="assert-actions">
                <button
                  className="modal-btn"
                  onClick={() => {
                    setPickedElement(null)
                    setInsertAt(null)
                  }}
                >
                  Cancel
                </button>
                <button
                  className="modal-btn primary"
                  onClick={handleAddAssert}
                  disabled={pickedElement.unreliable}
                  title={
                    pickedElement.unreliable
                      ? 'No reliable selector — this check would always fail on replay'
                      : undefined
                  }
                >
                  Add check
                </button>
              </div>
            </div>
  )
}
