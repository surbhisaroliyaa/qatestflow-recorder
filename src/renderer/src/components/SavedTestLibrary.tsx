import React from 'react'
import type { SuiteRunState } from '../suiteTypes'
import { CATEGORY_LABELS } from '../uiLabels'
import { trustScore } from '../trust'
import { allTags } from '../tags'
import { classifyRuns } from '../flaky'

// =====================================================================
// SavedTestLibrary — lifted out of App.tsx verbatim.
//
// Was an inline {cond && (…)} block inside the workspace return. Props are
// destructured under the names the markup already used; the open condition is
// re-expressed as an early return, because a component that simply returns the
// JSX would render ALWAYS.
// =====================================================================

export interface SavedTestLibraryProps {
  activeEnv: Environment | null
  anyLibraryFilter: () => boolean
  breakdownOpen: boolean
  bundleBusy: boolean
  envState: EnvState
  errorOpenFor: string | null
  failureFilter: FailureCategory | null
  filterCollapsed: Set<string>
  handleCloneTest: (test: SavedTestSummary) => Promise<void>
  handleDeleteSelected: () => Promise<void>
  handleDeleteTest: (test: SavedTestSummary) => Promise<void>
  handleExportBundle: () => Promise<void>
  handleInspectBundle: () => Promise<void>
  handleLoadTest: (fileName: string) => Promise<void>
  handleOpenAcChecklist: () => Promise<void>
  handleRunSelected: () => void
  handleRunSuite: (
    suite: string,
    tests: SavedTestSummary[],
    opts?: { forceSequential?: boolean }
  ) => Promise<void>
  handleSuiteDocs: () => Promise<void>
  importDone: string | null
  libraryFilter: 'all' | 'failing' | 'passing' | 'flaky'
  librarySearch: string
  matchesLibraryFilters: (t: SavedTestSummary) => boolean
  monitors: Awaited<ReturnType<typeof window.api.monitors.list>>
  openSuites: Set<string>
  openTrace: (id: string) => Promise<void>
  parallelMode: boolean
  parallelWorkers: number
  savedTests: SavedTestSummary[]
  selectedTests: Set<string>
  setActiveEnv: (id: string | null) => Promise<void>
  setBreakdownOpen: React.Dispatch<React.SetStateAction<boolean>>
  setEnvDraft: React.Dispatch<React.SetStateAction<Environment | null>>
  setEnvManagerOpen: React.Dispatch<React.SetStateAction<boolean>>
  setErrorOpenFor: React.Dispatch<React.SetStateAction<string | null>>
  setFailureFilter: React.Dispatch<React.SetStateAction<FailureCategory | null>>
  setFilterCollapsed: React.Dispatch<React.SetStateAction<Set<string>>>
  setImportDone: React.Dispatch<React.SetStateAction<string | null>>
  setLibraryFilter: React.Dispatch<React.SetStateAction<'all' | 'failing' | 'passing' | 'flaky'>>
  setLibrarySearch: React.Dispatch<React.SetStateAction<string>>
  setMonHistoryFor: React.Dispatch<React.SetStateAction<string | null>>
  setMonTestSel: React.Dispatch<React.SetStateAction<string>>
  setMonitorsOpen: React.Dispatch<React.SetStateAction<boolean>>
  setParallelMode: React.Dispatch<React.SetStateAction<boolean>>
  setParallelWorkers: React.Dispatch<React.SetStateAction<number>>
  setSelectedTests: React.Dispatch<React.SetStateAction<Set<string>>>
  setTagFilter: React.Dispatch<React.SetStateAction<Set<string>>>
  suiteRun: SuiteRunState | null
  suites: string[]
  tagFilter: Set<string>
  toggleSelect: (fileName: string) => void
  toggleSuite: (key: string, filtering: boolean) => void
}

export function SavedTestLibrary({
  activeEnv,
  anyLibraryFilter,
  breakdownOpen,
  bundleBusy,
  envState,
  errorOpenFor,
  failureFilter,
  filterCollapsed,
  handleCloneTest,
  handleDeleteSelected,
  handleDeleteTest,
  handleExportBundle,
  handleInspectBundle,
  handleLoadTest,
  handleOpenAcChecklist,
  handleRunSelected,
  handleRunSuite,
  handleSuiteDocs,
  importDone,
  libraryFilter,
  librarySearch,
  matchesLibraryFilters,
  monitors,
  openSuites,
  openTrace,
  parallelMode,
  parallelWorkers,
  savedTests,
  selectedTests,
  setActiveEnv,
  setBreakdownOpen,
  setEnvDraft,
  setEnvManagerOpen,
  setErrorOpenFor,
  setFailureFilter,
  setFilterCollapsed,
  setImportDone,
  setLibraryFilter,
  setLibrarySearch,
  setMonHistoryFor,
  setMonTestSel,
  setMonitorsOpen,
  setParallelMode,
  setParallelWorkers,
  setSelectedTests,
  setTagFilter,
  suiteRun,
  suites,
  tagFilter,
  toggleSelect,
  toggleSuite
}: SavedTestLibraryProps): React.JSX.Element | null {
  if (!((savedTests.length > 0 || suites.length > 0))) return null
  return (
            <div className="test-library">
              {/* F39: a parallel batch stays HERE rather than switching to the
                  workspace (it never drives the embedded browser, so that view
                  would just be an empty pane). So the progress line has to live
                  in the library too. */}
              {suiteRun?.running && (
                <div className="replay-status running">
                  {suiteRun.parallelBatch ? (
                    <>
                      Running {suiteRun.parallelBatch} test
                      {suiteRun.parallelBatch === 1 ? '' : 's'} at once, {parallelWorkers} at a
                      time…
                    </>
                  ) : (
                    <>
                      Running {suiteRun.suite} — {suiteRun.current} of {suiteRun.total}
                      {suiteRun.currentName ? `: ${suiteRun.currentName}` : ''}
                    </>
                  )}
                </div>
              )}
              <div className="library-heading">
                <span className="library-heading-title">Test Library</span>
                <span className="library-heading-sub">
                  {savedTests.length === 0
                    ? 'your saved test flows will appear here'
                    : `${savedTests.length} saved test flow${savedTests.length === 1 ? '' : 's'}`}
                </span>
              </div>

              {/* F25 (environment manager): pick which environment the whole
                  library runs against — Run All / Run selected honor it. */}
              <div className="env-bar">
                <span className="env-bar-label">🌐 Run against</span>
                <select
                  className="env-bar-select"
                  value={envState.activeId ?? ''}
                  onChange={(e) => setActiveEnv(e.target.value || null)}
                  title="The environment every test runs against — its base URL re-points navigations and its variables fill {{env:NAME}} credentials. The saved tests are never changed."
                >
                  <option value="">Recorded URLs (default)</option>
                  {envState.environments.map((env) => (
                    <option key={env.id} value={env.id}>
                      {env.name}
                    </option>
                  ))}
                </select>
                {activeEnv?.baseURL && <span className="env-bar-base">{activeEnv.baseURL}</span>}
                <button
                  type="button"
                  className="env-bar-manage"
                  onClick={() => {
                    setEnvDraft(null)
                    setEnvManagerOpen(true)
                  }}
                >
                  Manage…
                </button>
                {/* F31: one plain-English coverage doc for the whole library. */}
                {savedTests.length > 0 && (
                  <button
                    type="button"
                    className="env-bar-manage"
                    onClick={handleSuiteDocs}
                    title="Suite docs: a plain-English coverage document across every saved test — what QA covers, with a ⚠ on tests that verify nothing"
                  >
                    📖 Suite docs
                  </button>
                )}
                {/* F31: acceptance-criteria checklist — enter ACs, see coverage gaps. */}
                <button
                  type="button"
                  className="env-bar-manage"
                  onClick={handleOpenAcChecklist}
                  title="AC checklist: enter your acceptance criteria and see which tests cover each — an uncovered AC is a coverage gap"
                >
                  ✅ AC checklist
                </button>
                {/* F32: promote saved tests to scheduled monitors + failure alerts. */}
                <button
                  type="button"
                  className={`env-bar-manage${monitors.some((m) => m.enabled) ? ' monitoring' : ''}`}
                  onClick={() => {
                    setMonTestSel('')
                    setMonHistoryFor(null)
                    setMonitorsOpen(true)
                  }}
                  title="Monitors: re-run a saved test on a schedule and get a desktop alert when it fails (runs while the app is open)"
                >
                  📡 Monitors{monitors.length ? ` (${monitors.length})` : ''}
                </button>
              </div>

              {/* A1 (scalable library): search + status filters, so a big library
                  stays navigable. Only shown once there are a few tests. */}
              {savedTests.length > 3 && (
                <div className="library-toolbar">
                  <input
                    className="library-search"
                    value={librarySearch}
                    onChange={(e) => setLibrarySearch(e.target.value)}
                    placeholder="🔎 search tests by name…"
                    spellCheck={false}
                  />
                  <div className="library-filters">
                    {(['all', 'failing', 'passing', 'flaky'] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        className={`library-filter-chip${libraryFilter === f ? ' active' : ''}`}
                        onClick={() => setLibraryFilter(f)}
                      >
                        {f === 'all'
                          ? 'All'
                          : f === 'failing'
                            ? '✗ Failing'
                            : f === 'passing'
                              ? '✓ Passing'
                              : '⚡ Flaky'}
                      </button>
                    ))}
                    {/* F9 category drill-in, co-located with the status filters —
                        a quiet "by cause" toggle that expands the category chips
                        RIGHT HERE, beside the status chips (compose both without
                        jumping around the page). Only when something is failing. */}
                    {(() => {
                      const failing = savedTests.filter((t) => t.lastRun?.status === 'failed')
                      if (!failing.length) return null
                      const counts = new Map<string, number>()
                      for (const t of failing) {
                        const c = (t.lastRun?.category as string) || 'unknown'
                        counts.set(c, (counts.get(c) ?? 0) + 1)
                      }
                      const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1])
                      return (
                        <>
                          <button
                            type="button"
                            className={`library-filter-chip${breakdownOpen ? ' active' : ''}`}
                            onClick={() =>
                              setBreakdownOpen((o) => {
                                if (o) setFailureFilter(null) // collapsing clears the drill-in
                                return !o
                              })
                            }
                            title="Filter the failing tests by cause"
                          >
                            🩹 by cause {breakdownOpen ? '▾' : '▸'}
                          </button>
                          {breakdownOpen &&
                            ordered.map(([cat, n]) => (
                              <button
                                key={cat}
                                type="button"
                                className={`category-chip cat-${cat} breakdown-chip${
                                  failureFilter === cat ? ' active' : ''
                                }`}
                                onClick={() =>
                                  setFailureFilter((f) =>
                                    f === cat ? null : (cat as FailureCategory)
                                  )
                                }
                                title={`Show the ${n} test${n > 1 ? 's' : ''} that failed with "${
                                  CATEGORY_LABELS[cat as FailureCategory] ?? cat
                                }"`}
                              >
                                {CATEGORY_LABELS[cat as FailureCategory] ?? cat} <strong>{n}</strong>
                              </button>
                            ))}
                        </>
                      )
                    })()}
                    {anyLibraryFilter() && (
                      <button
                        type="button"
                        className="library-filter-clear"
                        onClick={() => {
                          setLibrarySearch('')
                          setLibraryFilter('all')
                          setFailureFilter(null)
                          setTagFilter(new Set()) // F38
                          // Collapses you made DURING a filter belonged to that
                          // filter — don't carry them into the unfiltered view.
                          setFilterCollapsed(new Set())
                        }}
                      >
                        clear ✕
                      </button>
                    )}
                    {/* A2: select every test currently matching the filters. */}
                    <button
                      type="button"
                      className="library-filter-clear"
                      onClick={() =>
                        setSelectedTests(
                          new Set(savedTests.filter(matchesLibraryFilters).map((t) => t.fileName))
                        )
                      }
                    >
                      select all{anyLibraryFilter() ? ' shown' : ''}
                    </button>
                  </div>
                  {/* F40: share the library. Exports whatever the filters/ticks
                      currently show — so "share the smoke suite" is just
                      filter by @smoke, then 📦 Export. */}
                  <div className="library-filters bundle-bar">
                    <button
                      type="button"
                      className="library-filter-clear"
                      disabled={bundleBusy}
                      onClick={handleExportBundle}
                      title="Export the tests currently shown (or ticked) as a portable folder you can commit to git or zip and send"
                    >
                      📦 Export bundle
                      {selectedTests.size
                        ? ` (${selectedTests.size} ticked)`
                        : anyLibraryFilter()
                          ? ' (shown)'
                          : ' (all)'}
                    </button>
                    <button
                      type="button"
                      className="library-filter-clear"
                      disabled={bundleBusy}
                      onClick={handleInspectBundle}
                      title="Import a bundle someone shared with you"
                    >
                      📥 Import bundle
                    </button>
                    {importDone && (
                      <span className="bundle-done">
                        ✓ {importDone}
                        <button type="button" className="tag-x" onClick={() => setImportDone(null)}>
                          ×
                        </button>
                      </span>
                    )}
                  </div>

                  {/* F39: parallel mode. Opt-in, and the note explains the
                      trade honestly — this is faster because it's a DIFFERENT
                      engine, not because the old one was wasting time. */}
                  <div className="library-filters parallel-bar">
                    <label className="parallel-toggle">
                      <input
                        type="checkbox"
                        checked={parallelMode}
                        onChange={(e) => setParallelMode(e.target.checked)}
                      />
                      ⚡ Run in parallel
                    </label>
                    {parallelMode && (
                      <>
                        <label className="parallel-workers">
                          workers
                          <input
                            type="number"
                            min={1}
                            max={16}
                            value={parallelWorkers}
                            onChange={(e) =>
                              setParallelWorkers(
                                Math.max(1, Math.min(16, parseInt(e.target.value, 10) || 1))
                              )
                            }
                          />
                        </label>
                        <span className="parallel-hint">
                          Runs {parallelWorkers} tests at once through real Playwright, headless.{' '}
                          <strong>Not the in-app engine</strong> — no self-heal, no recovery pause.
                          Tests with AI checks, manual steps, a11y or visual snapshots run the
                          normal way instead (the report says which).
                        </span>
                      </>
                    )}
                  </div>
                  {/* F38: tag filters, on their own row so they don't crowd the
                      status chips. Only rendered once something IS tagged —
                      an empty filter row would just be clutter. */}
                  {(() => {
                    const tagList = allTags(savedTests)
                    if (!tagList.length) return null
                    return (
                      <div className="library-filters library-tagbar">
                        <span className="tagbar-label">Tags:</span>
                        {tagList.map(({ tag, count }) => (
                          <button
                            key={tag}
                            type="button"
                            className={`tag-chip filter${tagFilter.has(tag) ? ' active' : ''}`}
                            onClick={() =>
                              setTagFilter((prev) => {
                                const next = new Set(prev)
                                if (next.has(tag)) next.delete(tag)
                                else next.add(tag)
                                return next
                              })
                            }
                            title={`${count} test${count === 1 ? '' : 's'} tagged ${tag}`}
                          >
                            {tag} <strong>{count}</strong>
                          </button>
                        ))}
                        {tagFilter.size > 0 && (
                          <>
                            {/* The payoff: tick everything currently listed, then
                                ▶ Run selected. "Run all @smoke" without keeping a
                                second list of which tests those are.
                                Labelled "shown", NOT "@smoke": it ticks what the
                                WHOLE filter bar is showing — tags plus any search,
                                status or section drill-in. Naming it after the tags
                                alone promised 4 and delivered 1 the moment a search
                                was also active (Surbhi, Test 6). */}
                            <button
                              type="button"
                              className="library-filter-clear runtag"
                              onClick={() =>
                                setSelectedTests(
                                  new Set(
                                    savedTests
                                      .filter(matchesLibraryFilters)
                                      .map((t) => t.fileName)
                                  )
                                )
                              }
                              title="Tick every test currently shown — these tags plus any search, status or section filter — ready to ▶ Run selected"
                            >
                              ▶ select all shown
                            </button>
                            <button
                              type="button"
                              className="library-filter-clear"
                              onClick={() => setTagFilter(new Set())}
                            >
                              clear tags ✕
                            </button>
                          </>
                        )}
                      </div>
                    )
                  })()}
                </div>
              )}

              {/* A2 (scalable library): bulk-action bar — appears once tests are
                  ticked. Run / delete the whole selection at once (the payoff of
                  the search + F9 category drill-in: operate on a group). */}
              {selectedTests.size > 0 && (
                <div className="library-bulkbar">
                  <span className="library-bulk-count">{selectedTests.size} selected</span>
                  <button type="button" className="library-bulk-btn" onClick={handleRunSelected}>
                    ▶ Run selected
                  </button>
                  <button
                    type="button"
                    className="library-bulk-btn danger"
                    onClick={handleDeleteSelected}
                  >
                    🗑 Delete
                  </button>
                  <button
                    type="button"
                    className="library-filter-clear"
                    onClick={() => setSelectedTests(new Set())}
                  >
                    clear ✕
                  </button>
                </div>
              )}

              {(() => {
                // Sections in display order: E2E + Daily always shown (even
                // empty, so they're discoverable), customs after, legacy
                // root-level tests last under "Unsorted".
                const groups = [...suites]
                for (const t of savedTests) {
                  if (t.suite && !groups.includes(t.suite)) groups.push(t.suite)
                }
                if (savedTests.some((t) => !t.suite)) groups.push('')
                return groups.map((suite) => {
                  // A1: search + status filter + F9 category drill-in, all ANDed.
                  const tests = savedTests
                    .filter((t) => t.suite === suite)
                    .filter(matchesLibraryFilters)
                  const suiteKey = suite || '(unsorted)'
                  const filtering = anyLibraryFilter()
                  // With any filter active, hide sections that have nothing to show,
                  // and force sections open so the matches are visible.
                  if (filtering && tests.length === 0) return null
                  const isOpen = filtering
                    ? !filterCollapsed.has(suiteKey)
                    : openSuites.has(suiteKey)
                  return (
                    <div key={suiteKey} className="library-section">
                      <div className="library-section-header">
                        {/* Tick the whole section. Sections were the one grouping
                            bulk actions couldn't reach: search/status/tags all
                            NARROW the list so "select all shown" can follow them,
                            but a section only expands — so with 58 tests the only
                            select-all ticked all 58 (Surbhi, Test 7).
                            Operates on `tests`, the section's tests AFTER filters,
                            so it means the same "all shown" as the top button.
                            Adds to the existing selection rather than replacing it,
                            so E2E + three extras works.
                            ONLY WHEN THE SECTION IS OPEN: on every collapsed header
                            it made a column of bright squares down the left edge —
                            an unchecked box ignores accent-color, so it reads as a
                            white block on a dark card — and it competed with the
                            caret and title for the start of the row. Collapsed is
                            also when you can't see what you'd be ticking. Open, it
                            sits directly above the row ticks it controls. */}
                        {isOpen && tests.length > 0 && (
                          <input
                            type="checkbox"
                            className="library-check section-check"
                            checked={tests.every((t) => selectedTests.has(t.fileName))}
                            ref={(el) => {
                              if (el) {
                                const n = tests.filter((t) => selectedTests.has(t.fileName)).length
                                el.indeterminate = n > 0 && n < tests.length
                              }
                            }}
                            onChange={() =>
                              setSelectedTests((prev) => {
                                const next = new Set(prev)
                                const all = tests.every((t) => next.has(t.fileName))
                                for (const t of tests) {
                                  if (all) next.delete(t.fileName)
                                  else next.add(t.fileName)
                                }
                                return next
                              })
                            }
                            title={`Select all ${tests.length} test${tests.length === 1 ? '' : 's'} in ${suite || 'Unsorted'}`}
                            aria-label={`Select all tests in ${suite || 'Unsorted'}`}
                          />
                        )}
                        <button
                          type="button"
                          className="section-toggle"
                          onClick={() => toggleSuite(suiteKey, filtering)}
                          aria-expanded={isOpen}
                          title={isOpen ? 'Collapse section' : 'Expand section'}
                        >
                          <span className="section-caret">{isOpen ? '▾' : '▸'}</span>
                          <span className="library-title">
                            {suite ? `${suite} test flows` : 'Unsorted'}
                          </span>
                          <span className="library-count">{tests.length}</span>
                          {/* Collapsed: one dot per test — suite health at a
                              glance without expanding */}
                          {!isOpen && tests.length > 0 && (
                            <span className="suite-health">
                              {tests.slice(0, 10).map((t) => (
                                <span
                                  key={t.fileName}
                                  className={`history-dot ${t.lastRun?.status ?? 'none'}`}
                                  title={`${t.name}: ${t.lastRun ? `last replay ${t.lastRun.status}` : 'never replayed'}`}
                                />
                              ))}
                              {tests.length > 10 && (
                                <span className="suite-health-more">+{tests.length - 10}</span>
                              )}
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          className="run-suite-btn"
                          onClick={() => handleRunSuite(suite || 'Unsorted', tests)}
                          disabled={tests.length === 0}
                          title={
                            tests.length === 0
                              ? 'No tests in this section yet'
                              : `Replay all ${tests.length} test(s) in ${suite || 'Unsorted'}`
                          }
                        >
                          ▶ Run all
                        </button>
                      </div>
                      {!isOpen ? null : tests.length === 0 ? (
                        <p className="library-empty">No tests yet — save one with 💾</p>
                      ) : (
                        <ul className="library-list">
                          {tests.map((test) => {
                            // Every recorded run (newest-first). Older files kept
                            // only `lastRun`; treat that as a one-run history.
                            const allRuns =
                              test.runs && test.runs.length
                                ? test.runs
                                : test.lastRun
                                  ? [test.lastRun]
                                  : []
                            // Each failure can be a DIFFERENT error at a different
                            // time — keep them all so the user sees why AND when.
                            const failedRuns = allRuns.filter((r) => r.status === 'failed')
                            const currentlyFailing = test.lastRun?.status === 'failed'
                            // F2: one-word trust verdict from the run history.
                            const flaky = classifyRuns(allRuns)
                            // F5: composite 0–100 trust score (grade A–F).
                            const trust = trustScore(test, Date.now())
                            return (
                              <li key={test.fileName} className="library-item">
                                <div className="library-item-head">
                                  {/* A2: tick for a bulk action (run / delete). */}
                                  <input
                                    type="checkbox"
                                    className="library-check"
                                    checked={selectedTests.has(test.fileName)}
                                    onChange={() => toggleSelect(test.fileName)}
                                    title="Select for a bulk action (run / delete)"
                                    aria-label={`Select ${test.name}`}
                                  />
                                  <button
                                    type="button"
                                    className="library-row"
                                    onClick={() => handleLoadTest(test.fileName)}
                                    title={`Open "${test.name}"`}
                                  >
                                    <span
                                      className={`run-dot ${test.lastRun?.status ?? 'none'}`}
                                      title={
                                        test.lastRun
                                          ? `Last replay ${test.lastRun.status} — ${new Date(test.lastRun.at).toLocaleString()}`
                                          : 'Never replayed'
                                      }
                                    />
                                    <span className="library-name">{test.name}</span>
                                    {/* F2: last runs, NEWEST-FIRST (leftmost = most
                                        recent, next to the status dot) so the trend
                                        can't be read backwards. */}
                                    {test.runs && test.runs.length > 1 && (
                                      <span
                                        className="history-dots"
                                        title="Recent runs — leftmost is the most recent, going back in time to the right"
                                      >
                                        {test.runs.map((run, i) => (
                                          <span
                                            key={i}
                                            className={`history-dot ${run.status}${i === 0 ? ' newest' : ''}`}
                                            title={`${i === 0 ? 'most recent · ' : ''}${run.status} — ${new Date(run.at).toLocaleString()}`}
                                          />
                                        ))}
                                      </span>
                                    )}
                                    {/* F2: the one-word trust verdict (flaky / newly-broken / …). */}
                                    {flaky.tag !== 'untested' && (
                                      <span
                                        className={`flaky-tag ${flaky.tag}`}
                                        title={flaky.title}
                                      >
                                        {flaky.label}
                                      </span>
                                    )}
                                    {/* F5: composite trust grade + score, breakdown on hover. */}
                                    <span
                                      className={`trust-badge grade-${trust.grade}`}
                                      title={
                                        `Trust score ${trust.score}/100 (grade ${trust.grade}) — how much to trust this test:\n` +
                                        trust.factors
                                          .map((f) => `• ${f.label} ${f.score}/100 — ${f.note}`)
                                          .join('\n')
                                      }
                                    >
                                      {trust.grade} · {trust.score}
                                    </span>
                                    {/* F38: this test's labels, clickable to filter
                                        the library down to them. */}
                                    {(test.tags ?? []).map((tag) => (
                                      <span
                                        key={tag}
                                        className={`tag-chip row${tagFilter.has(tag) ? ' active' : ''}`}
                                        onClick={(e) => {
                                          // The whole row is a button that OPENS the
                                          // test — stop the click so tapping a tag
                                          // filters instead of navigating away.
                                          e.stopPropagation()
                                          setTagFilter((prev) => {
                                            const next = new Set(prev)
                                            if (next.has(tag)) next.delete(tag)
                                            else next.add(tag)
                                            return next
                                          })
                                        }}
                                        title={`Filter the library to ${tag}`}
                                      >
                                        {tag}
                                      </span>
                                    ))}
                                    <span className="library-meta">
                                      {test.stepCount} steps ·{' '}
                                      {new Date(test.updatedAt).toLocaleDateString()}
                                    </span>
                                  </button>
                                  {/* Any failure — current OR past — is inspectable
                                  here. A test that passes now but failed before
                                  gets a calmer "Past fail(s)" label so it doesn't
                                  read as currently broken. */}
                                  {failedRuns.length > 0 && (
                                    <button
                                      type="button"
                                      className={`library-why${errorOpenFor === test.fileName ? ' open' : ''}${currentlyFailing ? '' : ' past'}`}
                                      onClick={() =>
                                        setErrorOpenFor(
                                          errorOpenFor === test.fileName ? null : test.fileName
                                        )
                                      }
                                      title={
                                        currentlyFailing ? 'Why did it fail?' : 'Past failures'
                                      }
                                    >
                                      ⚠{' '}
                                      {failedRuns.length > 1
                                        ? `${failedRuns.length} fails`
                                        : currentlyFailing
                                          ? 'Why?'
                                          : 'Past fail'}
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="library-clone"
                                    onClick={() => handleCloneTest(test)}
                                    title={`Clone "${test.name}" into an editable copy`}
                                    aria-label={`Clone ${test.name}`}
                                  >
                                    ⧉
                                  </button>
                                  <button
                                    type="button"
                                    className="library-delete"
                                    onClick={() => handleDeleteTest(test)}
                                    title="Delete test"
                                    aria-label={`Delete ${test.name}`}
                                  >
                                    ✕
                                  </button>
                                </div>
                                {errorOpenFor === test.fileName && failedRuns.length > 0 && (
                                  <div className="run-error-detail">
                                    {/* One entry per failed run — each shows WHEN it
                                      failed and WHY (the errors can differ run to
                                      run), with a jump to that run's screenshot. */}
                                    {failedRuns.map((run, ri) => (
                                      <div key={ri} className="run-fail-entry">
                                        <div className="run-fail-when">
                                          {new Date(run.at).toLocaleString()}
                                          {run.failedAt !== undefined
                                            ? ` · step ${run.failedAt + 1}`
                                            : ''}
                                        </div>
                                        <div className="run-error-msg">
                                          {run.error || 'No error message was recorded.'}
                                        </div>
                                        <div className="run-fail-actions">
                                          {run.screenshotPath && (
                                            <button
                                              type="button"
                                              className="run-error-shot"
                                              onClick={() =>
                                                window.api.library.openScreenshot(
                                                  run.screenshotPath!
                                                )
                                              }
                                            >
                                              📷 View failure screenshot
                                            </button>
                                          )}
                                          {run.traceId && (
                                            <button
                                              type="button"
                                              className="run-error-shot"
                                              onClick={() => openTrace(run.traceId!)}
                                            >
                                              ⏺ Open recording
                                            </button>
                                          )}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </div>
                  )
                })
              })()}

              {/* A1: nothing matches the active search/filter. */}
              {anyLibraryFilter() && savedTests.filter(matchesLibraryFilters).length === 0 && (
                <div className="library-no-match">
                  No tests match{librarySearch.trim() ? ` “${librarySearch.trim()}”` : ''}
                  {libraryFilter !== 'all' ? ` · ${libraryFilter}` : ''}
                  {failureFilter ? ` · ${CATEGORY_LABELS[failureFilter] ?? failureFilter}` : ''}.
                </div>
              )}

            </div>
  )
}
