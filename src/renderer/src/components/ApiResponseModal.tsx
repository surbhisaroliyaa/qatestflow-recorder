import React from 'react'
import { formatBytes } from '../uiFormat'

// =====================================================================
// ApiResponseModal — lifted out of App.tsx verbatim.
//
// Props are destructured under the names the markup already used, so the move
// cannot change behaviour by renaming. Types were inferred from each value's
// declaration in App.tsx and then checked by tsc, which is the actual authority.
// =====================================================================

export interface ApiResponseModalProps {
  apiPanelIndex: number | null
  apiResponseEv: ApiEvidence | undefined
  apiResponseStep: RecorderStep | undefined
  fieldCount: (n: number) => string
  handleCaptureContract: (index: number) => void
  prettyBody: (text?: string) => string
  setApiPanelIndex: React.Dispatch<React.SetStateAction<number | null>>
  statusIsOk: (status?: number) => boolean
}

export function ApiResponseModal({
  apiPanelIndex,
  apiResponseEv,
  apiResponseStep,
  fieldCount,
  handleCaptureContract,
  prettyBody,
  setApiPanelIndex,
  statusIsOk
}: ApiResponseModalProps): React.JSX.Element | null {
  if (!(apiPanelIndex !== null && apiResponseEv)) return null
  return (
    <div className="modal-backdrop" onClick={() => setApiPanelIndex(null)}>
      <div className="modal api-response-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">
            ↩ Response — step {apiPanelIndex + 1}
            {apiResponseStep ? ` · ${apiResponseStep.apiMethod ?? 'GET'}` : ''}
          </span>
          <button className="modal-close" onClick={() => setApiPanelIndex(null)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="api-response-body">
          <div className={`api-panel-status${statusIsOk(apiResponseEv.status) ? ' ok' : ' bad'}`}>
            {apiResponseEv.status != null
              ? apiResponseEv.status
              : 'no response — the request never reached the server'}
            {apiResponseEv.durationMs != null && (
              <span className="api-panel-meta">· {apiResponseEv.durationMs} ms</span>
            )}
            {apiResponseEv.sizeBytes != null && (
              <span className="api-panel-meta">· {formatBytes(apiResponseEv.sizeBytes)}</span>
            )}
          </div>
          <div className="api-panel-lbl">Sent</div>
          <pre className="api-panel-pre">
            {`${apiResponseEv.method} ${apiResponseEv.url}`}
            {apiResponseEv.requestHeaders ? `\n${apiResponseEv.requestHeaders}` : ''}
            {apiResponseEv.requestBody ? `\n\n${apiResponseEv.requestBody}` : ''}
          </pre>
          <div className="api-panel-lbl">Received</div>
          {apiResponseEv.responseHeaders && (
            <pre className="api-panel-pre api-panel-headers">{apiResponseEv.responseHeaders}</pre>
          )}
          <pre className="api-panel-pre">
            {prettyBody(apiResponseEv.responseBody) || '(empty body)'}
          </pre>
          <p className="api-panel-note">
            Credentials are masked (••••). Long bodies are cut at 2,000 characters — the size above
            is the real one.
          </p>
          {/* F24.2: capture the SHAPE of this known-good response as a contract.
              This is the check that catches a backend renaming `total` → `amount`:
              no value assertion can, because the field simply isn't there. */}
          {apiResponseStep?.type === 'api' && (
            <div className="api-contract-capture">
              <button
                type="button"
                className="modal-btn"
                onClick={() => handleCaptureContract(apiPanelIndex!)}
                disabled={!apiResponseEv.responseBody}
                title="Remember this response's SHAPE. Later runs fail if a field is renamed, dropped, or changes type."
              >
                📐 Save this shape as the contract
              </button>
              <span className="api-panel-note">
                {apiResponseStep.apiContract
                  ? `Contract set — ${fieldCount(Object.keys(apiResponseStep.apiContract).length)} being enforced.`
                  : 'No contract yet: a renamed or dropped field would go unnoticed.'}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
