import React from 'react'

// =====================================================================
// F32 — the monitors dashboard, lifted out of App.tsx verbatim.
//
// The JSX below is UNCHANGED from where it lived before: every prop is
// destructured under the name the markup already used, so the move cannot alter
// behaviour by renaming something. That matters more than tidiness here —
// App.tsx has no test coverage of its own, so a mechanical move the compiler can
// check is worth far more than a clever one it cannot.
//
// Rendered from BOTH the welcome and workspace screens (two separate returns),
// which is why it was a standalone value in App.tsx rather than inline JSX.
// =====================================================================

type Monitor = Awaited<ReturnType<typeof window.api.monitors.list>>[number]

export interface MonitorsModalProps {
  monitorsOpen: boolean
  setMonitorsOpen: (open: boolean) => void
  monitors: Monitor[]
  setMonitors: (m: Monitor[]) => void
  monRunningId: string | null
  monWebhook: string
  setMonWebhook: (v: string) => void
  monTestSel: string
  setMonTestSel: (v: string) => void
  monInterval: number
  setMonInterval: (v: number) => void
  monAlert: boolean
  setMonAlert: (v: boolean) => void
  monEnvId: string
  setMonEnvId: (v: string) => void
  monHistoryFor: string | null
  setMonHistoryFor: (v: string | null) => void
  savedTests: SavedTestSummary[]
  envState: EnvState
  runMonitorNow: (m: Monitor) => Promise<void>
  runAllMonitorsNow: () => Promise<void>
  // Any batch in flight — drives the amber "the page is hidden" note. Passed as
  // one boolean rather than four run states: the modal does not care WHICH kind
  // of batch is running, only that one is, and every previous bug in this area
  // came from a caller checking three of the four.
  batchRunning: boolean
}

export function MonitorsModal({
  monitorsOpen,
  setMonitorsOpen,
  monitors,
  setMonitors,
  monRunningId,
  monWebhook,
  setMonWebhook,
  monTestSel,
  setMonTestSel,
  monInterval,
  setMonInterval,
  monAlert,
  setMonAlert,
  monEnvId,
  setMonEnvId,
  monHistoryFor,
  setMonHistoryFor,
  savedTests,
  envState,
  runMonitorNow,
  runAllMonitorsNow,
  batchRunning
}: MonitorsModalProps): React.JSX.Element | null {
  if (!monitorsOpen) return null
  return (
    <div className="modal-backdrop" onClick={() => setMonitorsOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">📡 Monitors — scheduled re-runs + failure alerts</span>
          <button className="modal-close" onClick={() => setMonitorsOpen(false)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="ac-body">
          <p className="api-hint">
            A monitor re-runs a saved test on a schedule (headless) and pops a desktop alert when it
            fails — catching regressions between your manual runs.{' '}
            <strong>It only runs while this app is open</strong> (there's no background service), and
            it needs Playwright installed (same as cross-browser).
          </p>
          {monRunningId && (
            <p className="api-hint" style={{ color: '#7fd39a' }}>
              ⏳ A monitor run is in progress (headless, ~10–30s)… the row updates when it finishes.
            </p>
          )}
          {/* Opening ANY modal shrinks the native browser pane to nothing, or the
              dialog would render underneath it. That is normally invisible — but
              a screenshot of a hidden view comes back EMPTY, so a variant that
              fails while this is open loses its failure screenshot. Now that this
              dashboard can be opened mid-batch from the workspace, say so instead
              of quietly costing evidence. */}
          {batchRunning && (
            <p className="api-hint" style={{ color: '#e0b56b' }}>
              ⚠ A batch is running. The page is hidden while this dialog is open — the run
              continues normally, but a step that fails right now would save an empty failure
              screenshot. Close this to bring the page back.
            </p>
          )}
          {/* F32b: a failing run retries up to 3× before alerting (kills transient
              blips); alerts also POST to this webhook if set (off-machine reach). */}
          <label className="api-field">
            <span>Alert webhook — Slack / Discord / Teams (optional)</span>
            <input
              className="url-input"
              type="text"
              placeholder="https://hooks.slack.com/services/…  (also fires the desktop alert)"
              value={monWebhook}
              onChange={(e) => {
                setMonWebhook(e.target.value)
                const v = e.target.value.trim()
                if (v) localStorage.setItem('monitor.webhookUrl', v)
                else localStorage.removeItem('monitor.webhookUrl')
              }}
            />
          </label>
          <div className="mon-add">
            <select
              className="env-bar-select"
              value={monTestSel}
              onChange={(e) => setMonTestSel(e.target.value)}
            >
              <option value="">Pick a test to monitor…</option>
              {savedTests.map((t) => (
                <option key={t.fileName} value={t.fileName}>
                  {t.name}
                </option>
              ))}
            </select>
            <select
              className="env-bar-select"
              value={monInterval}
              onChange={(e) => setMonInterval(Number(e.target.value))}
            >
              <option value={5}>every 5 min</option>
              <option value={15}>every 15 min</option>
              <option value={30}>every 30 min</option>
              <option value={60}>every hour</option>
              <option value={240}>every 4 hours</option>
            </select>
            <select
              className="env-bar-select"
              value={monEnvId}
              onChange={(e) => setMonEnvId(e.target.value)}
              title="Which environment this monitor always runs against (independent of the global Run-against selection)"
            >
              <option value="">against recorded URLs</option>
              {envState.environments.map((env) => (
                <option key={env.id} value={env.id}>
                  against {env.name}
                </option>
              ))}
            </select>
            <label className="mon-alert-toggle" title="Fire a desktop notification when a run fails">
              <input
                type="checkbox"
                checked={monAlert}
                onChange={(e) => setMonAlert(e.target.checked)}
              />{' '}
              alert on fail
            </label>
            <button
              className="modal-btn primary"
              disabled={!monTestSel}
              onClick={async () => {
                const t = savedTests.find((s) => s.fileName === monTestSel)
                if (!t) return
                setMonitors(
                  await window.api.monitors.save({
                    id: `mon-${Date.now()}`,
                    fileName: t.fileName,
                    name: t.name,
                    intervalMin: monInterval,
                    enabled: true,
                    alertOnFail: monAlert,
                    envId: monEnvId || null,
                    lastRunAt: null,
                    runs: []
                  })
                )
                setMonTestSel('')
              }}
            >
              + Add monitor
            </button>
          </div>
          {monitors.length === 0 ? (
            <p className="api-hint">No monitors yet — pick a test above to start watching it.</p>
          ) : (
            <>
              <div className="mon-runall">
                <button
                  className="mon-btn primary"
                  disabled={monRunningId !== null}
                  onClick={runAllMonitorsNow}
                >
                  {monRunningId ? '⏳ running…' : `▶ Run all ${monitors.length} now`}
                </button>
                <span className="mon-runall-hint">
                  Runs every monitor once, in order — a one-click health check.
                </span>
              </div>
              <ul className="mon-list">
              {monitors.map((m) => {
                const last = m.runs[0]
                // One obvious status per monitor, so it's never a mystery whether
                // it's running, healthy, broken, or off.
                const running = monRunningId === m.id
                const status = running
                  ? { cls: 'running', label: '⏳ Running…' }
                  : !m.enabled
                    ? { cls: 'paused', label: '⏸ Paused' }
                    : !last
                      ? { cls: 'new', label: '• Never run' }
                      : last.status === 'passed'
                        ? { cls: 'pass', label: '✓ Passing' }
                        : last.status === 'failed'
                          ? { cls: 'fail', label: '✗ Failing' }
                          : { cls: 'err', label: '⚠ Can’t run' }
                // A monitor can outlive the environment it was pinned to. That used
                // to be near-silent — grey text reading "a deleted env" — while the
                // real consequence was severe: no pinned env means NO variables are
                // applied at all (see the `pinned` lookup in doMonitorRun), so a
                // test whose data rows use {{env:…}} logs in with an unresolved
                // token and fails on whatever assertion happens to come first.
                const envMissing = !!m.envId && !envState.environments.some((e) => e.id === m.envId)
                return (
                  <li key={m.id} className={`mon-card ${status.cls}`}>
                    <div className="mon-card-head">
                      <span className={`mon-status ${status.cls}`}>{status.label}</span>
                      <span className="mon-title">{m.name}</span>
                      <div className="mon-actions">
                        <button
                          className="mon-btn"
                          onClick={async () =>
                            setMonitors(await window.api.monitors.save({ ...m, enabled: !m.enabled }))
                          }
                          title={m.enabled ? 'Pause this monitor' : 'Resume this monitor'}
                        >
                          {m.enabled ? '⏸ pause' : '▶ resume'}
                        </button>
                        <button
                          className="mon-btn primary"
                          disabled={monRunningId !== null}
                          title={
                            monRunningId && !running
                              ? 'Another monitor is running — one headless run at a time'
                              : 'Run this test headless right now (~10–30s)'
                          }
                          onClick={() => runMonitorNow(m)}
                        >
                          {running ? '⏳ running…' : '▶ run now'}
                        </button>
                        <button
                          className="mon-btn"
                          onClick={() => setMonHistoryFor(monHistoryFor === m.id ? null : m.id)}
                        >
                          {monHistoryFor === m.id ? 'hide history' : `history (${m.runs.length})`}
                        </button>
                        <button
                          className="mon-btn danger"
                          onClick={async () => setMonitors(await window.api.monitors.delete(m.id))}
                        >
                          remove
                        </button>
                      </div>
                    </div>
                    <div className="mon-meta">
                      {/* The schedule is EDITABLE here. It used to be plain text,
                          set once when the monitor was created and never again —
                          so changing a monitor's cadence meant deleting it and
                          rebuilding it, which threw away its whole run history.
                          Takes effect immediately: the scheduler computes "due"
                          as lastRunAt + intervalMin, so shortening the interval
                          on a monitor that ran a while ago makes it due at once. */}
                      Runs{' '}
                      <select
                        className="mon-interval"
                        value={m.intervalMin}
                        title="How often this monitor re-runs (applies from its last run)"
                        onChange={async (e) =>
                          setMonitors(
                            await window.api.monitors.save({
                              ...m,
                              intervalMin: Number(e.target.value)
                            })
                          )
                        }
                      >
                        <option value={5}>every 5 min</option>
                        <option value={15}>every 15 min</option>
                        <option value={30}>every 30 min</option>
                        <option value={60}>every hour</option>
                        <option value={240}>every 4 hours</option>
                      </select>{' '}
                      · against{' '}
                      {/* Also editable now. Pinning was set once at creation, so a
                          monitor pointing at a deleted (or simply wrong) environment
                          could only be corrected by deleting and rebuilding it —
                          throwing away its whole run history to change one field. */}
                      <select
                        className={`mon-interval${envMissing ? ' missing' : ''}`}
                        value={envMissing ? '__missing' : (m.envId ?? '')}
                        title="Which environment's baseURL + variables this monitor runs against"
                        onChange={async (e) =>
                          setMonitors(
                            await window.api.monitors.save({
                              ...m,
                              envId: e.target.value === '' ? null : e.target.value
                            })
                          )
                        }
                      >
                        <option value="">recorded URLs</option>
                        {envState.environments.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name}
                          </option>
                        ))}
                        {/* Kept selectable-looking so the dropdown shows the truth
                            rather than silently reading as "recorded URLs", which is
                            what it actually falls back to at run time. */}
                        {envMissing && (
                          <option value="__missing" disabled>
                            ⚠ deleted environment
                          </option>
                        )}
                      </select>
                      {m.alertOnFail ? ' · 🔔 alerts on failure' : ''} ·{' '}
                      {last
                        ? `last run ${last.status} at ${new Date(last.at).toLocaleTimeString()}`
                        : 'not run yet'}
                    </div>
                    {monHistoryFor === m.id && (
                      <div className="mon-history">
                        {m.runs.length === 0 ? (
                          <div className="mon-history-empty">No runs yet — hit “run now”.</div>
                        ) : (
                          m.runs.map((r, i) => (
                            <div key={i} className={`mon-history-row ${r.status}`}>
                              <span className="mon-history-mark">
                                {r.status === 'passed' ? '✓' : r.status === 'failed' ? '✗' : '⚠'}
                              </span>
                              <span className="mon-history-when">
                                {new Date(r.at).toLocaleString()}
                              </span>
                              <span className="mon-history-detail">{r.detail || 'passed'}</span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
              </ul>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="modal-btn primary" onClick={() => setMonitorsOpen(false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
