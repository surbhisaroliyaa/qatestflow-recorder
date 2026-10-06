// =====================================================================
// MODAL FOCUS MANAGEMENT  (audit finding QF-004)
// =====================================================================
// What the audit found, by driving the real app:
//
//   · opening a modal left focus on BODY — a keyboard user had no idea a
//     dialog had appeared, and a screen reader announced nothing
//   · Tab then moved into the Back / Forward / Reload controls BEHIND the
//     modal, so you could operate the browser chrome through a dialog that
//     was visually covering it
//   · Escape did not close anything
//
// == Why this is a hook and not a <Modal> component ==
//
// The obvious fix is a shared <Modal> primitive that every dialog is rewritten
// to use. There are ~25 modals in this app, several of them blocking safety
// prompts, and rewriting all of them at once is a large change with no way to
// verify it short of opening every dialog by hand.
//
// They already share their markup — every one renders
// `.modal-backdrop > .modal`, with an optional `.modal-close` and a
// `.modal-title`. So one manager can attach to whichever backdrop is currently
// mounted and give ALL of them focus containment at once, today, without
// touching 25 files. A <Modal> component is still the better long-term home;
// this makes the app usable by keyboard in the meantime, and the behaviour
// moves into that component unchanged when it arrives.
//
// == Escape ==
//
// Escape clicks the dialog's own `.modal-close` button when it has one. A modal
// with no close button is a BLOCKING DECISION (the environment warning, the
// recovery prompt) where every option has consequences — dismissing one of
// those on a stray keypress would be worse than not handling the key at all,
// so those are deliberately left alone.
//
// == Dialogs with their own styling ==
//
// A dialog that cannot wear `.modal` (the trace viewer has its own size and
// colours, and `.modal` would override them) opts in by markup instead: the
// dialog element carries `role="dialog"` and its close button carries
// `data-modal-close`. Without that the trap marked the BACKDROP as the dialog
// and Escape found no close button.
//
// == Stacked dialogs ==
//
// App.tsx switches the trap on when the FIRST overlay opens and off when the
// last one closes. A second dialog opened on top of the first does not flip
// that, so the trap watches the DOM itself: whenever a new dialog becomes the
// topmost one it gets initial focus, and when it goes away focus returns to
// the control that opened it (usually a button in the dialog underneath).
// One mechanism for the first dialog and every one stacked on it.
// =====================================================================

/**
 * Turn focus containment on for as long as a modal is open.
 *
 * Returns a teardown function. Call it when the modal closes — it restores
 * focus to whatever had it before, which is what makes keyboard navigation
 * survive opening and closing a dialog.
 *
 * SELF-CONTAINED ON PURPOSE. Everything it needs is declared inside, so the
 * function can be stringified and injected into a real page — which is the
 * only way to TEST focus behaviour, since focus, Tab order and `offsetParent`
 * do not exist outside a real browser. src/main/observerSource.ts is written
 * the same way, for the same reason. Do not lift these helpers to module
 * scope: it would compile fine and silently break the tests that inject it.
 */
export function trapFocus(): () => void {
  /** Elements that can hold focus, in DOM order. `:not([disabled])` matters:
   *  a disabled first button would otherwise swallow the initial focus. */
  const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',')

  const focusableWithin = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      // offsetParent is null for display:none. A hidden control is still in the
      // DOM and would otherwise be a dead stop in the tab cycle.
      (el) => el.offsetParent !== null || el === document.activeElement
    )

  /** The dialog box inside a backdrop: the shared `.modal`, or a custom-styled
   *  one that declares itself with role="dialog" (see the header). */
  const DIALOG = '.modal, [role="dialog"]'
  /** Its dismiss button — the shared class, or the opt-in attribute. */
  const CLOSE = '.modal-close, [data-modal-close]'

  /** The topmost open dialog, or null. Last in the DOM wins — a modal opened on
   *  top of another is the one the user is actually looking at. */
  const currentDialog = (): HTMLElement | null => {
    const backdrops = document.querySelectorAll<HTMLElement>('.modal-backdrop')
    const backdrop = backdrops[backdrops.length - 1]
    if (!backdrop) return null
    return backdrop.querySelector<HTMLElement>(DIALOG) ?? backdrop
  }

  /**
   * Announce the dialog properly to assistive technology.
   *
   * Applied to the live node rather than written into 25 components: the same
   * reasoning as the rest of this module.
   */
  const markUpDialog = (dialog: HTMLElement): void => {
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    // Focusable as a fallback target, but never a Tab stop of its own.
    if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1')

    // Name the dialog from its own visible title, so a screen reader says which
    // dialog opened instead of just "dialog".
    if (!dialog.getAttribute('aria-labelledby')) {
      const title = dialog.querySelector<HTMLElement>('.modal-title')
      if (title) {
        if (!title.id) {
          title.id = `qa-modal-title-${Math.random().toString(36).slice(2, 10)}`
        }
        dialog.setAttribute('aria-labelledby', title.id)
      }
    }
  }

  const focusInitial = (dialog: HTMLElement): void => {
    const targets = focusableWithin(dialog)
    // Into the dialog — the fix for "focus stayed on BODY".
    //
    // Skip the close button when there is anything else to land on. It is first
    // in DOM order in every modal here, so the naive "focus the first control"
    // drops a keyboard user onto "×" — offering to dismiss the dialog before
    // they have read it. Land on the first control that DOES something instead;
    // the close button is still one Shift+Tab away.
    const preferred = targets.find((el) => !el.matches(CLOSE)) ?? targets[0]
    ;(preferred ?? dialog).focus()
  }

  /** Focus went away with a dialog that closed (it sits on BODY, or on a node
   *  no longer in the document). Only then is it ours to move — if the user
   *  has since clicked elsewhere, yanking them back would be worse. */
  const focusLost = (): boolean => {
    const active = document.activeElement
    return !active || active === document.body || !document.body.contains(active)
  }

  // Every dialog that is open, bottom first, each with where focus came from
  // when it appeared, so it can go back there. Without this, closing a dialog
  // drops the user at the top of the document and they have to tab all the way
  // back to where they were.
  let stack: { dialog: HTMLElement; returnTo: HTMLElement | null }[] = []

  /**
   * Bring the stack in line with the DOM. Runs once now and again on every DOM
   * change while the trap is on — that is what catches a dialog opened on top
   * of another, or one closing to reveal the dialog beneath.
   */
  const sync = (): void => {
    const gone = stack.filter((entry) => !entry.dialog.isConnected)
    if (gone.length) stack = stack.filter((entry) => entry.dialog.isConnected)

    const top = currentDialog()
    if (top && !stack.some((entry) => entry.dialog === top)) {
      // A new topmost dialog. If it REPLACED one in the same render (a modal
      // swapping to its next screen), it inherits that one's return target —
      // the control that opened it is gone or behind it.
      const returnTo = gone.length
        ? gone[0].returnTo
        : (document.activeElement as HTMLElement | null)
      stack.push({ dialog: top, returnTo })
      markUpDialog(top)
      focusInitial(top)
      return
    }

    // A dialog closed and the one beneath is back on top: return focus to the
    // control in it that opened the closed one.
    if (gone.length && focusLost()) {
      const target = gone[0].returnTo
      if (target && target.isConnected) target.focus()
      else if (top) focusInitial(top)
    }
  }

  // Whatever had focus before the first dialog — where it goes back when the
  // trap is switched off, however many dialogs were stacked in between.
  const opener = document.activeElement as HTMLElement | null
  sync()

  // childList only: markUpDialog writes attributes, and watching those would
  // make the trap react to itself.
  const observer = new MutationObserver(sync)
  observer.observe(document.body, { childList: true, subtree: true })

  const onKeyDown = (event: KeyboardEvent): void => {
    const live = currentDialog()
    if (!live) return

    if (event.key === 'Escape') {
      const close = live.querySelector<HTMLElement>(CLOSE)
      // No close button = a blocking decision. Leave it to the user.
      if (close) {
        event.preventDefault()
        close.click()
      }
      return
    }

    if (event.key !== 'Tab') return

    const targets = focusableWithin(live)
    if (!targets.length) {
      // Nothing to move to — keep focus in the dialog rather than letting Tab
      // escape to the browser chrome behind it.
      event.preventDefault()
      live.focus()
      return
    }

    const first = targets[0]
    const last = targets[targets.length - 1]
    const active = document.activeElement as HTMLElement | null

    // The wrap-around. This is the actual containment: without it, Tab off the
    // last control walked into the Back / Forward / Reload buttons behind.
    if (event.shiftKey && (active === first || !live.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !live.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  // Capture phase: the dialog's own inputs must not get to swallow Tab first.
  document.addEventListener('keydown', onKeyDown, true)

  return () => {
    document.removeEventListener('keydown', onKeyDown, true)
    // Drop pending notifications too — the dialogs just closed, and a late
    // sync() must not try to move focus after this has already restored it.
    observer.takeRecords()
    observer.disconnect()
    if (opener && focusLost()) {
      try {
        opener.focus()
      } catch {
        // the element that opened the dialog is gone — nothing to restore to
      }
    }
  }
}
