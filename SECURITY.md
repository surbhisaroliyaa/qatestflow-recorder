# Security

## Reporting a problem

Please report security issues privately to the maintainer (see the repository owner's profile)
rather than in a public issue. Include steps to reproduce and the version (`Help → About` or the
installer name).

## What the app protects, and how

- **Tested websites are untrusted.** A page you record or replay runs in its own browser view,
  session and **sandboxed** renderer process (the app's own window is sandboxed too).
- **The recorder is invisible to the page.** It runs in each frame's _isolated world_ (Electron
  context isolation) inside the recorder preload, and talks to the app over `ipcRenderer`, which
  page scripts cannot reach. The app learns which frame an event came from from Electron itself,
  not from anything the page could write. Script-written iframes (which get no preload) are
  recorded by the frame that contains them, from the same isolated world.
- **Only real input is recorded.** The recorder ignores any click, change or key press the page
  itself generates (`isTrusted === false`) — so a page cannot create steps by calling
  `button.click()` or dispatching events.
- **The app re-checks everything it receives** (`src/shared/recorderMessages.ts`): an allow-list
  of channels, a strict schema rebuilt from known fields, and size limits. File uploads are only
  accepted from real file-picker events resolved in the isolated world.
- **Passwords** are never written into test files. They are stored in
  `%APPDATA%\qatestflow-recorder\secrets.json`, encrypted with the operating system's protection
  (Windows DPAPI / macOS Keychain), and deleted when nothing refers to them. Password-like
  data-table columns, drafts, history, backups, run traces and baselines are covered too.
- **Exports and bundles carry no secrets** — they read them from environment variables.

## Known limits

- **Native dialogs are observed from the page world.** Overriding `alert`/`confirm`/`prompt` only
  works in the world the page calls them from, so a tiny shim lives there and reports each dialog
  to the recorder. A page could describe a dialog that never opened — but a page decides which
  dialogs it shows anyway, so this adds nothing it couldn't do by opening one.
- In a script-written iframe on a site whose Content-Security-Policy forbids inline scripts, the
  dialog shim cannot be installed, so dialogs inside _that_ iframe are not recorded. Clicks and
  typing there are unaffected.
- Protection of stored passwords is "only this user on this machine": software running as you on
  your unlocked machine can ask the OS to decrypt them, as it can for your browser's passwords.

## Vulnerability policy for dependencies

- CI runs `npm audit --audit-level=high` over **all** dependencies (including Electron, which is a
  devDependency but ships inside the installer). **High or critical advisories fail the build.**
- A high/critical advisory is fixed before the next release: update within range, or upgrade the
  major version after testing. It is not suppressed. If no fix exists yet, the advisory is recorded
  here with its impact and a review date.
- Low and moderate advisories are fixed at the next dependency update.

**Currently open:** one **low** advisory — `esbuild` inside `vite`, affecting only the development
server on Windows (not shipped in the app). No in-range fix yet; review at the next Vite update.
