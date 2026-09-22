// =====================================================================
// EVIDENCE PRIVACY — the stored policy  (Phase 4)
// =====================================================================
// The rules themselves live in src/shared/evidencePrivacy.ts, which is pure
// and tested. This file is only where they are KEPT.
//
// userData, not the shared Tests folder — the same decision F25 made for
// environments, and for a sharper reason here. A privacy policy names the
// things you consider sensitive: your selectors, your patterns, quite possibly
// your customers' field names. Writing that into a folder built to be
// committed and shared would make the privacy feature its own disclosure.
// =====================================================================

import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { DEFAULT_PRIVACY, type PrivacySettings } from '../shared/evidencePrivacy'

function privacyFile(): string {
  return join(app.getPath('userData'), 'evidence-privacy.json')
}

/**
 * Read the policy. Any failure — missing file, unreadable file, corrupt JSON —
 * returns the DEFAULT, which captures everything.
 *
 * That default deserves a note, because the safe-looking choice is the other
 * one. Failing "closed" (redact everything when the settings can't be read)
 * would silently strip evidence from a run the user expected to be complete,
 * and they would chase a bug that the redaction invented. Failing open keeps
 * the app's behaviour predictable and is what the user had before they ever
 * opened this screen. The policy is opt-in throughout; a policy that turns
 * itself on because a file was corrupt is not one.
 */
export async function loadPrivacy(): Promise<PrivacySettings> {
  try {
    const raw = await readFile(privacyFile(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PrivacySettings>
    return {
      builtins: parsed.builtins === true,
      patterns: typeof parsed.patterns === 'string' ? parsed.patterns : '',
      maskSelectors: typeof parsed.maskSelectors === 'string' ? parsed.maskSelectors : '',
      // The one field whose default is true, so a file written by an older
      // build (which had no such field) keeps capturing the DOM rather than
      // silently losing it.
      captureDom: parsed.captureDom !== false
    }
  } catch {
    return { ...DEFAULT_PRIVACY }
  }
}

export async function savePrivacy(settings: PrivacySettings): Promise<PrivacySettings> {
  const clean: PrivacySettings = {
    builtins: settings.builtins === true,
    patterns: String(settings.patterns ?? ''),
    maskSelectors: String(settings.maskSelectors ?? ''),
    captureDom: settings.captureDom !== false
  }
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(privacyFile(), JSON.stringify(clean, null, 2), 'utf-8')
  return clean
}
