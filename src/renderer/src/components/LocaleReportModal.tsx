import React from 'react'
import { LOCALE_PRESETS } from '../uiLabels'
import type { LocaleResult } from '../runTypes'

// =====================================================================
// LocaleReportModal — lifted out of App.tsx verbatim.
//
// Was an inline {cond && (…)} block inside the workspace return. Props are
// destructured under the names the markup already used; the open condition is
// re-expressed as an early return, because a component that simply returns the
// JSX would render ALWAYS.
// =====================================================================

export interface LocaleReportModalProps {
  localeReportOpen: boolean
  localeRun: {
total: number
current: number
currentLabel: string
running: boolean
results: LocaleResult[]
} | null
  setLocaleReportOpen: React.Dispatch<React.SetStateAction<boolean>>
}

export function LocaleReportModal({
  localeReportOpen,
  localeRun,
  setLocaleReportOpen
}: LocaleReportModalProps): React.JSX.Element | null {
  if (!(localeRun && !localeRun.running && localeReportOpen)) return null
  return (
        <div className="modal-backdrop" onClick={() => setLocaleReportOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">
                🌐 Localization sweep — {localeRun.results.length} locale
                {localeRun.results.length === 1 ? '' : 's'}
              </span>
              <button
                className="modal-close"
                onClick={() => setLocaleReportOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="ac-body">
              <p className="api-hint">
                Each language replays your test, then checks three things: did the text
                actually <strong>translate</strong>, did the <strong>layout hold</strong>{' '}
                (no text cut off that fit fine in the base language), and did
                right-to-left languages like Arabic <strong>flip direction</strong>{' '}
                correctly. A green ✓ means all three are fine. Hover a row for the raw
                numbers.
              </p>
              {(() => {
                const rows = localeRun.results.map((r, i) => {
                  const preset = LOCALE_PRESETS.find((l) => l.code === r.locale)
                  const rtlIssue = !!preset?.rtl && r.dir !== 'rtl'
                  const untr =
                    i > 0 ? Math.round((r.unchanged / Math.max(1, r.totalTexts)) * 100) : null
                  // Overflow RELATIVE TO THE BASE locale — a site trims the same
                  // footer/menu bits in every language (even the base) by design, so
                  // only overflow the TRANSLATION adds is a real finding. Text can't be
                  // matched across locales (it's translated), so compare counts.
                  const baseOverflow = localeRun.results[0]?.overflowCount ?? 0
                  const extraOverflow = i === 0 ? 0 : Math.max(0, r.overflowCount - baseOverflow)
                  // Only flag "unchanged" when a locale is BARELY translated (≥85%
                  // identical to base = the site likely ignored the language). A normal
                  // page keeps brand names/URLs identical, so a 60% cutoff cried wolf.
                  const clean =
                    r.ok && extraOverflow === 0 && !rtlIssue && (untr === null || untr < 85)
                  return { r, i, rtlIssue, untr, baseOverflow, extraOverflow, clean }
                })
                const good = rows.filter((x) => x.clean).length
                const issues = rows.length - good
                return (
                  <>
                    <div className="ac-summary">
                      {good} of {rows.length} language{rows.length === 1 ? '' : 's'} look good
                      {issues > 0 ? ` · ${issues} need${issues === 1 ? 's' : ''} a look ⚠` : ' ✓'}
                    </div>
                    <ul className="ac-list">
                      {rows.map(({ r, i, rtlIssue, untr, baseOverflow, extraOverflow, clean }) => {
                        // Plain-English verdict. The raw dir/overflow/% live in the
                        // hover title for anyone who wants the exact numbers.
                        const plain = i === 0
                          ? 'Baseline — every other language is compared against this one.'
                          : extraOverflow > 0
                            ? `After translating, text was cut off in ${extraOverflow} spot${extraOverflow === 1 ? '' : 's'} that fit fine in the base language — the layout may break here${r.overflow.length ? ` (e.g. “${r.overflow.slice(0, 2).join('”, “')}”)` : ''}.`
                            : rtlIssue
                              ? 'This language should read right-to-left, but the page stayed left-to-right.'
                              : untr !== null && untr >= 85
                                ? `Hardly translated — ${untr}% of the on-screen text is still the base language.`
                                : r.dir === 'rtl'
                                  ? 'Translated, the layout held up, and it correctly switched to right-to-left.'
                                  : 'Translated and the layout held up — no text overflowed.'
                        const raw = `dir=${r.dir} · overflow ${r.overflowCount} (base ${baseOverflow})${untr !== null ? ` · ${untr}% unchanged from base` : ''}`
                        return (
                          <li key={r.locale} className={`ac-row ${clean ? 'covered' : 'uncovered'}`}>
                            <span className="ac-mark">{clean ? '✓' : '⚠'}</span>
                            <span className="ac-text">
                              <strong>{r.locale}</strong>
                              {i === 0 ? ' (base)' : ''}
                              {r.screenshotPath && (
                                <button
                                  className="ac-shot"
                                  onClick={() =>
                                    window.api.library.openScreenshot(r.screenshotPath!)
                                  }
                                >
                                  📷
                                </button>
                              )}
                            </span>
                            {r.ok ? (
                              <span className="ac-tests" title={raw}>
                                {plain}
                              </span>
                            ) : (
                              <span className="ac-tests" title={r.error || undefined}>
                                Couldn’t finish the run
                                {r.failedAt != null ? ` — stopped at step ${r.failedAt + 1}` : ''}
                                {r.error ? `: ${r.error}` : ''}
                              </span>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </>
                )
              })()}
            </div>
            <div className="modal-footer">
              <button className="modal-btn primary" onClick={() => setLocaleReportOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
  )
}
