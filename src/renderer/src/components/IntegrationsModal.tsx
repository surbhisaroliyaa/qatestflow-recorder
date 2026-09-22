import React from 'react'
import { parseHeaders, postbackUrlError, gitlabConfigError } from '../../../shared/postback'

// =====================================================================
// OUTBOUND INTEGRATIONS — the settings screen  (Phase 4)
// =====================================================================
// Two separate things live here because they answer the same question from
// different directions: "how does the rest of the world find out about this?"
//
//   · POSTBACK — a machine-readable result, for a dashboard, a release gate,
//     a bot. The app already had a chat webhook (F32b), but that sends PROSE
//     about a monitor; nothing downstream can branch on "3 of 12 failed".
//   · GITLAB — a failure filed as an issue, mirroring the existing Jira
//     integration, for the tracker the team actually uses.
//
// Both hold a credential, so both say where it is stored: a tester handing a
// token to a desktop app is owed that, and the alternative is them assuming
// the worst (or, worse, assuming the best).
// =====================================================================

export interface IntegrationConfigShape {
  postback: { when: 'always' | 'failure' | 'off'; url: string; headers: string }
  gitlab: { baseUrl: string; token: string; projectId: string; labels: string }
}

export interface IntegrationsModalProps {
  integrations: IntegrationConfigShape | null
  setIntegrations: React.Dispatch<React.SetStateAction<IntegrationConfigShape | null>>
  onSave: () => Promise<void>
  onClose: () => void
  /** A postback that did not arrive on the last run — shown here because this
   *  is where it can be fixed. */
  postbackError: string | null
}

export function IntegrationsModal({
  integrations,
  setIntegrations,
  onSave,
  onClose,
  postbackError
}: IntegrationsModalProps): React.JSX.Element | null {
  if (!integrations) return null

  const urlError =
    integrations.postback.when === 'off' ? null : postbackUrlError(integrations.postback.url)
  const headerCount = Object.keys(parseHeaders(integrations.postback.headers)).length
  const typedHeaderLines = integrations.postback.headers.split('\n').filter((l) => l.trim()).length
  const glError =
    integrations.gitlab.token || integrations.gitlab.projectId
      ? gitlabConfigError(integrations.gitlab)
      : null

  const setPostback = (patch: Partial<IntegrationConfigShape['postback']>): void =>
    setIntegrations((prev) => (prev ? { ...prev, postback: { ...prev.postback, ...patch } } : prev))
  const setGitlab = (patch: Partial<IntegrationConfigShape['gitlab']>): void =>
    setIntegrations((prev) => (prev ? { ...prev, gitlab: { ...prev.gitlab, ...patch } } : prev))

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">🔗 Integrations</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          {postbackError && (
            <p className="warn-title">⚠ The last postback didn’t arrive: {postbackError}</p>
          )}

          <p className="privacy-label">Postback — tell something when a run finishes</p>
          <p className="privacy-hint">
            POSTs a small JSON result to a URL you choose, so a dashboard, a release gate or a bot
            can act on it. (The Slack/Teams webhook on a monitor sends a chat message; this sends
            data.)
          </p>

          <select
            className="trace-mode"
            value={integrations.postback.when}
            onChange={(e) => setPostback({ when: e.target.value as 'always' | 'failure' | 'off' })}
          >
            <option value="off">Don’t post</option>
            <option value="failure">Post when a run fails</option>
            <option value="always">Post after every run</option>
          </select>

          {integrations.postback.when !== 'off' && (
            <>
              <label className="privacy-label" htmlFor="pb-url">
                Receiver URL
              </label>
              <input
                id="pb-url"
                className="privacy-text"
                value={integrations.postback.url}
                onChange={(e) => setPostback({ url: e.target.value })}
                placeholder="https://hooks.example.com/qa/run"
                spellCheck={false}
              />
              {urlError && <p className="warn-title">⚠ {urlError}</p>}

              <label className="privacy-label" htmlFor="pb-headers">
                Extra headers
              </label>
              <textarea
                id="pb-headers"
                className="privacy-text"
                rows={3}
                value={integrations.postback.headers}
                onChange={(e) => setPostback({ headers: e.target.value })}
                placeholder={'Authorization: Bearer …\nX-Env: staging'}
                spellCheck={false}
              />
              <p className="privacy-hint">
                One <code>Name: value</code> per line — usually an auth token.{' '}
                {typedHeaderLines > headerCount && (
                  <span className="warn-title">
                    {typedHeaderLines - headerCount} line
                    {typedHeaderLines - headerCount === 1 ? ' is' : 's are'} being ignored
                    (Content-Type and Host are set by the app and can’t be overridden).
                  </span>
                )}
              </p>
            </>
          )}

          <p className="privacy-label">GitLab — file a failure as an issue</p>
          <p className="privacy-hint">
            The same idea as the Jira button, for GitLab. Needs a token with <code>api</code> scope.
          </p>
          <label className="privacy-label" htmlFor="gl-url">
            GitLab URL
          </label>
          <input
            id="gl-url"
            className="privacy-text"
            value={integrations.gitlab.baseUrl}
            onChange={(e) => setGitlab({ baseUrl: e.target.value })}
            placeholder="https://gitlab.com"
            spellCheck={false}
          />
          <label className="privacy-label" htmlFor="gl-project">
            Project (id or path)
          </label>
          <input
            id="gl-project"
            className="privacy-text"
            value={integrations.gitlab.projectId}
            onChange={(e) => setGitlab({ projectId: e.target.value })}
            placeholder="my-group/my-app"
            spellCheck={false}
          />
          <label className="privacy-label" htmlFor="gl-token">
            Access token
          </label>
          <input
            id="gl-token"
            className="privacy-text"
            type="password"
            value={integrations.gitlab.token}
            onChange={(e) => setGitlab({ token: e.target.value })}
            placeholder="glpat-…"
            spellCheck={false}
          />
          <label className="privacy-label" htmlFor="gl-labels">
            Labels for new issues (optional)
          </label>
          <input
            id="gl-labels"
            className="privacy-text"
            value={integrations.gitlab.labels}
            onChange={(e) => setGitlab({ labels: e.target.value })}
            placeholder="qa,automated"
            spellCheck={false}
          />
          {glError && <p className="warn-title">⚠ {glError}</p>}

          <p className="warn-note">
            These tokens are stored on this machine only, in the app’s own data folder — not in your
            Tests folder, so they can’t be committed or shared by accident.
          </p>
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="modal-btn primary" onClick={onSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
