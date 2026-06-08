# QATestFlow Recorder

> No-code QA test recorder with AI-powered selectors.
> Built with Electron + React + TypeScript.

A desktop QA workbench. Record a browser session by simply *using* the app — every click, type, and assertion becomes a step in an editable, reusable test. Export to Playwright (TS), YAML, or JSON. Resilient selectors. AI-assisted failure translation. See [`QA-Platform-PRD.md`](./QA-Platform-PRD.md) for the full spec.

## Tech stack

- **Electron** — desktop shell (cross-platform window + Node.js + Chromium)
- **React + TypeScript** — UI for the recorder, step editor, and library
- **Vite (via electron-vite)** — fast dev server, hot reload
- **Playwright** *(coming soon)* — replay engine

## Prerequisites

- Node.js v18+ (works on v24)
- npm

## Getting started

```bash
# Install dependencies
npm install

# Start dev server (opens the app with hot reload)
npm run dev
```

## Build for release

```bash
# Windows installer
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

## Project structure

```
src/
├── main/            # Electron main process — owns the window, IPC handlers
├── preload/         # Safe bridge exposing limited APIs to the renderer
└── renderer/        # React UI (welcome screen + browser chrome)
```

## Recommended IDE

- [VS Code](https://code.visualstudio.com/) with the [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) and [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode) extensions.
