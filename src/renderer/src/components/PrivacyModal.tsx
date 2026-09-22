import React from 'react'
import { describePrivacy, isValidPattern } from '../../../shared/evidencePrivacy'

// =====================================================================
// EVIDENCE PRIVACY — the settings screen  (Phase 4)
// =====================================================================
// This app's strongest idea is that every run leaves evidence. On a staging
// environment seeded with real data, that evidence is also a copy of real
// people's details, written to a folder the user shares and commits.
//
// Two things this screen has to do that an ordinary settings dialog does not:
//
//  1. SAY WHAT IT WILL DO, in a sentence, before it is switched on. Redaction
//     that surprises you is worse than none: a tester who doesn't know it is
//     on reads "[redacted]" in a failure and chases a bug that isn't there.
//
//  2. FLAG A BROKEN PATTERN. A regex with a typo matches nothing. Accepting it
//     silently would leave someone believing they are covered when they are
//     not, which is the one failure mode a privacy feature must not have.
//
// It also refuses to overclaim. A screenshot is pixels: text baked into an
// image that no selector covers stays readable. The note at the bottom says
// so, because a tool that implies its evidence is safe to publish is more
// dangerous than one that makes no promise at all.
// =====================================================================

export interface EvidencePrivacySettings {
  builtins: boolean
  patterns: string
  maskSelectors: string
  captureDom: boolean
}

export interface PrivacyModalProps {
  privacy: EvidencePrivacySettings | null
  setPrivacy: React.Dispatch<React.SetStateAction<EvidencePrivacySettings | null>>
  onSave: () => Promise<void>
  onClose: () => void
}

export function PrivacyModal({
  privacy,
  setPrivacy,
  onSave,
  onClose
}: PrivacyModalProps): React.JSX.Element | null {
  if (!privacy) return null

  const badPatterns = privacy.patterns
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !isValidPattern(l))

  const set = (patch: Partial<EvidencePrivacySettings>): void =>
    setPrivacy((prev) => (prev ? { ...prev, ...patch } : prev))

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">🔒 Evidence privacy</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p>
            Every run saves screenshots, the page’s HTML, the console and the network. On an
            environment with real data in it, that evidence is a copy of that data. This controls
            what’s allowed to reach the disk.
          </p>

          <p className="privacy-summary">{describePrivacy(privacy)}</p>

          <label className="privacy-row">
            <input
              type="checkbox"
              checked={privacy.builtins}
              onChange={(e) => set({ builtins: e.target.checked })}
            />
            <span>
              <strong>Redact emails, card numbers and tokens</strong>
              <br />
              <span className="privacy-hint">
                Things with an unmistakable shape. Names aren’t included — a pattern for names is a
                pattern for words, and it would redact your error messages too.
              </span>
            </span>
          </label>

          <label className="privacy-row">
            <input
              type="checkbox"
              checked={!privacy.captureDom}
              onChange={(e) => set({ captureDom: !e.target.checked })}
            />
            <span>
              <strong>Don’t save the page’s HTML</strong>
              <br />
              <span className="privacy-hint">
                The biggest one. The HTML <em>is</em> the data, not a picture of it. Turning it off
                removes the exposure rather than reducing it — you lose the “Open page HTML” link in
                the run recording.
              </span>
            </span>
          </label>

          <label className="privacy-label" htmlFor="privacy-masks">
            Hide these regions in screenshots
          </label>
          <textarea
            id="privacy-masks"
            className="privacy-text"
            rows={3}
            value={privacy.maskSelectors}
            onChange={(e) => set({ maskSelectors: e.target.value })}
            placeholder={'.customer-name\n[data-pii]\n#account-number'}
            spellCheck={false}
          />
          <p className="privacy-hint">
            CSS selectors, one per line. They’re painted over before each screenshot is taken, then
            uncovered again so the run itself is unaffected.
          </p>

          <label className="privacy-label" htmlFor="privacy-patterns">
            Redact anything matching these patterns
          </label>
          <textarea
            id="privacy-patterns"
            className="privacy-text"
            rows={3}
            value={privacy.patterns}
            onChange={(e) => set({ patterns: e.target.value })}
            placeholder={'ORD-\\d+\nCUST-[A-Z0-9]+'}
            spellCheck={false}
          />
          <p className="privacy-hint">
            Regular expressions, one per line. Applied to the page HTML, the console, the network,
            the failure messages and the step titles in the run recording. Not to screenshots — a
            screenshot is pixels; use the box above for those.
          </p>
          {badPatterns.length > 0 && (
            <p className="warn-title">
              ⚠ {badPatterns.length} of these {badPatterns.length === 1 ? 'is' : 'are'} not a valid
              expression and {badPatterns.length === 1 ? 'is' : 'are'} being ignored:{' '}
              <code>{badPatterns.join('  ')}</code>
            </p>
          )}

          {/* The gap Surbhi found: masks are painted on just before each
              screenshot and taken off again, so a CONTINUOUS window recording
              captures every masked region in between. Nothing on this screen
              covers the video. Said plainly here rather than left to be
              discovered, because the danger of a privacy feature is the
              surfaces you assume it reached. */}
          <p className="warn-title">
            ⚠ Run videos (🎬) are <strong>not</strong> covered by any of this. Masks are applied per
            screenshot and removed again; a video records the window continuously, so it captures
            what the masks hide. Use 🎬 no video on anything with real data in it.
          </p>

          <p className="warn-note">
            This reduces what leaks; it can’t guarantee none does. A screenshot is pixels — data
            baked into an image that no selector covers stays readable. Treat evidence as sensitive
            even with this on.
          </p>
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="modal-btn primary" onClick={onSave}>
            Save policy
          </button>
        </div>
      </div>
    </div>
  )
}
