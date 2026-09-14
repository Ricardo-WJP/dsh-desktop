'use strict'

const { app, BrowserWindow } = require('electron')
const { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const specs = JSON.parse(process.env.DSH_PRELOAD_SMOKE_SPECS || '[]')
const smokeRoot = mkdtempSync(join(tmpdir(), 'dsh-desktop-preload-smoke-'))
for (const path of ['user-data', 'session-data', 'cache']) mkdirSync(join(smokeRoot, path), { recursive: true })
app.setPath('userData', join(smokeRoot, 'user-data'))
app.setPath('sessionData', join(smokeRoot, 'session-data'))
app.setPath('cache', join(smokeRoot, 'cache'))
const pages = []
const windows = []
app.on('window-all-closed', event => event.preventDefault())

function assertSpec(spec) {
  if (spec === null || typeof spec !== 'object' || typeof spec.preload !== 'string' || typeof spec.bridge !== 'string') {
    throw new TypeError('Invalid preload smoke specification')
  }
  if (!Array.isArray(spec.methods) || spec.methods.length === 0 || spec.methods.some(method => typeof method !== 'string') || new Set(spec.methods).size !== spec.methods.length) {
    throw new TypeError('Invalid preload smoke method list')
  }
}

function waitForWindowClosed(window) {
  if (window.isDestroyed()) return Promise.resolve()
  return new Promise(resolve => window.once('closed', resolve))
}

async function closeWindow(window) {
  if (window.isDestroyed()) return
  const closed = waitForWindowClosed(window)
  window.close()
  await closed
}

async function run() {
  if (!Array.isArray(specs) || specs.length < 2) throw new Error('Expected generated preload smoke specifications')
  for (const spec of specs) {
    assertSpec(spec)
    const page = join(tmpdir(), `dsh-desktop-preload-smoke-${process.pid}-${pages.length}.html`)
    pages.push(page)
    writeFileSync(page, '<!doctype html><html><body>preload smoke</body></html>')
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: spec.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    windows.push(window)
    await window.loadFile(page)
    const result = await window.webContents.executeJavaScript(`({ type: typeof window[${JSON.stringify(spec.bridge)}], keys: Object.keys(window[${JSON.stringify(spec.bridge)}] || {}) })`)
    const expected = [...spec.methods].sort()
    const actual = [...(result?.keys || [])].sort()
    if (result?.type !== 'object' || JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Bridge ${spec.bridge} exposed ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)} from ${spec.preload}`)
    }
    console.log(`PRELOAD_SMOKE_OK ${spec.bridge} ${spec.preload}`)
    await closeWindow(window)
  }
}

app.whenReady().then(async () => {
  let exitCode = 0
  try {
    await run()
  } catch (error) {
    exitCode = 1
    console.error(error?.stack || error)
  } finally {
    for (const window of windows) {
      try { await closeWindow(window) } catch { /* best effort cleanup */ }
    }
    for (const page of pages) {
      try { unlinkSync(page) } catch { /* best effort cleanup */ }
    }
    try { rmSync(smokeRoot, { recursive: true, force: true }) } catch { /* best effort cleanup */ }
    app.exit(exitCode)
  }
})
