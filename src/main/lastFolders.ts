// =====================================================================
// WHERE EACH FILE DIALOG OPENS  (QF-006, Electron 43+)
// =====================================================================
// Up to Electron 42, a dialog given no `defaultPath` let Windows open it in
// the folder you used last. From Electron 43 it opens in Downloads, every
// time. Four dialogs here set no starting folder, so after the upgrade each
// would have sent you back to Downloads to navigate from scratch.
//
// This keeps "opens where you left off", per dialog, across restarts — the
// behaviour you had before. Stored in userData beside the app's other local
// state; a folder that no longer exists is simply not offered.
// =====================================================================
import { app } from 'electron'
import { existsSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname, join } from 'path'

export type DialogKey = 'upload-file' | 'bundle-export' | 'bundle-import' | 'git-repo'

const storePath = (): string => join(app.getPath('userData'), 'last-folders.json')

async function readStore(): Promise<Partial<Record<DialogKey, string>>> {
  try {
    return JSON.parse(await readFile(storePath(), 'utf-8'))
  } catch {
    return {}
  }
}

/** The folder this dialog should open in, or undefined to let the OS decide. */
export async function lastFolder(key: DialogKey): Promise<string | undefined> {
  const dir = (await readStore())[key]
  return dir && existsSync(dir) ? dir : undefined
}

/**
 * Remember where the user just went. A picked FILE remembers its folder; a
 * picked FOLDER remembers itself, so the next dialog opens right there.
 * Best-effort: failing to remember must never fail the action itself.
 */
export async function rememberFolder(key: DialogKey, picked: string, kind: 'file' | 'folder'): Promise<void> {
  try {
    const store = await readStore()
    store[key] = kind === 'file' ? dirname(picked) : picked
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(storePath(), JSON.stringify(store, null, 2), 'utf-8')
  } catch {
    // next time it opens in Downloads — annoying, not broken
  }
}
