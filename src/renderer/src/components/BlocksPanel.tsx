import React from 'react'

// =====================================================================
// BlocksPanel — lifted out of App.tsx verbatim.
//
// Was an inline {cond && (…)} block inside the workspace return. Props are
// destructured under the names the markup already used; the open condition is
// re-expressed as an early return, because a component that simply returns the
// JSX would render ALWAYS.
// =====================================================================

export interface BlocksPanelProps {
  armOrDeleteBlock: (fileName: string) => void
  blockFrom: number
  blockInsertAt: number | null
  blockNameInput: string
  blockTo: number
  blockUsage: Record<string, BlockLink[]>
  blocks: BlockSummary[]
  blocksCollapsed: boolean
  blocksPanelOpen: boolean
  closeBlocksPanel: () => void
  editingBlockRef: string | null
  handleEditBlock: (block: BlockSummary) => Promise<void>
  handleInsertBlock: (fileName: string) => Promise<void>
  handleInsertBlockLinked: (block: BlockSummary) => Promise<void>
  handleSaveBlock: () => Promise<void>
  pendingDeleteBlock: string | null
  setBlockFrom: React.Dispatch<React.SetStateAction<number>>
  setBlockNameInput: React.Dispatch<React.SetStateAction<string>>
  setBlockTo: React.Dispatch<React.SetStateAction<number>>
  setBlocksCollapsed: React.Dispatch<React.SetStateAction<boolean>>
  steps: RecorderStep[]
}

export function BlocksPanel({
  armOrDeleteBlock,
  blockFrom,
  blockInsertAt,
  blockNameInput,
  blockTo,
  blockUsage,
  blocks,
  blocksCollapsed,
  blocksPanelOpen,
  closeBlocksPanel,
  editingBlockRef,
  handleEditBlock,
  handleInsertBlock,
  handleInsertBlockLinked,
  handleSaveBlock,
  pendingDeleteBlock,
  setBlockFrom,
  setBlockNameInput,
  setBlockTo,
  setBlocksCollapsed,
  steps
}: BlocksPanelProps): React.JSX.Element | null {
  if (!(blocksPanelOpen)) return null
  return (
            <div className={`assert-panel blocks-panel${blocksCollapsed ? ' collapsed' : ''}`}>
              <div className="assert-target">
                <span className="assert-title">🧩 Reusable step blocks</span>
                {/* F7: minimise arrow — collapse to give the step list the whole
                    sidebar (for editing a block with many steps). */}
                <button
                  type="button"
                  className="block-collapse"
                  onClick={() => setBlocksCollapsed((c) => !c)}
                  title={
                    blocksCollapsed
                      ? 'Expand the blocks panel'
                      : 'Minimise — give the step list the whole sidebar'
                  }
                  aria-label={blocksCollapsed ? 'Expand blocks panel' : 'Minimise blocks panel'}
                >
                  {blocksCollapsed ? '▸' : '▾'}
                </button>
              </div>
              {/* Minimised mid-edit: keep Update / Close reachable without expanding. */}
              {blocksCollapsed && editingBlockRef && (
                <div className="assert-actions">
                  <button className="modal-btn" onClick={closeBlocksPanel}>
                    Close
                  </button>
                  <button
                    className="modal-btn primary"
                    onClick={handleSaveBlock}
                    disabled={!blockNameInput.trim() || steps.length === 0}
                  >
                    Update block
                  </button>
                </div>
              )}

              <div className="block-body">
              {/* F7: blast-radius banner — always visible (no hover). Shows the
                  tests a block feeds the moment it's IN FOCUS: armed for delete
                  (red — "breaks these") or being edited (amber — "changes these").
                  Delete takes priority since it's the destructive, timed action. */}
              {(() => {
                const focusRef = pendingDeleteBlock ?? editingBlockRef
                if (!focusRef) return null
                const deleting = !!pendingDeleteBlock
                const name = deleting
                  ? (blocks.find((x) => x.fileName === focusRef)?.name ?? 'this block')
                  : blockNameInput
                const links = blockUsage[focusRef] ?? []
                const cls = deleting
                  ? 'blast-radius blast-radius-delete'
                  : links.length === 0
                    ? 'blast-radius blast-radius-safe'
                    : 'blast-radius'
                return (
                  <div className={cls}>
                    {links.length === 0 ? (
                      <span className="blast-radius-head">
                        {deleting
                          ? `Deleting “${name}” is safe — no test links it. Click ✕ again to confirm.`
                          : '✓ No test links this block yet — updating it affects nothing else.'}
                      </span>
                    ) : (
                      <>
                        <span className="blast-radius-head">
                          {deleting ? '⚠ Deleting ' : '⚠ Updating '}
                          <strong>“{name}”</strong>
                          {deleting ? ' breaks ' : ' changes '}
                          {links.length} linked test{links.length > 1 ? 's' : ''}
                          {deleting ? ' — click ✕ again to confirm:' : ':'}
                        </span>
                        <ul className="blast-list">
                          {links.map((l) => (
                            <li key={l.fileName}>
                              {l.name}
                              {l.suite && <span className="blast-suite"> · {l.suite}</span>}
                              {l.count > 1 && <span className="blast-count"> ×{l.count}</span>}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )
              })()}

              {/* F7: while EDITING a block, hide the insert list so the block's
                  loaded steps sit in view right below the compact panel. */}
              {!editingBlockRef && (
                <>
                  <div className="block-section-label">
                    Insert a block{' '}
                    {blockInsertAt !== null ? `at step ${blockInsertAt + 1}` : 'at the end'}
                  </div>
              {blocks.length > 0 && (
                <div className="block-hint">
                  🔗 linked — stays in sync when you edit the block · ⧉ copy — an independent
                  snapshot you can edit here
                </div>
              )}
              {blocks.length === 0 ? (
                <div className="block-empty">
                  No saved blocks yet — save some steps below to reuse them across tests.
                </div>
              ) : (
                <ul className="block-list">
                  {blocks.map((b) => {
                    // F7: which tests link THIS block — drives the usage chip + the
                    // sharper delete warning ("breaks N tests").
                    const links = blockUsage[b.fileName] ?? []
                    const usedBy = links.length
                    const linkNames = links
                      .map((l) => `• ${l.name}${l.suite ? ` (${l.suite})` : ''}${l.count > 1 ? ` ×${l.count}` : ''}`)
                      .join('\n')
                    return (
                      <li key={b.fileName} className="block-row">
                      <button
                        type="button"
                        className="block-insert"
                        onClick={() => handleInsertBlockLinked(b)}
                        title={`Insert "${b.name}" as a LIVE link (${b.stepCount} steps) — editing the block later updates this test`}
                      >
                        🔗 {b.name} <span className="block-count">{b.stepCount} steps</span>
                      </button>
                      {/* F7: blast-radius at a glance — how many tests this block
                          feeds; hover to see which. "unused" = safe to change. */}
                      <span
                        className={`block-usage${usedBy === 0 ? ' block-usage-none' : ''}`}
                        title={
                          usedBy === 0
                            ? 'No test links this block — safe to edit or delete'
                            : `Used by ${usedBy} test${usedBy > 1 ? 's' : ''}:\n${linkNames}`
                        }
                      >
                        {usedBy === 0 ? 'unused' : `used by ${usedBy}`}
                      </span>
                      <button
                        type="button"
                        className="block-mini"
                        onClick={() => handleInsertBlock(b.fileName)}
                        title="Insert a one-time COPY (snapshot, not linked)"
                      >
                        ⧉
                      </button>
                      <button
                        type="button"
                        className="block-mini"
                        onClick={() => handleEditBlock(b)}
                        title={`Edit "${b.name}" — updates every test linked to it`}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className={`block-del${
                          pendingDeleteBlock === b.fileName ? ' confirming' : ''
                        }`}
                        onClick={() => armOrDeleteBlock(b.fileName)}
                        title={
                          pendingDeleteBlock === b.fileName
                            ? `Click again to permanently delete "${b.name}"${usedBy ? ` — BREAKS ${usedBy} linked test${usedBy > 1 ? 's' : ''}` : ''}`
                            : `Delete block "${b.name}"${usedBy ? ` (breaks ${usedBy} linked test${usedBy > 1 ? 's' : ''})` : ''}`
                        }
                        aria-label={`Delete block ${b.name}`}
                      >
                        {pendingDeleteBlock === b.fileName ? 'Sure?' : '✕'}
                      </button>
                    </li>
                    )
                  })}
                </ul>
              )}
                </>
              )}

              {/* F7: a clear "you're editing a block" cue when the insert list is hidden. */}
              {editingBlockRef && (
                <div className="block-editing-hint">
                  ✎ Editing block — its steps are loaded in the list below. Change them, then{' '}
                  <strong>Update block</strong> to push the fix to every linked test.
                </div>
              )}

              <div className="block-section-label">
                {editingBlockRef ? `Update block "${blockNameInput}"` : 'Save steps as a new block'}
              </div>
              <input
                className="assert-value"
                value={blockNameInput}
                onChange={(e) => setBlockNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveBlock()
                  else if (e.key === 'Escape') closeBlocksPanel()
                }}
                placeholder="block name (e.g. Login)…"
                spellCheck={false}
              />
              <div className="block-range">
                <span>Steps</span>
                <input
                  type="number"
                  min={1}
                  max={steps.length}
                  value={blockFrom}
                  onChange={(e) => setBlockFrom(Number(e.target.value))}
                />
                <span>to</span>
                <input
                  type="number"
                  min={1}
                  max={steps.length}
                  value={blockTo}
                  onChange={(e) => setBlockTo(Number(e.target.value))}
                />
                <span className="block-hint">of {steps.length}</span>
              </div>
              <div className="assert-actions">
                <button className="modal-btn" onClick={closeBlocksPanel}>
                  Close
                </button>
                <button
                  className="modal-btn primary"
                  onClick={handleSaveBlock}
                  disabled={!blockNameInput.trim() || steps.length === 0}
                >
                  {editingBlockRef ? 'Update block' : 'Save block'}
                </button>
              </div>
              </div>
            </div>
  )
}
