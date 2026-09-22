// =====================================================================
// OUTBOUND INTEGRATION SETTINGS  (Phase 4)
// =====================================================================
// Where the postback and GitLab configuration is KEPT. The rules live in
// src/shared/postback.ts, which is pure and tested.
//
// userData, not the shared Tests folder, and not the renderer's localStorage.
// Both of these hold a credential — a bearer token in the postback headers, a
// GitLab access token — and the same reasoning applies that put environment
// variables in userData (F25) and moved passwords out of test files (QF-003):
// a folder built to be committed and shared must not contain secrets.
// =====================================================================

import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { DEFAULT_POSTBACK, type PostbackSettings } from '../shared/postback'

export interface IntegrationSettings {
  postback: PostbackSettings
  gitlab: { baseUrl: string; token: string; projectId: string; labels: string }
}

export const DEFAULT_INTEGRATIONS: IntegrationSettings = {
  postback: { ...DEFAULT_POSTBACK },
  gitlab: { baseUrl: 'https://gitlab.com', token: '', projectId: '', labels: '' }
}

function settingsFile(): string {
  return join(app.getPath('userData'), 'integrations.json')
}

/** Read the settings. Any failure returns the defaults, which send nothing —
 *  the safe direction here, unlike the privacy policy: a corrupt file must not
 *  start posting run results to a URL nobody can currently see. */
export async function loadIntegrations(): Promise<IntegrationSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsFile(), 'utf-8')) as Partial<IntegrationSettings>
    const pb: Partial<PostbackSettings> = raw.postback ?? {}
    const gl: Partial<IntegrationSettings['gitlab']> = raw.gitlab ?? {}
    return {
      postback: {
        when: pb.when === 'always' || pb.when === 'failure' ? pb.when : 'off',
        url: typeof pb.url === 'string' ? pb.url : '',
        headers: typeof pb.headers === 'string' ? pb.headers : ''
      },
      gitlab: {
        baseUrl: typeof gl.baseUrl === 'string' && gl.baseUrl ? gl.baseUrl : 'https://gitlab.com',
        token: typeof gl.token === 'string' ? gl.token : '',
        projectId: typeof gl.projectId === 'string' ? gl.projectId : '',
        labels: typeof gl.labels === 'string' ? gl.labels : ''
      }
    }
  } catch {
    return {
      postback: { ...DEFAULT_INTEGRATIONS.postback },
      gitlab: { ...DEFAULT_INTEGRATIONS.gitlab }
    }
  }
}

export async function saveIntegrations(next: IntegrationSettings): Promise<IntegrationSettings> {
  const clean: IntegrationSettings = {
    postback: {
      when:
        next.postback?.when === 'always' || next.postback?.when === 'failure'
          ? next.postback.when
          : 'off',
      url: String(next.postback?.url ?? ''),
      headers: String(next.postback?.headers ?? '')
    },
    gitlab: {
      baseUrl: String(next.gitlab?.baseUrl ?? 'https://gitlab.com'),
      token: String(next.gitlab?.token ?? ''),
      projectId: String(next.gitlab?.projectId ?? ''),
      labels: String(next.gitlab?.labels ?? '')
    }
  }
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(settingsFile(), JSON.stringify(clean, null, 2), 'utf-8')
  return clean
}
