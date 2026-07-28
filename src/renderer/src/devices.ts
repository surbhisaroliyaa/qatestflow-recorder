// =====================================================================
// F36 — DEVICE EMULATION (upgrades Day-17 viewport)
//
// Day 17 gave a test a VIEWPORT: width + height. That resizes the window and
// nothing else. A real phone differs in four more ways, and each one changes
// what the page does:
//
//   userAgent         — sites that sniff the UA serve a different page entirely
//   isMobile          — sets the mobile flag + meta-viewport handling
//   hasTouch          — `ontouchstart` exists, navigator.maxTouchPoints > 0, and
//                       CSS `@media (pointer: coarse)` matches. Tap handlers and
//                       hover-only menus behave differently.
//   deviceScaleFactor — a retina 2x/3x screen; picks different @2x images and
//                       changes what a screenshot actually contains
//
// So "375×667" is a NARROW DESKTOP WINDOW, not a phone. A responsive site that
// switches layout on UA or on `pointer: coarse` will not switch, and the test
// passes while never having tested mobile at all. That's the gap this closes.
//
// HONEST LIMIT (surfaced in the UI): the in-app browser is Electron's
// WebContentsView — Chromium only. An "iPhone 13" run in-app is Chromium
// wearing a Safari costume: layout, touch, and pixel density are real, but
// WebKit's own rendering bugs cannot appear. Playwright itself runs iPhone 13
// on WebKit — which is why the EXPORT emits `devices['iPhone 13']` and the
// 🧭 cross-browser run (real Playwright) is where WebKit truth lives.
//
// Values below are copied verbatim from the installed
// playwright-core/lib/server/deviceDescriptorsSource.json so the in-app run and
// the exported spec describe the SAME device.
// =====================================================================

export interface DeviceProfile {
  id: string
  label: string
  group: 'Basic' | 'Phone' | 'Tablet'
  viewport: { width: number; height: number }
  /** undefined = keep the real browser UA (the size-only presets). */
  userAgent?: string
  deviceScaleFactor?: number
  isMobile?: boolean
  hasTouch?: boolean
  /** Name in Playwright's `devices[]`, for the export + cross-browser config. */
  playwrightDevice?: string
  /** The engine Playwright would really use — an honesty note for the UI. */
  realEngine?: 'webkit' | 'chromium'
}

// Day-17's three presets are kept EXACTLY as they were (size only, no UA/touch)
// so every already-saved test replays identically. The real devices are new
// entries — opting into one is a deliberate choice, never a silent change.
export const DEVICES: DeviceProfile[] = [
  {
    id: 'tablet-768',
    label: 'Tablet · 768×1024 (size only)',
    group: 'Basic',
    viewport: { width: 768, height: 1024 }
  },
  {
    id: 'mobile-375',
    label: 'Mobile · 375×667 (size only)',
    group: 'Basic',
    viewport: { width: 375, height: 667 }
  },
  {
    id: 'iphone-13',
    label: 'iPhone 13',
    group: 'Phone',
    viewport: { width: 390, height: 664 },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    playwrightDevice: 'iPhone 13',
    realEngine: 'webkit'
  },
  {
    id: 'iphone-se',
    label: 'iPhone SE',
    group: 'Phone',
    viewport: { width: 320, height: 568 },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 10_3_1 like Mac OS X) AppleWebKit/603.1.30 (KHTML, like Gecko) Version/26.0 Mobile/14E304 Safari/602.1',
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    playwrightDevice: 'iPhone SE',
    realEngine: 'webkit'
  },
  {
    id: 'pixel-7',
    label: 'Pixel 7',
    group: 'Phone',
    viewport: { width: 412, height: 839 },
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.37 Mobile Safari/537.36',
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    playwrightDevice: 'Pixel 7',
    realEngine: 'chromium'
  },
  {
    id: 'galaxy-s9plus',
    label: 'Galaxy S9+',
    group: 'Phone',
    viewport: { width: 320, height: 658 },
    userAgent:
      'Mozilla/5.0 (Linux; Android 8.0.0; SM-G965U Build/R16NW) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.37 Mobile Safari/537.36',
    deviceScaleFactor: 4.5,
    isMobile: true,
    hasTouch: true,
    playwrightDevice: 'Galaxy S9+',
    realEngine: 'chromium'
  },
  {
    id: 'ipad-gen7',
    label: 'iPad (gen 7)',
    group: 'Tablet',
    viewport: { width: 810, height: 1080 },
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    playwrightDevice: 'iPad (gen 7)',
    realEngine: 'webkit'
  }
]

export function deviceById(id: string | undefined): DeviceProfile | undefined {
  if (!id) return undefined
  return DEVICES.find((d) => d.id === id)
}

/**
 * Resolve what a saved test should run as.
 *
 * BACK-COMPAT is the whole point of this function. Every test saved before F36
 * carries only `viewport: {width,height}` and no `deviceId`. Such a test must
 * keep replaying exactly as it did — a size-only override, real desktop UA, no
 * touch. So:
 *
 *   deviceId set + known  → that full profile
 *   deviceId set + UNKNOWN → fall back to the saved size (a profile removed from
 *                            the catalogue must not silently become desktop —
 *                            that would change the test's meaning in silence)
 *   no deviceId, viewport → a synthetic size-only profile (Day-17 behaviour)
 *   neither               → undefined = fill the window (desktop, no override)
 */
export function resolveDevice(
  deviceId: string | undefined,
  viewport: { width: number; height: number } | undefined
): DeviceProfile | undefined {
  const known = deviceById(deviceId)
  if (known) return known
  if (viewport && viewport.width > 0 && viewport.height > 0) {
    return {
      id: deviceId ? `custom-${deviceId}` : 'custom',
      label: `Custom · ${viewport.width}×${viewport.height} (size only)`,
      group: 'Basic',
      viewport
    }
  }
  return undefined
}

/** One-line summary for the test bar / library chip. */
export function deviceSummary(d: DeviceProfile | undefined): string {
  if (!d) return 'Desktop (fills the window)'
  const bits = [`${d.viewport.width}×${d.viewport.height}`]
  if (d.deviceScaleFactor && d.deviceScaleFactor !== 1) bits.push(`@${d.deviceScaleFactor}x`)
  if (d.hasTouch) bits.push('touch')
  if (d.userAgent) bits.push('mobile UA')
  return `${d.label.replace(/ \(size only\)$/, '')} — ${bits.join(' · ')}`
}
