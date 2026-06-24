import { ipcRenderer } from 'electron'

// =====================================================================
// THE RELAY (Day 15 rewrite)
// =====================================================================
// The recorder observer no longer lives here. It is injected into EVERY frame
// of the embedded browser by main (see observerSource.ts + injectObserver in
// src/main/index.ts), because Electron's preload-into-sub-frames mechanism was
// unreliable — iframes randomly went uncaptured.
//
// This preload now loads ONLY in the top frame (nodeIntegrationInSubFrames is
// off again). Its single job is to be the bridge: the injected observers, which
// run in the page world and have no ipcRenderer, post their events UP to the
// top window via window.top.postMessage. Here — in the top frame, where
// ipcRenderer IS available — we forward each one to main over IPC, unchanged.
//
// So every recorded event from any frame travels:
//   frame's observer ──postMessage──▶ top window ──(this relay)──▶ main (IPC)

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { __qaflow?: boolean; channel?: unknown; payload?: unknown } | null
  // Only our own messages, tagged with __qaflow and a channel name.
  if (!data || data.__qaflow !== true || typeof data.channel !== 'string') return
  ipcRenderer.send(data.channel, data.payload)
})
