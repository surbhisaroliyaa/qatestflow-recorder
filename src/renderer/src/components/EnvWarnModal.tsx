import React from 'react'

// =====================================================================
// EnvWarnModal — lifted out of App.tsx verbatim.
//
// Props are destructured under the names the markup already used, so the move
// cannot change behaviour by renaming. Types were inferred from each value's
// declaration in App.tsx and then checked by tsc, which is the actual authority.
// =====================================================================

export interface EnvWarnModalProps {
  activeEnv: Environment | null
  envWarn: {
    mismatches: { from: string; to: string; tests: string[] }[]
    apiHosts: { host: string; tests: string[] }[]
    resolve: (choice: 'run' | 'noenv' | 'cancel') => void
  } | null
  envWarnRemember: boolean
  setEnvWarnRemember: React.Dispatch<React.SetStateAction<boolean>>
  settleEnvWarn: (choice: 'run' | 'noenv' | 'cancel') => void
}

export function EnvWarnModal({
  activeEnv,
  envWarn,
  envWarnRemember,
  setEnvWarnRemember,
  settleEnvWarn
}: EnvWarnModalProps): React.JSX.Element | null {
  if (!(envWarn)) return null
  return (
    <div className="modal-backdrop">
      <div className="modal env-warn" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">
            {envWarn.mismatches.length === 0
              ? '⚠ API steps bypass this environment'
              : '⚠ Environment retargets this run'}
          </span>
        </div>
        <div className="env-warn-body">
          {/* Navigations retargeted to another site (the original F25 warning). */}
          {envWarn.mismatches.length > 0 && (
            <>
              <p>
                The active environment <strong>{activeEnv?.name}</strong> re-points every navigation
                at <code className="env-warn-to">{envWarn.mismatches[0].to}</code>.{' '}
                {envWarn.mismatches.length === 1 && envWarn.mismatches[0].tests.length === 1
                  ? 'This test was recorded somewhere else.'
                  : `${envWarn.mismatches.reduce((n, m) => n + m.tests.length, 0)} test(s) in this run were recorded on ${envWarn.mismatches.length} other host(s).`}
              </p>
              <div className="env-warn-hosts">
                {envWarn.mismatches.map((m) => (
                  <div key={m.from} className="env-warn-row">
                    <code>{m.from}</code>
                    <span className="env-warn-arrow">→</span>
                    <code className="env-warn-to">{m.to}</code>
                    <span className="env-warn-count" title={m.tests.join('\n')}>
                      {m.tests.length === 1 ? m.tests[0] : `${m.tests.length} tests`}
                    </span>
                  </div>
                ))}
              </div>
              <p className="env-warn-hint">
                If those aren’t the same app, the run will hit pages that don’t exist.
              </p>
            </>
          )}
          {/* F24: API steps calling a host the environment does NOT cover. These
              are NOT retargeted — the danger is an app's own API on a separate
              host, where a "staging" run would still write to PRODUCTION. */}
          {envWarn.apiHosts.length > 0 && (
            <>
              <p className="env-warn-api-lead">
                🔌 This run’s <strong>API steps</strong> call{' '}
                {envWarn.apiHosts.length === 1 ? 'a host' : `${envWarn.apiHosts.length} hosts`} the
                environment does <strong>not</strong> cover. Those calls are{' '}
                <strong>not retargeted</strong> — they go to the host below exactly as recorded,
                even though the rest of the run goes to {activeEnv?.name}.
              </p>
              <div className="env-warn-hosts">
                {envWarn.apiHosts.map((a) => (
                  <div key={a.host} className="env-warn-row">
                    <code className="env-warn-api">{a.host}</code>
                    <span className="env-warn-arrow">↛</span>
                    <span className="env-warn-nochange">not retargeted</span>
                    <span className="env-warn-count" title={a.tests.join('\n')}>
                      {a.tests.length === 1 ? a.tests[0] : `${a.tests.length} tests`}
                    </span>
                  </div>
                ))}
              </div>
              <p className="env-warn-hint">
                Fine for a third-party API (Stripe, a public endpoint). But if that host is{' '}
                <strong>your own API</strong>, this run will read and write <strong>real
                production data</strong> while everything else points at {activeEnv?.name} — add it
                to the environment’s base URL, or edit the step to use a relative host.
              </p>
            </>
          )}
          <label className="env-warn-remember">
            <input
              type="checkbox"
              checked={envWarnRemember}
              onChange={(e) => setEnvWarnRemember(e.target.checked)}
            />
            <span>
              Don’t ask again for{' '}
              {envWarn.mismatches.length + envWarn.apiHosts.length === 1 ? (
                envWarn.mismatches.length === 1 ? (
                  <>
                    <code>{envWarn.mismatches[0].from}</code> →{' '}
                    <code>{envWarn.mismatches[0].to}</code>
                  </>
                ) : (
                  <code>{envWarn.apiHosts[0].host}</code>
                )
              ) : (
                <>these {envWarn.mismatches.length + envWarn.apiHosts.length} hosts</>
              )}
              <em> (these hosts only — a new one still asks)</em>
            </span>
          </label>
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={() => settleEnvWarn('cancel')}>
            Cancel
          </button>
          <button className="modal-btn" onClick={() => settleEnvWarn('run')}>
            Run anyway
          </button>
          <button className="modal-btn primary" onClick={() => settleEnvWarn('noenv')}>
            Run without environment
          </button>
        </div>
      </div>
    </div>
  )
}
