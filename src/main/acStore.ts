// F31 (AC checklist half): persist the project's acceptance criteria so the
// "which tests cover which AC" checklist survives restarts. One plain-text blob
// (one AC per line) in userData — same home as environments.json, since ACs are a
// personal working note, not part of the shared Tests folder.
import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'

function storePath(): string {
  return join(app.getPath('userData'), 'acceptance-criteria.json')
}

export async function loadAcs(): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(storePath(), 'utf-8'))
    return typeof parsed?.text === 'string' ? parsed.text : ''
  } catch {
    return '' // nothing saved yet
  }
}

export async function saveAcs(text: string): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(storePath(), JSON.stringify({ text }, null, 2), 'utf-8')
}
