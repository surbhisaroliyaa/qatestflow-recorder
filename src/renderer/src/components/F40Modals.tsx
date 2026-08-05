import React from 'react'

// =====================================================================
// F40 — the three bundle/secret dialogs: export result, import plan, and the
// one-time plaintext-secret migration notice.
//
// Grouped as one fragment because all three are triggered from the LIBRARY and
// render on both screens; App.tsx held them together for that reason and the
// grouping is preserved rather than second-guessed during a mechanical move.
//
// JSX moved verbatim; props destructured under the names the markup already
// used, so the compiler verifies the move rather than my reading of it.
// =====================================================================

export interface F40ModalsProps {
  bundleBusy: boolean
  bundleResult: { path: string; manifest: BundleManifest } | null
  setBundleResult: (v: { path: string; manifest: BundleManifest } | null) => void
  importPlan: {
    bundleDir: string
    manifest?: BundleManifest
    tests: BundleTestPreview[]
    choices: Record<string, 'keep-both' | 'overwrite' | 'skip'>
  } | null
  setImportPlan: React.Dispatch<
    React.SetStateAction<{
      bundleDir: string
      manifest?: BundleManifest
      tests: BundleTestPreview[]
      choices: Record<string, 'keep-both' | 'overwrite' | 'skip'>
    } | null>
  >
  secretMigration: { migrated: number; tests: string[] } | null
  setSecretMigration: (v: { migrated: number; tests: string[] } | null) => void
  handleApplyImport: () => Promise<void>
}

export function F40Modals({
  bundleBusy,
  bundleResult,
  setBundleResult,
  importPlan,
  setImportPlan,
  secretMigration,
  setSecretMigration,
  handleApplyImport
}: F40ModalsProps): React.JSX.Element {
  return (
    <>
        {
          /* F40: the app just rewrote the user's test files. Say so, plainly, with
             what changed and where the backup is — a silent file rewrite would be
             indefensible even when it's an improvement.
             NOTE: top-level, NOT inside the suite-report block — it fires at
             STARTUP, when no suite run exists. */
          secretMigration && (
            <div className="modal-backdrop" onClick={() => setSecretMigration(null)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <span className="modal-title">🔑 Passwords moved out of your test files</span>
                  <button
                    className="modal-close"
                    onClick={() => setSecretMigration(null)}
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>
                <div className="modal-body bundle-body">
                  <p>
                    Until now, a password field marked <strong>secret</strong> was masked on screen
                    and kept out of the export — but the value itself was still written into the
                    test&apos;s JSON file, in plain text, in a folder meant to be shared and
                    committed.
                  </p>
                  <p>
                    <strong>{secretMigration.migrated}</strong> test
                    {secretMigration.migrated === 1 ? '' : 's'} updated. The passwords now live in
                    your app data alongside your environments; each step keeps only a reference.
                    <strong> Nothing about how your tests run has changed.</strong>
                  </p>
                  <ul>
                    {secretMigration.tests.slice(0, 10).map((t) => (
                      <li key={t}>
                        <code>{t}</code>
                      </li>
                    ))}
                    {secretMigration.tests.length > 10 && (
                      <li>…and {secretMigration.tests.length - 10} more</li>
                    )}
                  </ul>
                  <p className="import-note">
                    A full copy of your library was saved to{' '}
                    <code>QATestFlow Tests/_backups/</code> before anything was changed.
                  </p>
                </div>
                <div className="assert-actions">
                  <button className="modal-btn primary" onClick={() => setSecretMigration(null)}>
                    Got it
                  </button>
                </div>
              </div>
            </div>
          )
        }
        {
          /* F40: what the export actually produced — and, just as importantly,
             what it deliberately left out. */
          bundleResult && (
            <div className="modal-backdrop" onClick={() => setBundleResult(null)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <span className="modal-title">
                    📦 Bundle exported — {bundleResult.manifest.testCount} test
                    {bundleResult.manifest.testCount === 1 ? '' : 's'}
                  </span>
                  <button
                    className="modal-close"
                    onClick={() => setBundleResult(null)}
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>
                <div className="modal-body bundle-body">
                  <p className="bundle-path">
                    <code>{bundleResult.path}</code>
                  </p>
                  <p>
                    It’s a plain folder — commit it to git so test changes show up in pull
                    requests, or zip it and send it.
                  </p>
                  <h4>Included</h4>
                  <ul>
                    <li>
                      {bundleResult.manifest.testCount} test
                      {bundleResult.manifest.testCount === 1 ? '' : 's'}
                    </li>
                    {bundleResult.manifest.blocks.length > 0 && (
                      <li>
                        {bundleResult.manifest.blocks.length} linked block
                        {bundleResult.manifest.blocks.length === 1 ? '' : 's'} — without these the
                        🧩 steps would be broken
                      </li>
                    )}
                    {bundleResult.manifest.uploads.length > 0 && (
                      <li>
                        {bundleResult.manifest.uploads.length} upload file
                        {bundleResult.manifest.uploads.length === 1 ? '' : 's'}
                      </li>
                    )}
                    {bundleResult.manifest.hasAcceptanceCriteria && <li>Acceptance criteria</li>}
                  </ul>
                  <h4>Deliberately left out</h4>
                  <ul className="bundle-omitted">
                    {bundleResult.manifest.secretsPlaceholdered.length > 0 && (
                      <li>
                        <strong>Passwords</strong> —{' '}
                        {bundleResult.manifest.secretsPlaceholdered.length} test
                        {bundleResult.manifest.secretsPlaceholdered.length === 1 ? '' : 's'} carry{' '}
                        <code>{'{{env:PASSWORD}}'}</code> instead. Safe to commit.
                      </li>
                    )}
                    {bundleResult.manifest.dataScrubbed.length > 0 && (
                      <li>
                        <strong>Sensitive data columns</strong> —{' '}
                        {bundleResult.manifest.dataScrubbed
                          .map((d) => d.columns.join(', '))
                          .join('; ')}{' '}
                        replaced with env tokens.
                      </li>
                    )}
                    <li>
                      <strong>Saved sessions</strong> — a session file is a credential, and it
                      expires. They record their own.
                    </li>
                    <li>
                      <strong>Run history &amp; trust scores</strong> — those describe your machine.
                      Every test arrives as “new / untested”, which is the truth for them.
                    </li>
                    {bundleResult.manifest.visualWithoutBaseline.length > 0 && (
                      <li>
                        <strong>Visual baselines</strong> —{' '}
                        {bundleResult.manifest.visualWithoutBaseline.length === 1
                          ? '1 test takes a snapshot'
                          : `${bundleResult.manifest.visualWithoutBaseline.length} tests take a snapshot`}
                        . A baseline is tied to the screen it was captured on, so a shared
                        one fails elsewhere for no real reason. Their <em>first</em> run creates
                        theirs and passes without comparing anything — the second run is the first
                        real check. The README says so.
                      </li>
                    )}
                  </ul>
                </div>
                <div className="assert-actions">
                  <button
                    className="modal-btn"
                    onClick={() => window.api.xbrowser.revealBundle(bundleResult.path)}
                  >
                    📂 Show in folder
                  </button>
                  <button className="modal-btn primary" onClick={() => setBundleResult(null)}>
                    Done
                  </button>
                </div>
              </div>
            </div>
          )
        }
        {
          /* F40: decide every collision BEFORE anything is written. */
          importPlan && (
            <div className="modal-backdrop" onClick={() => setImportPlan(null)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <span className="modal-title">
                    📥 Import bundle — {importPlan.tests.length} test
                    {importPlan.tests.length === 1 ? '' : 's'}
                  </span>
                  <button
                    className="modal-close"
                    onClick={() => setImportPlan(null)}
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>
                <div className="modal-body bundle-body">
                  {(() => {
                    const clashes = importPlan.tests.filter((t) => t.collidesWith)
                    if (!clashes.length) {
                      return <p>No name clashes — everything here is new to your library.</p>
                    }
                    return (
                      <>
                        <p>
                          <strong>{clashes.length}</strong> of these already exist here. Choose what
                          happens to each — nothing is written until you hit Import.
                        </p>
                        <div className="import-allrow">
                          Apply to all clashes:
                          {(['keep-both', 'overwrite', 'skip'] as const).map((c) => (
                            <button
                              key={c}
                              type="button"
                              // Show which one is in force. Without this the
                              // button you click never changes, so on a long
                              // list (56 rows, most of them off-screen) it reads
                              // as "the button doesn't work" — the rows DID all
                              // change, you just couldn't see it happen.
                              // Derived, not remembered: it lights up whenever
                              // every clashing row already agrees, so picking
                              // rows individually keeps it honest too.
                              className={`modal-btn${
                                clashes.length > 0 &&
                                clashes.every((t) => importPlan.choices[t.file] === c)
                                  ? ' primary'
                                  : ''
                              }`}
                              onClick={() =>
                                setImportPlan((prev) =>
                                  prev
                                    ? {
                                        ...prev,
                                        choices: Object.fromEntries(
                                          prev.tests.map((t) => [
                                            t.file,
                                            t.collidesWith ? c : 'overwrite'
                                          ])
                                        )
                                      }
                                    : prev
                                )
                              }
                            >
                              {c === 'keep-both'
                                ? 'Keep both'
                                : c === 'overwrite'
                                  ? 'Overwrite'
                                  : 'Skip'}
                            </button>
                          ))}
                          {/* At 56 rows — let alone a real team library — you
                              can't judge an import by reading every row. Say
                              what the current choices ADD UP TO. */}
                          {(() => {
                            const vals = Object.values(importPlan.choices)
                            const n = (c: string): number =>
                              importPlan.tests.filter(
                                (t) => t.collidesWith && importPlan.choices[t.file] === c
                              ).length
                            const fresh = importPlan.tests.length - clashes.length
                            return (
                              <span className="import-tally">
                                {fresh > 0 && (
                                  <>
                                    <strong>{fresh}</strong> new ·{' '}
                                  </>
                                )}
                                <strong>{n('keep-both')}</strong> kept alongside ·{' '}
                                <strong>{n('overwrite')}</strong> overwritten ·{' '}
                                <strong>{n('skip')}</strong> skipped
                                {vals.length === 0 && ' — nothing selected'}
                              </span>
                            )
                          })()}
                        </div>
                      </>
                    )
                  })()}
                  <ul className="import-list">
                    {importPlan.tests.map((t) => (
                      <li key={t.file} className={t.collidesWith ? 'clash' : ''}>
                        <div className="import-name">
                          <strong>{t.name}</strong>
                          {t.suite && <span className="import-suite">{t.suite}</span>}
                          <span className="import-meta">{t.stepCount} steps</span>
                          {(t.tags ?? []).map((tag) => (
                            <span key={tag} className="tag-chip">
                              {tag}
                            </span>
                          ))}
                        </div>
                        {t.collidesWith ? (
                          <div className="import-choice">
                            <span className="import-warn">
                              already exists ({t.existingStepCount} steps
                              {t.existingUpdatedAt
                                ? `, edited ${new Date(t.existingUpdatedAt).toLocaleDateString()}`
                                : ''}
                              )
                            </span>
                            {(['keep-both', 'overwrite', 'skip'] as const).map((c) => (
                              <button
                                key={c}
                                type="button"
                                className={`assert-kind${
                                  importPlan.choices[t.file] === c ? ' chosen' : ''
                                }`}
                                onClick={() =>
                                  setImportPlan((prev) =>
                                    prev
                                      ? { ...prev, choices: { ...prev.choices, [t.file]: c } }
                                      : prev
                                  )
                                }
                              >
                                {c === 'keep-both'
                                  ? 'Keep both'
                                  : c === 'overwrite'
                                    ? 'Overwrite'
                                    : 'Skip'}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <span className="import-new">new</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {importPlan.manifest?.visualWithoutBaseline?.length ? (
                    <p className="import-note">
                      ⚠{' '}
                      {importPlan.manifest.visualWithoutBaseline.length === 1
                        ? '1 of these takes a visual snapshot'
                        : `${importPlan.manifest.visualWithoutBaseline.length} of these take a visual snapshot`}
                      , and baselines aren’t shared (they’re tied to the screen they were
                      captured on). Your <strong>first</strong> run creates your own baseline and
                      passes without comparing anything — the second run is the first real check.
                    </p>
                  ) : null}
                  {importPlan.manifest?.secretsPlaceholdered?.length ? (
                    <p className="import-note">
                      🔑{' '}
                      {importPlan.manifest.secretsPlaceholdered.length === 1
                        ? '1 test needs a password'
                        : `${importPlan.manifest.secretsPlaceholdered.length} tests need a password`}
                      . Set <code>PASSWORD</code> in your environment (🌐 Run against →
                      manage) before running them.
                    </p>
                  ) : null}
                </div>
                <div className="assert-actions">
                  <button className="modal-btn" onClick={() => setImportPlan(null)}>
                    Cancel
                  </button>
                  <button
                    className="modal-btn primary"
                    disabled={bundleBusy}
                    onClick={handleApplyImport}
                  >
                    Import
                  </button>
                </div>
              </div>
            </div>
          )
        }
    </>
  )
}
