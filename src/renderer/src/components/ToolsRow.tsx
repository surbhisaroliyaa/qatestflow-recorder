import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fitCount } from '../toolFit'

// =====================================================================
// The QA tool belt, with a "More ⋯" overflow menu  (audit QF-007)
// =====================================================================
// The tools row used to WRAP onto a second line when the window was narrow.
// Nothing was cut off any more, but every wrapped line pushed the page under
// test down by another ~40 px — the one thing a tester is actually looking at.
// Now the row stays ONE line: whatever does not fit moves, rightmost first,
// into a "More ⋯" menu at the end of the row. With room for everything, there
// is no More button at all.
//
// One list of tool definitions renders BOTH the buttons and the menu items, so
// a tool in the menu runs the very same handler with the very same disabled /
// on-off state — there is no second copy to drift out of step.
//
// == How it measures without flicker ==
//
// A hidden copy of the full row (every button, never wrapping) sits inside the
// row, absolutely positioned so it takes no space. Its buttons are always laid
// out, so their widths are always known — even for the ones currently in the
// menu, which are not rendered in the real row. A ResizeObserver on the real
// row (the window changing width) and on the copy (a label changing, e.g.
// "A11y" → "Scanning…", "Net" → "Net · 12") recomputes how many fit. The
// result only ever changes a count, which changes neither observed size, so it
// cannot loop; and it runs in a layout effect, before the first paint, so the
// row never visibly shows the wrong buttons first.
//
// == Why opening the menu hides the page ==
//
// The page under test is a NATIVE view that Electron paints ON TOP of this
// whole window. Any HTML that overlaps the page area — this menu drops down
// into it — is drawn underneath the page and simply is not there. Modals and
// the step-pane drag solve this the same way: they ask main to hide the page
// (`browser:setOverlay`) for as long as they need the space. The menu does
// that too, via `onOpenChange`, and the page returns the moment it closes.
// =====================================================================

export interface ToolDef {
  id: string
  /** Visible text, including its icon — the same in the row and the menu. */
  label: string
  title: string
  className: string
  onClick: () => void
  disabled?: boolean
  /**
   * For on/off tools only (network capture, element picking): whether it is
   * on. The button gets aria-pressed, the menu item is a menuitemcheckbox.
   */
  checked?: boolean
}

export interface ToolsRowProps {
  /** Tools in display order, grouped by job (a divider separates groups). */
  groups: ToolDef[][]
  /** Told when the menu opens or closes — the page must hide while it's open. */
  onOpenChange: (open: boolean) => void
  /**
   * Awaited after the menu closes and BEFORE a menu item's action runs. Picking
   * an element, taking a snapshot or crawling for coverage all need the page
   * back on screen first — it was hidden while the menu was open.
   */
  beforeRun: () => Promise<void>
}

export function ToolsRow({ groups, onOpenChange, beforeRun }: ToolsRowProps): React.JSX.Element {
  const flat = groups.flat()
  const total = flat.length
  const rowRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<HTMLDivElement | null>(null)
  const moreBtnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [shown, setShown] = useState(total)
  const [open, setOpen] = useState(false)

  // --- measuring ------------------------------------------------------
  const recompute = useCallback((): void => {
    const row = rowRef.current
    const meas = measureRef.current
    if (!row || !meas) return
    const left = meas.getBoundingClientRect().left
    const rights = Array.from(meas.querySelectorAll('[data-tool]')).map(
      (el) => el.getBoundingClientRect().right - left
    )
    const more = meas.querySelector('[data-more]')
    const moreRect = more?.getBoundingClientRect()
    const moreWidth = moreRect ? moreRect.width : 0
    const moreLead =
      moreRect && rights.length ? moreRect.left - left - rights[rights.length - 1] : 0
    setShown(fitCount({ rights, available: row.clientWidth, moreWidth, moreLead }))
  }, [])

  useLayoutEffect(() => {
    recompute()
    const ro = new ResizeObserver(() => recompute())
    if (rowRef.current) ro.observe(rowRef.current)
    if (measureRef.current) ro.observe(measureRef.current)
    return () => ro.disconnect()
  }, [recompute])

  // A tool added or removed changes what fits — measure again.
  useLayoutEffect(() => {
    recompute()
  }, [total, recompute])

  const hiddenTools = flat.slice(shown)
  const hasMore = hiddenTools.length > 0
  // Nothing in the menu can be used right now (e.g. mid-replay, when every
  // tool is disabled) — then there is no reason to open it, and opening it
  // would hide the page for nothing.
  const moreUsable = hiddenTools.some((t) => !t.disabled)

  // --- the menu -------------------------------------------------------
  const close = useCallback((refocus: boolean): void => {
    setOpen(false)
    if (refocus) moreBtnRef.current?.focus()
  }, [])

  // Tell the parent (it hides / restores the native page). Closing on unmount
  // too, so the page can never stay hidden behind a menu that is gone.
  useEffect(() => {
    onOpenChange(open)
  }, [open, onOpenChange])
  useEffect(() => () => onOpenChange(false), [onOpenChange])

  // The window grew and the menu has nothing left in it — or nothing in it can
  // be used any more — so it must not stay open (and keep the page hidden).
  useEffect(() => {
    if (open && (!hasMore || !moreUsable)) setOpen(false)
  }, [open, hasMore, moreUsable])

  // Click outside, or the window losing focus, closes it. (A click on the page
  // under test cannot happen — the page is hidden while the menu is open.)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || moreBtnRef.current?.contains(t)) return
      setOpen(false)
    }
    const onBlur = (): void => setOpen(false)
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  const items = (): HTMLElement[] =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[data-menuitem]') ?? [])

  // Where focus lands when the menu opens: 'first' or 'last' item.
  const [focusOnOpen, setFocusOnOpen] = useState<'first' | 'last'>('first')
  useLayoutEffect(() => {
    if (!open) return
    const list = items()
    const target = focusOnOpen === 'last' ? list[list.length - 1] : list[0]
    target?.focus()
  }, [open, focusOnOpen])

  const openMenu = (at: 'first' | 'last'): void => {
    setFocusOnOpen(at)
    setOpen(true)
  }

  const onMoreKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    // Enter / Space arrive as a click (it is a real button); the arrows don't.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      openMenu(e.key === 'ArrowUp' ? 'last' : 'first')
    }
  }

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const list = items()
    const i = list.indexOf(document.activeElement as HTMLElement)
    const go = (n: number): void => {
      e.preventDefault()
      list[(n + list.length) % list.length]?.focus()
    }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(list.length - 1)
    else if (e.key === 'Escape') {
      e.preventDefault()
      // Not a modal, but a modal's Escape handler must not see this key too.
      e.stopPropagation()
      close(true)
    } else if (e.key === 'Tab') {
      // Tab leaves the menu. The items are about to unmount, which would drop
      // focus on <body>; parking it on More first means the browser's own Tab
      // (not prevented) then moves on from there — to the next control, or,
      // with Shift, to the one before More.
      moreBtnRef.current?.focus()
      setOpen(false)
    }
  }

  const run = (tool: ToolDef): void => {
    if (tool.disabled) return
    close(true)
    // The page is hidden while the menu is open. Wait until main has put it
    // back before running the tool, so e.g. Snapshot photographs the page and
    // not an empty, zero-sized view.
    void beforeRun().then(() => tool.onClick())
  }

  // --- rendering ------------------------------------------------------
  const button = (t: ToolDef, measuring: boolean): React.JSX.Element => (
    <button
      key={t.id}
      type="button"
      className={t.className}
      onClick={measuring ? undefined : t.onClick}
      disabled={t.disabled}
      title={t.title}
      aria-pressed={t.checked === undefined ? undefined : t.checked}
      data-tool={t.id}
      tabIndex={measuring ? -1 : undefined}
    >
      {t.label}
    </button>
  )

  let seen = 0
  const visibleGroups = groups
    .map((g) => {
      const start = seen
      seen += g.length
      return g.slice(0, Math.max(0, shown - start))
    })
    .filter((g) => g.length > 0)

  return (
    <div className="chrome-row tools" ref={rowRef}>
      {visibleGroups.map((g) => (
        <div className="tool-group" key={g[0].id}>
          {g.map((t) => button(t, false))}
        </div>
      ))}

      {hasMore && (
        <div className="tool-more">
          <button
            ref={moreBtnRef}
            type="button"
            className={`snapshot-btn tool-more-btn${open ? ' open' : ''}`}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? 'tools-more-menu' : undefined}
            disabled={!moreUsable}
            title={
              moreUsable
                ? `More tools: ${hiddenTools.map((t) => t.label).join(', ')}`
                : `More tools (not available right now): ${hiddenTools.map((t) => t.label).join(', ')}`
            }
            onClick={() => (open ? close(false) : openMenu('first'))}
            onKeyDown={onMoreKeyDown}
          >
            More ⋯
          </button>
          {open && (
            <div
              id="tools-more-menu"
              className="tool-more-menu"
              role="menu"
              aria-label="More tools"
              ref={menuRef}
              onKeyDown={onMenuKeyDown}
            >
              {hiddenTools.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`tool-more-item${t.checked ? ' on' : ''}`}
                  role={t.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                  aria-checked={t.checked === undefined ? undefined : t.checked}
                  // aria-disabled, not disabled: a disabled item stays
                  // focusable so arrowing through the menu still reads it out.
                  aria-disabled={t.disabled ? true : undefined}
                  tabIndex={-1}
                  title={t.title}
                  data-menuitem={t.id}
                  onClick={() => run(t)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* The measuring copy: every tool, one line, invisible and unfocusable.
          `visibility: hidden` keeps it out of the accessibility tree and the
          Tab order while still giving every button its real width. */}
      <div className="tools-measure-box" aria-hidden="true">
        <div className="tools-measure" ref={measureRef}>
          {groups.map((g) => (
            <div className="tool-group" key={g[0]?.id ?? 'empty'}>
              {g.map((t) => button(t, true))}
            </div>
          ))}
          <div className="tool-more" data-more="">
            <button type="button" className="snapshot-btn tool-more-btn" tabIndex={-1}>
              More ⋯
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
