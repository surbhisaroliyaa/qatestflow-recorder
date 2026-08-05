import React from 'react'

// =====================================================================
// JiraModal — lifted out of App.tsx verbatim.
//
// Props are destructured under the names the markup already used, so the move
// cannot change behaviour by renaming. Types were inferred from each value's
// declaration in App.tsx and then checked by tsc, which is the actual authority.
// =====================================================================

export interface JiraModalProps {
  handleJiraCopyOpen: () => Promise<void>
  handleJiraCreate: () => Promise<void>
  jiraBaseUrl: string
  jiraBusy: boolean
  jiraDescText: string
  jiraEmail: string
  jiraNote: string
  jiraOpen: boolean
  jiraProject: string
  jiraSummaryText: string
  jiraToken: string
  setJiraBaseUrl: React.Dispatch<React.SetStateAction<string>>
  setJiraDescText: React.Dispatch<React.SetStateAction<string>>
  setJiraEmail: React.Dispatch<React.SetStateAction<string>>
  setJiraOpen: React.Dispatch<React.SetStateAction<boolean>>
  setJiraProject: React.Dispatch<React.SetStateAction<string>>
  setJiraSummaryText: React.Dispatch<React.SetStateAction<string>>
  setJiraToken: React.Dispatch<React.SetStateAction<string>>
}

export function JiraModal({
  handleJiraCopyOpen,
  handleJiraCreate,
  jiraBaseUrl,
  jiraBusy,
  jiraDescText,
  jiraEmail,
  jiraNote,
  jiraOpen,
  jiraProject,
  jiraSummaryText,
  jiraToken,
  setJiraBaseUrl,
  setJiraDescText,
  setJiraEmail,
  setJiraOpen,
  setJiraProject,
  setJiraSummaryText,
  setJiraToken
}: JiraModalProps): React.JSX.Element | null {
  if (!(jiraOpen)) return null
  return (
    <div className="modal-backdrop" onClick={() => !jiraBusy && setJiraOpen(false)}>
      <div className="modal api-editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">🎫 Create a Jira ticket</span>
          <button
            className="modal-close"
            onClick={() => setJiraOpen(false)}
            disabled={jiraBusy}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="api-editor-body">
          <label className="api-field">
            <span>Summary (ticket title)</span>
            <input
              className="url-input"
              type="text"
              value={jiraSummaryText}
              onChange={(e) => setJiraSummaryText(e.target.value)}
            />
          </label>
          <label className="api-field">
            <span>Description</span>
            <textarea
              className="api-body"
              rows={8}
              value={jiraDescText}
              onChange={(e) => setJiraDescText(e.target.value)}
              spellCheck={false}
            />
          </label>
          <p className="api-hint">
            Push it straight to Jira with an API token, or use <strong>Copy + open Jira</strong> (no
            token — paste the ticket into Jira’s create page). Your site, email and project are
            remembered; the token is never stored.
          </p>
          <div className="jira-cred-grid">
            <label className="api-field">
              <span>Jira site URL</span>
              <input
                className="url-input"
                type="text"
                placeholder="https://yourteam.atlassian.net"
                value={jiraBaseUrl}
                onChange={(e) => setJiraBaseUrl(e.target.value)}
              />
            </label>
            <label className="api-field">
              <span>Project key</span>
              <input
                className="url-input"
                type="text"
                placeholder="QA"
                value={jiraProject}
                onChange={(e) => setJiraProject(e.target.value)}
              />
            </label>
            <label className="api-field">
              <span>Your email</span>
              <input
                className="url-input"
                type="text"
                placeholder="you@team.com"
                value={jiraEmail}
                onChange={(e) => setJiraEmail(e.target.value)}
              />
            </label>
            <label className="api-field">
              <span>
                API token <span className="mon-sub">(not stored)</span>
              </span>
              <input
                className="url-input"
                type="password"
                placeholder="Atlassian API token"
                value={jiraToken}
                onChange={(e) => setJiraToken(e.target.value)}
              />
            </label>
          </div>
          {jiraNote && (
            <p
              className="api-hint"
              style={{
                color: jiraNote.startsWith('✓')
                  ? '#7ee787'
                  : jiraNote.startsWith('⚠')
                    ? '#f0b232'
                    : '#9aa4b2'
              }}
            >
              {jiraNote}
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={() => setJiraOpen(false)} disabled={jiraBusy}>
            Close
          </button>
          <button className="modal-btn" onClick={handleJiraCopyOpen} disabled={jiraBusy}>
            📋 Copy + open Jira
          </button>
          <button className="modal-btn primary" onClick={handleJiraCreate} disabled={jiraBusy}>
            {jiraBusy ? '⏳ Creating…' : '⚡ Create in Jira'}
          </button>
        </div>
      </div>
    </div>
  )
}
