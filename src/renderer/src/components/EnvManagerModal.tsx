import React from 'react'

// =====================================================================
// F25 — the environment / config manager.
//
// Opened from BOTH the library and the workspace test-bar chip, which live in
// two separate returns — that is why it was a standalone value in App.tsx rather
// than inline JSX, and why it stays one here.
//
// JSX moved verbatim; props destructured under the names the markup already
// used, so the compiler verifies the move rather than my reading of it.
// =====================================================================

export interface EnvManagerModalProps {
  envManagerOpen: boolean
  setEnvManagerOpen: (v: boolean) => void
  envState: EnvState
  setEnvState: React.Dispatch<React.SetStateAction<EnvState>>
  envDraft: Environment | null
  setEnvDraft: React.Dispatch<React.SetStateAction<Environment | null>>
  setActiveEnv: (id: string | null) => Promise<void>
  saveEnv: (env: Environment) => Promise<void>
  deleteEnv: (id: string) => Promise<void>
  warnsReset: boolean
  setWarnsReset: (v: boolean) => void
}

export function EnvManagerModal({
  envManagerOpen,
  setEnvManagerOpen,
  envState,
  setEnvState,
  envDraft,
  setEnvDraft,
  setActiveEnv,
  saveEnv,
  deleteEnv,
  warnsReset,
  setWarnsReset
}: EnvManagerModalProps): React.JSX.Element | null {
  if (!envManagerOpen) return null
  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        setEnvManagerOpen(false)
        setEnvDraft(null)
      }}
    >
      <div className="env-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">
            🌐 Environments
            {envDraft && ` · ${envDraft.name || 'new environment'}`}
          </span>
          <button
            className="modal-close"
            onClick={() => {
              setEnvManagerOpen(false)
              setEnvDraft(null)
            }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {envDraft ? (
          // --- Edit one environment ---
          <div className="env-edit">
            <label className="env-field">
              <span className="env-field-label">Name</span>
              <input
                className="env-field-input"
                value={envDraft.name}
                placeholder="e.g. Staging"
                onChange={(e) => setEnvDraft({ ...envDraft, name: e.target.value })}
                autoFocus
                spellCheck={false}
              />
            </label>
            <label className="env-field">
              <span className="env-field-label">Base URL</span>
              <input
                className="env-field-input"
                value={envDraft.baseURL}
                placeholder="https://staging.example.com"
                onChange={(e) => setEnvDraft({ ...envDraft, baseURL: e.target.value })}
                spellCheck={false}
              />
            </label>
            <div className="env-field-help">
              At run time, every navigation recorded under a test&rsquo;s own base URL is
              re-pointed here &mdash; the saved test is never changed.
            </div>

            <div className="env-vars">
              <div className="env-vars-head">
                <span className="env-field-label">Variables</span>
                <span className="env-vars-hint">
                  Referenced in steps as <code>{'{{env:NAME}}'}</code> &mdash; e.g. a login
                  field. Each environment supplies its own values.
                </span>
              </div>
              {envDraft.vars.length === 0 && <div className="env-vars-empty">No variables yet.</div>}
              {envDraft.vars.map((v, vi) => (
                <div key={vi} className="env-var-row">
                  <input
                    className="env-var-name"
                    value={v.name}
                    placeholder="NAME"
                    onChange={(e) =>
                      setEnvDraft({
                        ...envDraft,
                        vars: envDraft.vars.map((x, i) =>
                          i === vi ? { ...x, name: e.target.value } : x
                        )
                      })
                    }
                    spellCheck={false}
                  />
                  <input
                    className="env-var-value"
                    type={v.secret ? 'password' : 'text'}
                    value={v.value}
                    placeholder="value"
                    onChange={(e) =>
                      setEnvDraft({
                        ...envDraft,
                        vars: envDraft.vars.map((x, i) =>
                          i === vi ? { ...x, value: e.target.value } : x
                        )
                      })
                    }
                    spellCheck={false}
                  />
                  <label
                    className="env-var-secret"
                    title="Mask this value on screen (a password)"
                  >
                    <input
                      type="checkbox"
                      checked={!!v.secret}
                      onChange={(e) =>
                        setEnvDraft({
                          ...envDraft,
                          vars: envDraft.vars.map((x, i) =>
                            i === vi ? { ...x, secret: e.target.checked } : x
                          )
                        })
                      }
                    />
                    secret
                  </label>
                  <button
                    type="button"
                    className="env-var-remove"
                    aria-label="Remove variable"
                    onClick={() =>
                      setEnvDraft({
                        ...envDraft,
                        vars: envDraft.vars.filter((_, i) => i !== vi)
                      })
                    }
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="env-add-var"
                onClick={() =>
                  setEnvDraft({
                    ...envDraft,
                    vars: [...envDraft.vars, { name: '', value: '' }]
                  })
                }
              >
                + Add variable
              </button>
            </div>

            <div className="modal-footer">
              <button className="modal-btn" onClick={() => setEnvDraft(null)}>
                Cancel
              </button>
              <button
                className="modal-btn primary"
                disabled={!envDraft.name.trim()}
                onClick={async () => {
                  // Drop half-typed variable rows (no name) before saving.
                  const clean: Environment = {
                    ...envDraft,
                    name: envDraft.name.trim(),
                    baseURL: envDraft.baseURL.trim().replace(/\/+$/, ''),
                    vars: envDraft.vars.filter((v) => v.name.trim())
                  }
                  await saveEnv(clean)
                  setEnvDraft(null)
                }}
              >
                Save environment
              </button>
            </div>
          </div>
        ) : (
          // --- List of environments ---
          <div className="env-list">
            <p className="env-list-intro">
              Define your dev / staging / prod environments once, then run any test &mdash; or the
              whole suite &mdash; against any of them. The active environment re-points navigations
              and fills <code>{'{{env:NAME}}'}</code> credentials.
            </p>
            {envState.environments.length === 0 ? (
              <div className="env-empty">No environments yet &mdash; add your first.</div>
            ) : (
              <ul className="env-items">
                {envState.environments.map((env) => (
                  <li
                    key={env.id}
                    className={`env-item${env.id === envState.activeId ? ' active' : ''}`}
                  >
                    <label className="env-item-pick" title="Make this the active environment">
                      <input
                        type="radio"
                        name="active-env"
                        checked={env.id === envState.activeId}
                        onChange={() => setActiveEnv(env.id)}
                      />
                      <span className="env-item-name">{env.name}</span>
                    </label>
                    <span className="env-item-base">{env.baseURL || 'no base URL'}</span>
                    <span className="env-item-vars">
                      {env.vars.length} var{env.vars.length === 1 ? '' : 's'}
                    </span>
                    <button type="button" className="env-item-btn" onClick={() => setEnvDraft(env)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="env-item-btn danger"
                      onClick={() => {
                        if (window.confirm(`Delete environment "${env.name}"?`)) deleteEnv(env.id)
                      }}
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="modal-footer">
              {/* "Don't ask again" is never a one-way door. */}
              <button
                className="modal-btn"
                onClick={() => {
                  window.api.environments.forgetRetarget().then(setEnvState)
                  setWarnsReset(true)
                  window.setTimeout(() => setWarnsReset(false), 2000)
                }}
                title="Show the host-mismatch warning again for every environment you dismissed"
              >
                {warnsReset ? '✓ Warnings reset' : 'Reset run warnings'}
              </button>
              <button
                className="modal-btn"
                onClick={() => setActiveEnv(null)}
                disabled={!envState.activeId}
                title="Run against each test's own recorded URLs"
              >
                Use recorded URLs
              </button>
              <button
                className="modal-btn primary"
                onClick={() =>
                  setEnvDraft({ id: `env-${Date.now()}`, name: '', baseURL: '', vars: [] })
                }
              >
                + Add environment
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
