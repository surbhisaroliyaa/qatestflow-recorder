// Generate every app-icon file from ONE source: build/icon.svg.
//
//   node tools/make-icons.mjs [--preview out.png]
//
// Writes:
//   build/icon.png      1024×1024 — electron-builder's master (Linux, fallback)
//   build/icon.ico      Windows: 16, 24, 32, 48, 64, 128, 256 in one file
//   build/icon.icns     macOS: 128–1024
//   resources/icon.png  512×512 — the window/taskbar icon at runtime
//
// Rendered by real Chromium (via Playwright, already a dependency) so the
// text uses the same font engine the app does. ICO and ICNS both allow PNG-
// encoded images inside, so no image library is needed to build them.
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(join(root, 'build', 'icon.svg'), 'utf-8')

const browser = await chromium.launch()
const page = await browser.newPage()
async function render(size) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<html><body style="margin:0;background:transparent">
       <div style="width:${size}px;height:${size}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div>
     </body></html>`
  )
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
}

const png = {}
for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) png[s] = await render(s)

// ICO: 6-byte header, a 16-byte directory entry per image, then the PNG data.
function ico(sizes) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(sizes.length, 4)
  const dir = Buffer.alloc(16 * sizes.length)
  let offset = 6 + dir.length
  sizes.forEach((s, i) => {
    const d = i * 16
    dir.writeUInt8(s >= 256 ? 0 : s, d) // 0 means 256
    dir.writeUInt8(s >= 256 ? 0 : s, d + 1)
    dir.writeUInt8(0, d + 2) // palette
    dir.writeUInt8(0, d + 3)
    dir.writeUInt16LE(1, d + 4) // colour planes
    dir.writeUInt16LE(32, d + 6) // bits per pixel
    dir.writeUInt32LE(png[s].length, d + 8)
    dir.writeUInt32LE(offset, d + 12)
    offset += png[s].length
  })
  return Buffer.concat([header, dir, ...sizes.map((s) => png[s])])
}

// ICNS: 'icns' + total length, then (type, length, PNG) per entry.
function icns(entries) {
  const parts = entries.map(([type, s]) => {
    const h = Buffer.alloc(8)
    h.write(type, 0, 'ascii')
    h.writeUInt32BE(8 + png[s].length, 4)
    return Buffer.concat([h, png[s]])
  })
  const body = Buffer.concat(parts)
  const h = Buffer.alloc(8)
  h.write('icns', 0, 'ascii')
  h.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([h, body])
}

writeFileSync(join(root, 'build', 'icon.png'), png[1024])
writeFileSync(join(root, 'build', 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]))
writeFileSync(
  join(root, 'build', 'icon.icns'),
  icns([
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024]
  ])
)
writeFileSync(join(root, 'resources', 'icon.png'), png[512])

// Optional contact sheet, to look at every size side by side.
const i = process.argv.indexOf('--preview')
if (i > 0 && process.argv[i + 1]) {
  const sizes = [256, 64, 48, 32, 24, 16]
  const cell = (bg) =>
    `<div style="background:${bg};padding:18px;display:flex;gap:22px;align-items:flex-end">${sizes
      .map(
        (s) =>
          `<div style="text-align:center;font:12px Segoe UI;color:#888"><img src="data:image/png;base64,${png[s].toString('base64')}" width="${s}" height="${s}"><br>${s}px</div>`
      )
      .join('')}</div>`
  await page.setViewportSize({ width: 700, height: 400 })
  await page.setContent(
    `<html><body style="margin:0">${cell('#f3f3f3')}${cell('#202020')}</body></html>`
  )
  writeFileSync(process.argv[i + 1], await page.screenshot({ fullPage: true }))
}

await browser.close()
console.log('icons written: build/icon.png, build/icon.ico, build/icon.icns, resources/icon.png')
