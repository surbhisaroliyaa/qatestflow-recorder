# Releasing QATestFlow Recorder

## Build the installer

```bash
npm install          # also downloads the Electron runtime (postinstall)
npm run build:win    # → dist/qatestflow-recorder-<version>-setup.exe
```

Before building a release: `npm run typecheck`, `npm test`, `npm run test:dom`, and
`node tools/doc-counts.mjs --check` should all pass (CI runs them on every push). Then, on a
desktop, run the end-to-end recording check against the built app — it drives real mouse and
keyboard input into the embedded browser and reads back the recorded steps:

```bash
npm run build && node tools/e2e-smoke.mjs
```

## App icon

All icon files are generated from one source, `build/icon.svg`:

```bash
node tools/make-icons.mjs            # writes build/icon.{png,ico,icns} and resources/icon.png
node tools/make-icons.mjs --preview preview.png   # plus a sheet showing every size
```

Edit the SVG, regenerate, and commit the generated files with it.

## Code signing (Windows)

The installer is currently **unsigned**, so Windows shows _"Windows protected your PC"_ /
_"Unknown publisher"_ on install. To sign, buy a code-signing certificate from a certificate
authority (a standard OV certificate as a `.pfx` file, or an EV certificate), then set two
environment variables before `npm run build:win`:

| Variable           | Value                                            |
| ------------------ | ------------------------------------------------ |
| `CSC_LINK`         | path to the `.pfx` file (or its base64 contents) |
| `CSC_KEY_PASSWORD` | the certificate's password                       |

electron-builder signs the app and installer automatically when they are set — no config change.
Never commit the certificate or its password.

## Auto-update

**Off.** The build config used to point at a placeholder (`https://example.com/auto-updates`);
it is now `publish: null`, and the app contains no updater code. To switch updates on later, pick a
real release channel (e.g. GitHub Releases), set `publish` in `electron-builder.yml`, add
`electron-updater` to the app, and test an update from one signed version to the next.

## macOS

Not currently shipped. A macOS release would also need an Apple Developer ID certificate,
notarization (`notarize` in `electron-builder.yml`), and a check of the entitlements and
permission descriptions on a clean Mac.
