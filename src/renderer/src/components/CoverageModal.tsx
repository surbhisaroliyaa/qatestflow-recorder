import React from 'react'

// =====================================================================
// CoverageModal — lifted out of App.tsx verbatim.
//
// Props are destructured under the names the markup already used, so the move
// cannot change behaviour by renaming. Types were inferred from each value's
// declaration in App.tsx and then checked by tsc, which is the actual authority.
// =====================================================================

export interface CoverageModalProps {
  coverageOpen: boolean
  coverageRun: {
    running: boolean
    found: number
    result: Awaited<ReturnType<typeof window.api.coverage.crawl>> | null
    coveredExact: Set<string>
    coveredContains: { value: string; origins: string[] }[]
  } | null
  normCovPath: (p: string) => string
  setCoverageOpen: React.Dispatch<React.SetStateAction<boolean>>
}

export function CoverageModal({
  coverageOpen,
  coverageRun,
  normCovPath,
  setCoverageOpen
}: CoverageModalProps): React.JSX.Element | null {
  if (!(coverageOpen)) return null
  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!coverageRun?.running) setCoverageOpen(false)
      }}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">🗺️ Coverage gap map</span>
          <button className="modal-close" onClick={() => setCoverageOpen(false)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="ac-body">
          {coverageRun?.running ? (
            <p className="api-hint">
              ⏳ Crawling from your current page… found <strong>{coverageRun.found}</strong> page
              {coverageRun.found === 1 ? '' : 's'} so far. The browser is walking the links — it
              returns to where you were when it's done.
            </p>
          ) : !coverageRun?.result || coverageRun.result.pages.length === 0 ? (
            <p className="api-hint">
              Nothing to map. Open your app in the browser first (navigate, and log in if it needs a
              session), then run 🗺️ Coverage from that page — it crawls outward from wherever you are.
            </p>
          ) : (
            (() => {
              const { result, coveredExact, coveredContains } = coverageRun
              const isCov = (path: string): boolean => {
                // Navigate coverage is scoped to THIS crawled site (origin+path),
                // so a same-path test on a different site isn't credited here.
                const full = result.origin + normCovPath(path)
                if (coveredExact.has(full)) return true
                // url-contains: matched against the PATH only (matching the full
                // URL would let a value like "https" cover everything), AND only
                // when the assert's own test drives this site, AND the value is
                // specific enough — a lone "/" or "" is too loose to be coverage.
                const p = normCovPath(path)
                return coveredContains.some(
                  (c) =>
                    c.value.replace(/\/+$/, '').length > 1 &&
                    c.origins.includes(result.origin) &&
                    p.includes(c.value)
                )
              }
              const seen = new Set<string>()
              const pages = result.pages.filter((p) => {
                const k = normCovPath(p.path)
                if (seen.has(k)) return false
                seen.add(k)
                return true
              })
              const coveredCount = pages.filter((p) => isCov(p.path)).length
              const gaps = pages.length - coveredCount
              const pct = Math.round((coveredCount / Math.max(1, pages.length)) * 100)
              const ordered = [...pages].sort(
                (a, b) => Number(isCov(a.path)) - Number(isCov(b.path))
              )
              return (
                <>
                  <p className="api-hint">
                    Crawled <strong>{pages.length}</strong> page{pages.length === 1 ? '' : 's'} from{' '}
                    <code>{result.origin}</code>
                    {result.capped ? ' (stopped at the 40-page cap)' : ''}. A page counts as tested
                    when a saved test <strong>navigates</strong> to it or <strong>asserts its URL</strong>
                    — one reached only by clicking through can still show as a gap, which is a nudge to
                    add an explicit check there.
                  </p>
                  <div className="ac-summary">
                    {coveredCount} of {pages.length} pages covered ({pct}%)
                    {gaps ? ` · ${gaps} gap${gaps === 1 ? '' : 's'} ⚠` : ' · full coverage ✓'}
                  </div>
                  <ul className="ac-list">
                    {ordered.map((p) => {
                      const cov = isCov(p.path)
                      return (
                        <li key={p.path} className={`ac-row ${cov ? 'covered' : 'uncovered'}`}>
                          <span className="ac-mark">{cov ? '✓' : '⚠'}</span>
                          <span className="ac-text">
                            <strong>{p.path}</strong>
                            <span className="mon-sub">
                              {cov ? 'covered by a test' : 'no test visits or verifies this page'}
                              {p.title && p.title !== p.path ? ` · ${p.title}` : ''}
                            </span>
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </>
              )
            })()
          )}
        </div>
        <div className="modal-footer">
          <button
            className="modal-btn primary"
            onClick={() => setCoverageOpen(false)}
            disabled={coverageRun?.running}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
