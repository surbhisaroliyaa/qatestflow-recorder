// =====================================================================
// ENVIRONMENT / CONFIG MANAGER (F25)
// One saved test, every environment. A QA team runs the SAME regression
// suite against dev, staging, and production — the only differences are the
// base URL and the login credentials. Recording (and maintaining) a separate
// copy per environment is the exact busywork this tool exists to kill.
//
// An Environment is a named { baseURL + variables } bundle:
//   • baseURL — at run time, every navigation that lived under the test's
//     recorded base is re-pointed here (transiently — the saved test is never
//     rewritten), so "Login flow" recorded on staging can run on prod.
//   • vars — named values (USERNAME, PASSWORD, …) that feed the EXISTING
//     {{env:NAME}} token machinery (Day 20). When an environment is ACTIVE its
//     vars win over process.env, so `{{env:PASSWORD}}` resolves to THIS env's
//     password. Switch the active env → the whole suite runs with new creds.
//
// Stored in userData (AppData), NOT the shared Tests folder: environments hold
// credentials, and those must not ride along into a git-shared test artifact.
// One process-wide "active" selection; replay + data runs + Run All all honor
// it through the shared env-resolution + retarget path.
// =====================================================================

import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'

// One named value inside an environment, e.g. { name: 'PASSWORD', value: '…' }.
// Referenced from a step as {{env:PASSWORD}}; secret marks it for password-style
// masking in the UI (the value is still stored — this is a local personal tool,
// the same trust model as the Day 17 saved sessions that store auth cookies).
export interface EnvVar {
  name: string
  value: string
  secret?: boolean
}

export interface Environment {
  id: string // stable, minted on create (never the name — names are editable)
  name: string // display name, e.g. "Staging"
  baseURL: string // where navigations are re-pointed, e.g. "https://staging.example.com"
  vars: EnvVar[]
}

// The whole store: the environments plus which one (if any) is active.
export interface EnvState {
  version: 1
  activeId: string | null
  environments: Environment[]
}

const EMPTY: EnvState = { version: 1, activeId: null, environments: [] }

function storePath(): string {
  return join(app.getPath('userData'), 'environments.json')
}

// Cached in-memory so env-token resolution (hit on every run) doesn't touch
// disk each time. Loaded lazily on first access, written through on every edit.
let cache: EnvState | null = null

async function load(): Promise<EnvState> {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await readFile(storePath(), 'utf-8'))
    if (parsed && Array.isArray(parsed.environments)) {
      cache = {
        version: 1,
        activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
        environments: parsed.environments
      }
    } else {
      cache = { ...EMPTY }
    }
  } catch {
    cache = { ...EMPTY } // no file yet (fresh app) — start empty
  }
  // An active id pointing at a deleted env is meaningless — drop it.
  if (cache.activeId && !cache.environments.some((e) => e.id === cache!.activeId)) {
    cache.activeId = null
  }
  return cache
}

async function persist(state: EnvState): Promise<void> {
  cache = state
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(storePath(), JSON.stringify(state, null, 2), 'utf-8')
}

export async function getEnvState(): Promise<EnvState> {
  return load()
}

// Create or update one environment (matched by id). A create supplies a fresh
// id; an update reuses it. Returns the full new state so the renderer refreshes
// in one round-trip.
export async function saveEnvironment(env: Environment): Promise<EnvState> {
  const state = await load()
  const environments = state.environments.some((e) => e.id === env.id)
    ? state.environments.map((e) => (e.id === env.id ? env : e))
    : [...state.environments, env]
  const next: EnvState = { ...state, environments }
  await persist(next)
  return next
}

export async function deleteEnvironment(id: string): Promise<EnvState> {
  const state = await load()
  const environments = state.environments.filter((e) => e.id !== id)
  const activeId = state.activeId === id ? null : state.activeId
  const next: EnvState = { ...state, environments, activeId }
  await persist(next)
  return next
}

// Select (or clear, with null) the active environment. null = run against the
// test's own recorded URLs / process.env, the pre-F25 behavior.
export async function setActiveEnvironment(id: string | null): Promise<EnvState> {
  const state = await load()
  const activeId = id && state.environments.some((e) => e.id === id) ? id : null
  const next: EnvState = { ...state, activeId }
  await persist(next)
  return next
}

export async function activeEnvironment(): Promise<Environment | null> {
  const state = await load()
  return state.environments.find((e) => e.id === state.activeId) ?? null
}

// The active env's variables as a plain { NAME: value } map, for merging over
// process.env during token resolution. Empty when nothing is active.
export async function activeEnvVars(): Promise<Record<string, string>> {
  const env = await activeEnvironment()
  const out: Record<string, string> = {}
  for (const v of env?.vars ?? []) if (v.name) out[v.name] = v.value
  return out
}
