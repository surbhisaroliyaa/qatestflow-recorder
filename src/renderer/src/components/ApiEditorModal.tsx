import React from 'react'
import { saveSpecWarning } from '../../../shared/apiSaveSpec'

// =====================================================================
// F24 — the API step editor.
//
// JSX moved verbatim from App.tsx; props destructured under the names the
// markup already used, so the compiler verifies the move.
//
// apiMethod / apiSendsBody are passed in rather than re-derived here. They are
// one-line expressions over apiDraft and it would have been easy to recompute
// them — but re-deriving is exactly how two copies of a rule drift apart, which
// is the failure this whole refactor exists to remove.
// =====================================================================

export interface ApiEditorModalProps {
  apiDraft: RecorderStep | null
  apiEditIndex: number | null
  apiMethod: string
  apiSendsBody: boolean
  patchApiDraft: (patch: Partial<RecorderStep>) => void
  saveApiEditor: () => void
  closeApiEditor: () => void
  fieldCount: (n: number) => string
}

export function ApiEditorModal({
  apiDraft,
  apiEditIndex,
  apiMethod,
  apiSendsBody,
  patchApiDraft,
  saveApiEditor,
  closeApiEditor,
  fieldCount
}: ApiEditorModalProps): React.JSX.Element | null {
  if (!apiDraft || apiEditIndex === null) return null
  return (
    <div className="modal-backdrop" onClick={closeApiEditor}>
      <div className="modal api-editor" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">🔌 API request</span>
          <button className="modal-close" onClick={closeApiEditor} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="api-editor-body">
          <div className="api-row api-req-line">
            <select
              className="api-method"
              value={apiMethod}
              onChange={(e) => patchApiDraft({ apiMethod: e.target.value as RecorderStep['apiMethod'] })}
            >
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <input
              className="api-url"
              type="text"
              placeholder="https://api.example.com/users/1"
              value={apiDraft.url ?? ''}
              onChange={(e) => patchApiDraft({ url: e.target.value })}
            />
          </div>
          <label className="api-field">
            <span>Headers — one per line, e.g. Authorization: Bearer {'{{env:TOKEN}}'}</span>
            <textarea
              className="api-headers"
              rows={3}
              placeholder={'Content-Type: application/json\nAuthorization: Bearer …'}
              value={apiDraft.apiHeaders ?? ''}
              onChange={(e) => patchApiDraft({ apiHeaders: e.target.value })}
            />
          </label>
          {apiSendsBody && (
            <label className="api-field">
              <span>Request body</span>
              <textarea
                className="api-body"
                rows={4}
                placeholder={'{ "name": "morpheus" }'}
                value={apiDraft.apiBody ?? ''}
                onChange={(e) => patchApiDraft({ apiBody: e.target.value })}
              />
            </label>
          )}
          <div className="api-row api-expect">
            <label className="api-field api-field-inline">
              <span>Expect status</span>
              <input
                type="text"
                placeholder="2xx  ·  200  ·  204,404"
                value={apiDraft.apiExpectStatus ?? ''}
                onChange={(e) => patchApiDraft({ apiExpectStatus: e.target.value })}
              />
            </label>
            <label className="api-field api-field-inline">
              <span>Response body contains (optional)</span>
              <input
                type="text"
                placeholder='e.g. "success" or an id'
                value={apiDraft.apiExpectBody ?? ''}
                onChange={(e) => patchApiDraft({ apiExpectBody: e.target.value })}
              />
            </label>
          </div>
          {/* F24.2: REAL assertions. "Body contains" is a substring match — it
              passes on {"id": null}, which is the dead-assertion disease F6 exists
              to catch, reinvented in API form. */}
          <label className="api-field">
            <span>
              ✅ Response checks — <strong>assertions</strong>. One per line:{' '}
              <code>path op value</code>
            </span>
            <textarea
              className="api-headers"
              rows={3}
              placeholder={
                'id not-empty\nstatus equals CONFIRMED\nitems count-gt 0\nheader:content-type contains application/json'
              }
              value={apiDraft.apiChecks ?? ''}
              onChange={(e) => patchApiDraft({ apiChecks: e.target.value })}
            />
          </label>
          <p className="api-hint api-ops">
            <strong>Operators:</strong> <code>equals</code> · <code>not-equals</code> ·{' '}
            <code>contains</code> · <code>not-contains</code> · <code>exists</code> ·{' '}
            <code>not-empty</code> · <code>empty</code> · <code>gt</code> · <code>lt</code> ·{' '}
            <code>count-eq</code> · <code>count-gt</code> · <code>count-lt</code> ·{' '}
            <code>is-number</code> · <code>is-string</code> · <code>is-boolean</code> ·{' '}
            <code>is-array</code>. Prefix a path with <code>header:</code> to check a response
            header.
          </p>
          <div className="api-row api-expect">
            <label className="api-field api-field-inline">
              <span>Must respond within (ms) — SLA, blank = no limit</span>
              <input
                type="text"
                placeholder="e.g. 500"
                value={apiDraft.apiMaxMs != null ? String(apiDraft.apiMaxMs) : ''}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10)
                  patchApiDraft({ apiMaxMs: Number.isFinite(n) && n > 0 ? n : undefined })
                }}
              />
            </label>
            <label className="api-field api-field-inline">
              <span>Give up after (seconds) — default 30</span>
              <input
                type="text"
                placeholder="30"
                value={apiDraft.apiTimeoutMs != null ? String(apiDraft.apiTimeoutMs / 1000) : ''}
                onChange={(e) => {
                  const n = parseFloat(e.target.value)
                  patchApiDraft({
                    apiTimeoutMs: Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : undefined
                  })
                }}
              />
            </label>
          </div>
          {/* F24.2: the contract. Captured from the response panel, shown here so
              you can see it exists and drop it. */}
          {apiDraft.apiContract && Object.keys(apiDraft.apiContract).length > 0 && (
            <div className="api-contract-row">
              <span>
                📐 <strong>Contract:</strong> {fieldCount(Object.keys(apiDraft.apiContract).length)}{' '}
                — fails if any is renamed, dropped, or changes type.
              </span>
              <button
                type="button"
                className="modal-btn"
                onClick={() => patchApiDraft({ apiContract: undefined })}
              >
                Remove
              </button>
            </div>
          )}
          {/* F24.1: the piece that makes create → verify → delete possible. The
              server invents the id, so it cannot be typed when authoring. */}
          {/* Visually separated from "Response checks" above. The two were
              adjacent, identically styled textareas with different grammars
              (`path op value` vs `name = path`), and a check typed into this one
              was silently dropped. */}
          <label className="api-field api-save-field">
            <span>
              💾 Save from response — <strong>not a check</strong>. One{' '}
              <code>name = path</code> per line, used later as <code>{'{{saved:name}}'}</code>
            </span>
            <textarea
              className="api-headers"
              rows={2}
              placeholder={'orderId = id\ntoken = data.accessToken'}
              value={apiDraft.apiSave ?? ''}
              onChange={(e) => patchApiDraft({ apiSave: e.target.value })}
            />
          </label>
          {/* Say so IMMEDIATELY. This warning exists because a dropped line cost
              a real assertion that looked saved and green for hours. */}
          {saveSpecWarning(apiDraft.apiSave) && (
            <p className="api-hint api-save-warn">⚠ {saveSpecWarning(apiDraft.apiSave)}</p>
          )}
          {/* F24.3: hand this response's auth to the browser — the suite-scale win. */}
          <div className="api-auth-block">
            <label className="api-check-line">
              <input
                type="checkbox"
                checked={!!apiDraft.apiInjectCookies}
                onChange={(e) => patchApiDraft({ apiInjectCookies: e.target.checked })}
              />
              <span>
                🔑 Log the <strong>browser</strong> in with this response’s cookies — the UI steps
                after this start already authenticated, with no login screen.
              </span>
            </label>
            <label className="api-field">
              <span>
                …or, if the API returns a <strong>token in the body</strong>: set localStorage —
                one <code>key = value</code> per line
              </span>
              <textarea
                className="api-headers"
                rows={2}
                placeholder={'authToken = {{saved:token}}'}
                value={apiDraft.apiInjectStorage ?? ''}
                onChange={(e) => patchApiDraft({ apiInjectStorage: e.target.value })}
              />
            </label>
          </div>
          <p className="api-hint">
            The request runs from the app itself (not the browser tab), so it works on any page. A
            failed status or missing body text fails the step like any check.
          </p>
          <p className="api-hint">
            <strong>Re-runnable tests:</strong> use <code>{'{{uuid}}'}</code>,{' '}
            <code>{'{{timestamp}}'}</code> or <code>{'{{randomInt}}'}</code> anywhere in the URL,
            headers or body to create data that never collides on a second run (
            <code>qa+{'{{timestamp}}'}@x.com</code>). For a teardown check, an{' '}
            <strong>Expect status</strong> of <code>204,404</code> accepts either — so “already
            gone” still passes and the test doesn’t go red forever after run 1.
          </p>
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={closeApiEditor}>
            Cancel
          </button>
          <button
            className="modal-btn primary"
            onClick={saveApiEditor}
            disabled={!(apiDraft.url ?? '').trim()}
          >
            Save step
          </button>
        </div>
      </div>
    </div>
  )
}
